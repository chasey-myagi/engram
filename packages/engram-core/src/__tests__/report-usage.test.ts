import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  CALIBRATION_IDENTITY,
  DEFAULT_WEIGHTS,
  type StoredConfidence,
} from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { addSource } from '../spi/append-claim.js'
import { claim, claimProvenance, claimVerification } from '../db/schema.js'
import { recallClaims } from '../spi/recall-claims.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import {
  FAILURE_OUTCOMES,
  USAGE_OUTCOMES,
  getFailurePool,
  getUsageEvents,
  reportUsage,
} from '../spi/report-usage.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const embedder = makeFakeEmbedder()

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL })
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, page_claims CASCADE',
  )
})

// 召回(S7 起用 DEFAULT_WEIGHTS 重算)后 value 须 ≥0.4 才可召回：把 4 个非 usage 因子置 0.9、usageCorrect 留 0
// (f4 中性，Harvester S19 才喂)。base = (0.3+0.3+0.15+0.15)·0.9 + 0.1·0 = 0.81 ⇒ 可召回，且 f4 仍为 0。
function factorsBlob(): StoredConfidence {
  return {
    factors: {
      authority: 0.9,
      humanReview: 0.9,
      entailment: 0.9,
      indepSupport: 0.9,
      usageCorrect: 0, // f4 neutral — Harvester (S19) is the only producer
      ageDays: 0,
      activeContradicts: 0,
      staleDecay: 1,
      conflictDecay: 1,
    },
    weights: DEFAULT_WEIGHTS,
    calibrationVersion: CALIBRATION_IDENTITY,
  }
}

/** Seed a recallable (active, grounded) claim at a known confidence; returns its id. */
async function seedActiveClaim(text: string, raw = 0.8): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: text,
    status: 'active',
    confidence: raw,
    confidenceRaw: raw,
    confidenceFactors: factorsBlob(),
    embedding: await embedder.embed(text),
    embeddingVersion: embedder.version,
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
  })
  const { sourceId } = await addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

async function countVerifications(): Promise<number> {
  const rows = await db.select({ id: claimVerification.id }).from(claimVerification)
  return rows.length
}

describe('S4 report_usage — append-only usage_truth events (A.2)', () => {
  it('appends exactly one usage_truth row with outcome / by_role / taskId / note; all four outcomes round-trip', async () => {
    for (const outcome of USAGE_OUTCOMES) {
      const id = await seedActiveClaim(`claim ${outcome}`)
      const { verificationId } = await reportUsage(db, id, outcome, {
        byRole: 'agent:bidder-7',
        taskId: 'task-42',
        note: `used as ${outcome}`,
      })
      const events = await getUsageEvents(db, id)
      expect(events).toHaveLength(1)
      const e = events[0]!
      expect(e.id).toBe(verificationId)
      expect(e.outcome).toBe(outcome) // round-trips through verdict JSONB
      expect(e.byRole).toBe('agent:bidder-7')
      expect(e.taskId).toBe('task-42')
      expect(e.note).toBe(`used as ${outcome}`)
    }
  })

  it('persists kind=usage_truth and a verdict carrying the outcome', async () => {
    const id = await seedActiveClaim('verdict shape')
    const { verificationId } = await reportUsage(db, id, 'corrected', { byRole: 'agent:x' })
    const [row] = await db
      .select()
      .from(claimVerification)
      .where(eq(claimVerification.id, verificationId))
    expect(row!.kind).toBe('usage_truth')
    expect(row!.verdict).toMatchObject({ outcome: 'corrected', taskId: null, note: null })
  })

  it('defaults by_role to consumer:unknown when ctx omits it (NOT NULL attribution column)', async () => {
    const id = await seedActiveClaim('default role')
    await reportUsage(db, id, 'adopted') // no ctx at all → default branch executes on a real write
    const [e] = await getUsageEvents(db, id)
    expect(e!.byRole).toBe('consumer:unknown')
  })

  it('verdict JSONB carries exactly {outcome, taskId, note, predictedConfidence, calibrationVersion, query, kbLacksAnswer} — by_role stays a column', async () => {
    const id = await seedActiveClaim('verdict keys')
    const { verificationId } = await reportUsage(db, id, 'adopted', {
      byRole: 'agent:x',
      taskId: 't',
      note: 'n',
    })
    const [row] = await db
      .select()
      .from(claimVerification)
      .where(eq(claimVerification.id, verificationId))
    expect(Object.keys(row!.verdict as object).sort()).toEqual([
      'calibrationVersion',
      'kbLacksAnswer',
      'note',
      'outcome',
      'predictedConfidence',
      'query',
      'taskId',
    ])
  })

  it('round-trips free-text note/taskId through verdict JSONB; empty string survives, omitted becomes null', async () => {
    const tricky = 'q"uote \\back/slash 中文 😀 {"json":true}'
    const id = await seedActiveClaim('boundary text')
    await reportUsage(db, id, 'partial', { byRole: 'r', taskId: tricky, note: tricky })
    const [e1] = await getUsageEvents(db, id)
    expect(e1!.taskId).toBe(tricky) // quotes / backslash / unicode / json-special all intact
    expect(e1!.note).toBe(tricky)

    const empties = await seedActiveClaim('boundary empty')
    await reportUsage(db, empties, 'partial', { byRole: 'r', note: '' }) // taskId omitted, note ''
    const [e2] = await getUsageEvents(db, empties)
    expect(e2!.note).toBe('') // empty string preserved, distinct from omitted
    expect(e2!.taskId).toBeNull() // omitted → null
  })

  it('getUsageEvents / getFailurePool return events in created_at-ascending order, not insertion order', async () => {
    const id = await seedActiveClaim('ordered events')
    // insert OUT of time order with explicit, staggered created_at — proves the orderBy actually orders
    const rows = [
      { createdAt: new Date('2025-03-03T00:00:00Z'), outcome: 'refuted', note: 'third' },
      { createdAt: new Date('2025-01-01T00:00:00Z'), outcome: 'corrected', note: 'first' },
      { createdAt: new Date('2025-02-02T00:00:00Z'), outcome: 'adopted', note: 'second' },
    ]
    for (const r of rows) {
      await db.insert(claimVerification).values({
        id: randomUUID(),
        claimId: id,
        kind: 'usage_truth',
        verdict: { outcome: r.outcome, taskId: null, note: r.note },
        byRole: 'r',
        createdAt: r.createdAt,
      })
    }
    // NO .sort() here — the order under test is the function's own
    expect((await getUsageEvents(db, id)).map((e) => e.note)).toEqual(['first', 'second', 'third'])
    expect((await getFailurePool(db)).map((e) => e.note)).toEqual(['first', 'third']) // corrected+refuted, still ascending
  })

  it('rejects a nonexistent claimId with no partial write, leaving prior events intact', async () => {
    const id = await seedActiveClaim('prior event')
    await reportUsage(db, id, 'adopted', { byRole: 'r' })
    expect(await countVerifications()).toBe(1)

    await expect(reportUsage(db, randomUUID(), 'adopted')).rejects.toThrow(/not found/i)
    expect(await countVerifications()).toBe(1) // rejected report wrote nothing; the prior row is untouched
  })

  it('rejects an invalid outcome (off-contract string or non-string) with no write', async () => {
    const id = await seedActiveClaim('bad outcome')
    // @ts-expect-error — off-contract string exercises the membership guard
    await expect(reportUsage(db, id, 'bogus')).rejects.toThrow(/invalid outcome/i)
    // @ts-expect-error — non-string inputs exercise the typeof branch of the guard
    await expect(reportUsage(db, id, null)).rejects.toThrow(/invalid outcome/i)
    // @ts-expect-error
    await expect(reportUsage(db, id, 7)).rejects.toThrow(/invalid outcome/i)
    expect(await countVerifications()).toBe(0)
  })

  it('getUsageEvents is scoped to its claimId — never leaks another claim’s events', async () => {
    const a = await seedActiveClaim('iso events alpha')
    const b = await seedActiveClaim('iso events beta')
    await reportUsage(db, a, 'adopted', { byRole: 'r' })
    await reportUsage(db, a, 'corrected', { byRole: 'r' })
    await reportUsage(db, b, 'refuted', { byRole: 'r' })

    const evA = await getUsageEvents(db, a)
    expect(evA).toHaveLength(2)
    expect(evA.every((e) => e.claimId === a)).toBe(true) // only A's events, no B leakage
    const evB = await getUsageEvents(db, b)
    expect(evB).toHaveLength(1)
    expect(evB[0]!.claimId).toBe(b)
  })

  it('readers filter kind=usage_truth — patrol / reembed_marker rows never pollute usage or failure pool', async () => {
    const id = await seedActiveClaim('kind filter')
    await reportUsage(db, id, 'refuted', { byRole: 'r' }) // a genuine failure-pool event
    // off-kind rows on the SAME claim (claim_verification is tri-purpose: patrol / usage_truth / reembed_marker)
    await db.insert(claimVerification).values({
      id: randomUUID(),
      claimId: id,
      kind: 'patrol',
      verdict: { entailment: 'pass' },
      byRole: 'verifier',
    })
    await db.insert(claimVerification).values({
      id: randomUUID(),
      claimId: id,
      kind: 'reembed_marker',
      verdict: { model: 'v2' },
      byRole: 'system',
    })

    const events = await getUsageEvents(db, id)
    expect(events).toHaveLength(1) // only the usage_truth row, not patrol/reembed
    expect(events[0]!.outcome).toBe('refuted')
    const pool = await getFailurePool(db)
    expect(pool).toHaveLength(1)
    expect(pool[0]!.claimId).toBe(id)
  })

  it('read-side fail-loud: a usage_truth row with a missing/invalid outcome throws from getUsageEvents, and the failure pool filters it out', async () => {
    const id = await seedActiveClaim('broken verdict')
    // hand-insert a malformed usage_truth row (simulates a future bad writer / manual row) — verdict has no outcome
    await db.insert(claimVerification).values({
      id: randomUUID(),
      claimId: id,
      kind: 'usage_truth',
      verdict: {},
      byRole: 'rogue',
    })
    // getUsageEvents filters only by kind → reaches the bad row → fail-loud instead of emitting outcome:undefined
    await expect(getUsageEvents(db, id)).rejects.toThrow(/invalid outcome/i)
    // getFailurePool's SQL filter admits only corrected/refuted (always valid), so a malformed row is
    // excluded before mapping — it never pollutes the pool and never reaches the guard.
    expect(await getFailurePool(db)).toHaveLength(0)
  })

  it('records by_role per report and is append-only — repeated reports never overwrite prior rows', async () => {
    const id = await seedActiveClaim('append only')
    await reportUsage(db, id, 'adopted', { byRole: 'agent:athlete' })
    await reportUsage(db, id, 'refuted', { byRole: 'human:judge' }) // judge ≠ athlete attribution preserved

    const events = await getUsageEvents(db, id)
    expect(events).toHaveLength(2) // both retained, nothing updated/deleted
    expect(events.map((e) => e.byRole).sort()).toEqual(['agent:athlete', 'human:judge'])
    expect(events.map((e) => e.outcome).sort()).toEqual(['adopted', 'refuted'])
  })

  it('does not mutate claim.confidence (升降信 decoupled from reporting)', async () => {
    const id = await seedActiveClaim('immutable confidence')
    const before = (await db.select().from(claim).where(eq(claim.id, id)))[0]!

    await reportUsage(db, id, 'corrected', { byRole: 'agent:x', note: 'wrong value' })

    const after = (await db.select().from(claim).where(eq(claim.id, id)))[0]!
    expect(after.confidence).toBe(before.confidence)
    expect(after.confidenceRaw).toBe(before.confidenceRaw)
    expect(after.confidenceFactors).toEqual(before.confidenceFactors)
  })

  it('failure pool enumerates only corrected/refuted across claims (adopted/partial excluded)', async () => {
    const a = await seedActiveClaim('pool corrected')
    const b = await seedActiveClaim('pool refuted')
    const c = await seedActiveClaim('pool adopted')
    const d = await seedActiveClaim('pool partial')
    await reportUsage(db, a, 'corrected', { byRole: 'r' })
    await reportUsage(db, b, 'refuted', { byRole: 'r' })
    await reportUsage(db, c, 'adopted', { byRole: 'r' })
    await reportUsage(db, d, 'partial', { byRole: 'r' })

    const pool = await getFailurePool(db)
    expect(pool.map((e) => e.outcome).sort()).toEqual(['corrected', 'refuted'])
    expect(new Set(pool.map((e) => e.claimId))).toEqual(new Set([a, b]))
    for (const e of pool) expect(FAILURE_OUTCOMES).toContain(e.outcome)
  })

  it('a claim with no usage history enumerates empty and recalls with f4 at its neutral value (no crash)', async () => {
    const id = await seedActiveClaim('no usage yet')
    expect(await getUsageEvents(db, id)).toEqual([])

    const [r] = await recallClaims(db, embedder, 'no usage yet')
    expect(r!.confidence.factors.usageCorrect).toBe(0) // f4 neutral; Harvester (S19) is the only feeder
  })

  it('end-to-end: recall → report corrected → event is queryable (failure pool) and confidence is unchanged', async () => {
    const id = await seedActiveClaim('engram usage seam')
    const [recalled] = await recallClaims(db, embedder, 'engram usage seam')
    expect(recalled!.claim.id).toBe(id)
    const confBefore = recalled!.confidence.value

    await reportUsage(db, id, 'corrected', { byRole: 'agent:consumer-1', taskId: 'bid-99' })

    const events = await getUsageEvents(db, id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ outcome: 'corrected', taskId: 'bid-99' })
    expect((await getFailurePool(db)).map((e) => e.claimId)).toContain(id)

    const [recalledAfter] = await recallClaims(db, embedder, 'engram usage seam')
    expect(recalledAfter!.confidence.value).toBe(confBefore) // report_usage left confidence untouched
    expect(recalledAfter!.confidence.factors.usageCorrect).toBe(0) // f4 still neutral (not fed until S19)
  })
})
