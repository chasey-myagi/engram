/**
 * EGR-CR-003 方案 A 的红→绿回归：把「预测概率」绑定到一次真实 recall。
 *
 *   - report_usage 不再接受 caller 自报的 confidence/version（编译期删入口；运行时只认 recallSnapshotId）。
 *   - 伪造 / 未召回的 claim 上报被拒（snapshotId 不存在 → fail-loud）。
 *   - by_role 校验（决策 c）：上报方 by_role 与召回快照不一致 → 拒。
 *   - 校准取样器 JOIN recall_snapshot；未绑 snapshot 的裸 usage_truth 行硬排除（决策 b）。
 *   - 真 recall 在 RecallResult 上带回 recallSnapshotId；端到端可上报。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { collectUsageCalibrationSamples } from '../calibration/fit-from-usage.js'
import { createDb, type DB } from '../db/client.js'
import { addSource } from '../spi/append-claim.js'
import { claim, claimProvenance, claimVerification } from '../db/schema.js'
import { recallClaims } from '../spi/recall-claims.js'
import { seedRecallSnapshot } from '../spi/recall-snapshot.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { getUsageEvents, reportUsage } from '../spi/report-usage.js'

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
  pool.on('error', () => {})
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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, recall_snapshot, page_claims CASCADE',
  )
})

function factorsBlob() {
  return {
    factors: {
      authority: 0.9,
      humanReview: 0.9,
      entailment: 0.9,
      indepSupport: 0.9,
      usageCorrect: 0,
      ageDays: 0,
      activeContradicts: 0,
      staleDecay: 1,
      conflictDecay: 1,
    },
    weights: DEFAULT_WEIGHTS,
    calibrationVersion: CALIBRATION_IDENTITY,
  }
}

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
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

describe('EGR-CR-003 — predicted probability is bound to a real recall (no caller self-report)', () => {
  it('report_usage no longer accepts caller-reported confidenceAtRecall/calibrationVersion (compile-time + runtime)', async () => {
    const id = await seedActiveClaim('no self-report')
    // @ts-expect-error — confidenceAtRecall write-entry was removed from ReportUsageContext (方案 A #3)
    await reportUsage(db, id, 'adopted', { byRole: 'r', confidenceAtRecall: 0.99 })
    // @ts-expect-error — calibrationVersion write-entry was removed too
    await reportUsage(db, id, 'corrected', { byRole: 'r', calibrationVersion: 'forged-g' })

    // The forbidden keys are silently ignored at runtime: with no recall snapshot, predicted/version stay null.
    const events = await getUsageEvents(db, id)
    for (const e of events) {
      expect(e.predictedConfidence).toBeNull()
      expect(e.calibrationVersion).toBeNull()
    }
  })

  it('rejects a forged / un-recalled snapshotId (no row → fail-loud, nothing written)', async () => {
    const id = await seedActiveClaim('forged snapshot')
    await expect(
      reportUsage(db, id, 'adopted', { byRole: 'r', recallSnapshotId: randomUUID() }),
    ).rejects.toThrow(/recall snapshot .* not found/i)
    expect(await getUsageEvents(db, id)).toHaveLength(0)
  })

  it('rejects a snapshotId whose recaller by_role differs from the reporter (决策 c by_role check)', async () => {
    const id = await seedActiveClaim('byrole mismatch')
    const snapId = await seedRecallSnapshot(db, { claimId: id, value: 0.8, byRole: 'agent:alice' })
    // bob recalled nothing — he tries to report against alice's snapshot.
    await expect(
      reportUsage(db, id, 'adopted', { byRole: 'agent:bob', recallSnapshotId: snapId }),
    ).rejects.toThrow(/by_role/i)
    expect(await getUsageEvents(db, id)).toHaveLength(0)
  })

  it('writes predictedConfidence/calibrationVersion from the TABLE, not from the caller', async () => {
    const id = await seedActiveClaim('table-sourced predicted')
    const snapId = await seedRecallSnapshot(db, {
      claimId: id,
      value: 0.73,
      calibrationVersion: 'iso-v9',
      byRole: 'agent:consumer',
    })
    await reportUsage(db, id, 'adopted', { byRole: 'agent:consumer', recallSnapshotId: snapId })
    const [e] = await getUsageEvents(db, id)
    expect(e!.predictedConfidence).toBe(0.73) // from the snapshot row
    expect(e!.calibrationVersion).toBe('iso-v9') // from the snapshot row
  })

  it('calibration sampler JOINs recall_snapshot — bare usage_truth rows (no snapshot) are hard-excluded (决策 b)', async () => {
    const id = await seedActiveClaim('bare row excluded')
    // a snapshot-bound sample → enters calibration
    const snapId = await seedRecallSnapshot(db, {
      claimId: id,
      value: 0.85,
      byRole: 'agent:bound',
    })
    await reportUsage(db, id, 'adopted', { byRole: 'agent:bound', recallSnapshotId: snapId })
    // a bare usage_truth row hand-inserted with a forged inline predictedConfidence but NO snapshot binding
    await db.insert(claimVerification).values({
      id: randomUUID(),
      claimId: id,
      kind: 'usage_truth',
      verdict: { outcome: 'adopted', taskId: 't-bare', predictedConfidence: 0.95 },
      byRole: 'agent:bare',
    })

    const samples = await collectUsageCalibrationSamples(db)
    expect(samples).toHaveLength(1) // only the snapshot-bound one; the bare forged row is excluded
    expect(samples[0]!.rawPredicted).toBe(0.85)
  })

  it('end-to-end: a real recall carries a recallSnapshotId that report_usage binds to', async () => {
    const id = await seedActiveClaim('end to end recall')
    const [hit] = await recallClaims(db, embedder, 'end to end recall', {
      byRole: 'agent:consumer',
    })
    expect(hit!.claim.id).toBe(id)
    const snapId = hit!.confidence.recallSnapshotId
    expect(typeof snapId).toBe('string')

    await reportUsage(db, id, 'adopted', {
      byRole: 'agent:consumer',
      taskId: 'task-1',
      recallSnapshotId: snapId,
    })
    const [e] = await getUsageEvents(db, id)
    // predicted came from the recall snapshot, equal to the recalled value (identity g ⇒ value)
    expect(e!.predictedConfidence).toBe(hit!.confidence.value)
    expect(e!.calibrationVersion).toBe(CALIBRATION_IDENTITY)

    const samples = await collectUsageCalibrationSamples(db)
    expect(samples).toHaveLength(1)
    expect(samples[0]!.rawPredicted).toBe(hit!.confidence.value)
  })
})
