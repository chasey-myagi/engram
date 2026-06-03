import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { computeCalibrationFromUsage } from '../calibration/calibration.js'
import { createDb, type DB } from '../db/client.js'
import { addSource } from '../spi/append-claim.js'
import { claim, claimProvenance, claimVerification } from '../db/schema.js'
import { getUsageEvents, reportUsage } from '../spi/report-usage.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string

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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, page_claims CASCADE',
  )
})

async function seedActiveClaim(text: string, raw = 0.8): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: text,
    status: 'active',
    confidence: raw,
    confidenceRaw: raw,
    confidenceFactors: {
      factors: {
        authority: 0.5,
        humanReview: 0,
        entailment: 0.5,
        indepSupport: 0,
        usageCorrect: 0,
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

/** Report `adopted` adopted + `refuted` refuted usage events at a fixed predicted value (a synthetic bin). */
async function reportBin(claimId: string, predicted: number, adopted: number, refuted: number) {
  for (let i = 0; i < adopted; i++)
    await reportUsage(db, claimId, 'adopted', { confidenceAtRecall: predicted, byRole: 'r' })
  for (let i = 0; i < refuted; i++)
    await reportUsage(db, claimId, 'refuted', { confidenceAtRecall: predicted, byRole: 'r' })
}

describe('S5 report_usage extension — capture predicted probability at consumption', () => {
  it('stores confidenceAtRecall as predictedConfidence + calibrationVersion on the event', async () => {
    const id = await seedActiveClaim('captures predicted')
    await reportUsage(db, id, 'adopted', {
      confidenceAtRecall: 0.73,
      calibrationVersion: 'identity',
      byRole: 'r',
    })
    const [e] = await getUsageEvents(db, id)
    expect(e!.predictedConfidence).toBe(0.73)
    expect(e!.calibrationVersion).toBe('identity')
  })

  it('defaults predictedConfidence/calibrationVersion to null when confidenceAtRecall is omitted', async () => {
    const id = await seedActiveClaim('no predicted')
    await reportUsage(db, id, 'adopted', { byRole: 'r' })
    const [e] = await getUsageEvents(db, id)
    expect(e!.predictedConfidence).toBeNull()
    expect(e!.calibrationVersion).toBeNull()
  })

  it('rejects an out-of-range confidenceAtRecall (a probability must be in [0,1])', async () => {
    const id = await seedActiveClaim('bad predicted')
    for (const bad of [1.5, -0.1, NaN]) {
      await expect(reportUsage(db, id, 'adopted', { confidenceAtRecall: bad })).rejects.toThrow(
        /confidenceAtRecall|\[0,1\]/i,
      )
    }
  })
})

describe('S5 P0 GATE — ECE from recall snapshots joined to usage_truth (A.3/A.9)', () => {
  it('eval==consumption: a perfectly-calibrated synthetic set fed entirely through report_usage yields ECE ≈ 0', async () => {
    const id = await seedActiveClaim('cal perfect')
    await reportBin(id, 0.55, 11, 9) // observed 0.55 == predicted
    await reportBin(id, 0.75, 15, 5) // observed 0.75 == predicted
    await reportBin(id, 0.95, 19, 1) // observed 0.95 == predicted

    const rep = await computeCalibrationFromUsage(db)
    expect(rep.sampleCount).toBe(60)
    expect(rep.ece).toBeLessThan(0.02)
    // per-bin reliability data is drawable
    expect(rep.bins[5]!.count).toBe(20)
    expect(rep.bins[5]!.observed).toBeCloseTo(0.55, 6)
    expect(rep.bins[9]!.observed).toBeCloseTo(0.95, 6)
  })

  it('the same SPI path on deliberately miscalibrated input yields ECE clearly > 0 (distinguishable, non-NaN)', async () => {
    const id = await seedActiveClaim('cal bad')
    await reportBin(id, 0.95, 10, 10) // observed 0.5 vs predicted 0.95 → gap 0.45
    await reportBin(id, 0.55, 19, 1) // observed 0.95 vs predicted 0.55 → gap 0.40

    const rep = await computeCalibrationFromUsage(db)
    expect(rep.sampleCount).toBe(40)
    expect(rep.ece).toBeGreaterThan(0.3)
    expect(Number.isNaN(rep.ece)).toBe(false)
  })

  it('input boundary: only usage_truth adopted/refuted carrying predictedConfidence enter — corrected/partial, missing-predicted, and non-usage_truth (A3) are all excluded', async () => {
    const id = await seedActiveClaim('cal filter')
    await reportUsage(db, id, 'adopted', { confidenceAtRecall: 0.85, byRole: 'r' }) // counted (correct)
    await reportUsage(db, id, 'refuted', { confidenceAtRecall: 0.85, byRole: 'r' }) // counted (incorrect)
    await reportUsage(db, id, 'corrected', { confidenceAtRecall: 0.85, byRole: 'r' }) // excluded: not adopted/refuted
    await reportUsage(db, id, 'partial', { confidenceAtRecall: 0.85, byRole: 'r' }) // excluded: not adopted/refuted
    await reportUsage(db, id, 'adopted', { byRole: 'r' }) // excluded: no predictedConfidence
    // A3: a non-usage_truth verification carrying a win-rate-like field must NOT enter the calibration input
    await db.insert(claimVerification).values({
      id: randomUUID(),
      claimId: id,
      kind: 'patrol',
      verdict: { outcome: 'adopted', predictedConfidence: 0.85, winRate: 0.99, elo: 1800 },
      byRole: 'judge',
    })

    const rep = await computeCalibrationFromUsage(db)
    expect(rep.sampleCount).toBe(2) // only the 2 usage_truth adopted/refuted with predictedConfidence
    expect(rep.bins[8]!.count).toBe(2) // 0.85 → bin 8
    expect(rep.bins[8]!.observed).toBeCloseTo(0.5) // 1 adopted of 2
  })

  it('preserves the falsy-but-valid endpoints: confidenceAtRecall 0 and 1 round-trip (not coerced to null) and bin correctly', async () => {
    const id = await seedActiveClaim('endpoints')
    await reportUsage(db, id, 'refuted', { confidenceAtRecall: 0, byRole: 'r' })
    await reportUsage(db, id, 'adopted', { confidenceAtRecall: 1, byRole: 'r' })

    const predicted = (await getUsageEvents(db, id))
      .map((e) => e.predictedConfidence)
      .sort((a, b) => (a ?? -1) - (b ?? -1))
    expect(predicted).toEqual([0, 1]) // 0 preserved by `?? null` (a `|| null` typo would drop it)

    const rep = await computeCalibrationFromUsage(db)
    expect(rep.bins[0]!.count).toBe(1) // predicted 0 → first bin
    expect(rep.bins[9]!.count).toBe(1) // predicted 1 → last bin
  })

  it('A3 by field: a usage_truth row whose verdict also carries winRate/elo is calibrated on outcome+predictedConfidence only — the extra fields are structurally ignored', async () => {
    const id = await seedActiveClaim('a3 by field')
    await db.insert(claimVerification).values({
      id: randomUUID(),
      claimId: id,
      kind: 'usage_truth',
      verdict: {
        outcome: 'adopted',
        taskId: null,
        note: null,
        predictedConfidence: 0.85,
        calibrationVersion: 'identity',
        winRate: 0.99, // injected ELO/win-rate signal — must NOT influence the computation
        elo: 1800,
      },
      byRole: 'r',
    })

    const rep = await computeCalibrationFromUsage(db)
    expect(rep.sampleCount).toBe(1) // admitted (valid usage_truth adopted + predictedConfidence)
    expect(rep.bins[8]!.count).toBe(1) // 0.85 → bin 8
    expect(rep.bins[8]!.observed).toBe(1) // adopted ⇒ 1; winRate/elo had zero effect
  })

  it('empty usage history ⇒ ECE 0, non-NaN, all-zero bins (no divide-by-zero)', async () => {
    const rep = await computeCalibrationFromUsage(db)
    expect(rep.ece).toBe(0)
    expect(rep.sampleCount).toBe(0)
    expect(rep.bins.every((b) => b.count === 0)).toBe(true)
  })

  it('honors a custom binCount through the DB path', async () => {
    const id = await seedActiveClaim('cal bins')
    await reportBin(id, 0.3, 1, 1) // [0,0.5) under 2 bins
    await reportBin(id, 0.8, 1, 1) // [0.5,1.0] under 2 bins
    const rep = await computeCalibrationFromUsage(db, 2)
    expect(rep.binCount).toBe(2)
    expect(rep.bins[0]!.count).toBe(2)
    expect(rep.bins[1]!.count).toBe(2)
  })
})
