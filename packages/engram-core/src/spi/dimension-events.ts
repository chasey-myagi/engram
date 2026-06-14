/**
 * L3 系统维度的 **append-only 度量脊柱**持久化（S30，A.9 stories 44/47/52，设计稿 FIG 10/10a「八维」）。
 *
 * 沿 metrics_events（gap_recorded，S10）/ redteam_immunity_scores（S29）的「只记事件 + 离线聚合」式样：
 * 每行 = 一次 run 在某维度上的一个读数（dimension + value + 诊断 payload + 落库时刻），**绝不可变**。
 * 维度用 **text 标签**（与 redteam_class 同款），故零触碰冻结枚举（红线#4：不新增 metrics_event_kind）。
 *
 * A3 红线在结构性边界：本表纯报告口径，**绝不进任何在线判据/校准 g/纵向计分**——
 * 拟合器 collectUsageCalibrationSamples 只读 usage_truth(claim_verification)，**从不**读本表，故维度值无路进 g。
 *
 * 时间序列（ΔECE↓ / Δcoverage↑ 可画曲线，P3 门）= getDimensionSeries 按 (dimension, created_at) 升序读出的 value 序列。
 */
import { randomUUID } from 'node:crypto'

import { and, asc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { dimensionEvents } from '../db/schema.js'

/**
 * 本切片落库的七个 substrate-ready 系统维度的稳定标签（设计稿八维去掉 ★⑦下游A/B 与 ★⑧纵向）。
 * ★⑧「纵向越用越好」**刻意不在本切片计算**——其生产者是 S31 的同卷复考（recompete），迁移到 S31 以避免
 * 「先落维度、后有生产者」（见 eval/system-dimensions.ts 的 RELOCATED_TO_S31 说明）。⑦下游A/B 无生产者切片、出 scope。
 */
export const DIMENSION = Object.freeze({
  /** ①P@k：召回前 k 命中期望 claim 的精确率。 */
  precisionAtK: 'precision_at_k',
  /** ①R@k：召回前 k 覆盖期望 claim 集的召回率。 */
  recallAtK: 'recall_at_k',
  /** ②grounding：召回 claim 钻回出处的占比（无出处不计数）。 */
  grounding: 'grounding',
  /** ★③校准 ECE：来自 S5 computeReliability（反映 S28 拟合的 g）。 */
  ece: 'ece',
  /** ④覆盖：golden 中库能答（越消费门）的占比。 */
  coverage: 'coverage',
  /** ⑤时效：召回/活跃 claim 中越过 kind 半衰期（staleDecay）的占比。 */
  staleness: 'staleness',
  /** ★⑥免疫红队：取自 S29 redteam_immunity_scores 的检出率（不重算、不进计分）。 */
  immunity: 'immunity',
} as const)

/** 本切片落库的七维标签集合（dimension 列的合法取值；纯文本、内核不解释其它标签）。 */
export type DimensionName = (typeof DIMENSION)[keyof typeof DIMENSION]
export const DIMENSION_NAMES: readonly DimensionName[] = Object.freeze(
  Object.values(DIMENSION),
) as readonly DimensionName[]

/** runtime 白名单守卫：dimension 必须 ∈ DIMENSION_NAMES（与 longitudinal-recompete 的 isRecompeteDimension 同款）。 */
export function isDimensionName(x: string): x is DimensionName {
  return (DIMENSION_NAMES as readonly string[]).includes(x)
}

/** dimension_events 一行的读出形状。 */
export interface DimensionEvent {
  id: string
  runId: string
  dimension: string
  /** 该维度本次 run 的标量读数 ∈ [0,1]。 */
  value: number
  payload: Record<string, unknown>
  createdBy: string
  createdAt: Date
}

function toDimensionEvent(row: typeof dimensionEvents.$inferSelect): DimensionEvent {
  return {
    id: row.id,
    runId: row.runId,
    dimension: row.dimension,
    value: row.value,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

export interface RecordDimensionInput {
  runId: string
  dimension: DimensionName
  value: number
  payload?: Record<string, unknown>
  createdBy?: string
}

/**
 * 追加一条维度读数（append-only）。value 必须 ∈ [0,1]（顺带挡 NaN：NaN>=0 为 false）；runId 非空。
 * 写者唯一来路 = runSystemDimensions 的离线聚合；手工调用同样受值域硬门约束（坏读数物理写不进、不污染时间序列）。
 */
export async function recordDimension(
  db: DB,
  input: RecordDimensionInput,
): Promise<{ eventId: string }> {
  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    throw new Error('recordDimension: runId must be a non-empty string')
  }
  // A3 硬门：非白名单维度物理写不进（ELO/胜负率/reward 等绝不进评测脊柱）。
  if (typeof input.dimension !== 'string' || !isDimensionName(input.dimension)) {
    throw new Error(
      `recordDimension: dimension must be one of ${DIMENSION_NAMES.join(', ')} ` +
        `(A3: ELO/win-rate/reward barred from the eval spine), got ${JSON.stringify(input.dimension)}`,
    )
  }
  if (!(input.value >= 0 && input.value <= 1)) {
    throw new Error(
      `recordDimension: value must be in [0,1] (got ${JSON.stringify(input.value)} for ${input.dimension})`,
    )
  }
  const id = randomUUID()
  await db.insert(dimensionEvents).values({
    id,
    runId: input.runId,
    dimension: input.dimension,
    value: input.value,
    payload: input.payload ?? {},
    createdBy: input.createdBy ?? 'eval:l3',
  })
  return { eventId: id }
}

/** 枚举维度事件（可按 dimension / runId 过滤），按时间升序（确定性、id 次级排序）。离线聚合取数口。 */
export async function getDimensionEvents(
  db: DB,
  filter: { dimension?: DimensionName; runId?: string } = {},
): Promise<DimensionEvent[]> {
  const conds = []
  if (filter.dimension !== undefined) conds.push(eq(dimensionEvents.dimension, filter.dimension))
  if (filter.runId !== undefined) conds.push(eq(dimensionEvents.runId, filter.runId))
  const rows = await db
    .select()
    .from(dimensionEvents)
    .where(conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds))
    .orderBy(asc(dimensionEvents.createdAt), asc(dimensionEvents.id))
  return rows.map(toDimensionEvent)
}

/** 一段时间序列的一个点（画曲线用）。 */
export interface DimensionSeriesPoint {
  runId: string
  value: number
  createdAt: Date
}

/**
 * **时间序列读路径**（P3 门：ΔECE↓ / Δcoverage↑ 可画曲线）：某维度按 created_at 升序的 (runId, value, createdAt) 序列。
 * 直接喂折线图：ece 序列应随 run 递减、coverage 序列应随 run 递增即为「越用越准」的可读证据。
 */
export async function getDimensionSeries(
  db: DB,
  dimension: DimensionName,
): Promise<DimensionSeriesPoint[]> {
  const rows = await db
    .select({
      runId: dimensionEvents.runId,
      value: dimensionEvents.value,
      createdAt: dimensionEvents.createdAt,
    })
    .from(dimensionEvents)
    .where(eq(dimensionEvents.dimension, dimension))
    .orderBy(asc(dimensionEvents.createdAt), asc(dimensionEvents.id))
  return rows.map((r) => ({ runId: r.runId, value: r.value, createdAt: r.createdAt }))
}
