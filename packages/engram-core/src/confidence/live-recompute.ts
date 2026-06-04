/**
 * confidence 的**召回时实时重算**抽取（S23）—— recall（消费读半边）与 editor inbox（主编审阅读半边）的
 * **单一真相源**。两条读路径都按这一处口径把「存档因子 + 活动权重 + 实时 f1/f2/f4 覆盖 + 实时 conflictDecay」
 * 合成 value=g(raw)，故 inbox 的「按 confidence 升序」与 recall 的「按 value 降序」用的是**同一个数**——
 * 绝不会因为 inbox 误读了可能过期的 claim.confidence 存档列而与 recall 漂移（S23 AC1 的硬约束）。
 *
 * 抽取来源：recall-claims.ts 原先内联的两段——①数每个候选的 active contradicts 边（实时矛盾计数），
 * ②用活动权重 × 存档因子 × 实时 f1/f2/f4 覆盖 × 实时 conflictDecay 现算 raw → applyG。
 * 抽出后 recall 与 inbox 各调一次，行为对二者都不变（recall 测试不动即证）。
 *
 * 纯读、确定性（给定库状态 + 活动规范）：零 LLM、零随机；时钟只用于 takenAt 快照（与 recall 一致）。
 */
import { and, eq, inArray, or } from 'drizzle-orm'

import {
  applyG,
  conflictDecay,
  rawFromStoredFactors,
  type CalibrationMap,
  type ConfidenceFactorBreakdown,
  type FactorWeights,
  type StoredConfidence,
} from './confidence.js'
import { loadCalibrationMaps } from '../calibration/calibration-store.js'
import type { DB } from '../db/client.js'
import { claim, relation } from '../db/schema.js'
import { latestEntailmentFactors } from '../verifier/patrol-verdict.js'
import { latestUsageCorrectFactors } from '../harvest/usage-correct.js'
import { latestHumanReviewFactors } from '../editor/human-review.js'

/**
 * 校准映射解析表（S27）：version → 该版本的 CalibrationMap。recall / inbox 在请求开头按候选 claim 钉的
 * **版本集合**批量解析（见 calibration-store.loadCalibrationMaps），再逐条同步喂给 applyG，保持纯/同步热路径。
 * identity 版本不必在此（applyG 对 identity 直通 raw、不查 map）；空表/全 identity → 空 Map 即可。
 */
export type CalibrationMaps = Map<string, CalibrationMap>

/** 一条 claim 实时重算后的 confidence 结果（recall / inbox 共用）。 */
export interface LiveConfidence {
  /** raw = base(存档因子 + 实时 f1/f2/f4 覆盖, 活动权重) × 存档 staleDecay × 实时 conflictDecay。 */
  raw: number
  /** value = g(raw)，按该 claim 存档的 calibrationVersion 现算。消费门/排序都用它。 */
  value: number
  /** 合成时实际用的因子（存档因子叠加实时 f1/f2/f4；未含两个衰减结果——它们另列）。 */
  factors: ConfidenceFactorBreakdown
  /** 实时 active contradicts 边数（对端仍 active 才算），喂 conflictDecay。 */
  activeContradicts: number
  /** 实时 conflictDecay = 1/(1+α·activeContradicts)。 */
  conflictDecay: number
  /** 与本 claim 矛盾且对端仍 active 的 claim id（去重，A.5「矛盾显式」双返）。 */
  contradicts: string[]
}

/**
 * 数一批候选 claim 各自的「实时活跃矛盾」对端集合：与之有 contradicts 边、且**对端仍 active** 的 claim id。
 * 「对端 active」一律按**真实 status 现查**判定，**绝不**把「在候选集里」当「active」——
 *   recall 候选恒为 active（候选查询带 status='active' 过滤），inbox 候选可含 draft/flagged/quarantined，
 *   若盲信「候选即 active」，一条 active claim 与一条 quarantined 对端的 contradicts 边会被误算成活跃矛盾、
 *   错误压低 conflictDecay 并把它假性冒泡到 inbox 队首（违反 A.5「矛盾显式只双返 active 对端」+ S23「升序最可疑在前」AC）。
 * 返回 Map<claimId, Set<对端id>>。自指边（from===to）跳过（写路径已挡，直插库兜底）；relation.to_claim 为空的半边跳过。
 */
export async function liveContradictsByClaim(
  db: DB,
  candidateIds: string[],
): Promise<Map<string, Set<string>>> {
  const byClaim = new Map<string, Set<string>>()
  if (candidateIds.length === 0) return byClaim
  const candidateSet = new Set(candidateIds)
  const edges = await db
    .select({ from: relation.fromClaim, to: relation.toClaim })
    .from(relation)
    .where(
      and(
        eq(relation.type, 'contradicts'),
        or(inArray(relation.fromClaim, candidateIds), inArray(relation.toClaim, candidateIds)),
      ),
    )
  // 矛盾边两端涉及的所有 id（候选与非候选一视同仁）现查真实 status：只有 status='active' 的才算活跃对端。
  // 候选自身的 active 性也在此现查（recall 候选恒 active → 自然命中；inbox 候选不预设、按真实态算）。
  const peerIds = [
    ...new Set(edges.flatMap((e) => [e.from, e.to]).filter((id): id is string => id != null)),
  ]
  const activeIds = new Set<string>()
  if (peerIds.length) {
    const rows = await db
      .select({ id: claim.id })
      .from(claim)
      .where(and(inArray(claim.id, peerIds), eq(claim.status, 'active')))
    for (const r of rows) activeIds.add(r.id)
  }
  const isActivePeer = (id: string): boolean => activeIds.has(id)
  return buildContradicts(edges, candidateSet, isActivePeer, byClaim)
}

/** 把矛盾边按候选分组（只收对端为「活跃对端」的边）。抽出便于在不同 active 口径间复用。 */
function buildContradicts(
  edges: { from: string; to: string | null }[],
  candidateSet: Set<string>,
  isActivePeer: (id: string) => boolean,
  byClaim: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const add = (a: string, b: string) => {
    const s = byClaim.get(a) ?? new Set<string>()
    s.add(b)
    byClaim.set(a, s)
  }
  for (const e of edges) {
    if (e.to == null) continue
    if (e.from === e.to) continue
    if (candidateSet.has(e.from) && isActivePeer(e.to)) add(e.from, e.to)
    if (candidateSet.has(e.to) && isActivePeer(e.from)) add(e.to, e.from)
  }
  return byClaim
}

/** 候选 claim 重算所需的最小输入（id + 存档因子）。recall / inbox 各从自己的 select 投影出它。 */
export interface RecomputeCandidate {
  id: string
  confidenceFactors: unknown
}

/**
 * 实时重算一批候选 claim 的 confidence（**recall 与 inbox 的单一口径**）。
 * 给定：候选（id + 存档因子）、活动权重、实时矛盾 Map、实时 f1/f2/f4 覆盖 Map。
 * 对每个候选：存档因子叠加有信号的实时 f1/f2/f4（无信号沿用存档）→ 用活动权重重算 base × 存档 staleDecay ×
 * 实时 conflictDecay → applyG。返回 Map<claimId, LiveConfidence>。与 recall-claims.ts 的 gated.map 逐字同款。
 *
 * f1/f2/f4 的覆盖 Map 由调用方批量查回（recall 与 inbox 都用 latest*Factors，无信号不入 Map → 不覆盖）。
 * 之所以让调用方传入而非这里查：recall 已在自己路径里查过一次，避免重复往返；inbox 也复用同三个查询。
 */
export function recomputeLiveConfidence(
  candidates: RecomputeCandidate[],
  weights: FactorWeights,
  contradictsByClaim: Map<string, Set<string>>,
  live: {
    humanReview: Map<string, number>
    entailment: Map<string, number>
    usageCorrect: Map<string, number>
  },
  // S27：候选 claim 各自钉的 calibrationVersion → 已解析的 g' 映射。identity 不必在此（applyG 直通）；
  // 缺省空 Map = 全 identity 老行为（向后兼容）。每条按**自己钉的版本**取 map → 老快照冻结在它当年的 g。
  maps: CalibrationMaps = new Map(),
): Map<string, LiveConfidence> {
  const out = new Map<string, LiveConfidence>()
  for (const c of candidates) {
    // confidence_factors 是 jsonb；写路径是唯一写者且类型锁定（StoredConfidence），故盲转安全（与 recall 一致）。
    const stored = c.confidenceFactors as StoredConfidence
    const contra = contradictsByClaim.get(c.id)
    const activeContradicts = contra ? contra.size : 0
    const cDecay = conflictDecay(activeContradicts)
    const liveHumanReview = live.humanReview.get(c.id)
    const liveEntailment = live.entailment.get(c.id)
    const liveUsageCorrect = live.usageCorrect.get(c.id)
    const factors: ConfidenceFactorBreakdown =
      liveHumanReview === undefined &&
      liveEntailment === undefined &&
      liveUsageCorrect === undefined
        ? stored.factors
        : {
            ...stored.factors,
            ...(liveHumanReview === undefined ? {} : { humanReview: liveHumanReview }),
            ...(liveEntailment === undefined ? {} : { entailment: liveEntailment }),
            ...(liveUsageCorrect === undefined ? {} : { usageCorrect: liveUsageCorrect }),
          }
    const raw = rawFromStoredFactors(factors, weights, { conflictDecay: cDecay })
    // 按该 claim 钉的版本取 g'（identity → applyG 直通、map 入参被忽略）。
    const value = applyG(raw, stored.calibrationVersion, maps.get(stored.calibrationVersion))
    out.set(c.id, {
      raw,
      value,
      factors,
      activeContradicts,
      conflictDecay: cDecay,
      contradicts: contra ? [...contra] : [],
    })
  }
  return out
}

/**
 * 一站式实时重算：给定候选 id 集，自查实时 f1/f2/f4 覆盖 + 实时矛盾 + 各候选钉的 g' 映射，按活动权重重算每条 value。
 * inbox 用它（recall 因已在自己路径查过这些信号、为省往返仍内联调底层 recomputeLiveConfidence + 自解析 maps）。
 */
export async function loadLiveConfidence(
  db: DB,
  candidates: RecomputeCandidate[],
  weights: FactorWeights,
): Promise<Map<string, LiveConfidence>> {
  const ids = candidates.map((c) => c.id)
  // 候选钉的非 identity 版本集合 → 批量解析 g' 映射（identity 不必解析）。
  const versions = candidates.map(
    (c) => (c.confidenceFactors as StoredConfidence).calibrationVersion,
  )
  const [contradictsByClaim, humanReview, entailment, usageCorrect, maps] = await Promise.all([
    liveContradictsByClaim(db, ids),
    latestHumanReviewFactors(db, ids),
    latestEntailmentFactors(db, ids),
    latestUsageCorrectFactors(db, ids),
    loadCalibrationMaps(db, versions),
  ])
  return recomputeLiveConfidence(
    candidates,
    weights,
    contradictsByClaim,
    { humanReview, entailment, usageCorrect },
    maps,
  )
}
