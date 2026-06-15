/**
 * 纵向冻结-golden 同卷复考（S31，**第⑧维「越用越好」**，A.9 stories 47/49；设计稿 FIG 10/10a 八维第⑧维 +
 * FIG「外环·release/纵向·越用越好验证：同卷复考 frozen golden 在 T0/T1/T2 重放 → ΔECE↓·Δcoverage↑ append-only」）。
 *
 * S30 把第⑧维**刻意迁到这里**（RELOCATED_TO_S31）：其生产者就是本模块的同卷复考。
 *
 * 做的事：取一个**冻结 golden**（**复用 S30 的 L3_GOLDEN + DIMENSION 定义** ⇒ 跨 release 同题、同维定义、可比），
 * 在**≥2 个 release 快照**上对**同一卷**重考，emit **append-only** 的 ΔECE↓ / Δcoverage↑ delta，**绝不回改**任一
 * 历史快照（重考新 release 只追新行）。纵向曲线（ΔECE↓ / Δcoverage↑）可直接画（getRecompeteSeries 读 value/delta 序列）。
 *
 * **三环嵌套**（设计稿 FIG，回灌三环）—— 同一卷复考的读数按它属哪一环标注：
 *   - inner（内环·秒级实时消费）：当前活动 g 改了召回 value（实时消费用 g(raw)）—— 「live g 改召回值」。
 *   - mid（中环·分/时级校准回灌）：真值→ECE→Fitter 产候选 g'→验收门→原子替换（校准回灌重拟 g）。
 *   - outer（外环·release/纵向）：**冻结 golden 同卷复考**跨 release —— 纵向曲线的**承重产线**就是 outer 环。
 *   三环用**同一套 S30 维度定义**算 ECE/coverage，故 inner/mid/outer 的读数同口径、可叠在一条曲线上对比。
 *
 * **A3 红线**（结构性边界）：复考输入**只取 ECE/coverage 等八维量**，**绝不**含 ELO/胜负率/reward——
 * recordRecompete 在写入处**硬拒**非白名单维度（RECOMPETE_DIMENSIONS）；纵向 Δ 物理上无路承载奖励信号。
 *
 * 同卷复考全经 Consumer SPI（computeSystemDimensions 只调 recall_claims / computeCalibrationFromUsage，零专用路径）。
 */
import type { DB } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import { recompeteEvents } from '../db/schema.js'
import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq } from 'drizzle-orm'

import { DIMENSION } from '../spi/dimension-events.js'
import {
  computeSystemDimensions,
  L3_GOLDEN,
  L3_GOLDEN_NAMESPACE,
  type ComputeOptions,
  type SystemGoldenItem,
} from './system-dimensions.js'

/**
 * 复考维度白名单（**A3 红线的结构性边界**）：纵向 Δ 只能由这两维构成——**与 S30 DIMENSION 同定义**
 * （'ece' / 'coverage'），跨 release 可比。**绝不**含 ELO/胜负率/reward。recordRecompete 拒任何不在此集的 dimension。
 */
export const RECOMPETE_DIMENSIONS = Object.freeze([DIMENSION.ece, DIMENSION.coverage] as const)
export type RecompeteDimension = (typeof RECOMPETE_DIMENSIONS)[number]

/** 三环标签（设计稿回灌三环；纯文本，与 S30 维度同口径算）。 */
export const RING = Object.freeze({
  /** 内环·秒级实时消费：当前活动 g 改召回 value。 */
  inner: 'inner',
  /** 中环·分/时级校准回灌：真值→ECE→Fitter→验收门→换 g。 */
  mid: 'mid',
  /** 外环·release/纵向：冻结 golden 同卷复考（纵向曲线承重产线）。 */
  outer: 'outer',
} as const)
export type Ring = (typeof RING)[keyof typeof RING]
export const RINGS: readonly Ring[] = Object.freeze(Object.values(RING)) as readonly Ring[]

/** 这套冻结复考卷的默认 golden 版本标签（**与 S30 同一冻结夹具**；同版本 ⇒ 同题，跨 release 可比的锚）。 */
export const FROZEN_GOLDEN_VERSION = `${L3_GOLDEN_NAMESPACE}:v1` as const

/** recompete_events 一行的读出形状。 */
export interface RecompeteEvent {
  id: string
  frozenGoldenVersion: string
  releaseSnapshot: string
  dimension: string
  value: number
  /** 相对上一 release 快照同维的改善量（ECE: prev−curr；coverage: curr−prev）。首快照=null（基线）。 */
  delta: number | null
  ring: string
  payload: Record<string, unknown>
  createdBy: string
  createdAt: Date
}

function toRecompeteEvent(row: typeof recompeteEvents.$inferSelect): RecompeteEvent {
  return {
    id: row.id,
    frozenGoldenVersion: row.frozenGoldenVersion,
    releaseSnapshot: row.releaseSnapshot,
    dimension: row.dimension,
    value: row.value,
    delta: row.delta,
    ring: row.ring,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

function isRecompeteDimension(x: string): x is RecompeteDimension {
  return (RECOMPETE_DIMENSIONS as readonly string[]).includes(x)
}

function isRing(x: string): x is Ring {
  return (RINGS as readonly string[]).includes(x)
}

export interface RecordRecompeteInput {
  frozenGoldenVersion: string
  releaseSnapshot: string
  dimension: RecompeteDimension
  value: number
  delta: number | null
  ring: Ring
  payload?: Record<string, unknown>
  createdBy?: string
}

/**
 * 追加一条复考读数（append-only）。**A3 硬门**：dimension 必须 ∈ RECOMPETE_DIMENSIONS（ELO/胜负率/reward 物理写不进）；
 * ring 必须 ∈ RINGS。value ∈ [0,1]（顺带挡 NaN）。delta 可为 null（首快照基线）或有限数。
 * **绝不回改历史**：每次只追新行；纵向是跨 release 的多批。
 */
export async function recordRecompete(
  db: DB,
  input: RecordRecompeteInput,
): Promise<{ eventId: string }> {
  if (!isRecompeteDimension(input.dimension)) {
    throw new Error(
      `recordRecompete: dimension must be one of ${RECOMPETE_DIMENSIONS.join(', ')} (A3: ELO/win-rate/reward barred from the longitudinal trend), got ${JSON.stringify(input.dimension)}`,
    )
  }
  if (!isRing(input.ring)) {
    throw new Error(
      `recordRecompete: ring must be one of ${RINGS.join(', ')}, got ${JSON.stringify(input.ring)}`,
    )
  }
  if (!(input.value >= 0 && input.value <= 1)) {
    throw new Error(`recordRecompete: value must be in [0,1] (got ${JSON.stringify(input.value)})`)
  }
  if (input.delta !== null && !Number.isFinite(input.delta)) {
    throw new Error(
      `recordRecompete: delta must be a finite number or null (got ${JSON.stringify(input.delta)})`,
    )
  }
  if (input.releaseSnapshot.trim().length === 0 || input.frozenGoldenVersion.trim().length === 0) {
    throw new Error('recordRecompete: frozenGoldenVersion and releaseSnapshot must be non-empty')
  }
  const id = randomUUID()
  await db.insert(recompeteEvents).values({
    id,
    frozenGoldenVersion: input.frozenGoldenVersion,
    releaseSnapshot: input.releaseSnapshot,
    dimension: input.dimension,
    value: input.value,
    delta: input.delta,
    ring: input.ring,
    payload: input.payload ?? {},
    createdBy: input.createdBy ?? 'eval:recompete',
  })
  return { eventId: id }
}

/** 取某 (golden 版本, 维度) 的**上一 release 快照**的 value（按 created_at 降序取第一行）。无前序 ⇒ null。 */
async function latestPriorValue(
  db: DB,
  frozenGoldenVersion: string,
  dimension: RecompeteDimension,
): Promise<number | null> {
  const [row] = await db
    .select({ value: recompeteEvents.value })
    .from(recompeteEvents)
    .where(
      and(
        eq(recompeteEvents.frozenGoldenVersion, frozenGoldenVersion),
        eq(recompeteEvents.dimension, dimension),
      ),
    )
    .orderBy(desc(recompeteEvents.createdAt), desc(recompeteEvents.id))
    .limit(1)
  return row ? row.value : null
}

/**
 * Δ 方向（**越用越好**的符号约定）：
 *   - ECE：改善 = 下降，故 delta = prev − curr（ΔECE↓ 为正）。
 *   - coverage：改善 = 上升，故 delta = curr − prev（Δcoverage↑ 为正）。
 * 首快照（prev=null）⇒ delta=null（基线，无前序可比）。
 */
function computeDelta(
  dimension: RecompeteDimension,
  prev: number | null,
  curr: number,
): number | null {
  if (prev === null) return null
  return dimension === DIMENSION.ece ? prev - curr : curr - prev
}

export interface RecompeteReport {
  frozenGoldenVersion: string
  releaseSnapshot: string
  ring: Ring
  /** 本次复考各维的 (value, delta)（dimension 顺序 = RECOMPETE_DIMENSIONS）。 */
  results: { dimension: RecompeteDimension; value: number; delta: number | null; eventId: string }[]
}

export interface RunRecompeteOptions extends ComputeOptions {
  /** 复考所对的冻结 golden 版本（默认 FROZEN_GOLDEN_VERSION）。 */
  frozenGoldenVersion?: string
  /** 本读数属哪一环（默认 outer——纵向承重环）。 */
  ring?: Ring
  /** 冻结题集（默认 L3_GOLDEN；显式传等于换一卷，仍要求跨 release 同传同一卷才可比）。 */
  golden?: readonly SystemGoldenItem[]
  createdBy?: string
}

/**
 * **跑一次 release 快照的同卷复考**：用**冻结 golden**（默认 L3_GOLDEN）经 computeSystemDimensions（评测=消费）算
 * ECE/coverage，对每维**相对上一快照求 Δ** 并 **append-only 落 recompete_events**（绝不回改历史）。
 *
 * 同卷可比：跨 release **必须传同一 frozenGoldenVersion + 同一 golden 卷**——这是「区分系统变好 vs 题变易」的锚。
 * 默认 ring='outer'（外环纵向）；inner/mid 环用同一函数、同一卷、传 ring 即可，三环读数同口径可叠一条曲线。
 */
export async function runRecompeteSnapshot(
  db: DB,
  embedder: Embedder,
  releaseSnapshot: string,
  opts: RunRecompeteOptions = {},
): Promise<RecompeteReport> {
  const frozenGoldenVersion = opts.frozenGoldenVersion ?? FROZEN_GOLDEN_VERSION
  const ring = opts.ring ?? RING.outer
  const golden = opts.golden ?? L3_GOLDEN
  // computeSystemDimensions 全经 Consumer SPI（零专用路径）算同卷各维。
  const dims = await computeSystemDimensions(db, embedder, {
    ...(opts.k !== undefined ? { k: opts.k } : {}),
    golden,
    ...(opts.immunityGeneration !== undefined
      ? { immunityGeneration: opts.immunityGeneration }
      : {}),
    ...(opts.ctx !== undefined ? { ctx: opts.ctx } : {}),
  })

  const dimValue: Record<RecompeteDimension, number> = {
    ece: dims.ece,
    coverage: dims.coverage,
  }

  const results: RecompeteReport['results'] = []
  for (const dimension of RECOMPETE_DIMENSIONS) {
    const value = dimValue[dimension]
    const prev = await latestPriorValue(db, frozenGoldenVersion, dimension)
    const delta = computeDelta(dimension, prev, value)
    const { eventId } = await recordRecompete(db, {
      frozenGoldenVersion,
      releaseSnapshot,
      dimension,
      value,
      delta,
      ring,
      // EGR-CR-029：记录本次 ECE 读数所用的 g 版本集合，使纵向曲线每个点都能回溯其口径（混版不静默）。
      payload: {
        prev,
        goldenCount: golden.length,
        calibrationFromVersions: dims.diagnostics.ece.fromVersions,
      },
      ...(opts.createdBy !== undefined ? { createdBy: opts.createdBy } : {}),
    })
    results.push({ dimension, value, delta, eventId })
  }
  return { frozenGoldenVersion, releaseSnapshot, ring, results }
}

/** 纵向曲线的一个点（画 ΔECE↓ / Δcoverage↑ 曲线用）。 */
export interface RecompeteSeriesPoint {
  releaseSnapshot: string
  ring: string
  value: number
  delta: number | null
  createdAt: Date
}

/**
 * **纵向曲线读路径**（P3 门：ΔECE↓ / Δcoverage↑ 可画曲线）：某 (冻结 golden 版本, 维度) 按 created_at 升序的
 * (release, ring, value, delta) 序列。直接喂折线图：ece 的 value 序列应随 release 递减、delta（=prev−curr）应 ≥0；
 * coverage 的 value 序列应随 release 递增、delta（=curr−prev）应 ≥0，即为「越用越准」的可读证据。可按 ring 过滤
 * （只画外环纵向 / 三环叠看）。
 */
export async function getRecompeteSeries(
  db: DB,
  dimension: RecompeteDimension,
  opts: { frozenGoldenVersion?: string; ring?: Ring } = {},
): Promise<RecompeteSeriesPoint[]> {
  const frozenGoldenVersion = opts.frozenGoldenVersion ?? FROZEN_GOLDEN_VERSION
  const conds = [
    eq(recompeteEvents.frozenGoldenVersion, frozenGoldenVersion),
    eq(recompeteEvents.dimension, dimension),
  ]
  if (opts.ring !== undefined) conds.push(eq(recompeteEvents.ring, opts.ring))
  const rows = await db
    .select({
      releaseSnapshot: recompeteEvents.releaseSnapshot,
      ring: recompeteEvents.ring,
      value: recompeteEvents.value,
      delta: recompeteEvents.delta,
      createdAt: recompeteEvents.createdAt,
    })
    .from(recompeteEvents)
    .where(and(...conds))
    .orderBy(asc(recompeteEvents.createdAt), asc(recompeteEvents.id))
  return rows.map((r) => ({
    releaseSnapshot: r.releaseSnapshot,
    ring: r.ring,
    value: r.value,
    delta: r.delta,
    createdAt: r.createdAt,
  }))
}

/** 取一次 release 快照的全部复考读数（按 dimension/ring 维度，确定性序）。审计/审查用。 */
export async function getRecompeteEvents(
  db: DB,
  filter: { frozenGoldenVersion?: string; releaseSnapshot?: string } = {},
): Promise<RecompeteEvent[]> {
  const conds = []
  if (filter.frozenGoldenVersion !== undefined)
    conds.push(eq(recompeteEvents.frozenGoldenVersion, filter.frozenGoldenVersion))
  if (filter.releaseSnapshot !== undefined)
    conds.push(eq(recompeteEvents.releaseSnapshot, filter.releaseSnapshot))
  const rows = await db
    .select()
    .from(recompeteEvents)
    .where(conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds))
    .orderBy(asc(recompeteEvents.createdAt), asc(recompeteEvents.id))
  return rows.map(toRecompeteEvent)
}
