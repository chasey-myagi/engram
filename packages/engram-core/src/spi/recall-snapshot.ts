/**
 * recall_snapshot 读写口（EGR-CR-003 方案 A）—— 让「预测概率」只能来自一次真实 recall。
 *
 * recall 拍下每条结果的 ConfidenceSnapshot 时，把值拷贝 + 召回方身份（by_role）落本表、生成 snapshotId，
 * 经 RecallResult.confidence.recallSnapshotId 带回。report_usage 改收 snapshotId、按 id 查回**表里的**
 * value/version 写 usage_truth（caller 再也碰不到 confidenceAtRecall/calibrationVersion 写入口）。
 * 校准取样器（collectGatedUsageSamples）JOIN 本表取 verified 预测值；未绑 snapshot 的裸 usage_truth 行硬排除。
 *
 * A3 红线：本表是纯校准燃料溯源锚，不进任何在线判据；不动冻结枚举（独立新表）。
 */
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import type { ConfidenceFactorBreakdown, FactorWeights } from '../confidence/confidence.js'
import type { DB, Tx } from '../db/client.js'
import { recallSnapshot } from '../db/schema.js'

/** DB 或事务 Tx（recall 用前者落快照；与其它 SPI 同形）。 */
type Queryable = DB | Tx

/** 一条 recall_snapshot 行读出的形状（report_usage 据此写 usage_truth、校验 by_role）。 */
export interface RecallSnapshotRow {
  id: string
  claimId: string
  /** 召回瞬间 value=g(raw)（预测概率 ∈[0,1]）—— 写进 usage_truth.predictedConfidence。 */
  value: number
  raw: number
  /** 产生该 value 的 g 版本 —— 写进 usage_truth.calibrationVersion。 */
  calibrationVersion: string
  /** 召回方身份（report_usage 校验上报方 by_role 与此一致，c）。 */
  byRole: string
  takenAt: Date
}

/** 落一条 recall 快照所需的输入（recall 路径填）。 */
export interface PersistRecallSnapshotInput {
  claimId: string
  value: number
  raw: number
  factors: ConfidenceFactorBreakdown
  weights: FactorWeights
  calibrationVersion: string
  /** 召回方身份（缺省 'consumer:unknown'）。 */
  byRole: string
  /** 召回瞬间（同一次 recall 内所有结果共享同一 takenAt）。 */
  takenAt: Date
}

/**
 * 落一条 recall_snapshot，返回 snapshotId（randomUUID）。recall 路径对每条过门结果各调一次。
 * 纯插入、append-only；claim 不存在由 claim_id FK 兜底拒。
 */
export async function persistRecallSnapshot(
  q: Queryable,
  input: PersistRecallSnapshotInput,
): Promise<string> {
  const id = randomUUID()
  await q.insert(recallSnapshot).values({
    id,
    claimId: input.claimId,
    value: input.value,
    raw: input.raw,
    factors: input.factors,
    weights: input.weights,
    calibrationVersion: input.calibrationVersion,
    byRole: input.byRole,
    takenAt: input.takenAt,
  })
  return id
}

/** 按 id 查回一条 recall_snapshot；不存在 → null（report_usage 据此 fail-loud 拒未召回上报）。 */
export async function getRecallSnapshot(
  db: DB,
  snapshotId: string,
): Promise<RecallSnapshotRow | null> {
  const rows = await db
    .select({
      id: recallSnapshot.id,
      claimId: recallSnapshot.claimId,
      value: recallSnapshot.value,
      raw: recallSnapshot.raw,
      calibrationVersion: recallSnapshot.calibrationVersion,
      byRole: recallSnapshot.byRole,
      takenAt: recallSnapshot.takenAt,
    })
    .from(recallSnapshot)
    .where(eq(recallSnapshot.id, snapshotId))
    .limit(1)
  return rows[0] ?? null
}

/**
 * **test-only 的 seed-真快照 helper**（EGR-CR-003 决策 b 的配套）。
 *
 * 合成校准测试（isotonic / EGR-CR-027/029/030 等）用 raw=0.5/0.7/0.9 这类**任意分布**测拟合 / ECE，
 * 真 recall 产不出这种分布（value 由 claim 因子确定性算）。本 helper 让测试「先 seed 一条真 recall_snapshot
 * 再上报」——而不是给 report_usage 留宽限期口子。seed 出的就是一条**真**的 recall_snapshot 行（与 recall 写的同形），
 * report_usage 照常按 id 查表、校验 by_role、用表里的 value/version 写 usage_truth。
 *
 * 仅供测试与受控评测 fixture 使用；生产路径的快照只能由 recall 经 persistRecallSnapshot 产生。
 */
export async function seedRecallSnapshot(
  db: DB,
  input: {
    claimId: string
    /** 要 seed 的预测概率（合成 bin 的 x 值，∈[0,1]）。 */
    value: number
    /** g 版本，缺省 'identity'。 */
    calibrationVersion?: string
    /** 召回方身份，缺省 'consumer:unknown'（report_usage 上报时须传同一 by_role）。 */
    byRole?: string
    /** raw 缺省 = value（identity g 下 value==raw）。 */
    raw?: number
    takenAt?: Date
  },
): Promise<string> {
  return persistRecallSnapshot(db, {
    claimId: input.claimId,
    value: input.value,
    raw: input.raw ?? input.value,
    factors: {} as ConfidenceFactorBreakdown,
    weights: {} as FactorWeights,
    calibrationVersion: input.calibrationVersion ?? 'identity',
    byRole: input.byRole ?? 'consumer:unknown',
    takenAt: input.takenAt ?? new Date(),
  })
}
