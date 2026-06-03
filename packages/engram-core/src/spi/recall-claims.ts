/**
 * 召回路径（Consumer SPI 的读半边，附录 A.2）—— 最高测试缝。评测=消费，同走这条缝。
 *
 * recallClaims(db, query, ctx) 返回 RecallResult[]，每行带：
 *   - claim 本体
 *   - 召回瞬间拍下的 ConfidenceSnapshot（value=g(raw) / raw / 因子 / 权重 / 校准版本 / takenAt）
 *   - provenances[]（每个结果至少 1 条出处；无出处的 claim 绝不出现）
 *   - mustVerify（落在 [0.4,0.6) 的可用但须先核验）
 *
 * 内核消费门（硬判据）：value<0.4 永不出现；0.4≤value<0.6 带 mustVerify=true；value≥0.6 mustVerify=false。
 * ctx.confidenceFloor 只能**抬高**门槛（≥0.4），更低会被夹到 0.4 —— consumer 可更严，绝不能放松内核底线。
 *
 * 关键设计：raw 写时存、g 召回时现算（value=applyG(raw, 版本)）。所以 S27/S28 换 g（identity↔isotonic）
 * 对所有召回即时生效，无需回写每条 claim。检索匹配 S3 用确定性子串（text/subject）；语义向量是 S9。
 */
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm'

import {
  applyG,
  type ConfidenceFactorBreakdown,
  type FactorWeights,
  type StoredConfidence,
} from '../confidence/confidence.js'
import type { DB } from '../db/client.js'
import { claim, claimProvenance, type ClaimStatus, type ProvRelevance } from '../db/schema.js'

/** 内核消费门下界（A.2）：低于此的 claim 绝不进入召回结果。consumer 只能抬高，不能降低。 */
export const KERNEL_CONFIDENCE_FLOOR = 0.4
/** 信任门：value<此值的结果带 mustVerify=true（可用但须先核验）；≥此值可直接用。内核绝对语义，不随 floor 变。 */
export const MUST_VERIFY_THRESHOLD = 0.6
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

  const floor = resolveFloor(ctx.confidenceFloor)
  const limit = typeof ctx.limit === 'number' && ctx.limit > 0 ? ctx.limit : DEFAULT_RECALL_LIMIT
  const pattern = `%${escapeLike(query)}%`

  // 消费门是两层。第一层 = 状态可消费：只放 status=active。draft=影子区(不召回)、quarantined=不可消费、
  // superseded=已被取代、flagged=降权可见(降权机制 S17 产出前先一并硬排除) —— 依据 PRD A.4 状态表
  // 「影子区不召回」与设计稿消费门「conf≥0.6 ∧ status=active」。注意：晋升路径(draft→active)是 S13，
  // 在它到位前经 SPI 写入的 claim 都是 draft，召回为空是**正确**的（不召回未治理内容）。第二层 = conf band，在下面。
  // 取法：按 raw 降序、平手 id 升序，DB 侧 LIMIT 兜住内存。g 单调非降（identity/isotonic），故 raw 序 = value 序，
  // 这条有界 top-N 正确（高 conf 在前，floor 过滤掉的必是尾部）。
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
      confidenceRaw: claim.confidenceRaw,
      confidenceFactors: claim.confidenceFactors,
    })
    .from(claim)
    .where(
      and(
        eq(claim.status, 'active'),
        or(ilike(claim.claimText, pattern), ilike(claim.subject, pattern)),
      ),
    )
    .orderBy(desc(claim.confidenceRaw), asc(claim.id))
    .limit(limit)

  // g 召回时现算 → 消费门过滤。整次 recall 共享同一 takenAt（"召回瞬间")。
  const takenAt = new Date()
  const gated = candidates
    .map((c) => {
      // confidence_factors 是 jsonb；写路径是唯一写者且类型锁定（StoredConfidence），故此处盲转安全。
      const stored = c.confidenceFactors as StoredConfidence
      const raw = c.confidenceRaw
      // S3 只有 'identity' 一个 g。未知 calibrationVersion 会让 applyG 抛错、整次召回失败——
      // 当 S27/S28 引入多 g 版本并支持回滚时，这里需改成按行隔离/退化（unknown→跳过或落 floor）；此切片不处理。
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
        weights: g.stored.weights,
        calibrationVersion: g.stored.calibrationVersion,
        takenAt,
      },
      provenances,
      mustVerify: g.value < MUST_VERIFY_THRESHOLD,
    })
  }

  // SQL 的 (raw 降序, id 升序) LIMIT 只负责**正确地选出候选集合**：g 单调非降 ⇒ top-N-by-raw 与
  // top-N-by-value 是同一集合（floor 过滤掉的必是尾部）。最终**顺序**在此按 (value 降序, id 升序) 重排——
  // 这样即便将来 g 非严格单调（S28 isotonic 的阶梯把不同 raw 映到同一 value），同 value 的平手仍按 id 升序，
  // 文档化的确定性次序对所有 g 成立（不依赖 raw 当二级键）。results 已 ≤ limit，无需再 slice。
  results.sort((a, b) =>
    b.confidence.value !== a.confidence.value
      ? b.confidence.value - a.confidence.value
      : a.claim.id < b.claim.id
        ? -1
        : 1,
  )
  return results
}
