import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { trustedHumanActor } from '../spi/actor.js'
import { computeCalibrationFromUsage, DEFAULT_BIN_COUNT } from '../calibration/calibration.js'
import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource, appendClaim } from '../spi/append-claim.js'
import { writeHumanReview } from '../editor/human-review.js'
import { transitionClaim } from '../spi/transition.js'
import { reportUsage } from '../spi/report-usage.js'
import { recallClaims } from '../spi/recall-claims.js'
import { L3_GOLDEN } from '../eval/system-dimensions.js'
import { DIMENSION } from '../spi/dimension-events.js'
import {
  FROZEN_GOLDEN_VERSION,
  RECOMPETE_DIMENSIONS,
  RING,
  getRecompeteEvents,
  getRecompeteSeries,
  recordRecompete,
  runRecompeteSnapshot,
} from '../eval/longitudinal-recompete.js'

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
    'TRUNCATE source, claim, claim_provenance, claim_verification, relation, recompete_events CASCADE',
  )
})

/** Self-author a claim through the REAL write SPI so the golden becomes answerable via recall (S30 pattern). */
async function selfAuthor(claimText: string): Promise<string> {
  const src = await addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.95,
  })
  const { claimId } = await appendClaim(db, embedder, { claimText, createdBy: 'agent:self' }, [
    { sourceId: src.sourceId, locator: 'p1', relevance: 'exact' },
  ])
  await writeHumanReview(db, {
    claimId,
    actor: trustedHumanActor('human:editor'),
    verdict: { humanReview: 1, action: 'approve' },
  })
  await transitionClaim(db, claimId, 'active', {
    actor: trustedHumanActor('human:test'),
    entailmentPass: true,
  })
  return claimId
}

/** Seed a non-zero ECE: a high-confidence recall that was refuted (S5/S28 calibration fuel). */
async function seedMiscalibration(claimText: string, query: string): Promise<void> {
  const claimId = await selfAuthor(claimText)
  const [hit] = await recallClaims(db, embedder, query)
  if (!hit) return
  await reportUsage(db, claimId, 'refuted', {
    byRole: 'consumer:test',
    confidenceAtRecall: hit.confidence.value,
    calibrationVersion: hit.confidence.calibrationVersion,
  })
}

describe('S31 longitudinal frozen-golden recompete — the 8th dimension (relocated from S30)', () => {
  it('uses the SAME S30 dimension definitions (ece/coverage) — the recompete whitelist IS the S30 DIMENSION labels', () => {
    expect(new Set(RECOMPETE_DIMENSIONS)).toEqual(new Set([DIMENSION.ece, DIMENSION.coverage]))
    // and the three rings exist (inner/mid/outer)
    expect(new Set(Object.values(RING))).toEqual(new Set(['inner', 'mid', 'outer']))
  })

  it('two release snapshots on a FROZEN golden → a delta is appended; the prior snapshot rows are UNCHANGED (append-only)', async () => {
    // T0: empty KB ⇒ coverage 0
    const t0 = await runRecompeteSnapshot(db, embedder, 'T0')
    const t0cov = t0.results.find((r) => r.dimension === DIMENSION.coverage)!
    expect(t0cov.value).toBe(0)
    expect(t0cov.delta).toBeNull() // first snapshot = baseline, no prior to diff
    const t0RowsBefore = await getRecompeteEvents(db, { releaseSnapshot: 'T0' })

    // grow the KB so two golden answers are now recallable
    await selfAuthor(L3_GOLDEN[0]!.expectedClaimTexts[0]!)
    await selfAuthor(L3_GOLDEN[1]!.expectedClaimTexts[0]!)

    // T1: coverage rose ⇒ Δcoverage↑ appended
    const t1 = await runRecompeteSnapshot(db, embedder, 'T1')
    const t1cov = t1.results.find((r) => r.dimension === DIMENSION.coverage)!
    expect(t1cov.value).toBe(2 / L3_GOLDEN.length)
    expect(t1cov.delta).toBeGreaterThan(0) // coverage-up: curr - prev > 0

    // APPEND-ONLY: T0 rows are byte-for-byte unchanged (no retroactive mutation)
    const t0RowsAfter = await getRecompeteEvents(db, { releaseSnapshot: 'T0' })
    expect(t0RowsAfter).toEqual(t0RowsBefore)
  })

  it('EGR-CR-029 — recompete payload records the calibrationFromVersions actually used for its ECE reading', async () => {
    // With no calibration map committed, the active version is identity ⇒ the ECE reading is taken over ['identity'].
    // Every recompete row must carry that version set in its payload so the longitudinal curve is口径-traceable.
    const report = await runRecompeteSnapshot(db, embedder, 'rel-versioned')
    expect(report.results.length).toBe(RECOMPETE_DIMENSIONS.length)
    const rows = await getRecompeteEvents(db, { releaseSnapshot: 'rel-versioned' })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.payload.calibrationFromVersions).toEqual(['identity'])
    }
  })

  it('Δcoverage-up curve is DRAWABLE: getRecompeteSeries reads the value/delta series across releases', async () => {
    await runRecompeteSnapshot(db, embedder, 'T0') // coverage 0
    await selfAuthor(L3_GOLDEN[0]!.expectedClaimTexts[0]!)
    await selfAuthor(L3_GOLDEN[1]!.expectedClaimTexts[0]!)
    await runRecompeteSnapshot(db, embedder, 'T1') // coverage 0.5
    await selfAuthor(L3_GOLDEN[2]!.expectedClaimTexts[0]!)
    await selfAuthor(L3_GOLDEN[3]!.expectedClaimTexts[0]!)
    await runRecompeteSnapshot(db, embedder, 'T2') // coverage 1

    const series = await getRecompeteSeries(db, DIMENSION.coverage)
    expect(series.map((p) => p.releaseSnapshot)).toEqual(['T0', 'T1', 'T2'])
    expect(series.map((p) => p.value)).toEqual([0, 0.5, 1]) // value series straight off the curve
    expect(series.map((p) => p.delta)).toEqual([null, 0.5, 0.5]) // baseline, then Δ↑ each release
    // monotone non-decreasing value (the "better-with-use" read for coverage)
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!.value).toBeGreaterThanOrEqual(series[i - 1]!.value)
      expect(series[i]!.delta!).toBeGreaterThanOrEqual(0)
    }
  })

  it('ΔECE-down: as calibration improves across releases (DISTINCT identities), ECE drops and delta (prev−curr) is positive', async () => {
    // T0: a single high-confidence-but-refused usage ⇒ non-zero ECE
    await seedMiscalibration(L3_GOLDEN[0]!.expectedClaimTexts[0]!, L3_GOLDEN[0]!.query)
    const t0 = await runRecompeteSnapshot(db, embedder, 'T0')
    const t0ece = t0.results.find((r) => r.dimension === DIMENSION.ece)!
    expect(t0ece.value).toBeGreaterThan(0)
    expect(t0ece.delta).toBeNull()

    // T1: add many well-calibrated usages under DISTINCT (byRole, taskId) identities so the gated reader
    // actually admits them as separate samples ⇒ ECE drops vs T0. (Same-identity spam would NOT move it —
    // EGR-CR-027: the gate blocks spam, not real distinct-identity signal.)
    const claimId = await selfAuthor(L3_GOLDEN[1]!.expectedClaimTexts[0]!)
    const [hit] = await recallClaims(db, embedder, L3_GOLDEN[1]!.query)
    for (let i = 0; i < 10; i++) {
      // hit.confidence.value is a high recall confidence; adopted at high confidence is WELL-calibrated,
      // diluting the one mis-calibrated high-conf-refuted sample from T0 ⇒ ECE falls.
      await reportUsage(db, claimId, 'adopted', {
        byRole: `consumer:wc-${i}`,
        taskId: `task-${i}`,
        confidenceAtRecall: hit!.confidence.value,
        calibrationVersion: hit!.confidence.calibrationVersion,
      })
    }
    const t1 = await runRecompeteSnapshot(db, embedder, 'T1')
    const t1ece = t1.results.find((r) => r.dimension === DIMENSION.ece)!
    // ECE dropped (more well-calibrated DISTINCT samples) ⇒ ΔECE-down delta (prev - curr) > 0
    expect(t1ece.value).toBeLessThan(t0ece.value)
    expect(t1ece.delta!).toBeGreaterThan(0)
    expect(t1ece.delta!).toBeCloseTo(t0ece.value - t1ece.value, 10)
  })

  it('EGR-CR-027 — spamming the SAME (byRole, taskId) does NOT move gated ΔECE (no faked "better-with-use")', async () => {
    // T0: one high-confidence-but-refused usage ⇒ non-zero ECE baseline.
    await seedMiscalibration(L3_GOLDEN[0]!.expectedClaimTexts[0]!, L3_GOLDEN[0]!.query)
    const t0 = await runRecompeteSnapshot(db, embedder, 'T0')
    const t0ece = t0.results.find((r) => r.dimension === DIMENSION.ece)!
    expect(t0ece.value).toBeGreaterThan(0)

    // T1: a single consumer spams the SAME (byRole, taskId) 100× with well-calibrated adopted reports.
    // Under the OLD raw reader this would flood the diagram and drop ECE (faking "the system got better").
    const claimId = await selfAuthor(L3_GOLDEN[1]!.expectedClaimTexts[0]!)
    const [hit] = await recallClaims(db, embedder, L3_GOLDEN[1]!.query)
    for (let i = 0; i < 100; i++) {
      await reportUsage(db, claimId, 'adopted', {
        byRole: 'consumer:spam',
        taskId: 't-spam',
        confidenceAtRecall: hit!.confidence.value,
        calibrationVersion: hit!.confidence.calibrationVersion,
      })
    }
    const t1 = await runRecompeteSnapshot(db, embedder, 'T1')
    const t1ece = t1.results.find((r) => r.dimension === DIMENSION.ece)!
    // The 100 spam rows fold to ONE gated sample ⇒ ECE moves only by that single legitimate vote, not by spam volume.
    // Assert the spam cannot be used to manufacture a downward ΔECE far beyond a single sample's effect.
    // Concretely: with T0 having 1 sample and T1 adding exactly 1 gated sample, ECE shifts to the 2-sample value,
    // NOT toward 0 as 100 raw rows would force. We pin the gated outcome: ECE stays > 0 and the drop is bounded.
    expect(t1ece.value).toBeGreaterThan(0) // a single extra well-calibrated vote can't zero out the error

    // Direct proof the gate folded the spam: the raw reader sees 101 rows, the gated reader sees 2.
    const gated = await computeCalibrationFromUsage(db)
    const raw = await computeCalibrationFromUsage(db, DEFAULT_BIN_COUNT, 'raw-events')
    expect(gated.sampleCount).toBe(2) // T0's 1 refuted + T1's folded-to-1 spam identity
    expect(raw.sampleCount).toBe(101) // 1 + 100 spam rows actually written
  })

  it('cross-release comparability: the SAME frozen golden version anchors the series (same questions across releases)', async () => {
    await runRecompeteSnapshot(db, embedder, 'T0')
    await runRecompeteSnapshot(db, embedder, 'T1')
    const rows = await getRecompeteEvents(db)
    // all rows share the one frozen golden version ⇒ same questions ⇒ comparable across releases
    expect(new Set(rows.map((r) => r.frozenGoldenVersion))).toEqual(
      new Set([FROZEN_GOLDEN_VERSION]),
    )
  })

  it('ring distinction: inner (live g) / mid (refit g) / outer (recompete) are recorded distinctly under the same definitions', async () => {
    await selfAuthor(L3_GOLDEN[0]!.expectedClaimTexts[0]!)
    // outer ring = the default frozen-golden recompete (longitudinal load-bearing)
    const outer = await runRecompeteSnapshot(db, embedder, 'rel', { ring: RING.outer })
    expect(outer.ring).toBe('outer')
    // inner & mid rings reuse the SAME function + SAME golden + SAME dimension defs, only the ring label differs
    const inner = await runRecompeteSnapshot(db, embedder, 'rel', { ring: RING.inner })
    const mid = await runRecompeteSnapshot(db, embedder, 'rel', { ring: RING.mid })
    expect(inner.ring).toBe('inner')
    expect(mid.ring).toBe('mid')
    // the series can be filtered per ring (draw outer-only longitudinal, or overlay all three)
    const outerCov = await getRecompeteSeries(db, DIMENSION.coverage, { ring: RING.outer })
    expect(outerCov.every((p) => p.ring === 'outer')).toBe(true)
    const allCov = await getRecompeteSeries(db, DIMENSION.coverage)
    expect(new Set(allCov.map((p) => p.ring))).toEqual(new Set(['inner', 'mid', 'outer']))
  })

  // EGR-CR-028 — write-side prior-value lookup must be ring-isolated: outer's longitudinal delta
  // must reference the previous OUTER reading, never an intervening mid/inner reading. Regression
  // for "outer T0 -> mid T0 -> outer T1, outer delta only references the prior outer value".

  it('EGR-CR-028 — outer delta is ring-isolated: an intervening mid reading does NOT become outer T1 prev', async () => {
    // A1) seed a non-zero ECE baseline so the ece reading is meaningful, and one answerable golden so
    //     coverage is non-zero (sown via the path proven in the 'ring distinction' test).
    await seedMiscalibration(L3_GOLDEN[0]!.expectedClaimTexts[0]!, L3_GOLDEN[0]!.query)
    const outer0 = await runRecompeteSnapshot(db, embedder, 'T0', { ring: RING.outer })
    const outer0Cov = outer0.results.find((r) => r.dimension === DIMENSION.coverage)!
    const outer0Ece = outer0.results.find((r) => r.dimension === DIMENSION.ece)!

    // A2) INTERLEAVE a mid snapshot whose value is DISTINCT from outer0: grow the KB (more coverage)
    //     and add well-calibrated distinct usages (lowers ECE) so BOTH dims move before the mid read.
    const claimId = await selfAuthor(L3_GOLDEN[1]!.expectedClaimTexts[0]!)
    const [hit] = await recallClaims(db, embedder, L3_GOLDEN[1]!.query)
    for (let i = 0; i < 10; i++) {
      await reportUsage(db, claimId, 'adopted', {
        byRole: `consumer:mid-${i}`,
        taskId: `mid-task-${i}`,
        confidenceAtRecall: hit!.confidence.value,
        calibrationVersion: hit!.confidence.calibrationVersion,
      })
    }
    const mid = await runRecompeteSnapshot(db, embedder, 'T0', { ring: RING.mid })
    const midCov = mid.results.find((r) => r.dimension === DIMENSION.coverage)!
    const midEce = mid.results.find((r) => r.dimension === DIMENSION.ece)!
    // guard the construction: the mid reading must differ from outer0, else pollution is unobservable
    expect(midCov.value).not.toBe(outer0Cov.value)
    expect(midEce.value).not.toBe(outer0Ece.value)

    // A3) outer T1 — its prior must be outer0, NOT the intervening mid.
    const outer1 = await runRecompeteSnapshot(db, embedder, 'T1', { ring: RING.outer })
    const outer1Cov = outer1.results.find((r) => r.dimension === DIMENSION.coverage)!
    const outer1Ece = outer1.results.find((r) => r.dimension === DIMENSION.ece)!

    const t1Rows = await getRecompeteEvents(db, { releaseSnapshot: 'T1' })
    const outer1CovRow = t1Rows.find(
      (r) => r.dimension === DIMENSION.coverage && r.ring === 'outer',
    )!
    const outer1EceRow = t1Rows.find((r) => r.dimension === DIMENSION.ece && r.ring === 'outer')!

    // coverage (curr - prev): prev pinned to outer0, NOT the mid that landed in between
    expect(outer1CovRow.payload.prev).toBe(outer0Cov.value)
    expect(outer1CovRow.payload.prev).not.toBe(midCov.value)
    expect(outer1Cov.delta!).toBeCloseTo(outer1Cov.value - outer0Cov.value, 10)
    expect(outer1Cov.delta!).not.toBeCloseTo(outer1Cov.value - midCov.value, 10)

    // ece (prev - curr): same ring isolation
    expect(outer1EceRow.payload.prev).toBe(outer0Ece.value)
    expect(outer1EceRow.payload.prev).not.toBe(midEce.value)
    expect(outer1Ece.delta!).toBeCloseTo(outer0Ece.value - outer1Ece.value, 10)
    expect(outer1Ece.delta!).not.toBeCloseTo(midEce.value - outer1Ece.value, 10)
  })

  it('EGR-CR-028 — isolation is symmetric: mid delta references the prior MID value, not an intervening outer', async () => {
    // Sequence: mid T0 -> outer T0 (DISTINCT, lands LAST before mid T1) -> mid T1. The buggy unfiltered
    // lookup would grab the outer row (most-recent overall) as mid T1's prev; isolation must pick mid T0.
    await selfAuthor(L3_GOLDEN[0]!.expectedClaimTexts[0]!)
    const mid0 = await runRecompeteSnapshot(db, embedder, 'T0', { ring: RING.mid })
    const mid0Cov = mid0.results.find((r) => r.dimension === DIMENSION.coverage)!

    // grow the KB so the intervening outer reading is DISTINCT from mid T0
    await selfAuthor(L3_GOLDEN[1]!.expectedClaimTexts[0]!)
    const outer0 = await runRecompeteSnapshot(db, embedder, 'T0', { ring: RING.outer })
    const outer0Cov = outer0.results.find((r) => r.dimension === DIMENSION.coverage)!
    expect(outer0Cov.value).not.toBe(mid0Cov.value) // the polluting value differs ⇒ pollution is observable

    const mid1 = await runRecompeteSnapshot(db, embedder, 'T1', { ring: RING.mid })
    const mid1Cov = mid1.results.find((r) => r.dimension === DIMENSION.coverage)!

    const t1Rows = await getRecompeteEvents(db, { releaseSnapshot: 'T1' })
    const mid1CovRow = t1Rows.find((r) => r.dimension === DIMENSION.coverage && r.ring === 'mid')!
    // mid T1 prev must be mid T0, NOT the intervening outer T0
    expect(mid1CovRow.payload.prev).toBe(mid0Cov.value)
    expect(mid1CovRow.payload.prev).not.toBe(outer0Cov.value)
    expect(mid1Cov.delta!).toBeCloseTo(mid1Cov.value - mid0Cov.value, 10)
    expect(mid1Cov.delta!).not.toBeCloseTo(mid1Cov.value - outer0Cov.value, 10)
  })

  it('EGR-CR-028 — first snapshot of a ring stays a baseline (delta null) even when another ring already has rows', async () => {
    await selfAuthor(L3_GOLDEN[0]!.expectedClaimTexts[0]!)
    // a mid row lands FIRST (itself a baseline since it is the first mid row)...
    const mid0 = await runRecompeteSnapshot(db, embedder, 'T0', { ring: RING.mid })
    expect(mid0.results.find((r) => r.dimension === DIMENSION.coverage)!.delta).toBeNull()

    // ...then the FIRST outer snapshot — it has no prior OUTER row ⇒ baseline (delta null, prev null),
    // and must NOT pick up the pre-existing mid row as its prior.
    const outer0 = await runRecompeteSnapshot(db, embedder, 'T0', { ring: RING.outer })
    const outer0Cov = outer0.results.find((r) => r.dimension === DIMENSION.coverage)!
    const outer0Ece = outer0.results.find((r) => r.dimension === DIMENSION.ece)!
    expect(outer0Cov.delta).toBeNull()
    expect(outer0Ece.delta).toBeNull()

    const t0Rows = await getRecompeteEvents(db, { releaseSnapshot: 'T0' })
    const outer0CovRow = t0Rows.find(
      (r) => r.dimension === DIMENSION.coverage && r.ring === 'outer',
    )!
    expect(outer0CovRow.payload.prev).toBeNull()
  })

  it('A3 RED LINE: ELO / win-rate / reward is BARRED — recordRecompete physically rejects any non-whitelisted dimension', async () => {
    // the longitudinal deltas are ECE/coverage only; an ELO/win-rate/reward signal cannot be recorded at all.
    for (const banned of ['elo', 'win_rate', 'reward', 'precision_at_k', 'immunity']) {
      await expect(
        recordRecompete(db, {
          frozenGoldenVersion: FROZEN_GOLDEN_VERSION,
          releaseSnapshot: 'T0',
          // @ts-expect-error — deliberately feeding a banned/non-whitelisted dimension
          dimension: banned,
          value: 0.9,
          delta: null,
          ring: RING.outer,
        }),
      ).rejects.toThrow(/A3|dimension must be one of/)
    }
    // the two allowed dims (the S30 ECE/coverage definitions) ARE accepted
    await expect(
      recordRecompete(db, {
        frozenGoldenVersion: FROZEN_GOLDEN_VERSION,
        releaseSnapshot: 'T0',
        dimension: DIMENSION.ece,
        value: 0.1,
        delta: null,
        ring: RING.outer,
      }),
    ).resolves.toBeDefined()
  })

  it('recordRecompete guards value range and ring (bad readings cannot pollute the longitudinal series)', async () => {
    for (const bad of [1.5, Number.NaN, -0.1, Number.POSITIVE_INFINITY]) {
      await expect(
        recordRecompete(db, {
          frozenGoldenVersion: FROZEN_GOLDEN_VERSION,
          releaseSnapshot: 'T0',
          dimension: DIMENSION.coverage,
          value: bad,
          delta: null,
          ring: RING.outer,
        }),
      ).rejects.toThrow(/\[0,1\]/)
    }
    await expect(
      recordRecompete(db, {
        frozenGoldenVersion: FROZEN_GOLDEN_VERSION,
        releaseSnapshot: 'T0',
        dimension: DIMENSION.coverage,
        value: 0.5,
        delta: null,
        // @ts-expect-error — invalid ring
        ring: 'sideways',
      }),
    ).rejects.toThrow(/ring must be one of/)
  })
})
