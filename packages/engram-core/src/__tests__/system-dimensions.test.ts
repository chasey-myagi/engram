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
import { agentActor, trustedHumanActor } from '../spi/actor.js'
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
    actor: trustedHumanActor('human:editor'),
    verdict: { humanReview: 1, action: 'approve' },
  })
  // draft → active (the only way a claim becomes recallable). Promote via a human role (humans may approve, S13).
  await transitionClaim(db, claimId, 'active', {
    actor: trustedHumanActor('human:test'),
    entailmentPass: true,
  })
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

  it('P@k pinned to an EXACT value: a golden recalling 1 relevant + 1 irrelevant-but-above-floor claim → precisionAtK === 1/2 (denominator counts retrieved-not-relevant, numerator counts only text hits)', async () => {
    // 钉死 P@k 的分子/分母语义（gate#1 test-review：此前只断言 >0 && <=1，换分母也照样绿）。
    // 造一道定制 golden：query 同时召回「相关」(命中 expected 子串) + 「不相关但过门」(高 trigram 重叠、不含 expected) 各一条。
    const relevant = 'precision pinned relevant claim alpha'
    const distractor = 'precision pinned relevant claim beta' // 与 query 高度重叠 → 被召回；不含 expected → 不相关
    const query = 'precision pinned relevant claim'
    await selfAuthor(relevant)
    await selfAuthor(distractor)
    // sanity：两条都过相似度+消费门、确实都被召回（否则下面的 1/2 是假的）。
    const hits = await recallClaims(db, embedder, query, { minSimilarity: 0.4 })
    expect(hits.length).toBe(2)

    const golden = [{ id: 'p-exact', query, expectedClaimTexts: [relevant] }] as const
    const dims = await computeSystemDimensions(db, embedder, { golden, k: 5 })
    expect(dims.precisionAtK).toBe(1 / 2) // 召回 2、相关 1 → 1/2（分母数检索到的、分子只数命中 expected 的）
    expect(dims.recallAtK).toBe(1) // 期望集 {relevant} 被覆盖
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
    // EGR-CR-029: diagnostics record the g version(s) the reading was taken over (active = identity here)
    // so sampleCount is interpretable and any cross-version pooling is never silent.
    expect(dims.diagnostics.ece.fromVersions).toEqual(['identity'])
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
    // false and contradiction are DISTINCT (generation, class) keys, each with a single row, so
    // latest-per-key leaves both in the pool: (7+9)/(10+10). Result unchanged under the new caliber.
    expect(dims.immunity).toBeCloseTo(16 / 20, 10) // (7+9)/(10+10) — aggregated detection rate from the substrate
    // scoreRows = number of (generation, class) keys that fed the aggregate (= 2 here); no stale rows discarded.
    expect(dims.diagnostics.immunity).toEqual({
      scoreRows: 2,
      injected: 20,
      detected: 16,
      discardedStaleRows: 0,
    })
  })

  it('EGR-CR-052: rescoring the SAME (generation, class) takes ONLY the latest row — stale rows do not dilute immunity', async () => {
    await freezeRedTeamGeneration(db, {
      version: 'rt-rescore',
      items: [
        {
          id: 'i1',
          redteamClass: 'false',
          claimText: 'x',
          evidence: 'y',
          sourceKind: 'external_feed',
        },
      ],
      reason: 'rescore test',
    })
    // same (generation, class): first 10/10, then a fix-regression re-score back to 0/10 (latest = current state)
    await recordImmunityScore(db, {
      generationVersion: 'rt-rescore',
      redteamClass: 'false',
      injected: 10,
      detected: 10,
    })
    await recordImmunityScore(db, {
      generationVersion: 'rt-rescore',
      redteamClass: 'false',
      injected: 10,
      detected: 0,
    })
    const dims = await computeSystemDimensions(db, embedder, { immunityGeneration: 'rt-rescore' })
    // reflects the LATEST 0/10, NOT the historical mean (10+0)/(10+10) = 0.5
    expect(dims.immunity).toBeCloseTo(0, 10)
    // diagnostics count ONLY the latest row (injected:10, not 20), and report the discarded stale row.
    expect(dims.diagnostics.immunity).toMatchObject({ injected: 10, detected: 0 })
    expect(dims.diagnostics.immunity!.scoreRows).toBe(1) // one participating (generation, class) key
    expect(dims.diagnostics.immunity!.discardedStaleRows).toBe(1) // one older re-score row dropped
  })

  it('EGR-CR-052: the reverse case (bad → good) is not under-counted — latest 10/10 reads as 1, not the 0.5 mean', async () => {
    await freezeRedTeamGeneration(db, {
      version: 'rt-fixed',
      items: [
        {
          id: 'i1',
          redteamClass: 'false',
          claimText: 'x',
          evidence: 'y',
          sourceKind: 'external_feed',
        },
      ],
      reason: 'fix-then-rescore test',
    })
    // same (generation, class): first 0/10 (broken), then a fix re-score to 10/10 (latest = current state)
    await recordImmunityScore(db, {
      generationVersion: 'rt-fixed',
      redteamClass: 'false',
      injected: 10,
      detected: 0,
    })
    await recordImmunityScore(db, {
      generationVersion: 'rt-fixed',
      redteamClass: 'false',
      injected: 10,
      detected: 10,
    })
    const dims = await computeSystemDimensions(db, embedder, { immunityGeneration: 'rt-fixed' })
    // reflects the LATEST 10/10 = 1, NOT the historical mean (0+10)/(10+10) = 0.5
    expect(dims.immunity).toBeCloseTo(1, 10)
    expect(dims.diagnostics.immunity).toMatchObject({
      injected: 10,
      detected: 10,
      discardedStaleRows: 1,
    })
  })

  it('EGR-CR-052: latest is taken PER (generation, class) key, not one-row-for-the-whole-table', async () => {
    // The frozen items list is FK'd only by generationVersion — immunity scores reference the generation,
    // not individual item classes (cf. the existing test at :270 records a contradiction score against a
    // generation that only froze a single `false` item). So a single valid `false` item suffices here.
    await freezeRedTeamGeneration(db, {
      version: 'rt-multi',
      items: [
        {
          id: 'i1',
          redteamClass: 'false',
          claimText: 'x',
          evidence: 'y',
          sourceKind: 'external_feed',
        },
      ],
      reason: 'multi-class latest-per-key test',
    })
    // false rescored twice (10/10 then 0/10); contradiction scored once (9/10)
    await recordImmunityScore(db, {
      generationVersion: 'rt-multi',
      redteamClass: 'false',
      injected: 10,
      detected: 10,
    })
    await recordImmunityScore(db, {
      generationVersion: 'rt-multi',
      redteamClass: 'false',
      injected: 10,
      detected: 0,
    })
    await recordImmunityScore(db, {
      generationVersion: 'rt-multi',
      redteamClass: 'contradiction',
      injected: 10,
      detected: 9,
    })
    const dims = await computeSystemDimensions(db, embedder, { immunityGeneration: 'rt-multi' })
    // per-key latest sum: (latest false 0 + contradiction 9) / (10 + 10) = 9/20.
    // NOT whole-table-last-row (would drop contradiction), NOT full-history-sum (would be (10+0+9)/30 = 19/30).
    expect(dims.immunity).toBeCloseTo(9 / 20, 10)
    expect(dims.diagnostics.immunity).toMatchObject({
      scoreRows: 2, // two participating keys: false + contradiction
      injected: 20,
      detected: 9,
      discardedStaleRows: 1, // the older false 10/10 row
    })
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
    // 上界、NaN、下界(负)、+Infinity 全拒（[0,1] guard 最常见的 bug 是下界/<= off-by-one）。
    for (const bad of [1.5, Number.NaN, -0.1, Number.POSITIVE_INFINITY]) {
      await expect(
        recordDimension(db, { runId: 'r', dimension: DIMENSION.ece, value: bad }),
      ).rejects.toThrow(/must be in \[0,1\]/)
    }
    await expect(
      recordDimension(db, { runId: '  ', dimension: DIMENSION.ece, value: 0.5 }),
    ).rejects.toThrow(/non-empty/)
    // 闭区间端点 0 与 1 必须**被接受**（证明是 >=/<= 而非 >/<）。
    await expect(
      recordDimension(db, { runId: 'bound', dimension: DIMENSION.ece, value: 0 }),
    ).resolves.toBeDefined()
    await expect(
      recordDimension(db, { runId: 'bound', dimension: DIMENSION.coverage, value: 1 }),
    ).resolves.toBeDefined()
  })

  // EGR-CR-053 (#128): recordDimension() 须 runtime 拒非白名单 dimension，读侧不强转未知标签。
  it('recordDimension rejects non-whitelisted dimensions (A3: elo/win_rate/reward barred from the eval spine)', async () => {
    for (const bad of ['elo', 'win_rate', 'reward', 'downstream_ab', '']) {
      await expect(
        recordDimension(db, { runId: 'r', dimension: bad as never, value: 0.5 }),
      ).rejects.toThrow(/dimension must be one of/)
    }
    // 白名单端点仍被接受（证明守卫不误杀合法维度）。
    for (const ok of DIMENSION_NAMES) {
      await expect(
        recordDimension(db, { runId: 'ok', dimension: ok, value: 0.5 }),
      ).resolves.toBeDefined()
    }
  })

  it('rejected dimension writes no row to dimension_events (fail-loud, not half-batch)', async () => {
    await expect(
      recordDimension(db, { runId: 'r2', dimension: 'elo' as never, value: 0.5 }),
    ).rejects.toThrow(/dimension must be one of/)
    const series = await getDimensionSeries(db, DIMENSION.ece)
    const rows = (
      await pool.query<{ c: string }>('SELECT count(*)::text AS c FROM dimension_events')
    ).rows
    expect(rows[0]!.c).toBe('0') // 校验在 insert 之前，零行落库
    expect(series).toHaveLength(0)
  })

  it('aggregateLatest fails loud on a non-whitelisted dimension already in the table (no blind cast)', async () => {
    // 绕过 recordDimension 直接 DB 写，模拟历史脏行或外部直写。
    await pool.query(
      `INSERT INTO dimension_events (id, run_id, dimension, value, payload, created_by, created_at)
       VALUES ($1, 'dirty', 'reward', 0.9, '{}'::jsonb, 'test', now())`,
      [randomUUID()],
    )
    await expect(aggregateLatest(db, { runId: 'dirty' })).rejects.toThrow(
      /non-whitelisted dimension/,
    )
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

  // ── EGR-CR-054 (#129): computeSystemDimensions 入口须 fail-loud 拒非正/非整数 k ──
  // 根因两层区分：本组测的是**入口 k 守卫**（`k must be a positive integer`），与上面 453-462
  // 的**下游 [0,1] 守卫**（`must be in [0,1]`）是两层，不可互相替代。非法 k 必须在任何 recall /
  // 计算 / 落库发生前抛出，从根上消除「recall 静默回退 50 ↔ P@k 分母用原始 k」的脑裂与半批写入。
  it('rejects non-positive / non-integer k at the entry (k=0/-1/0.5/NaN all fail-loud)', async () => {
    // 任意合法 golden（最小夹具即可触发入口校验，无需真 DB 命中）。
    const golden = [{ id: 'kguard', query: 'anything', expectedClaimTexts: ['x'] }] as const
    for (const badK of [0, -1, 0.5, Number.NaN]) {
      await expect(computeSystemDimensions(db, embedder, { golden, k: badK })).rejects.toThrow(
        /k must be a positive integer/,
      )
    }
  })

  it('does NOT misfire on the smallest legal k=1 nor the default path (guard is k<=0, not k<1; no off-by-one)', async () => {
    const golden = [{ id: 'kguard', query: 'anything', expectedClaimTexts: ['x'] }] as const
    // k=1 是最小合法正整数 → 必须正常返回（证明守卫是 `k <= 0` 而非误写成 `k < 1`）。
    await expect(computeSystemDimensions(db, embedder, { golden, k: 1 })).resolves.toBeDefined()
    // 默认路径（不传 k → DEFAULT_K=5）不受影响。
    await expect(computeSystemDimensions(db, embedder, { golden })).resolves.toBeDefined()
  })

  it('illegal k writes ZERO dimension_events rows (fail-loud before any record, not half-batch)', async () => {
    // k=0 是最危险支：下游 [0,1] 守卫拦不住（precision 被算成合法的 0），未修前会把 6 个维度静默落库。
    const runId = 'egr-cr-054-no-half-batch'
    await expect(runSystemDimensions(db, embedder, runId, { k: 0 })).rejects.toThrow(
      /k must be a positive integer/,
    )
    const rows = await getDimensionEvents(db, { runId })
    expect(rows).toHaveLength(0) // 半批也不允许：入口抛出在任何 recordDimension 之前
  })
})
