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
import { getSource } from './append-claim.js'

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

/**
 * Distiller 降级：把 source 标人工待处理（append-only，不阻塞 ingestion）。
 *
 * SPI 边界守不变式（向 sibling metrics.ts 的 fail-loud 口径看齐）：三字段 trim 后均非空、source 必须存在，
 * 任一不过即 throw（绝不静默写出「定位不到 source」的空待办污染人审队列）。payload 存 trim 后的值。
 */
export async function markSourceHumanPending(
  db: DB,
  opts: { sourceId: string; reason: string; byRole: string },
): Promise<{ eventId: string }> {
  const sourceId = opts.sourceId.trim()
  const reason = opts.reason.trim()
  const byRole = opts.byRole.trim()
  if (sourceId.length === 0) {
    throw new Error('worker-audit: refusing to mark source pending with empty sourceId')
  }
  if (reason.length === 0) {
    throw new Error('worker-audit: refusing to mark source pending with empty reason')
  }
  if (byRole.length === 0) {
    throw new Error('worker-audit: refusing to mark source pending with empty byRole')
  }
  const src = await getSource(db, sourceId)
  if (!src) {
    throw new Error(`worker-audit: refusing to mark source pending — source ${sourceId} not found`)
  }

  const id = randomUUID()
  await db.insert(metricsEvents).values({
    id,
    kind: 'source_human_pending',
    queryText: null,
    payload: { sourceId, reason, byRole } satisfies HumanPendingPayload,
  })
  return { eventId: id }
}

function isHumanPendingPayload(p: unknown): p is HumanPendingPayload {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  return (
    typeof o.sourceId === 'string' &&
    o.sourceId.length > 0 &&
    typeof o.reason === 'string' &&
    o.reason.length > 0 &&
    typeof o.byRole === 'string' &&
    o.byRole.length > 0
  )
}

/**
 * 读待人工处理的 source 标记（最新在前）。
 *
 * 向 sibling metrics.ts 的 toGapEvent 口径看齐：遇 null / 守卫不过的 payload（坏 writer / 手工迁移行）**直接 throw**，
 * 绝不 `?? ''` 把坏行洗白成「定位不到 source」的空待办——宁可炸，也不让人审队列计数虚高、点不开任何 source。
 */
export async function getHumanPendingSources(db: DB): Promise<HumanPendingSource[]> {
  const rows = await db
    .select()
    .from(metricsEvents)
    .where(eq(metricsEvents.kind, 'source_human_pending'))
    .orderBy(desc(metricsEvents.createdAt), desc(metricsEvents.id))
  return rows.map((r) => {
    if (!isHumanPendingPayload(r.payload)) {
      throw new Error(
        `worker-audit: source_human_pending row ${r.id} carries a malformed payload ${JSON.stringify(r.payload)}`,
      )
    }
    return {
      eventId: r.id,
      sourceId: r.payload.sourceId,
      reason: r.payload.reason,
      byRole: r.payload.byRole,
      createdAt: r.createdAt,
    }
  })
}
