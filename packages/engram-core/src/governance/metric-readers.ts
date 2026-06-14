/**
 * 恒温器五指标的**生产读取口径**（S26，A.8）—— 每个 reader 独立从既有 SPI/表算一个标量。
 *
 * **每个 reader 各自 try/catch、独立降级**（readMetrics 把 reader 错误吞成 NEUTRAL 值并记一条 degraded 标记）：
 * 某个指标源炸了不掀翻整轮控制、更不碰读写主干——这是「失效静音退回三层主干」红线在度量层的兑现。
 *
 * falseQuarantineRate 在**生产路径**由真 S22 human_overturn 事件喂（getHumanOverturns，un_quarantine 类）；
 * L2 仿真另走合成时序注入（不经本模块）。
 *
 * immuneLag（flag→quarantine 中位延迟）：当前 schema 不存状态翻转时戳（claim 只有单一 createdAt，
 * 状态机 transitionClaim 不落带时戳的迁移流水），故**无可靠数据源** → 本 reader 诚实返回中性 0 并标 degraded，
 * 绝不杜撰延迟（呼应 gap_recorded 的「不知道就说不知道」取向）。真延迟统计待状态迁移事件落库后接入。
 */
import { eq, inArray, sql } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { claim, claimVerification } from '../db/schema.js'
import { getEditorConflictQueue } from '../spi/conflict-arbiter.js'
import { getHumanOverturns } from '../editor/human-overturn.js'
import type { GovernanceMetrics } from './control-law.js'

/** 单个指标读取结果：度量值 + 是否有意降级（无数据源/部分降级）+ 原因。 */
export interface MetricRead {
  value: number
  degraded?: boolean
  reason?: string
}

/** 单个指标读取器：纯读、返回结构化结果；抛错仍由 readMetrics 兜（视为降级）。 */
export type MetricReader = (db: DB) => Promise<MetricRead>

/** 五个指标读取器的 bundle（可逐个替换/注入，便于测试与降级演示）。 */
export interface MetricReaders {
  distillBacklog: MetricReader
  entailRejectRate: MetricReader
  conflictQueueDepth: MetricReader
  immuneLag: MetricReader
  falseQuarantineRate: MetricReader
}

/** 各指标降级时退回的中性值（=「无压力」，不会凭空触发收紧；silent-safe）。 */
export const NEUTRAL_METRICS: GovernanceMetrics = {
  distillBacklog: 0,
  entailRejectRate: 0,
  conflictQueueDepth: 0,
  immuneLag: 0,
  falseQuarantineRate: 0,
}

/** distillBacklog：当前处于 draft 的 claim 数（待晋升/待蒸馏消化的积压）。 */
export async function readDistillBacklog(db: DB): Promise<MetricRead> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(claim)
    .where(eq(claim.status, 'draft'))
  return { value: row?.n ?? 0 }
}

/**
 * entailRejectRate：patrol 巡查里 entailment ∈ {fail, not_co_true} 的占比（每 claim 取最新一条 entailment 裁决）。
 * 无任何 entailment 巡查 → 0（无拒绝压力）。与 patrol-verdict 同口径：倒序逐行、每 claim 取首条带 entailment 的。
 */
export async function readEntailRejectRate(db: DB): Promise<MetricRead> {
  const rows = await db
    .select({
      claimId: claimVerification.claimId,
      verdict: claimVerification.verdict,
      createdAt: claimVerification.createdAt,
      id: claimVerification.id,
    })
    .from(claimVerification)
    .where(eq(claimVerification.kind, 'patrol'))
    .orderBy(sql`${claimVerification.createdAt} desc`, sql`${claimVerification.id} desc`)
  const latestByClaim = new Map<string, 'pass' | 'fail' | 'not_co_true'>()
  for (const r of rows) {
    if (latestByClaim.has(r.claimId)) continue
    const v = r.verdict as { entailment?: unknown } | null
    const e = v?.entailment
    if (e === 'pass' || e === 'fail' || e === 'not_co_true') latestByClaim.set(r.claimId, e)
  }
  if (latestByClaim.size === 0) return { value: 0 }
  let reject = 0
  for (const e of latestByClaim.values()) if (e === 'fail' || e === 'not_co_true') reject += 1
  return { value: reject / latestByClaim.size }
}

/** conflictQueueDepth：待人裁的升级冲突条数（getEditorConflictQueue）。 */
export async function readConflictQueueDepth(db: DB): Promise<MetricRead> {
  const queue = await getEditorConflictQueue(db)
  return { value: queue.length }
}

/**
 * immuneLag：flag→quarantine 中位延迟（秒）。当前 schema 无状态迁移时戳 → 无可靠数据源。
 * 诚实降级为中性 0 并自报 degraded（绝不杜撰延迟）。真延迟统计待状态迁移事件落库后接入。
 */
export async function readImmuneLag(_db: DB): Promise<MetricRead> {
  return { value: 0, degraded: true, reason: 'no state-transition timestamp source' }
}

/**
 * falseQuarantineRate：人工翻案的误隔离率 ∈ [0,1]。**生产信号 = S22 human_overturn(un_quarantine)**。
 *   rate = un_quarantine 翻案数 / (un_quarantine 翻案数 + 当前仍处 quarantined 的 claim 数)
 * 即「被隔离后又被人翻案」占「全部被隔离过」的近似比率。分母为 0（从无隔离）→ 0。
 */
export async function readFalseQuarantineRate(db: DB): Promise<MetricRead> {
  const overturns = await getHumanOverturns(db)
  const unQuarantine = overturns.filter((o) => o.payload.overturn === 'un_quarantine').length
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(claim)
    .where(inArray(claim.status, ['quarantined']))
  const stillQuarantined = row?.n ?? 0
  const denom = unQuarantine + stillQuarantined
  if (denom === 0) return { value: 0 }
  return { value: unQuarantine / denom }
}

/** 生产默认 readers：全部接真 SPI/表。 */
export const defaultMetricReaders: MetricReaders = {
  distillBacklog: readDistillBacklog,
  entailRejectRate: readEntailRejectRate,
  conflictQueueDepth: readConflictQueueDepth,
  immuneLag: readImmuneLag,
  falseQuarantineRate: readFalseQuarantineRate,
}

/** 读一轮五指标的结果：度量值 + 哪些指标降级了（reader 抛错被吞）。 */
export interface MetricsReadResult {
  metrics: GovernanceMetrics
  /** 本轮降级（reader 抛错→退中性值）的指标名集合。非空 = 控制以部分降级数据跑（仍确定性）。 */
  degraded: (keyof GovernanceMetrics)[]
}

/**
 * 读一轮五指标，**逐指标独立降级**：某 reader 抛错 → 退该指标中性值 + 记入 degraded，其余照常读。
 * 全部 reader 都抛也只是退到 NEUTRAL_METRICS（=无压力，控制器不会凭空收紧）——绝不让度量层故障传染主干。
 */
export async function readMetrics(
  db: DB,
  readers: MetricReaders = defaultMetricReaders,
): Promise<MetricsReadResult> {
  const degraded: (keyof GovernanceMetrics)[] = []
  const read = async (key: keyof GovernanceMetrics, reader: MetricReader): Promise<number> => {
    try {
      const r = await reader(db)
      // 三种降级：reader 自报 degraded（无数据源）、返回非有限数、或抛错。
      if (r.degraded || !Number.isFinite(r.value)) {
        degraded.push(key)
        // 自报降级时保留其有限的中性值（如 immuneLag 的 0），仅非有限数才退 NEUTRAL。
        return Number.isFinite(r.value) ? r.value : NEUTRAL_METRICS[key]
      }
      return r.value
    } catch {
      degraded.push(key)
      return NEUTRAL_METRICS[key]
    }
  }
  const metrics: GovernanceMetrics = {
    distillBacklog: await read('distillBacklog', readers.distillBacklog),
    entailRejectRate: await read('entailRejectRate', readers.entailRejectRate),
    conflictQueueDepth: await read('conflictQueueDepth', readers.conflictQueueDepth),
    immuneLag: await read('immuneLag', readers.immuneLag),
    falseQuarantineRate: await read('falseQuarantineRate', readers.falseQuarantineRate),
  }
  return { metrics, degraded }
}
