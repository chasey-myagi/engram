/**
 * Arbiter 工种（S20）—— 冲突收敛。**有界 loop**（AgentRuntime 端口 + makeHarnessPiRuntime，与 Distiller 同款），
 * `conflict.detected` 触发，按 A.5 确定性优先级阶梯把矛盾收敛到「机判自裁」或「升级主编」。
 *
 * 关键不变量（红线 + A.5）：
 *   - **胜者判定纯确定性**：winner 由 @engram/core 的 adjudicateConflict（纯阶梯，零 LLM/随机/时钟）算定。
 *     loop 只做编排（遍历待裁对、调工具、收尾），**绝不让 LLM 决定该信谁** —— 同一对 + 同一库状态恒得同一胜者（可回归）。
 *   - **人机共用一张表**：②supersede>③recency>④authority>⑤indepSupport；① 人工裁定仅人可用（机判永不触达 ①）。
 *     唯一胜者 → resolveConflict（记 contradicts 边 + 采信/信任标记，不惊动人）；并列/证据不足 → escalateConflict（升级主编队列）。
 *   - **只人能放松（红线#2）**：Arbiter 标信任/升级，**绝不改 claim.status**（不放松、不隔离、不复活）。
 *   - **有界降级（红线）**：maxTurns 预算耗尽 → 把**所有尚未裁的对升级主编**，绝不无限重试。
 *   - **recall 不变**：裁决只记 contradicts 边 + 事件标记 → 召回该事实仍双返两方（带 contradicts + 各自 as_of/authority），
 *     不在 recall 处自动选边（A.5「矛盾显式」）。
 *
 * judge≠athlete：Arbiter 跑在自己的 by_role（agent:arbiter）/ DB 角色下；它不产出 claim、不写 claim_verification，
 * 只落 contradicts 边 + conflict_adjudicated 事件（采信标记 / 主编队列）。
 */
import { randomUUID } from 'node:crypto'

import {
  adjudicateConflict,
  assertNcExactEvidence,
  escalateConflict,
  loadConflictSide,
  recordAgentRun,
  resolveConflict,
  schema,
  adjudicatedPairKeys,
  type AgentRunTraceInput,
  type ConflictSide,
  type DB,
} from '@engram/core'
import { eq, inArray } from 'drizzle-orm'

import type { AgentRuntime, AgentTool } from './runtime/port.js'

const DEFAULT_MAX_TURNS = 12
const DEFAULT_BY_ROLE = 'agent:arbiter'

export interface ArbiterDeps {
  db: DB
  /** 有界 agent loop 运行时（端口）。测试注 harness-pi+fake model，生产注 harness-pi+真 model。与 Distiller 同款。 */
  runtime: AgentRuntime
}

export interface ArbiterOptions {
  /** 有界 loop 步数上限；耗尽 → 把尚未裁的对升级主编。默认 12。 */
  maxTurns?: number
  /** 工种身份（by_role）。默认 'agent:arbiter'。 */
  byRole?: string
  /**
   * 限定只裁这些**无序对**（`conflict.detected` 精准触发时用）。每项 [a,b] 是一对矛盾 claimId。
   * 不给则扫全库 active↔active 的 contradicts 边（cron/批量收敛用）。
   */
  pairs?: Array<[string, string]>
}

/** 一对冲突的裁决处置（可审计、可解释）。 */
export interface ArbiterOutcome {
  a: string
  b: string
  /** resolved=机判自裁；escalated=升级主编；skipped=对端已失活/不存在（无需裁）。 */
  outcome: 'resolved' | 'escalated' | 'skipped'
  winnerId?: string
  loserId?: string
  /** 在哪一阶定的（②③④⑤ / 'human' 待人裁）。 */
  rung?: string
  reason: string
}

export interface ArbiterResult {
  byRole: string
  /** 机判自裁的对数。 */
  resolved: number
  /** 升级主编的对数（含预算耗尽降级 + 并列）。 */
  escalated: number
  /** 因对端失活/不存在跳过的对数。 */
  skipped: number
  /** loop 终态原因（done / max_turns / error / …）。 */
  loopReason: string
  /** S5:本轮 agent run 相关键(agent_run_trace.run_id;Arbiter 不产 claim,仅记 run 留痕)。 */
  runId: string
  /** S5:run trace 是否成功落库(best-effort;false=被吞,不影响裁决)。 */
  traceRecorded: boolean
  outcomes: ArbiterOutcome[]
}

/** 无序对的稳定 key（去重 + 幂等触发用）。 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * 取本轮待裁的冲突对。限定 pairs（精准触发）或扫全库 active↔active 的 contradicts 边（批量收敛）。
 * 只裁**双方都还 active** 的对：一方已被收紧（flagged/quarantined/superseded）就不再是「活跃矛盾」，无需机判。
 * 返回去重后的无序对列表（含两端 status 已校验为 active）。
 */
async function selectPairs(
  db: DB,
  opts: { pairs?: Array<[string, string]> },
): Promise<Array<[string, string]>> {
  let raw: Array<[string, string]>
  if (opts.pairs && opts.pairs.length > 0) {
    raw = opts.pairs
  } else {
    const edges = await db
      .select({ from: schema.relation.fromClaim, to: schema.relation.toClaim })
      .from(schema.relation)
      .where(eq(schema.relation.type, 'contradicts'))
    raw = edges
      .filter((e): e is { from: string; to: string } => e.to != null)
      .map((e) => [e.from, e.to] as [string, string])
  }

  // 去重（无序）。
  const seen = new Set<string>()
  const deduped: Array<[string, string]> = []
  for (const [a, b] of raw) {
    if (a === b) continue
    const k = pairKey(a, b)
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push([a, b])
  }
  if (deduped.length === 0) return []

  // 只保留双方都还 active 的对（活跃矛盾才需机判）。
  const ids = [...new Set(deduped.flat())]
  const rows = await db
    .select({ id: schema.claim.id, status: schema.claim.status })
    .from(schema.claim)
    .where(inArray(schema.claim.id, ids))
  const statusById = new Map(rows.map((r) => [r.id, r.status]))
  const active = deduped.filter(
    ([a, b]) => statusById.get(a) === 'active' && statusById.get(b) === 'active',
  )
  // 幂等：跳过已落 conflict_adjudicated 标记的对——cron/重触发反复跑不再重判、不堆叠重复事件
  // （呼应 contradicts 边的幂等；机判 resolved 是终态、escalated 待人，均不应每日 cron 再写一条）。
  const adjudicated = await adjudicatedPairKeys(db)
  return active.filter(([a, b]) => !adjudicated.has(pairKey(a, b)))
}

/**
 * 跑一轮 Arbiter 收敛。有界 loop 编排：每对冲突在 loop 内调 adjudicate_conflict 工具裁一次（工具内确定性判 + 落库）；
 * 全裁完调 finish。loop 非正常收尾（耗尽/出错）→ 把**尚未裁的对全升级主编**，绝不无限重试。
 */
export async function runArbiter(
  deps: ArbiterDeps,
  opts: ArbiterOptions = {},
): Promise<ArbiterResult> {
  const byRole = opts.byRole ?? DEFAULT_BY_ROLE
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const runId = randomUUID() // S5:本轮 agent run 相关键

  const result: ArbiterResult = {
    byRole,
    resolved: 0,
    escalated: 0,
    skipped: 0,
    loopReason: 'done',
    runId,
    traceRecorded: false,
    outcomes: [],
  }

  const pairs = await selectPairs(deps.db, opts.pairs !== undefined ? { pairs: opts.pairs } : {})
  if (pairs.length === 0) {
    return result // 无活跃矛盾：空轮（不进 loop、不触发 runtime）。
  }

  // 待裁队列：按 key 索引，loop 工具按 key 逐对消费；剩余的在收尾时升级。
  const pending = new Map<string, [string, string]>()
  for (const [a, b] of pairs) pending.set(pairKey(a, b), [a, b])

  /** 确定性裁一对：现拍双方快照 → 纯阶梯判 → resolve / escalate 落库。从 pending 移除。 */
  const adjudicateOne = async (a: string, b: string): Promise<ArbiterOutcome> => {
    const key = pairKey(a, b)
    pending.delete(key)
    // 现拍裁决输入（确定性、可重建）。一端已失活/不存在 → 跳过（非活跃矛盾，无需机判）。
    let sideA: ConflictSide
    let sideB: ConflictSide
    try {
      ;[sideA, sideB] = await Promise.all([
        loadConflictSide(deps.db, a),
        loadConflictSide(deps.db, b),
      ])
    } catch (err) {
      const outcome: ArbiterOutcome = {
        a,
        b,
        outcome: 'skipped',
        reason: `skipped: ${err instanceof Error ? err.message : String(err)}`,
      }
      result.skipped += 1
      result.outcomes.push(outcome)
      return outcome
    }
    // 纯确定性阶梯：该信谁由它判，零 LLM。
    const adj = adjudicateConflict(sideA, sideB)
    if (adj.outcome === 'winner' && adj.winnerId !== undefined && adj.loserId !== undefined) {
      // NC-exact 红线（红线#3 / A.6）：机判自裁 = 把**败者**判为负（refuted），采信胜者。
      // 落采信前**必过统一闸门**：胜者须有 ≥1 条 relevance='exact' 反向命题（明确反向、含定量否定）方可把败者判负。
      // 无 exact 反向证据 → 拒判 + 强制升级主编（写 ruling_refused），**不**落 resolveConflict 的采信标记，
      // 转而 escalate 把这对交给人裁（同 Verifier 路共用此一处闸门，零分叉）。
      const gate = await assertNcExactEvidence(deps.db, {
        ruledAgainstClaimId: adj.loserId,
        reverseEvidenceClaimId: adj.winnerId, // Arbiter 路：反向命题在胜者的 exact 出处上。
        rulingKind: 'refuted',
        path: 'arbiter',
        byRole,
      })
      if (gate.ok) {
        const persisted = await resolveConflict(deps.db, { a, b, adjudication: adj, byRole })
        const outcome: ArbiterOutcome = {
          a,
          b,
          outcome: 'resolved',
          ...(persisted.winnerId !== undefined ? { winnerId: persisted.winnerId } : {}),
          ...(persisted.loserId !== undefined ? { loserId: persisted.loserId } : {}),
          rung: adj.rung,
          reason: adj.reason,
        }
        result.resolved += 1
        result.outcomes.push(outcome)
        return outcome
      }
      // 拒判：不落采信标记，升级主编（ruling_refused 已写）。改记一条 escalated 入主编队列，
      // 让人用同一张优先级表 + ① 人工裁定手裁（红线#3：agent 缺 exact 反向证据无权把败者判负）。
      const refuseReason =
        `NC-exact red line refused machine adjudication: winner ${adj.winnerId} lacks a relevance='exact' ` +
        `reverse proposition to rule loser ${adj.loserId} refuted (ladder rung '${adj.rung}'). Escalated to editor-in-chief.`
      await escalateConflict(deps.db, { a, b, rung: 'human', reason: refuseReason, byRole })
      const outcome: ArbiterOutcome = {
        a,
        b,
        outcome: 'escalated',
        rung: 'human',
        reason: refuseReason,
      }
      result.escalated += 1
      result.outcomes.push(outcome)
      return outcome
    }
    // 并列/不可机判 → 升级主编。
    await escalateConflict(deps.db, { a, b, rung: adj.rung, reason: adj.reason, byRole })
    const outcome: ArbiterOutcome = {
      a,
      b,
      outcome: 'escalated',
      rung: adj.rung,
      reason: adj.reason,
    }
    result.escalated += 1
    result.outcomes.push(outcome)
    return outcome
  }

  const adjudicateTool: AgentTool = {
    name: 'adjudicate_conflict',
    description:
      'Adjudicate ONE conflicting claim pair by the fixed deterministic priority ladder ' +
      '(supersede > recency > authority > independent-support). If a unique winner exists it self-adjudicates ' +
      '(records the contradicts edge + a believed/trust marker); if tied it escalates to the editor-in-chief. ' +
      'The winner decision is deterministic — you do NOT choose the winner, you only drive which pair to process. ' +
      'Provide the two claim ids of one pending pair.',
    parameters: {
      type: 'object',
      properties: {
        claimA: { type: 'string', description: 'First conflicting claim id.' },
        claimB: { type: 'string', description: 'Second conflicting claim id.' },
      },
      required: ['claimA', 'claimB'],
    },
    async execute(args) {
      const a = typeof args.claimA === 'string' ? args.claimA.trim() : ''
      const b = typeof args.claimB === 'string' ? args.claimB.trim() : ''
      if (!a || !b) return { text: 'rejected: both claimA and claimB are required', isError: true }
      if (a === b) return { text: 'rejected: a claim cannot conflict with itself', isError: true }
      const key = pairKey(a, b)
      if (!pending.has(key)) {
        // 已裁过 / 不在本轮待裁集 → 回灌 LLM（不重复裁、不堆事件）。
        return {
          text: `pair (${a}, ${b}) is not a pending conflict in this round (already adjudicated or out of scope)`,
          isError: true,
        }
      }
      const outcome = await adjudicateOne(a, b)
      if (outcome.outcome === 'resolved') {
        return {
          text: `resolved: winner=${outcome.winnerId} by rung '${outcome.rung}' — ${outcome.reason}`,
        }
      }
      if (outcome.outcome === 'escalated') {
        return { text: `escalated to editor-in-chief: ${outcome.reason}` }
      }
      return { text: outcome.reason }
    },
  }

  const finishTool: AgentTool = {
    name: 'finish',
    description: 'Call when every pending conflict pair has been adjudicated.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { text: 'acknowledged — conflict convergence complete' }
    },
  }

  const { systemPrompt, prompt } = renderForLoop(pairs)
  const run = await deps.runtime.run({
    systemPrompt,
    prompt,
    tools: [adjudicateTool, finishTool],
    maxTurns,
  })
  result.loopReason = run.reason

  // S5:落本轮 run 留痕(best-effort、永不抛;ok=false 仅记一笔、不影响裁决收敛)。
  const traceInput: AgentRunTraceInput = {
    runId,
    workerName: byRole,
    byRole,
    reason: run.reason,
    turns: run.turns,
    ...(run.usage !== undefined
      ? {
          inputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens,
          ...(run.usage.reasoningTokens !== undefined
            ? { reasoningTokens: run.usage.reasoningTokens }
            : {}),
        }
      : {}),
    ...(run.trace !== undefined
      ? {
          toolCalls: run.trace.toolCalls,
          toolErrors: run.trace.toolErrors,
          toolNames: run.trace.toolNames,
        }
      : {}),
    payload: { pairs: pairs.length },
  }
  result.traceRecorded = (await recordAgentRun(deps.db, traceInput)).ok

  // 有界降级（红线）：loop 非正常收尾 **或** 仍有未裁对 → 把剩余对全升级主编，绝不无限重试。
  // （即使 reason='done'，若 LLM 漏裁某对，也兜底升级——确定性收敛不靠 LLM 跑全。）
  if (pending.size > 0) {
    for (const [a, b] of [...pending.values()]) {
      pending.delete(pairKey(a, b))
      // 这些对当时确认 active（selectPairs 已校验）；耗尽预算未及裁 → 升级主编（待人用同表 + ①）。
      const reason =
        run.reason === 'done'
          ? 'escalated: pair left un-adjudicated by the bounded loop — handed to editor-in-chief'
          : `escalated: bounded arbiter loop ended with reason='${run.reason}' before adjudicating this pair (budget exhaustion → human, no infinite retry)`
      try {
        await escalateConflict(deps.db, { a, b, rung: 'human', reason, byRole })
        result.escalated += 1
        result.outcomes.push({ a, b, outcome: 'escalated', rung: 'human', reason })
      } catch (err) {
        result.skipped += 1
        result.outcomes.push({
          a,
          b,
          outcome: 'skipped',
          reason: `escalate failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  return result
}

/**
 * 把待裁对渲染成 loop prompt：每行一对「<claimA>\t<claimB>」，loop 据此逐对调 adjudicate_conflict。
 * system prompt 明确「胜者确定性、LLM 不选边」，避免 LLM 以为要自己判该信谁。
 */
function renderForLoop(pairs: Array<[string, string]>): { systemPrompt: string; prompt: string } {
  const systemPrompt =
    'You are the Arbiter. You converge conflicting claim pairs using a FIXED deterministic priority ladder. ' +
    'For EACH conflicting pair below, call adjudicate_conflict with its two claim ids. ' +
    'The winner is decided deterministically by the ladder (supersede > recency > authority > independent-support) — ' +
    'you do NOT pick the winner, you only drive which pair to process next. When every pair has been adjudicated, call finish.'
  const body = pairs.map(([a, b]) => `${a}\t${b}`).join('\n')
  return {
    systemPrompt,
    prompt: `Conflicting claim pairs to adjudicate (each line is "<claimA>\\t<claimB>"):\n${body}`,
  }
}

/**
 * Arbiter 触发声明（A.7：conflict.detected）。choreography 无在线 meta-orchestrator：
 * 工种**声明**自己的触发，由外层调度器（事件总线 / cron）按此调 runArbiter。这里只声明，不内嵌定时器。
 *  - event: Verifier 的 not_co_true 信号 / Reconciler 的近重复投毒升级 / append 写下的 contradicts 边 → conflict.detected。
 *  - cron: 兜底批量收敛全库未裁的 active↔active contradicts 边。
 */
export const ARBITER_TRIGGER = {
  event: 'conflict.detected',
  cron: 'daily',
} as const

/** 处理 conflict.detected 事件：对一批冲突对立即跑收敛。薄包装 runArbiter。 */
export async function arbitrateConflicts(
  deps: ArbiterDeps,
  pairs: Array<[string, string]>,
  opts: Omit<ArbiterOptions, 'pairs'> = {},
): Promise<ArbiterResult> {
  return runArbiter(deps, { ...opts, pairs })
}
