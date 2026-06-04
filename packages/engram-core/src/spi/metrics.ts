/**
 * 评测埋点事件流（A.9）—— append-only，离线聚合，绝不进任何在线判据/校准。
 *
 * S10 首个用途 gap_recorded：召回交白卷的**诚实信号**。当一次非空 recall 没有任何 claim 越过消费门
 * （库确实没答案），recall 落一条引用该 query 的 gap 事件 —— 绝不拿杜撰/门下 claim 顶替「不知道」。
 * 这正是「越用越准」要回填的缺口：知识库诚实记录被问到却答不出什么。
 *
 * 沿 report_usage 的式样：只记事件、读侧 fail-loud、聚合离线算。gap 没有可引的 claim，故按 query 文本归因。
 */
import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { metricsEvents, metricsEventKind, type MetricsEventKind } from '../db/schema.js'

export const GAP_RECORDED = 'gap_recorded' as const satisfies MetricsEventKind
/** 全部事件类别，从 pgEnum 的单一真相源派生 —— 将来加新 kind 不会与此常量悄悄漂移。 */
export const METRICS_EVENT_KINDS: readonly MetricsEventKind[] = metricsEventKind.enumValues

/** gap_recorded 的诊断负载：区分「门后」(候选有、全在门下) 与「无候选」两种盲点，纯离线分析、不计分。 */
export interface GapPayload {
  /** 相似度过滤后的 NN 候选数。0 = 库里压根没相关项；>0 而仍交白卷 = 门后(door-behind)。 */
  candidateCount: number
  /** 越过消费门的候选数。gap 时通常为 0（门后被全挡）。 */
  gatedCount: number
  /** 本次召回的消费下界（配置态 ∨ 请求态 取严后的值）。 */
  floor: number
  /** 提问所用嵌入器版本（盲点归因到语义空间）。 */
  embedderVersion: string
}

/** metrics_events 一行的读出形状。 */
export interface MetricsEvent {
  id: string
  kind: MetricsEventKind
  queryText: string | null
  payload: Record<string, unknown>
  createdAt: Date
}

function toMetricsEvent(row: typeof metricsEvents.$inferSelect): MetricsEvent {
  return {
    id: row.id,
    kind: row.kind,
    queryText: row.queryText,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  }
}

/** gap_recorded 一行的强类型读出形状（payload 已校验为 GapPayload，queryText 必非空）。 */
export interface GapEvent {
  id: string
  queryText: string
  payload: GapPayload
  createdAt: Date
}

function isGapPayload(p: unknown): p is GapPayload {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  return (
    typeof o.candidateCount === 'number' &&
    typeof o.gatedCount === 'number' &&
    typeof o.floor === 'number' &&
    typeof o.embedderVersion === 'string'
  )
}

/**
 * 向 usage_truth 读法看齐的 fail-loud 解读：gap_recorded 的写者唯一（recall→recordGap）、形状锁定，
 * 但读侧仍兜一道——万一混入坏行/手工行，宁可炸，也绝不吐出 candidateCount=undefined 的坏事件污染 L5 评分。
 */
function toGapEvent(row: typeof metricsEvents.$inferSelect): GapEvent {
  if (row.queryText == null) {
    throw new Error(`metrics: gap_recorded row ${row.id} has a null query_text`)
  }
  if (!isGapPayload(row.payload)) {
    throw new Error(
      `metrics: gap_recorded row ${row.id} carries a malformed payload ${JSON.stringify(row.payload)}`,
    )
  }
  return { id: row.id, queryText: row.queryText, payload: row.payload, createdAt: row.createdAt }
}

/**
 * 追加一条 gap_recorded 事件（recall 交白卷时由召回路径调用）。返回新事件 id。
 * 这是消费关键路径上的硬写（非 best-effort）：盲点信号是 L5 评测的金标准答案，必须可靠落地。
 */
export async function recordGap(
  db: DB,
  queryText: string,
  payload: GapPayload,
): Promise<{ eventId: string }> {
  const id = randomUUID()
  await db.insert(metricsEvents).values({ id, kind: GAP_RECORDED, queryText, payload })
  return { eventId: id }
}

/** 枚举某类事件（默认全部），按时间升序。离线聚合取数口。 */
export async function getMetricsEvents(db: DB, kind?: MetricsEventKind): Promise<MetricsEvent[]> {
  const rows = kind
    ? await db
        .select()
        .from(metricsEvents)
        .where(eq(metricsEvents.kind, kind))
        .orderBy(asc(metricsEvents.createdAt), asc(metricsEvents.id))
    : await db
        .select()
        .from(metricsEvents)
        .orderBy(asc(metricsEvents.createdAt), asc(metricsEvents.id))
  return rows.map(toMetricsEvent)
}

/**
 * 取某条 query 的 gap 事件（不传 query 则取全部 gap），按时间**降序**（最新在前）。
 * 评测谐波用「召回前后该 query 的 gap 计数是否增加」来判定本次召回是否落了盲点信号。
 */
export async function getGapEvents(db: DB, queryText?: string): Promise<GapEvent[]> {
  const where =
    queryText === undefined
      ? eq(metricsEvents.kind, GAP_RECORDED)
      : and(eq(metricsEvents.kind, GAP_RECORDED), eq(metricsEvents.queryText, queryText))
  const rows = await db
    .select()
    .from(metricsEvents)
    .where(where)
    .orderBy(desc(metricsEvents.createdAt), desc(metricsEvents.id))
  return rows.map(toGapEvent)
}
