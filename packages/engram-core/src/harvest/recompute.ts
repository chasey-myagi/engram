/**
 * 按一条 claim 的全量出处 + 当前可计算因子，**重算并持久化**它的 confidence 快照（S19 Harvester 用）。
 *
 * 这是 commit-merge 重算（commit-claim.ts）的**抽取版**：读 claim 的全量 supports 出处 + asOf →
 * computeConfidenceFromProvenances(tx, all, asOf, {claimId}) → 写回 claim.confidence/raw/factors。
 * 传 claimId ⇒ 因子装配的**单一标注点**会把 f2 entailment（最新 patrol）与 f4 usageCorrect（usage_truth 独立统计）
 * 一并接上（实时口径）。保持原 claim 的 asOf（不刷新年龄）。
 *
 * 刻意**只重算 confidence、绝不改 status**（红线 #2：放松仅人可做；Harvester 是纯统计、不碰状态机）；
 * 也**不动 g / calibration_version**（A.7：Harvester 无 g 更新；g 由 S28 Advisor 接管）—— 与 commit-merge 同口径，
 * calibrationVersion 走 computeConfidence 的 identity 默认（pre-S28 全库一致）。
 *
 * 事务内对 claim 行 FOR UPDATE 锁定后再读出处 + 写回，序列化并发重算 / 与 supersede/transition 互斥（杜绝 TOCTOU）。
 * claim 不存在 / 无任何 supports 出处 → 返回 null（不写）。
 */
import { eq } from 'drizzle-orm'

import type { StoredConfidence } from '../confidence/confidence.js'
import type { DB } from '../db/client.js'
import { claim, claimProvenance } from '../db/schema.js'
import { computeConfidenceFromProvenances } from '../spi/append-claim.js'

export interface RecomputeResult {
  claimId: string
  /** 重算后的 raw（base·staleDecay·conflictDecay）。 */
  confidenceRaw: number
  /** 重算后的 confidence（= g(raw)，g 起步 identity）。 */
  confidence: number
  /** 重算后存档的 f4 usageCorrect（便于审计 / 断言）。 */
  usageCorrect: number
}

/**
 * 重算并持久化一条 claim 的 confidence 快照（含实时 f2/f4）。不改 status、不动 g。
 * 返回新快照摘要；claim 不存在或无 supports 出处 → null。
 */
export async function recomputeClaimConfidence(
  db: DB,
  claimId: string,
): Promise<RecomputeResult | null> {
  return db.transaction(async (tx) => {
    // 锁行 + 事务内读最新 asOf（与 supersede/transition 的 FOR UPDATE 范式一致，序列化并发重算）。
    const [row] = await tx
      .select({ asOf: claim.asOf })
      .from(claim)
      .where(eq(claim.id, claimId))
      .for('update')
    if (!row) return null

    const provs = await tx
      .select({ sourceId: claimProvenance.sourceId, relevance: claimProvenance.relevance })
      .from(claimProvenance)
      .where(eq(claimProvenance.claimId, claimId))
    // 无出处（理论上 D1 不可能）→ 不重算（避免把一条 claim 的 confidence 抹成 0）。
    if (provs.length === 0) return null

    // 传 claimId ⇒ 单一标注点接上实时 f2/f4。保持原 asOf（不刷新年龄）。
    const conf = await computeConfidenceFromProvenances(tx, provs, row.asOf, { claimId })
    const stored: StoredConfidence = {
      factors: conf.factors,
      weights: conf.weights,
      calibrationVersion: conf.calibrationVersion,
    }
    await tx
      .update(claim)
      .set({
        confidence: conf.confidence,
        confidenceRaw: conf.confidenceRaw,
        confidenceFactors: stored,
      })
      .where(eq(claim.id, claimId))

    return {
      claimId,
      confidenceRaw: conf.confidenceRaw,
      confidence: conf.confidence,
      usageCorrect: conf.factors.usageCorrect,
    }
  })
}
