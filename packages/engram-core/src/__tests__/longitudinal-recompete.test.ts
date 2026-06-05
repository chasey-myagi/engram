import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

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
    byRole: 'human:editor',
    verdict: { humanReview: 1, action: 'approve' },
  })
  await transitionClaim(db, claimId, 'active', { by: 'human:test', entailmentPass: true })
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

  it('ΔECE-down: as calibration improves across releases, ECE drops and delta (prev−curr) is positive', async () => {
    // T0: a single high-confidence-but-refused usage ⇒ non-zero ECE
    await seedMiscalibration(L3_GOLDEN[0]!.expectedClaimTexts[0]!, L3_GOLDEN[0]!.query)
    const t0 = await runRecompeteSnapshot(db, embedder, 'T0')
    const t0ece = t0.results.find((r) => r.dimension === DIMENSION.ece)!
    expect(t0ece.value).toBeGreaterThan(0)
    expect(t0ece.delta).toBeNull()

    // T1: add many well-calibrated usages (adopted at low confidence is irrelevant; here just dilute the error
    // by adding correctly-low predictions) ⇒ ECE drops vs T0
    const claimId = await selfAuthor(L3_GOLDEN[1]!.expectedClaimTexts[0]!)
    const [hit] = await recallClaims(db, embedder, L3_GOLDEN[1]!.query)
    for (let i = 0; i < 10; i++) {
      await reportUsage(db, claimId, 'adopted', {
        byRole: 'consumer:test',
        confidenceAtRecall: hit!.confidence.value,
        calibrationVersion: hit!.confidence.calibrationVersion,
      })
    }
    const t1 = await runRecompeteSnapshot(db, embedder, 'T1')
    const t1ece = t1.results.find((r) => r.dimension === DIMENSION.ece)!
    // ECE dropped (more well-calibrated samples) ⇒ ΔECE-down delta (prev - curr) > 0
    expect(t1ece.value).toBeLessThan(t0ece.value)
    expect(t1ece.delta!).toBeGreaterThan(0)
    expect(t1ece.delta!).toBeCloseTo(t0ece.value - t1ece.value, 10)
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
