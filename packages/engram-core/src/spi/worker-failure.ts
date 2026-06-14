/**
 * worker_failure 的 **durable dead-letter / 审计 SPI**（EGR-CR-039）—— dispatcher 吞掉的工种处理器抛错的落库口。
 *
 * 总线 EventDispatcher 按设计零 db 依赖：处理器抛错被吞、只计内存 result.failures + push 进内存 result.traces。
 * 这两个字段过去唯一的归宿是返回对象，进程内存一翻篇失败信号就永久丢失（ops/editor 无从在 DB 看到「谁在持续挂」）。
 * 本 SPI 把落库责任落到持有 db 的层（EngramRunner）：遍历 traces 里 ok:false 的行，逐条 recordWorkerFailure 落本表。
 *
 * 沿 dimension-events.ts（record/get 对 + 值域门）与 worker-audit.ts（确定性排序）的已验证范式。append-only：
 * 一行 = 一次被吞的工种失败，绝不可变。纯审计 / 可恢复性用，**绝不进任何在线判据 / 校准 g / 纵向计分**。
 */
import { randomUUID } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { workerFailure } from '../db/schema.js'

/** worker_failure 一行的读出形状。 */
export interface WorkerFailure {
  eventId: string
  workerName: string
  eventType: string
  error: string
  payloadDigest: Record<string, unknown>
  createdAt: Date
}

export interface RecordWorkerFailureInput {
  /** 抛错的工种名（'distiller' | 'verifier' | …，非空）。 */
  workerName: string
  /** 触发该工种的事件类型字符串（'source.ingested' 等，非空）。 */
  eventType: string
  /** 处理器抛错的 message。 */
  error: string
  /** 事件 payload 摘要（claimIds 计数 / sourceId 等，避免存大块）。缺省落空对象。 */
  payloadDigest?: Record<string, unknown>
}

/**
 * 追加一条工种失败审计（append-only）。workerName / eventType 必须非空（坏审计行物理写不进、不污染 dead-letter）。
 * 写者主路径 = EngramRunner.persistFailures 的 best-effort 落库；手工调用同样受非空门约束。
 */
export async function recordWorkerFailure(
  db: DB,
  input: RecordWorkerFailureInput,
): Promise<{ eventId: string }> {
  if (typeof input.workerName !== 'string' || input.workerName.trim().length === 0) {
    throw new Error('recordWorkerFailure: workerName must be a non-empty string')
  }
  if (typeof input.eventType !== 'string' || input.eventType.trim().length === 0) {
    throw new Error('recordWorkerFailure: eventType must be a non-empty string')
  }
  const id = randomUUID()
  await db.insert(workerFailure).values({
    id,
    workerName: input.workerName,
    eventType: input.eventType,
    error: input.error,
    payloadDigest: input.payloadDigest ?? {},
  })
  return { eventId: id }
}

/** 读工种失败审计（可按 workerName / eventType 过滤），按 (createdAt desc, id desc) 确定性排序（最新在前）。 */
export async function getWorkerFailures(
  db: DB,
  filter: { workerName?: string; eventType?: string } = {},
): Promise<WorkerFailure[]> {
  const conds = []
  if (filter.workerName !== undefined) conds.push(eq(workerFailure.workerName, filter.workerName))
  if (filter.eventType !== undefined) conds.push(eq(workerFailure.eventType, filter.eventType))
  const rows = await db
    .select()
    .from(workerFailure)
    .where(conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds))
    .orderBy(desc(workerFailure.createdAt), desc(workerFailure.id))
  return rows.map((r) => ({
    eventId: r.id,
    workerName: r.workerName,
    eventType: r.eventType,
    error: r.error,
    payloadDigest: (r.payloadDigest ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt,
  }))
}
