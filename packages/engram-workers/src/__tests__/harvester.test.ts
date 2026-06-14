import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  makeFakeEmbedder,
  recallClaims,
  reportUsage,
  schema,
  type DB,
} from '@engram/core'

import { harvestBatch, HARVESTER_TRIGGER, runHarvester } from '../harvester.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'engram-core',
  'drizzle',
)

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder = makeFakeEmbedder()
// 内核未导出 DEFAULT_WEIGHTS；测试内联起步基线（与 A.3 一致）。
const WEIGHTS = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  pool.on('error', () => {}) // 吞 teardown 期 DROP ... WITH(FORCE) 终止连接的 57P01（测试已结束、连接被服务端杀属预期）
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE source, claim, claim_provenance, relation, claim_verification CASCADE')
})

/** Seed a recallable active claim with one exact provenance; neutral usageCorrect, factors clear the floor pre-usage. */
async function mkClaim(opts?: {
  claimText?: string
  status?: schema.ClaimStatus
  factors?: Partial<{ authority: number; entailment: number; indepSupport: number }>
}): Promise<string> {
  const claimText = opts?.claimText ?? `claim-${randomUUID()}`
  const { sourceId } = await addSource(db, {
    content: `src for ${claimText}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  const factors = {
    authority: 0.9,
    humanReview: 0,
    entailment: 0.5,
    indepSupport: 0.75, // base(neutral usage) = 0.4575 ≥ 0.4 floor → recallable even before any usage
    usageCorrect: 0,
    ageDays: 0,
    activeContradicts: 0,
    staleDecay: 1,
    conflictDecay: 1,
    ...opts?.factors,
  }
  const id = randomUUID()
  await db.insert(schema.claim).values({
    id,
    claimText,
    status: opts?.status ?? 'active',
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: { factors, weights: WEIGHTS, calibrationVersion: 'identity' },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'agent:distiller',
    embedding: await embedder.embed(claimText),
    embeddingVersion: embedder.version,
  })
  await db.insert(schema.claimProvenance).values({
    id: randomUUID(),
    claimId: id,
    sourceId,
    locator: 'L1',
    relevance: 'exact',
  })
  return id
}

/** Read the persisted (stored) f4 + raw straight from the claim row. */
async function storedOf(claimId: string): Promise<{ usageCorrect: number; raw: number }> {
  const [row] = await db
    .select({ f: schema.claim.confidenceFactors, raw: schema.claim.confidenceRaw })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  const stored = row!.f as { factors: { usageCorrect: number } }
  return { usageCorrect: stored.factors.usageCorrect, raw: row!.raw }
}

async function statusOf(claimId: string): Promise<schema.ClaimStatus> {
  const [row] = await db
    .select({ s: schema.claim.status })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  return row!.s
}

/** Wrap a DB so its FIRST .transaction() call rejects (then delegates) — exercises a per-claim recompute failure. */
function dbFailingFirstTransaction(real: DB): DB {
  let armed = true
  return new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop === 'transaction') {
        return (...a: unknown[]): unknown => {
          if (armed) {
            armed = false
            return Promise.reject(new Error('injected recompute transaction failure'))
          }
          return (real.transaction as (...x: unknown[]) => unknown)(...a)
        }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as unknown as DB
}

describe('S19 Harvester worker — usage→confidence loop (pure statistics, A.6/A.7)', () => {
  it('end-to-end: several INDEPENDENT adopted usages → Harvester raises stored f4 and confidence', async () => {
    const id = await mkClaim({ claimText: 'sku harvest 1' })
    const before = await storedOf(id)
    expect(before.usageCorrect).toBe(0) // stored neutral pre-harvest

    // 3 independent consumers/tasks all adopt → observed=1, n=3 (≥N) → f4=1
    for (const u of ['a', 'b', 'c']) {
      await reportUsage(db, id, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }

    const res = await runHarvester({ db })
    expect(res.harvested).toBe(1)
    expect(res.skipped).toBe(0)
    expect(res.byRole).toBe('agent:harvester')

    const after = await storedOf(id)
    expect(after.usageCorrect).toBe(1) // f4 persisted into the stored snapshot
    expect(after.raw).toBeGreaterThan(before.raw) // strong adopted history raised confidence

    // and the change is visible through recall (the SPI seam)
    const hits = await recallClaims(db, embedder, 'sku harvest 1')
    expect(hits[0]!.confidence.factors.usageCorrect).toBe(1)
  })

  it('anti-brigading: MANY reports from the SAME task do NOT inflate f4 (collapses to one heavily-damped vote)', async () => {
    const id = await mkClaim({ claimText: 'sku harvest 2' })
    // 100 adopted reports, all from the SAME consumer + SAME task → one independent vote, n=1 < N=3 → damped to 1/3.
    for (let i = 0; i < 100; i += 1) {
      await reportUsage(db, id, 'adopted', { byRole: 'consumer:spammer', taskId: 'task-x' })
    }
    await runHarvester({ db })
    const after = await storedOf(id)
    expect(after.usageCorrect).toBeCloseTo(1 / 3, 10) // NOT 1.0 — brigading cannot swing f4
    expect(after.usageCorrect).toBeLessThan(1)
  })

  it('batch targeting is not truncated by maxClaims: a targeted claim beyond the row cap is still recomputed', async () => {
    // 4 distinct usage-claims; target the 4th with maxClaims=1. Pre-fix (limit(1)+in-memory filter) would
    // distinct→1 arbitrary row, filter to ∅, and silently no-op. Post-fix (inArray in SQL, no limit) recomputes it.
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const id = await mkClaim({ claimText: `sku batch decoy ${i}` })
      await reportUsage(db, id, 'adopted', { byRole: `consumer:d${i}`, taskId: `td-${i}` })
      ids.push(id) // decoys: 3 distinct usage-claims
    }
    const target = await mkClaim({ claimText: 'sku batch target' })
    for (const u of ['x', 'y', 'z']) {
      await reportUsage(db, target, 'adopted', { byRole: `consumer:${u}`, taskId: `tt-${u}` }) // n=3 → f4=1
    }
    // 4 distinct usage-claims, maxClaims=1: pre-fix limit(1)+filter would drop the target (no-op); post-fix inArray finds it.
    const res = await harvestBatch({ db }, [target], { maxClaims: 1 })
    expect(res.harvested).toBe(1)
    expect((await storedOf(target)).usageCorrect).toBe(1) // recomputed despite maxClaims=1
  })

  it('refuted history keeps f4 at 0 (does not raise confidence), vs adopted which does raise it', async () => {
    // Two identical claims: one gets independent ADOPTED, the other independent REFUTED.
    const adoptedClaim = await mkClaim({ claimText: 'sku harvest adopt' })
    const refutedClaim = await mkClaim({ claimText: 'sku harvest refute' })
    for (const u of ['a', 'b', 'c']) {
      await reportUsage(db, adoptedClaim, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
      await reportUsage(db, refutedClaim, 'refuted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    await runHarvester({ db })

    const adopted = await storedOf(adoptedClaim)
    const refuted = await storedOf(refutedClaim)
    expect(adopted.usageCorrect).toBe(1) // observed=1 → f4=1
    expect(refuted.usageCorrect).toBe(0) // observed=0 → f4=0
    // f4 weight 0.1: adopted raw is exactly 0.1·(1−0) higher than refuted's (identical otherwise).
    expect(adopted.raw - refuted.raw).toBeCloseTo(0.1, 6) // float products w/ wall-clock staleDecay → 6 digits, not 10
    expect(refuted.raw).toBeLessThan(adopted.raw) // refuted history does not raise confidence; adopted does
  })

  it('a FAILED batch leaves confidence unchanged (failure holds current state, no g update, no crash)', async () => {
    const id = await mkClaim({ claimText: 'sku harvest 4' })
    for (const u of ['a', 'b', 'c']) {
      await reportUsage(db, id, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    const before = await storedOf(id)

    // Simulate a DB outage during the batch by ending the pool's ability to query mid-run:
    // a broken DB whose every query rejects. runHarvester must not throw and must change nothing.
    const brokenPool = new pg.Pool({ connectionString: 'postgresql://nobody@127.0.0.1:1/none' })
    const brokenDb = createDb(brokenPool)
    const res = await runHarvester({ db: brokenDb }) // must resolve, not reject
    await brokenPool.end()

    expect(res.harvested).toBe(0) // nothing harvested on a dead DB
    const after = await storedOf(id) // read back on the healthy db
    expect(after.usageCorrect).toBe(before.usageCorrect) // confidence untouched (held state)
    expect(after.raw).toBe(before.raw)
  })

  it('a no-op claim (usage_truth but no provenance left) is skipped without crashing; the rest still harvests', async () => {
    const good = await mkClaim({ claimText: 'sku harvest good' })
    const noProv = await mkClaim({ claimText: 'sku harvest noprov' })
    for (const u of ['a', 'b', 'c']) {
      await reportUsage(db, good, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
      await reportUsage(db, noProv, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    // Strip noProv's provenance → recomputeClaimConfidence returns null (won't zero out its confidence) — a no-op, not a crash.
    await db.delete(schema.claimProvenance).where(eq(schema.claimProvenance.claimId, noProv))

    const res = await runHarvester({ db }) // must not throw
    expect(res.harvested).toBe(1) // only good (noProv is a null/no-op)
    expect(await storedOf(good).then((s) => s.usageCorrect)).toBe(1)
  })

  it('harvestBatch (report_usage-batch trigger) only recomputes the given claim ids', async () => {
    const target = await mkClaim({ claimText: 'sku batch target' })
    const other = await mkClaim({ claimText: 'sku batch other' })
    for (const u of ['a', 'b', 'c']) {
      await reportUsage(db, target, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
      await reportUsage(db, other, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    const res = await harvestBatch({ db }, [target])
    expect(res.harvested).toBe(1)
    expect(await storedOf(target).then((s) => s.usageCorrect)).toBe(1) // target updated
    expect(await storedOf(other).then((s) => s.usageCorrect)).toBe(0) // other left alone (not in batch)
  })

  // EGR-CR-037 (#112): an EMPTY claimIds batch is a no-op — it must NOT degrade into the cron full-DB scan.
  // Pre-fix: harvestBatch([]) → runHarvester({claimIds: []}) → selector's `length > 0` is false → cron branch
  // recomputes EVERY usage_truth claim. Post-fix: harvestBatch([]) short-circuits to a zero result, touching nothing.
  it('EGR-CR-037: harvestBatch([]) is a no-op and does NOT degrade into a full-DB cron recompute', async () => {
    // ≥2 claims that the cron scan WOULD recompute (each has independent adopted usage → f4 would move 0→1).
    const a = await mkClaim({ claimText: 'sku empty-batch A' })
    const b = await mkClaim({ claimText: 'sku empty-batch B' })
    for (const id of [a, b]) {
      for (const u of ['x', 'y', 'z']) {
        await reportUsage(db, id, 'adopted', { byRole: `consumer:${u}:${id}`, taskId: `t:${u}:${id}` })
      }
    }
    const beforeA = await storedOf(a)
    const beforeB = await storedOf(b)
    expect(beforeA.usageCorrect).toBe(0) // stored neutral pre-harvest (cron would push these to 1)
    expect(beforeB.usageCorrect).toBe(0)

    const res = await harvestBatch({ db }, [])

    expect(res.harvested).toBe(0) // nothing harvested
    expect(res.skipped).toBe(0)
    expect(res.outcomes).toEqual([]) // no per-claim work
    expect(res.byRole).toBe('agent:harvester') // default role still reported
    // The decisive anti-degradation assertions: the full-DB cron set was NOT recomputed.
    const afterA = await storedOf(a)
    const afterB = await storedOf(b)
    expect(afterA.usageCorrect).toBe(beforeA.usageCorrect) // still 0 — untouched
    expect(afterA.raw).toBe(beforeA.raw)
    expect(afterB.usageCorrect).toBe(beforeB.usageCorrect)
    expect(afterB.raw).toBe(beforeB.raw)
  })

  it('claims with no usage are never touched (Harvester only visits claims with usage_truth)', async () => {
    const used = await mkClaim({ claimText: 'sku used' })
    const unused = await mkClaim({ claimText: 'sku unused' })
    for (const u of ['a', 'b', 'c']) {
      await reportUsage(db, used, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    const res = await runHarvester({ db })
    expect(res.harvested).toBe(1) // only the used claim
    expect(await storedOf(unused).then((s) => s.usageCorrect)).toBe(0) // untouched
  })

  it('declares its own trigger: report_usage batch + daily cron (A.7 choreography, no inline timer)', () => {
    expect(HARVESTER_TRIGGER.batchOn).toBe('report_usage')
    expect(HARVESTER_TRIGGER.cron).toBe('daily')
  })

  it('A3 red line: Harvester never updates g — calibration_version stays identity across a harvest', async () => {
    const id = await mkClaim({ claimText: 'sku harvest g' })
    for (const u of ['a', 'b', 'c']) {
      await reportUsage(db, id, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    await runHarvester({ db })
    const [row] = await db
      .select({ f: schema.claim.confidenceFactors })
      .from(schema.claim)
      .where(eq(schema.claim.id, id))
    const stored = row!.f as { calibrationVersion: string }
    expect(stored.calibrationVersion).toBe('identity') // g untouched (S28 owns g, not Harvester)
  })

  it("red line #2: the Harvester recomputes a non-active claim's confidence but NEVER relaxes its status (quarantined stays quarantined)", async () => {
    // selectUsageClaims filters on kind='usage_truth' only (no status filter) → it DOES visit a quarantined claim;
    // recomputeClaimConfidence only writes confidence/raw/factors, never status. Pin that the agent cannot relax.
    const id = await mkClaim({ claimText: 'sku harvest quarantined', status: 'quarantined' })
    for (const u of ['a', 'b', 'c']) {
      await reportUsage(db, id, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    const res = await runHarvester({ db })
    expect(res.harvested).toBe(1) // it visited + recomputed the quarantined claim
    expect((await storedOf(id)).usageCorrect).toBe(1) // confidence dimension (f4) DID move
    expect(await statusOf(id)).toBe('quarantined') // RED LINE #2: status untouched — an agent never relaxes
  })

  it("A.7 failure holds state: one claim's recompute throwing is skipped (no crash) — the rest still harvest", async () => {
    const a = await mkClaim({ claimText: 'sku harvest fail A' })
    const b = await mkClaim({ claimText: 'sku harvest fail B' })
    for (const id of [a, b]) {
      for (const u of ['x', 'y', 'z']) {
        await reportUsage(db, id, 'adopted', {
          byRole: `consumer:${u}:${id}`,
          taskId: `t:${u}:${id}`,
        })
      }
    }
    // first per-claim recompute transaction rejects; the loop must catch it, skip, and continue with the other claim
    const proxied = dbFailingFirstTransaction(db)
    const res = await runHarvester({ db: proxied }, { claimIds: [a, b] }) // must RESOLVE, not throw
    expect(res.skipped).toBe(1) // exactly one recompute threw → skipped (the central A.7 no-crash/hold-state contract)
    expect(res.harvested).toBe(1) // the other claim still harvested — one failure does not block the batch
    const failed = res.outcomes.find((o) => o.note?.includes('recompute error'))
    expect(failed).toBeDefined()
    expect(Number.isNaN(failed!.usageCorrect)).toBe(true) // skipped claim carries the NaN sentinel + note
  })
})
