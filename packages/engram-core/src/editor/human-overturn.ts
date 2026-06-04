/**
 * human_overturn 事件（S22，A.9）—— append-only 评测埋点。**S26 恒温器 falseQuarantineRate 的生产者**。
 *
 * 当主编**翻案了 agent 的判决**时记一条：
 *   - un_quarantine：人解隔离一条被 agent 隔离的 claim（quarantined→active）→ 这正是「人工翻案的误隔离」一例，
 *     S26 据此算 falseQuarantineRate（被误隔离、后被人翻案的比率）。
 *   - pardon：人赦免一条被 agent flag 的 claim（flagged→active）。
 *   - rollback：人回滚到一条被取代的旧版（superseded→active）。
 *   - reject_agent_promoted：人驳回一条 agent 已晋升（active）的 claim（active→quarantined 经主编 Reject）。
 *
 * 沿 conflict_adjudicated(S20)/gap_recorded(S10) 的「只记事件 + 离线聚合」式样：只读 / fail-loud / 绝不进任何在线计分或校准。
 * 翻案事件**不自己改 claim.status**——状态由 transitionClaim 的红边（仅人可放松）驱动，本模块只在那次放松旁记一条审计痕。
 */
import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import type { DB, Tx } from '../db/client.js'
import { metricsEvents, type MetricsEventKind } from '../db/schema.js'

/** human_overturn 事件的 metrics_event_kind 值（S22）。 */
export const HUMAN_OVERTURN = 'human_overturn' as const satisfies MetricsEventKind

type Queryable = DB | Tx

/** 翻案类型：人放松/驳回了 agent 的哪一类判决（A.4 红边 + 主编 Reject）。 */
export type OverturnKind = 'un_quarantine' | 'pardon' | 'rollback' | 'reject_agent_promoted'

/** human_overturn 的 payload 形状（离线分析 / S26 恒温器读出用，绝不进任何计分）。 */
export interface HumanOverturnPayload {
  /** 翻案类型。un_quarantine 是 falseQuarantineRate 的主信号（误隔离被人翻案）。 */
  overturn: OverturnKind
  /** 被翻案的 claim。 */
  claimId: string
  /** 翻案前的 agent 判决态（quarantined/flagged/superseded/active）。 */
  fromStatus: string
  /** 翻案后落到的态（un_quarantine/pardon/rollback→active；reject_agent_promoted→quarantined）。 */
  toStatus: string
  /** 翻案人身份（'human…'）。 */
  byRole: string
  /** 人类可读理由（可选，离线审计用）。 */
  reason?: string
}

function isOverturnKind(x: unknown): x is OverturnKind {
  return (
    x === 'un_quarantine' || x === 'pardon' || x === 'rollback' || x === 'reject_agent_promoted'
  )
}

function isOverturnPayload(p: unknown): p is HumanOverturnPayload {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  return (
    isOverturnKind(o.overturn) &&
    typeof o.claimId === 'string' &&
    typeof o.fromStatus === 'string' &&
    typeof o.toStatus === 'string' &&
    typeof o.byRole === 'string'
  )
}

/**
 * 落一条 human_overturn 事件。queryText=null（按 claim 归因，不按 query）。
 * 在 transitionClaim 红边放松（或主编 Reject 一条 agent 已晋升 claim）的**同一事务**内调用，与状态翻转原子绑定。
 * 返回新事件 id。append-only，绝不去重——每次翻案都是一次真实人工干预观测，频次本身是信号（对齐 reflux/gap 取向）。
 */
export async function recordHumanOverturn(
  q: Queryable,
  payload: HumanOverturnPayload,
): Promise<{ eventId: string }> {
  const id = randomUUID()
  await q.insert(metricsEvents).values({ id, kind: HUMAN_OVERTURN, queryText: null, payload })
  return { eventId: id }
}

/** human_overturn 事件的读出形状（payload 已校验）。 */
export interface HumanOverturn {
  eventId: string
  payload: HumanOverturnPayload
  createdAt: Date
}

/**
 * 向 gap/conflict 读法看齐的 fail-loud 解读：写者唯一、形状锁定，读侧仍兜一道——宁可炸，也绝不吐坏事件污染
 * S26 falseQuarantineRate 的聚合。
 */
function toOverturn(row: typeof metricsEvents.$inferSelect): HumanOverturn {
  if (!isOverturnPayload(row.payload)) {
    throw new Error(
      `human-overturn: human_overturn row ${row.id} carries a malformed payload ${JSON.stringify(row.payload)}`,
    )
  }
  return { eventId: row.id, payload: row.payload, createdAt: row.createdAt }
}

/**
 * 读 human_overturn 事件（可按 claim 过滤），最新在前。S26 恒温器据此聚合 falseQuarantineRate
 * （un_quarantine 占被隔离总数的比率）。
 */
export async function getHumanOverturns(db: DB, claimId?: string): Promise<HumanOverturn[]> {
  const rows = await db
    .select()
    .from(metricsEvents)
    .where(eq(metricsEvents.kind, HUMAN_OVERTURN))
    .orderBy(desc(metricsEvents.createdAt), desc(metricsEvents.id))
  const all = rows.map(toOverturn)
  return claimId === undefined ? all : all.filter((o) => o.payload.claimId === claimId)
}
