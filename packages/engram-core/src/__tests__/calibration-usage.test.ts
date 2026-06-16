import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { computeCalibrationFromUsage, DEFAULT_BIN_COUNT } from '../calibration/calibration.js'
import {
  commitCalibrationMap,
  getActiveCalibrationVersion,
} from '../calibration/calibration-store.js'
import { collectUsageCalibrationSamples } from '../calibration/fit-from-usage.js'
import { createDb, type DB } from '../db/client.js'
import { addSource } from '../spi/append-claim.js'
import { claim, claimProvenance, claimVerification } from '../db/schema.js'
import { seedRecallSnapshot } from '../spi/recall-snapshot.js'
import { getUsageEvents, reportUsage } from '../spi/report-usage.js'

/**
 * EGR-CR-003：报一条 usage_truth，预测概率经一条**真 recall_snapshot** 绑定（决策 b 的 test-seed helper 用法）。
 * 合成 bin（predicted/version 任意分布）由 seedRecallSnapshot 落一条真快照拍下；reportUsage 按 snapshotId 查表取值，
 * by_role 须与快照一致（决策 c）—— 故快照 by_role = 上报 by_role。caller 不再自报 confidenceAtRecall/calibrationVersion。
 */
async function reportSeeded(
  claimId: string,
  outcome: 'adopted' | 'refuted' | 'corrected' | 'partial',
  opts: { predicted: number; calibrationVersion?: string; byRole?: string; taskId?: string },
): Promise<void> {
  const byRole = opts.byRole ?? 'consumer:unknown'
  const recallSnapshotId = await seedRecallSnapshot(db, {
    claimId,
    value: opts.predicted,
    byRole,
    ...(opts.calibrationVersion !== undefined
      ? { calibrationVersion: opts.calibrationVersion }
      : {}),
  })
  await reportUsage(db, claimId, outcome, {
    byRole,
    recallSnapshotId,
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
  })
}

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

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
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

/**
 * Report `adopted` adopted + `refuted` refuted usage events at a fixed predicted value (a synthetic bin).
 * Every event carries a DISTINCT identity (byRole keyed by predicted+index) so each row survives the
 * independent-identity gating as its own sample — these are the bin-math/filtering fixtures, not anti-spam
 * fixtures. The predicted value is folded into the identity so calls at different bins never collide.
 */
async function reportBin(claimId: string, predicted: number, adopted: number, refuted: number) {
  let n = 0
  for (let i = 0; i < adopted; i++)
    await reportSeeded(claimId, 'adopted', { predicted, byRole: `r:${predicted}:${n++}` })
  for (let i = 0; i < refuted; i++)
    await reportSeeded(claimId, 'refuted', { predicted, byRole: `r:${predicted}:${n++}` })
}

describe('S5/EGR-CR-003 report_usage — predicted probability bound to a real recall snapshot', () => {
  it('writes predictedConfidence + calibrationVersion from the bound recall_snapshot (not caller-reported)', async () => {
    const id = await seedActiveClaim('captures predicted')
    const recallSnapshotId = await seedRecallSnapshot(db, {
      claimId: id,
      value: 0.73,
      calibrationVersion: 'identity',
      byRole: 'r',
    })
    await reportUsage(db, id, 'adopted', { byRole: 'r', recallSnapshotId })
    const [e] = await getUsageEvents(db, id)
    expect(e!.predictedConfidence).toBe(0.73) // sourced from the snapshot row
    expect(e!.calibrationVersion).toBe('identity')
  })

  it('defaults predictedConfidence/calibrationVersion to null when no recall snapshot is bound', async () => {
    const id = await seedActiveClaim('no predicted')
    await reportUsage(db, id, 'adopted', { byRole: 'r' })
    const [e] = await getUsageEvents(db, id)
    expect(e!.predictedConfidence).toBeNull()
    expect(e!.calibrationVersion).toBeNull()
  })

  it('rejects a forged / un-recalled snapshotId — predicted probability cannot be self-asserted', async () => {
    const id = await seedActiveClaim('bad predicted')
    await expect(
      reportUsage(db, id, 'adopted', { byRole: 'r', recallSnapshotId: randomUUID() }),
    ).rejects.toThrow(/recall snapshot .* not found/i)
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
    // distinct identities for the two counted rows so independent-identity gating keeps them as 2 votes
    // (this case asserts the INPUT-filter boundary — which outcomes/kinds enter — not the anti-spam fold).
    await reportSeeded(id, 'adopted', { predicted: 0.85, byRole: 'r:a' }) // counted (correct)
    await reportSeeded(id, 'refuted', { predicted: 0.85, byRole: 'r:b' }) // counted (incorrect)
    await reportSeeded(id, 'corrected', { predicted: 0.85, byRole: 'r:c' }) // excluded: not adopted/refuted
    await reportSeeded(id, 'partial', { predicted: 0.85, byRole: 'r:d' }) // excluded: not adopted/refuted
    await reportUsage(db, id, 'adopted', { byRole: 'r:e' }) // excluded: no recall snapshot bound
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

  it('preserves the falsy-but-valid endpoints: snapshot value 0 and 1 round-trip (not coerced to null) and bin correctly', async () => {
    const id = await seedActiveClaim('endpoints')
    // distinct identities so both endpoints survive independent-identity gating as separate samples.
    await reportSeeded(id, 'refuted', { predicted: 0, byRole: 'r:lo' })
    await reportSeeded(id, 'adopted', { predicted: 1, byRole: 'r:hi' })

    const predicted = (await getUsageEvents(db, id))
      .map((e) => e.predictedConfidence)
      .sort((a, b) => (a ?? -1) - (b ?? -1))
    expect(predicted).toEqual([0, 1]) // 0 preserved by `?? null` (a `|| null` typo would drop it)

    const rep = await computeCalibrationFromUsage(db)
    expect(rep.bins[0]!.count).toBe(1) // predicted 0 → first bin
    expect(rep.bins[9]!.count).toBe(1) // predicted 1 → last bin
  })

  it('A3 by field: a usage_truth row whose verdict also carries winRate/elo is calibrated on the snapshot value + outcome only — the extra fields are structurally ignored', async () => {
    const id = await seedActiveClaim('a3 by field')
    // The predicted value comes from a bound recall_snapshot (0.85); winRate/elo injected into the
    // usage_truth verdict must NOT influence the computation (calibration reads outcome + snapshot.value only).
    const recallSnapshotId = await seedRecallSnapshot(db, { claimId: id, value: 0.85, byRole: 'r' })
    await db.insert(claimVerification).values({
      id: randomUUID(),
      claimId: id,
      kind: 'usage_truth',
      verdict: {
        outcome: 'adopted',
        taskId: null,
        note: null,
        recallSnapshotId,
        winRate: 0.99, // injected ELO/win-rate signal — must NOT influence the computation
        elo: 1800,
      },
      byRole: 'r',
    })

    const rep = await computeCalibrationFromUsage(db)
    expect(rep.sampleCount).toBe(1) // admitted (valid usage_truth adopted + bound snapshot)
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

describe('EGR-CR-027 — ECE reader is gated by independent (byRole, taskId) identity (A.6 anti-Goodhart)', () => {
  it('T1: 100 repeats of the SAME (byRole, taskId) collapse to ONE gated sample — raw-events mode still counts 100', async () => {
    const id = await seedActiveClaim('spam one identity')
    // Same consumer spams the same claim/task 100× — under the OLD raw reader this was 100 reliability samples.
    for (let i = 0; i < 100; i++) {
      await reportSeeded(id, 'adopted', { predicted: 0.85, byRole: 'consumer:spam', taskId: 't-1' })
    }
    // RED before the fix (default reader counted raw rows ⇒ 100); GREEN after (default = independent-identities ⇒ 1).
    expect((await computeCalibrationFromUsage(db)).sampleCount).toBe(1)
    // raw-events diagnostic mode proves the 100 rows were actually written — it is the read-side gate that folds them.
    expect(
      (await computeCalibrationFromUsage(db, DEFAULT_BIN_COUNT, 'raw-events')).sampleCount,
    ).toBe(100)

    // a genuinely DISTINCT identity adds a real second vote (the gate blocks spam, not real signal).
    await reportSeeded(id, 'adopted', { predicted: 0.85, byRole: 'consumer:b', taskId: 't-2' })
    expect((await computeCalibrationFromUsage(db)).sampleCount).toBe(2)
    expect(
      (await computeCalibrationFromUsage(db, DEFAULT_BIN_COUNT, 'raw-events')).sampleCount,
    ).toBe(101)
  })

  it('T1b: same byRole but DIFFERENT taskId are distinct identities (the gate keys on the (byRole, taskId) pair)', async () => {
    const id = await seedActiveClaim('same role distinct task')
    await reportSeeded(id, 'adopted', { predicted: 0.85, byRole: 'c', taskId: 't-1' })
    await reportSeeded(id, 'adopted', { predicted: 0.85, byRole: 'c', taskId: 't-2' })
    await reportSeeded(id, 'adopted', { predicted: 0.85, byRole: 'c', taskId: 't-1' }) // dup of t-1
    expect((await computeCalibrationFromUsage(db)).sampleCount).toBe(2) // {c,t-1}, {c,t-2}
  })

  it('T1c: latest vote wins per identity — a later refuted overrides an earlier adopted for the same identity', async () => {
    const id = await seedActiveClaim('latest wins')
    // single identity flip-flops; gated reader keeps only the latest outcome (refuted ⇒ correct=false).
    await reportSeeded(id, 'adopted', { predicted: 0.85, byRole: 'c', taskId: 't' })
    await reportSeeded(id, 'refuted', { predicted: 0.85, byRole: 'c', taskId: 't' })
    const rep = await computeCalibrationFromUsage(db)
    expect(rep.sampleCount).toBe(1)
    expect(rep.bins[8]!.count).toBe(1) // 0.85 → bin 8
    expect(rep.bins[8]!.observed).toBe(0) // latest is refuted ⇒ observed 0 (adopted did not linger)
  })

  it('T3: the fitter reader and the ECE reader fold to the SAME independent-identity count (shared gate, no drift)', async () => {
    const id = await seedActiveClaim('shared gate parity')
    // mix: one spammed identity (×50) + three distinct identities, all under calibrationVersion=identity.
    for (let i = 0; i < 50; i++) {
      await reportSeeded(id, 'adopted', {
        predicted: 0.7,
        byRole: 'consumer:spam',
        taskId: 't-1',
        calibrationVersion: CALIBRATION_IDENTITY,
      })
    }
    for (const role of ['consumer:x', 'consumer:y', 'consumer:z']) {
      await reportSeeded(id, 'adopted', {
        predicted: 0.7,
        byRole: role,
        taskId: 't-1',
        calibrationVersion: CALIBRATION_IDENTITY,
      })
    }
    const eceSamples = (await computeCalibrationFromUsage(db)).sampleCount
    const fitterSamples = (await collectUsageCalibrationSamples(db)).length
    expect(eceSamples).toBe(4) // spam folds to 1 + 3 distinct
    expect(fitterSamples).toBe(eceSamples) // both readers share the one gate ⇒ identical independent count
  })
})

describe('EGR-CR-029 — ECE segments by calibrationVersion (no cross-version pooling)', () => {
  // These cases activate a non-identity calibration map; the shared beforeEach does not truncate
  // calibration_map, so wipe it here to keep each version-segmentation case isolated.
  beforeEach(async () => {
    await pool.query('TRUNCATE calibration_map CASCADE')
  })

  /**
   * Seed a heavily-miscalibrated `identity` batch and a perfectly-calibrated `iso-v1` batch in the
   * SAME bin (predicted 0.95). Activate iso-v1 so it is the active version. Returns the claim id.
   *   - identity: 10 adopted / 10 refuted ⇒ observed 0.5 vs predicted 0.95 (gap 0.45).
   *   - iso-v1:   19 adopted /  1 refuted ⇒ observed 0.95 == predicted 0.95 (gap ~0).
   * Each row carries a DISTINCT (byRole) identity so independent-identity gating keeps every row.
   */
  async function seedTwoVersionBins(): Promise<string> {
    const id = await seedActiveClaim('cross-version pooling')
    // activate a non-identity g so getActiveCalibrationVersion(db) === 'iso-v1'
    await commitCalibrationMap(db, {
      map: {
        version: 'iso-v1',
        knots: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
      reason: 'test: activate iso-v1',
    })
    let n = 0
    // identity batch — same bin (0.95), deliberately miscalibrated (observed 0.5)
    for (let i = 0; i < 10; i++)
      await reportSeeded(id, 'adopted', {
        predicted: 0.95,
        calibrationVersion: 'identity',
        byRole: `idn:${n++}`,
      })
    for (let i = 0; i < 10; i++)
      await reportSeeded(id, 'refuted', {
        predicted: 0.95,
        calibrationVersion: 'identity',
        byRole: `idn:${n++}`,
      })
    // iso-v1 batch — same bin (0.95), perfectly calibrated (observed 0.95)
    for (let i = 0; i < 19; i++)
      await reportSeeded(id, 'adopted', {
        predicted: 0.95,
        calibrationVersion: 'iso-v1',
        byRole: `iso:${n++}`,
      })
    await reportSeeded(id, 'refuted', {
      predicted: 0.95,
      calibrationVersion: 'iso-v1',
      byRole: `iso:${n++}`,
    })
    return id
  }

  it('T1: default reads ONLY the active version (iso-v1) — the miscalibrated identity batch is excluded', async () => {
    await seedTwoVersionBins()
    expect(await getActiveCalibrationVersion(db)).toBe('iso-v1')

    // RED before fix: default pools BOTH versions ⇒ sampleCount 40 and ECE dragged up by identity's 0.45 gap.
    const rep = await computeCalibrationFromUsage(db)
    expect(rep.sampleCount).toBe(20) // only the iso-v1 batch
    expect(rep.ece).toBeLessThan(0.02) // iso-v1 is well calibrated; identity's gap must NOT leak in
    expect(rep.fromVersions).toEqual(['iso-v1'])
    expect(rep.mixed).toBe(false)
  })

  it('T2: explicit fromVersions=[identity, iso-v1] returns the mixed pool and is flagged mixed=true', async () => {
    await seedTwoVersionBins()
    const rep = await computeCalibrationFromUsage(db, {
      fromVersions: ['identity', 'iso-v1'],
    })
    expect(rep.sampleCount).toBe(40) // both batches
    expect(rep.mixed).toBe(true) // mixing is only ever an explicit, flagged choice — never silent
    expect(new Set(rep.fromVersions)).toEqual(new Set(['identity', 'iso-v1']))
    expect(rep.ece).toBeGreaterThan(0.2) // identity's 0.45 gap now (correctly) shows up
  })

  it('T3: explicit fromVersions=[identity] retrieves the old (miscalibrated) report', async () => {
    await seedTwoVersionBins()
    const rep = await computeCalibrationFromUsage(db, { fromVersions: ['identity'] })
    expect(rep.sampleCount).toBe(20) // only the identity batch
    expect(rep.ece).toBeGreaterThan(0.3) // observed 0.5 vs predicted 0.95
    expect(rep.fromVersions).toEqual(['identity'])
  })

  it('T4: a missing calibrationVersion coalesces to identity (counted under identity, excluded under iso-v1)', async () => {
    const id = await seedActiveClaim('coalesce default')
    // a recall snapshot seeded WITHOUT an explicit version defaults to 'identity' (the snapshot is the source of truth)
    await reportSeeded(id, 'adopted', { predicted: 0.85, byRole: 'noversion' })

    const underIdentity = await computeCalibrationFromUsage(db, { fromVersions: ['identity'] })
    expect(underIdentity.sampleCount).toBe(1) // default snapshot version is identity

    const underIso = await computeCalibrationFromUsage(db, { fromVersions: ['iso-v1'] })
    expect(underIso.sampleCount).toBe(0) // not counted under a different version
  })

  it('T5: with no active map, the default active version is identity — zero behavior change for never-recalibrated KBs', async () => {
    // mirrors the existing identity-only fixtures: perfect set ECE≈0, miscalibrated set ECE>0.3,
    // proving the version gate is a no-op when g was never swapped (active == identity).
    const perfect = await seedActiveClaim('t5 perfect')
    await reportBin(perfect, 0.55, 11, 9)
    await reportBin(perfect, 0.75, 15, 5)
    await reportBin(perfect, 0.95, 19, 1)
    const repPerfect = await computeCalibrationFromUsage(db)
    expect(repPerfect.sampleCount).toBe(60)
    expect(repPerfect.ece).toBeLessThan(0.02)
    expect(repPerfect.fromVersions).toEqual(['identity'])
    expect(repPerfect.mixed).toBe(false)

    await pool.query(
      'TRUNCATE source, claim, claim_provenance, relation, claim_verification, page_claims CASCADE',
    )

    const bad = await seedActiveClaim('t5 bad')
    await reportBin(bad, 0.95, 10, 10)
    await reportBin(bad, 0.55, 19, 1)
    const repBad = await computeCalibrationFromUsage(db)
    expect(repBad.sampleCount).toBe(40)
    expect(repBad.ece).toBeGreaterThan(0.3)
  })
})
