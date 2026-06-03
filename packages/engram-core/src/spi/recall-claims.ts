/**
 * 召回路径（Consumer SPI 的读半边，附录 A.2）—— 最高测试缝。评测=消费，同走这条缝。
 *
 * recallClaims(db, query, ctx) 返回 RecallResult[]，每行带：
 *   - claim 本体
 *   - 召回瞬间拍下的 ConfidenceSnapshot（value=g(raw) / raw / 因子 / 权重 / 校准版本 / takenAt）
 *   - provenances[]（每个结果至少 1 条出处；无出处的 claim 绝不出现）
 *   - mustVerify（落在 [0.4,0.6) 的可用但须先核验）
 *
 * 内核消费门（硬判据）：value 低于消费下界永不出现；落在 [floor, mustVerify) 带 mustVerify=true；≥mustVerify 直接可用。
 * 门限来自配置态活动规范（S7）：consumeFloor≥内核 0.4、mustVerifyThreshold≥内核 0.6，且与请求态 ctx.confidenceFloor
 * 取最严（max）—— consumer/config 都只能更严，绝不能放松内核底线。
 *
 * 关键设计：raw 召回时用**活动权重**对存档因子现算（rawFromStoredFactors，S7 配置态变更即刻生效），
 * 再 value=applyG(raw, 版本)（g 现算，S27/S28 换 g 即时生效）。存档的 confidence_raw 自 S7 起是写时审计快照、
 * 召回不再读它。检索匹配 S3 用确定性子串（text/subject）；语义向量是 S9。
 */
import { and, eq, ilike, inArray, or } from 'drizzle-orm'

import { getActiveStandards } from '../config/standards.js'
import {
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
  applyG,
  rawFromStoredFactors,
  type ConfidenceFactorBreakdown,
  type FactorWeights,
  type StoredConfidence,
} from '../confidence/confidence.js'
import type { DB } from '../db/client.js'
import { claim, claimProvenance, type ClaimStatus, type ProvRelevance } from '../db/schema.js'

// 内核消费门常量定义在命门模块；这里 re-export 保持既有 import 路径（index / adapter / bidding）不变。
export { KERNEL_CONFIDENCE_FLOOR, MUST_VERIFY_THRESHOLD }
/** 默认召回上限：防无界返回。consumer 可经 ctx.limit 调整。 */
export const DEFAULT_RECALL_LIMIT = 50

/** 召回瞬间的 confidence 快照（A.2）。一旦返回即是值拷贝：claim 之后被改不影响已返回的快照。 */
export interface ConfidenceSnapshot {
  /** value = g(raw)，召回瞬间按当前 g 现算。 */
  value: number
  /** 写时存下的证据聚合（去桶后的连续值）。 */
  raw: number
  /** 七因子拆解（含两个衰减结果），解释"为什么信"。 */
  factors: ConfidenceFactorBreakdown
  weights: FactorWeights
  calibrationVersion: string
  /** 召回瞬间（同一次 recall 内所有结果共享同一 takenAt）。 */
  takenAt: Date
}

export interface RecalledProvenance {
  sourceId: string
  locator: string
  relevance: ProvRelevance
}

export interface RecallResult {
  claim: {
    id: string
    claimText: string
    subject: string | null
    predicate: string | null
    object: string | null
    status: ClaimStatus
    lineageId: string
    asOf: Date
  }
  confidence: ConfidenceSnapshot
  provenances: RecalledProvenance[]
  /** value 落在 [floor, 0.6) → true（可用但须先核验）；≥0.6 → false。 */
  mustVerify: boolean
}

export interface RecallContext {
  /** 抬高消费门槛；只能 ≥ 内核 floor (0.4)，更低会被夹到 0.4，绝不放松内核底线。 */
  confidenceFloor?: number
  /**
   * 返回上限（默认 50）；按 value 降序取前 N。注意：候选先按 raw 取前 N 再过 floor，故窗口内若有
   * 低于 floor 的高 raw 候选被滤除，结果可能少于 N——不会从窗口外回填（窗口外 raw 必更低、必同样在 floor 下，
   * 故 g 单调下不存在被错漏的可消费 claim）。
   */
  limit?: number
}

/**
 * 把 LIKE 元字符（% _ \）转义成字面量，让 query 是确定性子串匹配而非通配。
 * 用反斜杠转义 —— 对齐 Postgres LIKE/ILIKE 的默认 escape 字符（无需显式 ESCAPE 子句）。
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 解析消费门下界：consumer 只能抬高。无效/未给 → 内核 floor；低于内核 floor → 夹到内核 floor。 */
function resolveFloor(confidenceFloor: number | undefined): number {
  if (typeof confidenceFloor !== 'number' || !Number.isFinite(confidenceFloor)) {
    return KERNEL_CONFIDENCE_FLOOR
  }
  return Math.max(KERNEL_CONFIDENCE_FLOOR, confidenceFloor)
}

/**
 * 召回：候选读 → g 映射 → 消费门过滤 → 拍快照。
 * query 为空串则不返回任何结果（无匹配语义，避免"召回全库"）。
 */
export async function recallClaims(
  db: DB,
  query: string,
  ctx: RecallContext = {},
): Promise<RecallResult[]> {
  if (typeof query !== 'string' || query.length === 0) return []

  // 配置态：活动规范（权重 + 门限）。改后新请求即刻按它重算（S7）；表空则用内核内置默认。
  const std = await getActiveStandards(db)
  // 消费下界取最严：配置态 consumeFloor 与请求态 ctx.confidenceFloor 都 ≥ 内核 0.4，取二者较大。
  const floor = Math.max(std.consumeFloor, resolveFloor(ctx.confidenceFloor))
  const limit = typeof ctx.limit === 'number' && ctx.limit > 0 ? ctx.limit : DEFAULT_RECALL_LIMIT
  const pattern = `%${escapeLike(query)}%`

  // 消费门第一层 = 状态可消费：只放 status=active（draft 影子区 / quarantined / superseded / flagged 全硬排除，
  // PRD A.4 状态表 / 设计稿消费门；晋升 draft→active 是 S13，在它到位前 append 的 claim 都是 draft，召回为空是正确的）。
  // ② 确定性子串命中 claim_text 或 subject。注意：召回用**活动权重重算** value（≠存档 confidence_raw），
  // 故不能在 SQL 里按 confidence_raw 排序/截断——排序与 limit 在 JS 侧按重算后的 value 做
  // （候选量由 query 子串匹配收敛；S9 向量召回会进一步收敛）。
  const candidates = await db
    .select({
      id: claim.id,
      claimText: claim.claimText,
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      status: claim.status,
      lineageId: claim.lineageId,
      asOf: claim.asOf,
      confidenceFactors: claim.confidenceFactors,
    })
    .from(claim)
    .where(
      and(
        eq(claim.status, 'active'),
        or(ilike(claim.claimText, pattern), ilike(claim.subject, pattern)),
      ),
    )

  // 召回瞬间：用活动权重对存档因子重算 raw（配置态变更即刻生效），再现算 g → value。整次 recall 共享 takenAt。
  const takenAt = new Date()
  const gated = candidates
    .map((c) => {
      // confidence_factors 是 jsonb；写路径是唯一写者且类型锁定（StoredConfidence），故此处盲转安全。
      const stored = c.confidenceFactors as StoredConfidence
      const raw = rawFromStoredFactors(stored.factors, std.factorWeights) // 活动权重重算
      // S7 阶段 g 仍只有 'identity'（g 是统计态、S28 接管，与配置态 w 分离）。未知版本 applyG 会抛 → S27/S28 处理。
      const value = applyG(raw, stored.calibrationVersion)
      return { c, raw, value, stored }
    })
    .filter((g) => g.value >= floor)

  if (gated.length === 0) return []

  // 出处扇出：一次查回所有过门 claim 的出处，按 claim 分组。无出处的 claim 绝不出现（D1 兜底）。
  const ids = gated.map((g) => g.c.id)
  const provRows = await db
    .select({
      claimId: claimProvenance.claimId,
      sourceId: claimProvenance.sourceId,
      locator: claimProvenance.locator,
      relevance: claimProvenance.relevance,
    })
    .from(claimProvenance)
    .where(inArray(claimProvenance.claimId, ids))

  const byClaim = new Map<string, RecalledProvenance[]>()
  for (const p of provRows) {
    const list = byClaim.get(p.claimId)
    const prov: RecalledProvenance = {
      sourceId: p.sourceId,
      locator: p.locator,
      relevance: p.relevance,
    }
    if (list) list.push(prov)
    else byClaim.set(p.claimId, [prov])
  }

  const results: RecallResult[] = []
  for (const g of gated) {
    const provenances = byClaim.get(g.c.id)
    if (!provenances || provenances.length === 0) continue // 无出处绝不出现
    results.push({
      claim: {
        id: g.c.id,
        claimText: g.c.claimText,
        subject: g.c.subject,
        predicate: g.c.predicate,
        object: g.c.object,
        status: g.c.status,
        lineageId: g.c.lineageId,
        asOf: g.c.asOf,
      },
      confidence: {
        value: g.value,
        raw: g.raw,
        factors: g.stored.factors,
        weights: std.factorWeights, // 活动权重入快照——"为什么当时这么信"可重建（历史快照随它冻结）
        calibrationVersion: g.stored.calibrationVersion,
        takenAt,
      },
      provenances,
      mustVerify: g.value < std.mustVerifyThreshold, // 配置态信任门
    })
  }

  // 召回用活动权重重算了 value，故排序/截断都在 JS 侧按 value 做：value 降序、平手 id 升序，取前 limit。
  results.sort((a, b) =>
    b.confidence.value !== a.confidence.value
      ? b.confidence.value - a.confidence.value
      : a.claim.id < b.claim.id
        ? -1
        : 1,
  )
  return results.slice(0, limit)
}
