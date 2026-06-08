/**
 * agent-loop trace sink SPI(S3,可观测第三层的**写/读端**)—— 把 harness-pi adapter 采到的 run-level 留痕落进
 * agent_run_trace,并按 runId 读回(S9 诊断 join 用)。append-only。
 *
 * **best-effort 契约**:recordAgentRun 任何问题(坏输入 / DB 写失败)都返回 `{ok:false}`、**绝不抛进 worker 路径**——
 * trace 是旁路观测,不可拖垮真活(对比 recordDimension/recordGap 是 fail-loud 的 eval 写)。调用方据 ok 计失败数。
 *
 * **A3 边界**:本模块**唯一**合法引用 agentRunTrace 表(故在 a3-firewall 的 core allowlist 内)。它只**写/读**留痕,
 * 绝不参与 g 校准 / 纵向 / 在线召回——拟合器只读 usage_truth,calibration/* 永不 import 本模块(firewall 静态钉死)。
 */
import { randomUUID } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { agentRunTrace } from '../db/schema.js'

/** 一条 agent run 留痕的输入(调用方从 AgentRunResult 拼)。token/工具字段缺省按 0/null 入库。 */
export interface AgentRunTraceInput {
  runId: string
  workerName: string
  byRole: string
  reason: string
  turns: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  toolCalls?: number
  toolErrors?: number
  toolNames?: string[]
  payload?: Record<string, unknown>
}

export interface AgentRunTraceRecord {
  id: string
  runId: string
  workerName: string
  byRole: string
  reason: string
  turns: number
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  toolCalls: number
  toolErrors: number
  toolNames: string[]
  payload: Record<string, unknown>
  createdAt: Date
}

function nonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0
}

/**
 * append-only 记一条 agent run 留痕。**best-effort、永不抛**:坏输入 / 写失败 → `{ok:false}`(调用方计失败数,不影响真活)。
 */
export async function recordAgentRun(
  db: DB,
  input: AgentRunTraceInput,
): Promise<{ ok: boolean; eventId?: string }> {
  try {
    if (!nonEmpty(input.runId) || !nonEmpty(input.workerName) || !nonEmpty(input.byRole)) {
      return { ok: false }
    }
    if (!nonEmpty(input.reason) || !(input.turns >= 0)) {
      return { ok: false }
    }
    const id = randomUUID()
    await db.insert(agentRunTrace).values({
      id,
      runId: input.runId,
      workerName: input.workerName,
      byRole: input.byRole,
      reason: input.reason,
      turns: input.turns,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      reasoningTokens: input.reasoningTokens ?? null,
      toolCalls: input.toolCalls ?? 0,
      toolErrors: input.toolErrors ?? 0,
      toolNames: input.toolNames ?? [],
      payload: input.payload ?? {},
    })
    return { ok: true, eventId: id }
  } catch {
    // 写失败被吞(trace 不可拖垮真活);调用方据返回 ok=false 计一次失败。
    return { ok: false }
  }
}

/** 按 runId / workerName 读回留痕(S9 诊断 join 用),createdAt 降序。无过滤则取最近 limit 条。 */
export async function getAgentRunTrace(
  db: DB,
  opts: { runId?: string; workerName?: string; limit?: number } = {},
): Promise<AgentRunTraceRecord[]> {
  const conds = []
  if (opts.runId !== undefined) conds.push(eq(agentRunTrace.runId, opts.runId))
  if (opts.workerName !== undefined) conds.push(eq(agentRunTrace.workerName, opts.workerName))
  const rows = await db
    .select()
    .from(agentRunTrace)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(agentRunTrace.createdAt))
    .limit(opts.limit ?? 200)
  return rows.map((r) => ({
    id: r.id,
    runId: r.runId,
    workerName: r.workerName,
    byRole: r.byRole,
    reason: r.reason,
    turns: r.turns,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    reasoningTokens: r.reasoningTokens,
    toolCalls: r.toolCalls,
    toolErrors: r.toolErrors,
    toolNames: (r.toolNames as string[] | null) ?? [],
    payload: (r.payload as Record<string, unknown> | null) ?? {},
    createdAt: r.createdAt,
  }))
}
