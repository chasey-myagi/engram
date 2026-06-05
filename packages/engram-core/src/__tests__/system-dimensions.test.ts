import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type DB } from '../db/client.js'
import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { claim, claimProvenance } from '../db/schema.js'
import { addSource, appendClaim } from '../spi/append-claim.js'
import { writeHumanReview } from '../editor/human-review.js'
import { transitionClaim } from '../spi/transition.js'
import { recallClaims } from '../spi/recall-claims.js'
import { reportUsage } from '../spi/report-usage.js'
import { freezeRedTeamGeneration, recordImmunityScore } from '../spi/redteam-generation.js'
import {
  DIMENSION,
  DIMENSION_NAMES,
  getDimensionEvents,
  getDimensionSeries,
  recordDimension,
} from '../spi/dimension-events.js'
import {
  aggregateLatest,
  computeSystemDimensions,
  L3_GOLDEN,
  L3_GOLDEN_NAMESPACE,
  RELOCATED_TO_S31,
  runGoldenItem,
  runSystemDimensions,
} from '../eval/system-dimensions.js'

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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, claim_verification, relation, metrics_events, dimension_events, redteam_generations, redteam_immunity_scores CASCADE',
  )
})

/**
 * Self-author a claim through the REAL write SPI (append → human Approve → transition to active), addressable
 * by `query` via the fake embedder (claimText shares trigrams with query). This is how the KB "earns" a golden
 * answer — the golden item itself is NEVER written; only the KB's own claim is. The Approve lifts f1 humanReview
 * to 1.0 so the live-recomputed recall value clears the 0.4 consumption floor (authority alone leaves it under).
 */
async function selfAuthor(
  claimText: string,
  opts: { authorityScore?: number; asOf?: Date; kind?: 'structured_spec' | 'external_feed' } = {},
): Promise<string> {
  const src = await addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: opts.kind ?? 'structured_spec',
    authorityScore: opts.authorityScore ?? 0.95,
  })
  const { claimId } = await appendClaim(
    db,
    embedder,
    { claimText, createdBy: 'agent:self', ...(opts.asOf ? { asOf: opts.asOf } : {}) },
    [{ sourceId: src.sourceId, locator: 'p1', relevance: 'exact' }],
  )
  // human Approve → f1 humanReview = 1.0 (real editor path), so the recall value clears the floor.
  await writeHumanReview(db, {
    claimId,
    byRole: 'human:editor',
    verdict: { humanReview: 1, action: 'approve' },
  })
  // draft → active (the only way a claim becomes recallable). Promote via a human role (humans may approve, S13).
  await transitionClaim(db, claimId, 'active', { by: 'human:test', entailmentPass: true })
  return claimId
}

/** Answer the first two golden items with self-authored claims (above-floor, fresh). */
async function answerTwoGolden(): Promise<void> {
  await selfAuthor(L3_GOLDEN[0]!.expectedClaimTexts[0]!)
  await selfAuthor(L3_GOLDEN[1]!.expectedClaimTexts[0]!)
}

describe('S30 L3 system dimensions (substrate-ready 7) — append-only events through the Consumer SPI', () => {
  it('the 7 dimension labels are exactly the substrate-ready set (no longitudinal, no downstream A/B)', () => {
    expect(DIMENSION_NAMES.length).toBe(7)
    expect(new Set(DIMENSION_NAMES)).toEqual(
      new Set([
        'precision_at_k',
        'recall_at_k',
        'grounding',
        'ece',
        'coverage',
        'staleness',
        'immunity',
      ]),
    )
    // the longitudinal dim is DELIBERATELY relocated to S31 (its producer is the recompete there)
    expect(RELOCATED_TO_S31.dimension).toBe('longitudinal_better_with_use')
    expect(DIMENSION_NAMES).not.toContain('longitudinal_better_with_use')
    expect(DIMENSION_NAMES).not.toContain('downstream_ab')
  })

  it('golden is an isolated frozen namespace, scored but NEVER written as a claim — recall cannot surface it', async () => {
    expect(L3_GOLDEN_NAMESPACE).toBe('eval:l3-golden')
    expect(Object.isFrozen(L3_GOLDEN)).toBe(true)
    expect(L3_GOLDEN.every((g) => Object.isFrozen(g))).toBe(true)
    expect(new Set(L3_GOLDEN.map((g) => g.id)).size).toBe(L3_GOLDEN.length)

    // running the whole scored suite on an EMPTY KB must never insert a claim (golden firewalled from store)
    await runSystemDimensions(db, embedder, 'run-empty')
    const claimRows = (
      await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM claim')
    ).rows
    expect(claimRows[0]!.count).toBe('0')

    // and querying a golden's own answer text returns nothing (the golden answer is not in the store)
    for (const g of L3_GOLDEN) {
      const hits = await recallClaims(db, embedder, g.expectedClaimTexts[0]!)
      expect(hits).toHaveLength(0) // empty KB: the golden answer is NOT recallable from the golden itself
    }
  })

  it('eval==consumption: golden is answered ONLY by self-authored claims via recall_claims (no eval-only path)', async () => {
    // fresh KB: nothing answerable
    const before = await computeSystemDimensions(db, embedder)
    expect(before.coverage).toBe(0)
    expect(before.recallAtK).toBe(0)

    // KB grows its OWN claim (real append SPI). Now the golden can be answered — but only via real recall.
    await answerTwoGolden()
    const after = await computeSystemDimensions(db, embedder)
    expect(after.coverage).toBe(2 / L3_GOLDEN.length) // 2 of 4 answered
    expect(after.recallAtK).toBeGreaterThan(before.recallAtK)
    expect(after.precisionAtK).toBeGreaterThan(0)
  })

  it('P@k / R@k rise as the KB self-authors the expected claims (computed through real recall)', async () => {
    await answerTwoGolden()
    const two = await computeSystemDimensions(db, embedder)
    await selfAuthor(L3_GOLDEN[2]!.expectedClaimTexts[0]!)
    await selfAuthor(L3_GOLDEN[3]!.expectedClaimTexts[0]!)
    const four = await computeSystemDimensions(db, embedder)
    expect(four.recallAtK).toBeGreaterThan(two.recallAtK)
    expect(four.coverage).toBe(1) // all 4 golden answered
    expect(four.recallAtK).toBe(1) // every expected text covered
    expect(four.precisionAtK).toBeGreaterThan(0)
    expect(four.precisionAtK).toBeLessThanOrEqual(1)
  })

  it('grounding counts ONLY claims that drill back to provenance (a no-provenance claim is not counted)', async () => {
    await answerTwoGolden()
    const dims = await computeSystemDimensions(db, embedder)
    // every recalled claim went through D1 (append forces provenance) ⇒ grounding == 1
    expect(dims.diagnostics.recalledClaimCount).toBeGreaterThanOrEqual(2)
    expect(dims.diagnostics.groundedClaimCount).toBe(dims.diagnostics.recalledClaimCount)
    expect(dims.grounding).toBe(1)

    // inject an active, above-floor, query-addressable claim with ZERO provenance directly (bypassing append):
    // recall drops it (D1 兜底) ⇒ it is structurally NOT counted toward grounding, and recalledClaimCount is unchanged.
    const qVec = await embedder.embed(L3_GOLDEN[2]!.query, 'query')
    await db.insert(claim).values({
      id: randomUUID(),
      claimText: L3_GOLDEN[2]!.expectedClaimTexts[0]!,
      status: 'active',
      confidence: 0.9,
      confidenceRaw: 0.9,
      confidenceFactors: {
        factors: {
          authority: 0.9,
          humanReview: 0.9,
          entailment: 0.9,
          indepSupport: 0.9,
          usageCorrect: 0.9,
          ageDays: 0,
          activeContradicts: 0,
          staleDecay: 1,
          conflictDecay: 1,
        },
        weights: DEFAULT_WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      lineageId: randomUUID(),
      asOf: new Date(),
      createdBy: 'test:no-prov',
      embedding: qVec,
      embeddingVersion: embedder.version,
    })
    const after = await computeSystemDimensions(db, embedder)
    // the no-provenance claim never surfaces in recall ⇒ recalledClaimCount unchanged, grounding still 1
    expect(after.diagnostics.recalledClaimCount).toBe(dims.diagnostics.recalledClaimCount)
    expect(after.grounding).toBe(1)
    // direct recall of its query confirms D1 drop (the answer is in the store but not grounded ⇒ not recalled)
    expect(await recallClaims(db, embedder, L3_GOLDEN[2]!.query)).toHaveLength(0)
  })

  it('ECE dimension draws from the S5/S28 calibration substrate (usage truths), not ad-hoc logic', async () => {
    const claimId = await selfAuthor(L3_GOLDEN[0]!.expectedClaimTexts[0]!)
    // recall to get a real snapshot value, then report usage truths carrying predictedConfidence (S5 fuel).
    const [hit] = await recallClaims(db, embedder, L3_GOLDEN[0]!.query)
    expect(hit).toBeTruthy()
    const predicted = hit!.confidence.value
    // a deliberately mis-calibrated pair: high predicted but the consumption was refuted ⇒ non-zero ECE.
    await reportUsage(db, claimId, 'refuted', {
      byRole: 'consumer:test',
      confidenceAtRecall: predicted,
      calibrationVersion: hit!.confidence.calibrationVersion,
    })
    const dims = await computeSystemDimensions(db, embedder)
    expect(dims.diagnostics.ece.sampleCount).toBe(1) // the usage truth flowed into ECE
    expect(dims.ece).toBeGreaterThan(0) // high-confidence-but-wrong ⇒ calibration error
    expect(dims.ece).toBeLessThanOrEqual(1)
  })

  it('immunity dimension is drawn from S29 redteam_immunity_scores (detection rate), NOT recomputed', async () => {
    // no scores yet ⇒ immunity is null (not measured), distinct from 0
    const none = await computeSystemDimensions(db, embedder)
    expect(none.immunity).toBeNull()

    // seed an S29 frozen generation + immunity scores (the real substrate)
    await freezeRedTeamGeneration(db, {
      version: 'rt-test',
      items: [
        {
          id: 'i1',
          redteamClass: 'false',
          claimText: 'x',
          evidence: 'y',
          sourceKind: 'external_feed',
        },
      ],
      reason: 'test',
    })
    await recordImmunityScore(db, {
      generationVersion: 'rt-test',
      redteamClass: 'false',
      injected: 10,
      detected: 7,
    })
    await recordImmunityScore(db, {
      generationVersion: 'rt-test',
      redteamClass: 'contradiction',
      injected: 10,
      detected: 9,
    })
    const dims = await computeSystemDimensions(db, embedder)
    expect(dims.immunity).toBeCloseTo(16 / 20, 10) // (7+9)/(10+10) — aggregated detection rate from the substrate
    expect(dims.diagnostics.immunity).toEqual({ scoreRows: 2, injected: 20, detected: 16 })
  })

  it('A3: the immunity dimension is reported only — its value never enters ECE/calibration', async () => {
    // seed perfect immunity AND a non-zero ECE; immunity must not contaminate ECE.
    await freezeRedTeamGeneration(db, {
      version: 'rt-a3',
      items: [
        {
          id: 'i1',
          redteamClass: 'false',
          claimText: 'x',
          evidence: 'y',
          sourceKind: 'external_feed',
        },
      ],
      reason: 'test',
    })
    await recordImmunityScore(db, {
      generationVersion: 'rt-a3',
      redteamClass: 'false',
      injected: 5,
      detected: 5,
    })
    const claimId = await selfAuthor(L3_GOLDEN[0]!.expectedClaimTexts[0]!)
    const [hit] = await recallClaims(db, embedder, L3_GOLDEN[0]!.query)
    await reportUsage(db, claimId, 'refuted', {
      byRole: 'consumer:test',
      confidenceAtRecall: hit!.confidence.value,
    })
    const dims = await computeSystemDimensions(db, embedder)
    expect(dims.immunity).toBe(1) // perfect detection
    expect(dims.ece).toBeGreaterThan(0) // ECE reflects usage truth ONLY — perfect immunity didn't push it to 0
  })

  it('persists as append-only dimension_events: one row per measured dimension, value in [0,1]', async () => {
    await answerTwoGolden()
    const report = await runSystemDimensions(db, embedder, 'run-1')
    // no immunity scores ⇒ 6 rows (immunity not measured ⇒ not recorded, not faked as 0)
    expect(report.dimensions.immunity).toBeNull()
    expect(report.events).toHaveLength(6)
    const rows = await getDimensionEvents(db, { runId: 'run-1' })
    expect(rows).toHaveLength(6)
    expect(rows.map((r) => r.dimension)).not.toContain('immunity')
    for (const r of rows) {
      expect(r.value).toBeGreaterThanOrEqual(0)
      expect(r.value).toBeLessThanOrEqual(1)
      expect(r.runId).toBe('run-1')
    }
  })

  it('idempotent offline rollup: re-aggregating the SAME event log yields the SAME dimension values', async () => {
    await answerTwoGolden()
    await runSystemDimensions(db, embedder, 'run-X')
    const agg1 = await aggregateLatest(db, { runId: 'run-X' })
    const agg2 = await aggregateLatest(db, { runId: 'run-X' })
    const agg3 = await aggregateLatest(db, { runId: 'run-X' })
    expect(agg1).toEqual(agg2)
    expect(agg2).toEqual(agg3)
    // and the aggregate matches what the run recorded (rollup reads events, never re-recalls)
    const report = await runSystemDimensions(db, embedder, 'run-X2')
    const aggX2 = await aggregateLatest(db, { runId: 'run-X2' })
    expect(aggX2.precision_at_k).toBe(report.dimensions.precisionAtK)
    expect(aggX2.coverage).toBe(report.dimensions.coverage)
  })

  it('raw events are never mutated: a second run appends a new batch, the first run rows are unchanged', async () => {
    await answerTwoGolden()
    const r1 = await runSystemDimensions(db, embedder, 'run-A')
    const firstRows = await getDimensionEvents(db, { runId: 'run-A' })
    // grow the KB then run again under a different runId
    await selfAuthor(L3_GOLDEN[2]!.expectedClaimTexts[0]!)
    const r2 = await runSystemDimensions(db, embedder, 'run-B')
    const firstRowsAgain = await getDimensionEvents(db, { runId: 'run-A' })
    expect(firstRowsAgain).toEqual(firstRows) // run-A rows immutable
    expect(r2.dimensions.coverage).toBeGreaterThan(r1.dimensions.coverage) // run-B sees the new claim
  })

  it('ECE-down / coverage-up time-series are DRAWABLE: getDimensionSeries reads the value series over runs', async () => {
    // run 0: nothing answered ⇒ coverage 0
    await runSystemDimensions(db, embedder, 'r0')
    // run 1: 2 answered ⇒ coverage 0.5
    await answerTwoGolden()
    await runSystemDimensions(db, embedder, 'r1')
    // run 2: all 4 answered ⇒ coverage 1
    await selfAuthor(L3_GOLDEN[2]!.expectedClaimTexts[0]!)
    await selfAuthor(L3_GOLDEN[3]!.expectedClaimTexts[0]!)
    await runSystemDimensions(db, embedder, 'r2')

    const coverageSeries = await getDimensionSeries(db, DIMENSION.coverage)
    expect(coverageSeries.map((p) => p.runId)).toEqual(['r0', 'r1', 'r2'])
    const values = coverageSeries.map((p) => p.value)
    expect(values).toEqual([0, 0.5, 1]) // coverage-up curve is readable straight off the series
    // monotone non-decreasing in time (the "better-with-use" read, here for coverage)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!)
    }
  })

  it('staleness: a recalled claim past its kind half-life is counted; a fresh one is not', async () => {
    // fresh structured_spec answer ⇒ staleDecay 1 ⇒ not stale
    await selfAuthor(L3_GOLDEN[0]!.expectedClaimTexts[0]!)
    const fresh = await computeSystemDimensions(db, embedder)
    expect(fresh.staleness).toBe(0)
    expect(fresh.diagnostics.staleClaimCount).toBe(0)

    // a SECOND recallable answer whose STORED staleDecay is past the half-life (0.45 < 0.5) but whose high base
    // keeps the live-recomputed value above the 0.4 floor (so recall still surfaces it). recall reports the
    // stored staleDecay in the snapshot ⇒ this claim is counted stale.
    const qVec = await embedder.embed(L3_GOLDEN[1]!.query, 'query')
    const staleId = randomUUID()
    await db.insert(claim).values({
      id: staleId,
      claimText: L3_GOLDEN[1]!.expectedClaimTexts[0]!,
      status: 'active',
      confidence: 0.5,
      confidenceRaw: 0.5,
      confidenceFactors: {
        factors: {
          authority: 1,
          humanReview: 1,
          entailment: 1,
          indepSupport: 1,
          usageCorrect: 1,
          ageDays: 200,
          activeContradicts: 0,
          staleDecay: 0.45, // past half-life ⇒ counted stale; base ≈ 1 ⇒ value ≈ 0.45 ≥ 0.4 ⇒ still recalled
          conflictDecay: 1,
        },
        weights: DEFAULT_WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      lineageId: randomUUID(),
      asOf: new Date(Date.now() - 200 * 86_400_000),
      createdBy: 'test:stale',
      embedding: qVec,
      embeddingVersion: embedder.version,
    })
    const src = await addSource(db, {
      content: 'b',
      contentHash: randomUUID(),
      kind: 'external_feed',
      authorityScore: 0.9,
    })
    await db.insert(claimProvenance).values({
      id: randomUUID(),
      claimId: staleId,
      sourceId: src.sourceId,
      locator: 'p1',
      relevance: 'exact',
    })

    // confirm it is recalled (above floor) AND reported stale
    const hit = await recallClaims(db, embedder, L3_GOLDEN[1]!.query)
    expect(hit.some((h) => h.claim.id === staleId)).toBe(true)
    expect(hit.find((h) => h.claim.id === staleId)!.confidence.factors.staleDecay).toBeLessThan(0.5)

    const mixed = await computeSystemDimensions(db, embedder)
    expect(mixed.diagnostics.staleClaimCount).toBeGreaterThanOrEqual(1)
    expect(mixed.staleness).toBeGreaterThan(0)
  })

  it('recordDimension rejects out-of-range values and empty runId (bad readings cannot pollute the series)', async () => {
    await expect(
      recordDimension(db, { runId: 'r', dimension: DIMENSION.ece, value: 1.5 }),
    ).rejects.toThrow(/must be in \[0,1\]/)
    await expect(
      recordDimension(db, { runId: 'r', dimension: DIMENSION.ece, value: Number.NaN }),
    ).rejects.toThrow(/must be in \[0,1\]/)
    await expect(
      recordDimension(db, { runId: '  ', dimension: DIMENSION.ece, value: 0.5 }),
    ).rejects.toThrow(/non-empty/)
  })

  it('runGoldenItem only calls recall_claims (no write): scoring an empty KB writes zero claims', async () => {
    const obs = await runGoldenItem(db, embedder, L3_GOLDEN[0]!, 5)
    expect(obs.answered).toBe(false)
    expect(obs.recalled).toHaveLength(0)
    const claimRows = (
      await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM claim')
    ).rows
    expect(claimRows[0]!.count).toBe('0')
  })
})
