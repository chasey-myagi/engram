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
import { claim, claimProvenance, type ClaimStatus } from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { reportUsage } from '../spi/report-usage.js'
import {
  computeUsageCorrectFactor,
  computeUsageCorrectStats,
  latestUsageCorrectFactors,
  usageCorrectStatsFromCounts,
  USAGE_CORRECT_K,
  USAGE_CORRECT_MIN_SAMPLES,
} from '../harvest/usage-correct.js'

// S19 · f4 usageCorrect 接线（命门 A.3 / 派生 A.6）：usage_truth 独立门控统计 → observed_correctness → f4，
// 在因子装配（commit/recompute）与召回 live-override 实时生效。
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder = makeFakeEmbedder()

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL })
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
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

/** 直接 seed 一条 recallable claim（精确控制 status + 存档因子），返回 id。出处一条 exact source。 */
async function seedClaim(opts: {
  status: ClaimStatus
  factors?: Partial<ConfidenceFactorBreakdown>
  claimText?: string
}): Promise<string> {
  const claimText = opts.claimText ?? `seed-${randomUUID()}`
  const { sourceId } = await addSource(db, {
    content: `src for ${claimText}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  const factors: ConfidenceFactorBreakdown = {
    authority: 0.9,
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
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText,
    status: opts.status,
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: stored,
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'agent:distiller',
    embedding: await embedder.embed(claimText),
    embeddingVersion: embedder.version,
  })
  // 一条 exact 出处（recall 需要 ≥1 出处才出现，D1 兜底）。
  await db.insert(claimProvenance).values({
    id: randomUUID(),
    claimId: id,
    sourceId,
    locator: 'L1',
    relevance: 'exact',
  })
  return id
}

describe('S19 f4 usageCorrect — observed_correctness → f4 (pure mapping)', () => {
  it('usageCorrectStatsFromCounts: f4 = clamp(observed·k − 0.5, 0, 1) with low-sample damp', () => {
    expect(USAGE_CORRECT_K).toBe(2)
    expect(USAGE_CORRECT_MIN_SAMPLES).toBe(3)

    // observed=1.0, n=3 (≥N, no damp): mapped = clamp(1·2−0.5)=1 → f4=1
    expect(usageCorrectStatsFromCounts(3, 0).factor).toBe(1)
    // observed=0.5, n=4: mapped = clamp(0.5·2−0.5)=0.5, damp=1 → f4=0.5
    expect(usageCorrectStatsFromCounts(2, 2).observed).toBe(0.5)
    expect(usageCorrectStatsFromCounts(2, 2).factor).toBeCloseTo(0.5, 10)
    // observed=0.25, n=4: mapped = clamp(0.25·2−0.5)=0 → f4=0 (mostly refuted)
    expect(usageCorrectStatsFromCounts(1, 3).factor).toBe(0)
    // all refuted: observed=0 → f4=0
    expect(usageCorrectStatsFromCounts(0, 4).factor).toBe(0)
    // never used (n=0): observed=null, f4=neutral 0
    const none = usageCorrectStatsFromCounts(0, 0)
    expect(none.observed).toBeNull()
    expect(none.factor).toBe(NEUTRAL_FACTORS.usageCorrect)
    expect(none.factor).toBe(0)
  })

  it('low-sample damp: n<N pulls f4 toward neutral 0 proportionally (thin data cannot swing)', () => {
    // observed=1.0 always maps to 1.0 pre-damp; damp = n/N (N=3).
    const n1 = usageCorrectStatsFromCounts(1, 0) // n=1 → damp 1/3
    const n2 = usageCorrectStatsFromCounts(2, 0) // n=2 → damp 2/3
    const n3 = usageCorrectStatsFromCounts(3, 0) // n=3 → damp 1
    expect(n1.factor).toBeCloseTo(1 / 3, 10)
    expect(n2.factor).toBeCloseTo(2 / 3, 10)
    expect(n3.factor).toBe(1)
    // monotone: more (consistently-correct) independent samples ⇒ higher f4, capped at full-confidence n≥N.
    expect(n1.factor).toBeLessThan(n2.factor)
    expect(n2.factor).toBeLessThan(n3.factor)
  })

  it('A3 red line (structural): the f4 fitter input takes only adopted/refuted counts — there is no ELO/win-rate channel', () => {
    // usageCorrectStatsFromCounts(adopted, refuted, {k, minSamples}) — its signature carries no rank/elo/winRate field.
    // A win-rate-like value can only enter by being miscoded as adopted/refuted counts, which IS observed_correctness.
    const keys = Object.keys(usageCorrectStatsFromCounts(1, 1, {}))
    expect(keys).toContain('observed')
    expect(keys).not.toContain('elo')
    expect(keys).not.toContain('winRate')
    expect(keys).not.toContain('rank')
    // The parameter object only knows k / minSamples (mapping knobs), nothing rank-like.
    expect(usageCorrectStatsFromCounts(1, 1, { k: 2, minSamples: 3 }).observed).toBe(0.5)
  })
})

describe('S19 f4 usageCorrect — independent-user/task gating (anti-brigading), DB-backed', () => {
  it('repeated reports from the SAME (by_role, task) collapse to ONE vote (same-task brigading does not inflate f4)', async () => {
    const id = await seedClaim({ status: 'active' })
    // 50 adopted reports, all from the SAME consumer + SAME task → one independent identity → one vote.
    for (let i = 0; i < 50; i += 1) {
      await reportUsage(db, id, 'adopted', { byRole: 'consumer:a', taskId: 'task-1' })
    }
    const stats = await computeUsageCorrectStats(db, id)
    expect(stats.adopted).toBe(1) // collapsed to a single independent vote
    expect(stats.refuted).toBe(0)
    expect(stats.independentSamples).toBe(1) // n=1, NOT 50
    // n=1 < N=3 ⇒ heavily damped: f4 = 1·(1/3), not a full 1.0 — brigading cannot swing confidence.
    expect(stats.factor).toBeCloseTo(1 / 3, 10)
  })

  it('observed_correctness counts only DISTINCT identities; (by_role, task) pair is the identity key', async () => {
    const id = await seedClaim({ status: 'active' })
    // 4 distinct identities adopted (different users OR different tasks), 0 refuted.
    await reportUsage(db, id, 'adopted', { byRole: 'consumer:a', taskId: 't1' })
    await reportUsage(db, id, 'adopted', { byRole: 'consumer:b', taskId: 't1' }) // different user, same task
    await reportUsage(db, id, 'adopted', { byRole: 'consumer:a', taskId: 't2' }) // same user, different task
    await reportUsage(db, id, 'adopted', { byRole: 'consumer:c', taskId: 't3' })
    const stats = await computeUsageCorrectStats(db, id)
    expect(stats.adopted).toBe(4)
    expect(stats.refuted).toBe(0)
    expect(stats.observed).toBe(1)
    expect(stats.independentSamples).toBe(4) // ≥N → no damp
    expect(stats.factor).toBe(1) // strong, consistent independent adoption
  })

  it('latest outcome per identity wins: an identity that first adopted then refuted counts as refuted', async () => {
    const id = await seedClaim({ status: 'active' })
    // identity A: adopted then later refuted → counts as refuted (latest). identities B,C,D adopted.
    await reportUsage(db, id, 'adopted', { byRole: 'consumer:a', taskId: 't1' })
    await reportUsage(db, id, 'refuted', { byRole: 'consumer:a', taskId: 't1' }) // newer for A
    await reportUsage(db, id, 'adopted', { byRole: 'consumer:b', taskId: 't1' })
    await reportUsage(db, id, 'adopted', { byRole: 'consumer:c', taskId: 't1' })
    const stats = await computeUsageCorrectStats(db, id)
    expect(stats.adopted).toBe(2) // B, C
    expect(stats.refuted).toBe(1) // A (latest = refuted)
    expect(stats.observed).toBeCloseTo(2 / 3, 10)
  })

  it('corrected/partial are not counted in the f4 denominator (only adopted/refuted)', async () => {
    const id = await seedClaim({ status: 'active' })
    await reportUsage(db, id, 'adopted', { byRole: 'consumer:a', taskId: 't1' })
    await reportUsage(db, id, 'corrected', { byRole: 'consumer:b', taskId: 't2' }) // not counted
    await reportUsage(db, id, 'partial', { byRole: 'consumer:c', taskId: 't3' }) // not counted
    const stats = await computeUsageCorrectStats(db, id)
    expect(stats.adopted).toBe(1)
    expect(stats.refuted).toBe(0)
    expect(stats.independentSamples).toBe(1) // only the adopted identity counts
  })

  it('latestUsageCorrectFactors batch matches the single-claim factor; claims with no usage are absent from the map', async () => {
    const a = await seedClaim({ status: 'active', claimText: 'aaa' })
    const b = await seedClaim({ status: 'active', claimText: 'bbb' })
    const c = await seedClaim({ status: 'active', claimText: 'ccc' }) // never used
    for (const u of ['x', 'y', 'z']) {
      await reportUsage(db, a, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    await reportUsage(db, b, 'refuted', { byRole: 'consumer:x', taskId: 't1' })
    await reportUsage(db, b, 'refuted', { byRole: 'consumer:y', taskId: 't2' })
    await reportUsage(db, b, 'refuted', { byRole: 'consumer:z', taskId: 't3' })

    const m = await latestUsageCorrectFactors(db, [a, b, c])
    expect(m.get(a)).toBe(await computeUsageCorrectFactor(db, a)) // 3 independent adopted → 1
    expect(m.get(a)).toBe(1)
    expect(m.get(b)).toBe(await computeUsageCorrectFactor(db, b)) // 3 independent refuted → 0
    expect(m.get(b)).toBe(0)
    expect(m.has(c)).toBe(false) // no usage → not in map (caller keeps stored)
  })
})

describe('S19 f4 usageCorrect — recall live-override (assertable via confSnapshot.factors.usageCorrect)', () => {
  it('recall recomputes f4 live: strong independent adoption raises usageCorrect and the value', async () => {
    // base(neutral usageCorrect 0) = 0.3·0.9 + 0.15·0.5(entail) + 0.15·0.75(indep) = 0.4575 ≥ 0.4 floor → recalled even pre-usage.
    const id = await seedClaim({
      status: 'active',
      claimText: 'sku-u spec 4',
      factors: { indepSupport: 0.75 },
    })

    // no usage yet → stored neutral 0
    const h0 = await recallClaims(db, embedder, 'sku-u spec 4')
    expect(h0).toHaveLength(1)
    expect(h0[0]!.confidence.factors.usageCorrect).toBe(0)
    const vNeutral = h0[0]!.confidence.value

    // 3 independent adopted → live f4 = 1.0
    for (const u of ['a', 'b', 'c']) {
      await reportUsage(db, id, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    const h1 = await recallClaims(db, embedder, 'sku-u spec 4')
    expect(h1).toHaveLength(1)
    expect(h1[0]!.confidence.factors.usageCorrect).toBe(1) // live f4 in the snapshot
    expect(h1[0]!.confidence.value).toBeGreaterThan(vNeutral) // f4 raised confidence
  })

  it('recall live-override leaves f2/other factors intact (only usageCorrect changes)', async () => {
    const id = await seedClaim({
      status: 'active',
      claimText: 'sku-v spec 8',
      factors: { entailment: 0.5, authority: 0.9, indepSupport: 0.3 },
    })
    for (const u of ['a', 'b', 'c', 'd']) {
      await reportUsage(db, id, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
    }
    const h = await recallClaims(db, embedder, 'sku-v spec 8')
    expect(h[0]!.confidence.factors.usageCorrect).toBe(1)
    expect(h[0]!.confidence.factors.entailment).toBe(0.5) // untouched (no patrol)
    expect(h[0]!.confidence.factors.authority).toBe(0.9)
    expect(h[0]!.confidence.factors.indepSupport).toBe(0.3)
  })
})
