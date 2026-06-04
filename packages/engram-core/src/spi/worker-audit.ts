/**
 * 工种审计 SPI（S15 起）—— 工种（Distiller…）不直插内核表，经此缝留痕。
 *
 * markSourceHumanPending：Distiller 有界 loop 耗尽 / 源畸形 / kind 不支持时，把 source 标人工待处理
 *   （append-only marker，**不阻塞** ingestion、不无限重试）。
 *
 * 注：Distiller 的工种身份（by_role）记在它产出 claim 的 `created_by` 上（athlete 身份）；它**不**写
 * claim_verification —— 自己给自己写巡查行就是「自背书」，违 judge≠athlete 红线。by_role 入 claim_verification
 * 是 **Verifier(judge)** 的机制（S17）：届时 Verifier 的 patrol 行 by_role 与 Distiller 的 created_by 不同，
 * judge≠athlete 可证。verification_kind 是 A.1 冻结的三态（patrol/usage_truth/reembed_marker），不为工种审计扩。
 */
import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { metricsEvents } from '../db/schema.js'

/** 待人工处理的 source 标记的读出形状。 */
export interface HumanPendingSource {
  eventId: string
  sourceId: string
  reason: string
  byRole: string
  createdAt: Date
}

interface HumanPendingPayload {
  sourceId: string
  reason: string
  byRole: string
}

/** Distiller 降级：把 source 标人工待处理（append-only，不阻塞 ingestion）。 */
export async function markSourceHumanPending(
  db: DB,
  opts: { sourceId: string; reason: string; byRole: string },
): Promise<{ eventId: string }> {
  const id = randomUUID()
  await db.insert(metricsEvents).values({
    id,
    kind: 'source_human_pending',
    queryText: null,
    payload: {
      sourceId: opts.sourceId,
      reason: opts.reason,
      byRole: opts.byRole,
    } satisfies HumanPendingPayload,
  })
  return { eventId: id }
}

/** 读待人工处理的 source 标记（最新在前）。 */
export async function getHumanPendingSources(db: DB): Promise<HumanPendingSource[]> {
  const rows = await db
    .select()
    .from(metricsEvents)
    .where(eq(metricsEvents.kind, 'source_human_pending'))
    .orderBy(desc(metricsEvents.createdAt), desc(metricsEvents.id))
  return rows.map((r) => {
    const p = (r.payload ?? {}) as Partial<HumanPendingPayload>
    return {
      eventId: r.id,
      sourceId: p.sourceId ?? '',
      reason: p.reason ?? '',
      byRole: p.byRole ?? '',
      createdAt: r.createdAt,
    }
  })
}
