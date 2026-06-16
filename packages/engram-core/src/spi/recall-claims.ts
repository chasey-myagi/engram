/**
 * 召回路径（Consumer SPI 的读半边，附录 A.2）—— 最高测试缝。评测=消费，同走这条缝。
 *
 * recallClaims(db, embedder, query, ctx) 返回 RecallResult[]，每行带：
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
 * 召回不再读它。S9：候选源 = claim_text 嵌入的 HNSW 近邻 top-k（只嵌 claim_text，不再匹配 subject/谓/宾）。
 */
import { and, cosineDistance, eq, inArray, isNotNull } from 'drizzle-orm'

import { getActiveStandards } from '../config/standards.js'
import {
  DEFAULT_RECALL_MIN_SIMILARITY,
  DEFAULT_RECALL_TOPK,
  type Embedder,
} from '../embedding/embedder.js'
import {
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
  type ConfidenceFactorBreakdown,
  type FactorWeights,
} from '../confidence/confidence.js'
import { liveContradictsByClaim, recomputeLiveConfidence } from '../confidence/live-recompute.js'
import { loadCalibrationMaps } from '../calibration/calibration-store.js'
import type { DB } from '../db/client.js'
import {
  claim,
  claimProvenance,
  source,
  type ClaimStatus,
  type ProvRelevance,
} from '../db/schema.js'
import { latestEntailmentFactors } from '../verifier/patrol-verdict.js'
import { latestUsageCorrectFactors } from '../harvest/usage-correct.js'
import { latestHumanReviewFactors } from '../editor/human-review.js'
import { recordGap } from './metrics.js'

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

/**
 * 受控 source metadata 缝（EGR-CR-043）：core 把 `source.meta` 当不透明 jsonb，但消费侧（adapter / 评测）需要
 * 自己注入的业务身份来收紧。开一个**只读、受白名单约束**的缝顺 provenance 扇出带回，consumer 不再穿透 schema。
 * 白名单是「core 控制对外暴露面」的语义——只有列在此处的 key 才会进 `RecalledProvenance.sourceMeta`，
 * 其余 key（如 vendor / product_id）即便存在 `source.meta` 也不外泄。core 仍不解释这些 key 的业务含义。
 */
export const RECALL_SOURCE_META_KEYS = ['source_type'] as const

export interface RecalledProvenance {
  sourceId: string
  locator: string
  relevance: ProvRelevance
  /**
   * consumer 可消费的受控 source metadata 摘要（只读、白名单过滤、`Object.freeze`）。
   * core 把它当不透明键值对，不解释语义；adapter 据此（如 `sourceMeta.source_type`）收紧。
   * 无对应 meta key → 该 key 不出现；source 无任何白名单 key → `{}`（frozen）。
   */
  sourceMeta: Readonly<Record<string, unknown>>
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
  /** value 落在 [floor, mustVerifyThreshold) → true（可用但须先核验）；≥ 该门 → false。 */
  mustVerify: boolean
  /**
   * 与本 claim 存在 contradicts 边、且对方仍 active 的 claim id 列表（A.5「矛盾显式」：双返、不静默丢、不自动选）。
   * 其长度（去重后的 active 对端数，非底层边数）即喂 conflictDecay 的活跃矛盾计数 —— 冲突双方实时各吃惩罚。
   */
  contradicts: string[]
  /** 该 claim 向量的 embedding_version 锚（S9）；用于识别 stale 向量。无嵌入则 null。 */
  embeddingVersion: string | null
}

export interface RecallContext {
  /** 抬高消费门槛；只能 ≥ 内核 floor (0.4)，更低会被夹到 0.4，绝不放松内核底线。 */
  confidenceFloor?: number
  /**
   * 返回上限（默认 50）。S9 候选源 = HNSW 近邻 top-k；之后用活动权重重算 value → 过门 →
   * 按 value 降序(平手 id 升序)排序 → 最后 slice(limit)。结果是 min(过门数, N)。
   */
  limit?: number
  /** HNSW 近邻候选数（默认 50，A.6 top-k）。 */
  topK?: number
  /** 候选 cosine 相似度下界（默认见 DEFAULT_RECALL_MIN_SIMILARITY）；低于此的近邻视为不相关。 */
  minSimilarity?: number
}

/**
 * 批量查回各 source 的受控 metadata 摘要（EGR-CR-043 受控缝的实现）。
 * 只投影 `RECALL_SOURCE_META_KEYS` 白名单内、且实际存在于 `source.meta` 的 key；`Object.freeze` 保证只读。
 * core 不解释 key 语义——白名单只决定「哪些 key 允许外泄」，不决定它们的业务含义。
 */
async function readSourceMetaSummaries(
  db: DB,
  sourceIds: string[],
): Promise<Map<string, Readonly<Record<string, unknown>>>> {
  const map = new Map<string, Readonly<Record<string, unknown>>>()
  if (sourceIds.length === 0) return map
  const rows = await db
    .select({ id: source.id, meta: source.meta })
    .from(source)
    .where(inArray(source.id, sourceIds))
  for (const r of rows) {
    const meta = (r.meta ?? {}) as Record<string, unknown>
    const summary: Record<string, unknown> = {}
    for (const key of RECALL_SOURCE_META_KEYS) {
      if (Object.prototype.hasOwnProperty.call(meta, key)) summary[key] = meta[key]
    }
    map.set(r.id, Object.freeze(summary))
  }
  return map
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
  embedder: Embedder,
  query: string,
  ctx: RecallContext = {},
): Promise<RecallResult[]> {
  if (typeof query !== 'string' || query.length === 0) return []

  // 配置态：活动规范（权重 + 门限）。改后新请求即刻按它重算（S7）；表空则用内核内置默认。
  const std = await getActiveStandards(db)
  // 消费下界取最严：配置态 consumeFloor 与请求态 ctx.confidenceFloor 都 ≥ 内核 0.4，取二者较大。
  const floor = Math.max(std.consumeFloor, resolveFloor(ctx.confidenceFloor))
  const limit = typeof ctx.limit === 'number' && ctx.limit > 0 ? ctx.limit : DEFAULT_RECALL_LIMIT
  const topK = typeof ctx.topK === 'number' && ctx.topK > 0 ? ctx.topK : DEFAULT_RECALL_TOPK
  // 相似度下界：ctx 显式 > 嵌入器推荐（真模型语义空间更高）> 内核默认（适配 fake 子串空间）。
  const minSimilarity =
    typeof ctx.minSimilarity === 'number'
      ? ctx.minSimilarity
      : (embedder.minSimilarity ?? DEFAULT_RECALL_MIN_SIMILARITY)

  // 消费门第一层 = 状态可消费：只放 status=active（draft 影子区 / quarantined / superseded / flagged 全硬排除，
  // PRD A.4 状态表 / 设计稿消费门；晋升 draft→active 是 S13）。② 候选源（S9）= claim_text 嵌入的 HNSW 近邻
  // top-k（替代 S3 子串匹配；gate 不变）。NULL 向量行排除。重算/排序/limit 仍在 JS 侧（见下）。
  const queryVector = await embedder.embed(query, 'query')
  const distance = cosineDistance(claim.embedding, queryVector)
  const nn = await db
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
      embeddingVersion: claim.embeddingVersion,
      distance,
    })
    .from(claim)
    .where(
      and(
        eq(claim.status, 'active'),
        isNotNull(claim.embedding),
        // 版本等值门：只取当前 embedder 版本的向量。跨版本（含 NULL 版本）向量处于不同语义空间，
        // cosine 无意义，必须永不进候选——别等 reembed 抢在查询前跑完（EGR-CR-005）。
        eq(claim.embeddingVersion, embedder.version),
      ),
    )
    .orderBy(distance)
    .limit(topK)
  // 相似度下界：剔除 cosine 太低的近邻（小库下 top-k 会把无关项也带出；空查询/无相关 → 候选空 → 召回空）。
  const candidates = nn.filter((c) => 1 - Number(c.distance) >= minSimilarity)

  // S8 矛盾显式：数每个候选的 active contradicts 边（对端仍 active 才算活跃矛盾），喂实时 conflictDecay。
  // S23：抽到 live-recompute.ts 的 liveContradictsByClaim（recall / editor inbox 单一口径）。recall 候选恒为 active，
  // 故候选集内对端天然算活跃；助手会另补查非候选对端的 status，只把仍 active 的对端计入。行为与原内联逐字等价。
  const candidateIds = candidates.map((c) => c.id)
  const contradictsByClaim = await liveContradictsByClaim(db, candidateIds)

  // S17 f2 实时口径：召回时把 entailment 因子接到候选 claim **最新 patrol 裁决**（pass→1 / fail/not_co_true→0；
  // 无 patrol 则不覆盖、沿用存档值），与 conflictDecay 的实时重算同款（不吃写时快照、反映最新巡查）。一次批量查回。
  const entailmentByClaim = await latestEntailmentFactors(db, candidateIds)
  // S19 f4 实时口径：召回时把 usageCorrect 因子接到候选 claim 的 usage_truth 独立门控统计（observed_correctness→f4；
  // 无 usage 则不覆盖、沿用存档值），与 f2 同款实时口径（不吃写时快照、反映最新使用真值）。一次批量查回。
  const usageCorrectByClaim = await latestUsageCorrectFactors(db, candidateIds)
  // S22 f1 实时口径：召回时把 humanReview 因子接到候选 claim 的最新主编人审（Approve→1 / Reject→0；
  // 无人审则不覆盖、沿用存档值），与 f2/f4 同款实时口径（不吃写时快照、反映最新人审）。一次批量查回。
  const humanReviewByClaim = await latestHumanReviewFactors(db, candidateIds)

  // S27：按候选 claim **各自钉的** calibrationVersion 批量解析 g′ 映射（identity 不必解析、applyG 直通）。
  // 老快照冻结：每条按它钉的版本算 g，换活动版本不回溯改写老 claim。一次批量查回（热路径再同步 applyG）。
  const calibrationVersions = candidates.map(
    (c) => (c.confidenceFactors as { calibrationVersion: string }).calibrationVersion,
  )
  const calibrationMaps = await loadCalibrationMaps(db, calibrationVersions)

  // 召回瞬间：用活动权重对存档因子重算 raw（配置态变更即刻生效）+ 实时 conflictDecay，再现算 g → value。
  // S23：合成逻辑抽到 recomputeLiveConfidence（recall / editor inbox 单一口径）；recall 把已批量查回的实时
  // 矛盾/f1/f2/f4 + S27 g′ 映射传入（不重复往返），结果与原内联 gated.map 逐字等价。
  const takenAt = new Date()
  const liveById = recomputeLiveConfidence(
    candidates,
    std.factorWeights,
    contradictsByClaim,
    {
      humanReview: humanReviewByClaim,
      entailment: entailmentByClaim,
      usageCorrect: usageCorrectByClaim,
    },
    calibrationMaps,
  )
  const gated = candidates
    .map((c) => {
      const live = liveById.get(c.id)!
      return {
        c,
        raw: live.raw,
        value: live.value,
        // S7 起召回不再读存档 confidence 列；保留 calibrationVersion 入快照（从存档因子取）。
        calibrationVersion: (c.confidenceFactors as { calibrationVersion: string })
          .calibrationVersion,
        factors: live.factors,
        activeContradicts: live.activeContradicts,
        cDecay: live.conflictDecay,
        contradicts: live.contradicts,
      }
    })
    .filter((g) => g.value >= floor)

  // 出处扇出：一次查回所有过门 claim 的出处，按 claim 分组。无出处的 claim 绝不出现（D1 兜底）。
  // gated 空时跳过查询（避免 inArray([]) 的空 IN）；空结果统一在尾部走 gap 信号。
  const ids = gated.map((g) => g.c.id)
  const provRows = ids.length
    ? await db
        .select({
          claimId: claimProvenance.claimId,
          sourceId: claimProvenance.sourceId,
          locator: claimProvenance.locator,
          relevance: claimProvenance.relevance,
        })
        .from(claimProvenance)
        .where(inArray(claimProvenance.claimId, ids))
    : []

  // 受控 metadata 缝（EGR-CR-043）：一次批量查回涉及 source 的 meta，按白名单投影成只读摘要，
  // 顺 provenance 扇出带回。consumer 据 sourceMeta 收紧，不再穿透 schema 旁路查 source.meta。
  const sourceIds = [...new Set(provRows.map((p) => p.sourceId))]
  const metaBySource = await readSourceMetaSummaries(db, sourceIds)
  const emptyMeta = Object.freeze({}) as Readonly<Record<string, unknown>>

  const byClaim = new Map<string, RecalledProvenance[]>()
  for (const p of provRows) {
    const list = byClaim.get(p.claimId)
    const prov: RecalledProvenance = {
      sourceId: p.sourceId,
      locator: p.locator,
      relevance: p.relevance,
      sourceMeta: metaBySource.get(p.sourceId) ?? emptyMeta,
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
        // 快照里 entailment 反映**最新 patrol**（S17）、usageCorrect 反映**最新 usage_truth 独立统计**（S19）、
        // activeContradicts/conflictDecay 反映**实时**矛盾边数；其余因子取存档值。g.factors 已是「存档因子 + 实时 f2/f4 覆盖」。
        factors: {
          ...g.factors,
          activeContradicts: g.activeContradicts,
          conflictDecay: g.cDecay,
        },
        weights: std.factorWeights, // 活动权重入快照——"为什么当时这么信"可重建（历史快照随它冻结）
        calibrationVersion: g.calibrationVersion,
        takenAt,
      },
      provenances,
      mustVerify: g.value < std.mustVerifyThreshold, // 配置态信任门
      contradicts: g.contradicts,
      embeddingVersion: g.c.embeddingVersion, // S9 版本锚随快照
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
  const final = results.slice(0, limit)

  // 诚实信号（S10 / A.9）：非空 query 却交白卷 —— 无相关候选 / 候选全在门后(door-behind) / 兜底无出处 ——
  // 都落一条引用该 query 的 gap_recorded。这是消费关键路径上的设计写：库诚实记录「被问到却答不出」什么，
  // 喂「越用越准」的缺口回填；绝不拿门下/杜撰 claim 顶替「不知道」。空 query（开头已返回）不算提问、不记。
  if (final.length === 0) {
    await recordGap(db, query, {
      candidateCount: candidates.length,
      gatedCount: gated.length,
      floor,
      embedderVersion: embedder.version,
    })
    return []
  }
  return final
}
