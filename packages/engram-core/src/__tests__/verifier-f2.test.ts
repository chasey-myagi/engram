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
  NEUTRAL_FACTORS,
  type ConfidenceFactorBreakdown,
  type StoredConfidence,
} from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { claim, claimVerification, type ClaimStatus } from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { makeFakeSameFactJudge } from '../same-fact/fake-judge.js'
import { addSource } from '../spi/append-claim.js'
import { commitClaim } from '../spi/commit-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { transitionClaim, PROMOTE_CONFIDENCE_FLOOR } from '../spi/transition.js'
import {
  computeEntailmentFactor,
  entailmentVerdictToFactor,
  latestEntailmentFactors,
  latestPatrolVerdict,
  writePatrolVerdict,
} from '../verifier/patrol-verdict.js'

// S17 · f2 entailment 接线（命门 A.3）：patrol 裁决 → f2，在 commit/recall/promote 三处实时生效。
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder = makeFakeEmbedder()
const judge = makeFakeSameFactJudge() // 结构化三元走确定性规则

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
  await pool.query('TRUNCATE source, claim, claim_provenance, relation, claim_verification CASCADE')
})

const VERIFIER_ROLE = 'agent:verifier'

async function aSource(authorityScore = 0.9) {
  return addSource(db, {
    content: `body-${randomUUID()}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore,
  })
}

/** 直接 seed 一条 claim 行，精确控制 status + 存档因子（promote 门用，绕开 commit 的算术）。 */
async function seedClaim(opts: {
  status: ClaimStatus
  factors: Partial<ConfidenceFactorBreakdown>
  claimText?: string
  createdBy?: string
}): Promise<string> {
  const id = randomUUID()
  const factors: ConfidenceFactorBreakdown = {
    authority: 0,
    humanReview: 0,
    entailment: NEUTRAL_FACTORS.entailment,
    indepSupport: 0,
    usageCorrect: 0,
    ageDays: 0,
    activeContradicts: 0,
    staleDecay: 1,
    conflictDecay: 1,
    ...opts.factors,
  }
  const stored: StoredConfidence = {
    factors,
    weights: DEFAULT_WEIGHTS,
    calibrationVersion: CALIBRATION_IDENTITY,
  }
  await db.insert(claim).values({
    id,
    claimText: opts.claimText ?? `seed-${id}`,
    status: opts.status,
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: stored,
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: opts.createdBy ?? 'agent:distiller',
    embedding: null,
    embeddingVersion: null,
  })
  return id
}

describe('S17 f2 entailment factor — patrol → f2 (命门 A.3)', () => {
  it('entailmentVerdictToFactor: pass→1, fail→0, not_co_true→0, none→neutral 0.5', () => {
    expect(entailmentVerdictToFactor('pass')).toBe(1)
    expect(entailmentVerdictToFactor('fail')).toBe(0)
    expect(entailmentVerdictToFactor('not_co_true')).toBe(0)
    expect(entailmentVerdictToFactor(null)).toBe(NEUTRAL_FACTORS.entailment)
    expect(NEUTRAL_FACTORS.entailment).toBe(0.5) // 单一真相源（"未跑过"）
  })

  it('writePatrolVerdict + latestPatrolVerdict: append-only, latest (by createdAt desc) wins; no patrol → null', async () => {
    const id = await seedClaim({ status: 'active', factors: { authority: 0.9 } })
    expect(await latestPatrolVerdict(db, id)).toBeNull() // no patrol yet
    await writePatrolVerdict(db, {
      claimId: id,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'fail' },
    })
    await writePatrolVerdict(db, {
      claimId: id,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'pass' },
    })
    expect(await latestPatrolVerdict(db, id)).toBe('pass') // latest of two rounds
    expect(await computeEntailmentFactor(db, id)).toBe(1) // pass → 1
    // append-only: both rounds persisted
    const rows = await db.select().from(claimVerification).where(eq(claimVerification.claimId, id))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === 'patrol' && r.byRole === VERIFIER_ROLE)).toBe(true)
  })

  it('latestEntailmentFactors: batch read, latest per claim, claims with no patrol absent from the map', async () => {
    const a = await seedClaim({ status: 'active', factors: {} })
    const b = await seedClaim({ status: 'active', factors: {} })
    const c = await seedClaim({ status: 'active', factors: {} }) // never patrolled
    await writePatrolVerdict(db, {
      claimId: a,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'pass' },
    })
    await writePatrolVerdict(db, {
      claimId: b,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'pass' },
    })
    await writePatrolVerdict(db, {
      claimId: b,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'fail' },
    }) // newer
    const m = await latestEntailmentFactors(db, [a, b, c])
    expect(m.get(a)).toBe(1) // pass
    expect(m.get(b)).toBe(0) // latest = fail
    expect(m.has(c)).toBe(false) // no patrol → not in map (caller keeps stored/neutral)
  })

  it('recall recomputes f2 live from the latest patrol: pass raises the value, fail drops it below the floor (out of recall)', async () => {
    // two independent strong sources ⇒ stored base (entail 0.5) = 0.3·0.9 + 0.15·0.5(entail) + 0.15·0.5(indep) = 0.42 ≥ floor
    const triple = { subject: 'sku-1', predicate: 'weight', object: '5kg' }
    const s1 = await aSource()
    const first = await commitClaim(
      db,
      embedder,
      judge,
      { claimText: 'sku-1 weight 5kg', ...triple },
      [{ sourceId: s1.sourceId, locator: 'a' }],
    )
    const s2 = await aSource()
    await commitClaim(db, embedder, judge, { claimText: 'sku-1 weight 5kg', ...triple }, [
      { sourceId: s2.sourceId, locator: 'b' },
    ])
    await transitionClaim(db, first.claimId, 'active', { by: 'human:editor' }) // promote (human bypass)

    // no patrol: entailment is the stored neutral 0.5
    const h0 = await recallClaims(db, embedder, 'sku-1 weight 5kg')
    expect(h0).toHaveLength(1)
    expect(h0[0]!.confidence.factors.entailment).toBe(0.5)
    const vNeutral = h0[0]!.confidence.value

    // pass patrol → live f2 = 1.0 → higher value, recalled
    await writePatrolVerdict(db, {
      claimId: first.claimId,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'pass' },
    })
    const h1 = await recallClaims(db, embedder, 'sku-1 weight 5kg')
    expect(h1).toHaveLength(1)
    expect(h1[0]!.confidence.factors.entailment).toBe(1)
    expect(h1[0]!.confidence.value).toBeGreaterThan(vNeutral)

    // fail patrol → live f2 = 0 → base 0.345 < 0.4 kernel floor → dropped from recall
    await writePatrolVerdict(db, {
      claimId: first.claimId,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'fail' },
    })
    const h2 = await recallClaims(db, embedder, 'sku-1 weight 5kg')
    expect(h2.find((r) => r.claim.id === first.claimId)).toBeUndefined()
  })

  it('commit-merge recompute reflects an existing patrol: merging a new source into a patrol-passed claim keeps f2=1 in the stored snapshot', async () => {
    const triple = { subject: 'sku-2', predicate: 'len', object: '1m' }
    const s1 = await aSource()
    const first = await commitClaim(db, embedder, judge, { claimText: 'sku-2 len 1m', ...triple }, [
      { sourceId: s1.sourceId, locator: 'a' },
    ])
    await writePatrolVerdict(db, {
      claimId: first.claimId,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'pass' },
    })
    // merge a second independent source → commitClaim recomputes stored conf with claimId → reads the patrol
    const s2 = await aSource()
    const merged = await commitClaim(
      db,
      embedder,
      judge,
      { claimText: 'sku-2 len 1m', ...triple },
      [{ sourceId: s2.sourceId, locator: 'b' }],
    )
    expect(merged.merged).toBe(true)
    expect(merged.claimId).toBe(first.claimId)
    const [row] = await db
      .select({ f: claim.confidenceFactors })
      .from(claim)
      .where(eq(claim.id, first.claimId))
    expect((row!.f as StoredConfidence).factors.entailment).toBe(1) // patrol pass persisted into the merged snapshot
  })

  it('promote gate uses live f2: a draft below the floor with neutral entailment cannot promote, but does once a patrol passes', async () => {
    // stored factors: base(entail 0.5)=0.3·1 + 0.15·0.5 + 0.15·0.75 = 0.4875 < 0.5; base(entail 1)=0.5625 ≥ 0.5
    const id = await seedClaim({
      status: 'draft',
      createdBy: 'agent:distiller',
      factors: { authority: 1, indepSupport: 0.75, entailment: 0.5 },
    })
    // no patrol yet → gate sees neutral 0.5 → conf 0.4875 < 0.5 → blocked (entailmentPass flag alone is not enough)
    await expect(
      transitionClaim(db, id, 'active', { by: VERIFIER_ROLE, entailmentPass: true }),
    ).rejects.toThrow(new RegExp(`conf 0\\.\\d+ < ${PROMOTE_CONFIDENCE_FLOOR}`))
    const [d] = await db.select({ s: claim.status }).from(claim).where(eq(claim.id, id))
    expect(d!.s).toBe('draft') // unchanged

    // a passing patrol raises live f2 to 1.0 → conf 0.5625 ≥ 0.5 → promotion proceeds
    await writePatrolVerdict(db, {
      claimId: id,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'pass' },
    })
    const res = await transitionClaim(db, id, 'active', { by: VERIFIER_ROLE, entailmentPass: true })
    expect(res).toEqual({ from: 'draft', to: 'active' })
  })

  it('promote still requires the entailmentPass flag even when conf clears the floor (両gate, not one)', async () => {
    const id = await seedClaim({
      status: 'draft',
      createdBy: 'agent:distiller',
      factors: { authority: 1, indepSupport: 0.75, entailment: 0.5 },
    })
    await writePatrolVerdict(db, {
      claimId: id,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'pass' },
    })
    // conf now ≥ 0.5 (live f2=1) but entailmentPass omitted → still blocked on the entailment gate
    await expect(transitionClaim(db, id, 'active', { by: VERIFIER_ROLE })).rejects.toThrow(
      /entailment did not pass/,
    )
  })

  // EGR-CR-001 (#82): a not_co_true patrol row refused by the NC-exact red line (red line #3) must NEVER score into f2.
  // The read primitives must skip refusedByNcExact rows and keep scanning older rows (fall back to the last VALID
  // patrol, or neutral 0.5 if none) — never let a refused negation silently push f2 to 0.
  describe('EGR-CR-001: NC-exact refused not_co_true patrol rows are non-scoring (read-side filter)', () => {
    it('(2a) a refused not_co_true on top of an older valid pass → latest=pass, factor=1 (single + batch)', async () => {
      const id = await seedClaim({ status: 'active', factors: { authority: 0.9 } })
      // older: a legitimate pass
      await writePatrolVerdict(db, {
        claimId: id,
        byRole: VERIFIER_ROLE,
        verdict: { entailment: 'pass' },
      })
      // newest: a not_co_true that was REFUSED by the NC-exact red line → must be skipped, not scored
      await writePatrolVerdict(db, {
        claimId: id,
        byRole: VERIFIER_ROLE,
        verdict: { entailment: 'not_co_true', refusedByNcExact: true },
      })
      expect(await latestPatrolVerdict(db, id)).toBe('pass') // refused row skipped → falls back to the prior valid pass
      expect(await computeEntailmentFactor(db, id)).toBe(1)
      const m = await latestEntailmentFactors(db, [id])
      expect(m.get(id)).toBe(1) // batch primitive same caliber
    })

    it('(2b) a refused not_co_true as the ONLY row → latest=null, factor=neutral 0.5; batch map omits the claim', async () => {
      const id = await seedClaim({ status: 'active', factors: { authority: 0.9 } })
      await writePatrolVerdict(db, {
        claimId: id,
        byRole: VERIFIER_ROLE,
        verdict: { entailment: 'not_co_true', refusedByNcExact: true },
      })
      expect(await latestPatrolVerdict(db, id)).toBeNull() // no valid patrol remains → null (not not_co_true)
      expect(await computeEntailmentFactor(db, id)).toBe(NEUTRAL_FACTORS.entailment) // 0.5, not 0
      const m = await latestEntailmentFactors(db, [id])
      expect(m.has(id)).toBe(false) // caller falls back to stored / neutral
    })

    it('(2c) backward compat: a legacy not_co_true WITHOUT refusedByNcExact still scores 0 (the new filter does not misfire on history)', async () => {
      const id = await seedClaim({ status: 'active', factors: { authority: 0.9 } })
      await writePatrolVerdict(db, {
        claimId: id,
        byRole: VERIFIER_ROLE,
        verdict: { entailment: 'not_co_true' }, // historical-shape row: no marker
      })
      expect(await latestPatrolVerdict(db, id)).toBe('not_co_true')
      expect(await computeEntailmentFactor(db, id)).toBe(0)
      const m = await latestEntailmentFactors(db, [id])
      expect(m.get(id)).toBe(0)
    })
  })

  // EGR-CR-001 (#82) test 3: commit / append archival snapshot must NOT be burned to f2=0 by a refused not_co_true.
  it('EGR-CR-001: a refused not_co_true does NOT burn f2=0 into the stored snapshot on commit-merge recompute (stays neutral)', async () => {
    const triple = { subject: 'sku-r', predicate: 'len', object: '1m' }
    const s1 = await aSource()
    const first = await commitClaim(db, embedder, judge, { claimText: 'sku-r len 1m', ...triple }, [
      { sourceId: s1.sourceId, locator: 'a' },
    ])
    // a not_co_true patrol row that was refused by the NC-exact red line → must not score
    await writePatrolVerdict(db, {
      claimId: first.claimId,
      byRole: VERIFIER_ROLE,
      verdict: { entailment: 'not_co_true', refusedByNcExact: true },
    })
    // merge a second independent source → commitClaim recomputes stored conf with claimId → reads the patrol
    const s2 = await aSource()
    const merged = await commitClaim(
      db,
      embedder,
      judge,
      { claimText: 'sku-r len 1m', ...triple },
      [{ sourceId: s2.sourceId, locator: 'b' }],
    )
    expect(merged.merged).toBe(true)
    expect(merged.claimId).toBe(first.claimId)
    const [row] = await db
      .select({ f: claim.confidenceFactors })
      .from(claim)
      .where(eq(claim.id, first.claimId))
    // neutral 0.5, NOT 0 — the refused negation never enters the stored snapshot
    expect((row!.f as StoredConfidence).factors.entailment).toBe(NEUTRAL_FACTORS.entailment)
  })
})
