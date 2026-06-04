/**
 * Distiller 工种（S15）—— 第一个上线的内核工种。source.ingested 触发，跑一轮**有界** agent loop，
 * 把 source 蒸馏成有出处的 claim。**只依赖 @engram/core SPI + AgentRuntime 端口**，不直接 import 任何 agent loop。
 *
 * 五阶段脊柱（A.7）：① read_source（本切片只读 structured_spec / human_qa，其余 parser 是 S16）→
 * ② extract（LLM 在 loop 里逐条 commit_claim）→ ③ 跨源去重 / ④ 冲突探测 / ⑤ 单事务 commit —— ③④⑤ 全由
 * commitClaim(S14) 承担（等价→合并出处升印证、矛盾→contradicts 边留双方、claim+出处+关系单事务）。
 * 无出处的 claim 当场拒（commit_claim 工具要求 locator）。低置信/冲突不阻塞写——留 draft 影子区 + contradicts 边，
 * 异步交 Verifier/人（S17 起）。有界：maxTurns 硬上限；耗尽/源畸形/kind 不支持 → 把 source 标人工待处理
 * （markSourceHumanPending），**不无限重试、不阻塞 ingestion**。工种身份（by_role）记在产出 claim 的
 * created_by（athlete 身份）上；Distiller **不**写 claim_verification（自背书违 judge≠athlete，那是 Verifier 的活）。
 */
import {
  commitClaim,
  getSource,
  markSourceHumanPending,
  type DB,
  type Embedder,
  type SameFactJudge,
} from '@engram/core'

import type { AgentRuntime, AgentTool } from './runtime/port.js'

/** S15 只读这两类结构化源（其余 kind 的 parser 是 S16）。 */
const SUPPORTED_KINDS = new Set(['structured_spec', 'human_qa'])
const DEFAULT_MAX_TURNS = 12
const DEFAULT_BY_ROLE = 'agent:distiller'

export interface DistillerDeps {
  db: DB
  embedder: Embedder
  judge: SameFactJudge
  /** 有界 agent loop 运行时（端口）。测试注 harness-pi+fake model，生产注 harness-pi+真 model。 */
  runtime: AgentRuntime
}

export interface DistillOptions {
  /** 有界 loop 步数上限；耗尽 → 降级人工。默认 12。 */
  maxTurns?: number
  /** 工种身份（by_role / createdBy）。默认 'agent:distiller'。 */
  byRole?: string
}

export interface DistillResult {
  sourceId: string
  status: 'done' | 'human_pending'
  /** 成功提交的 claim 次数（每次 commit_claim 工具调用成功 +1；同一事实合并仍计一次提交）。 */
  committed: number
  /** done / max_turns / aborted / error / unsupported_kind。 */
  reason: string
}

const SYSTEM_PROMPT =
  'You are the Distiller. Read the given source and extract its atomic factual claims. ' +
  'For EACH claim, call commit_claim with the claim text and a `locator` pointing to where in the source ' +
  'the fact is stated — a claim with no locator is rejected and not committed. Prefer structured triples ' +
  '(subject/predicate/object) when the fact is structured. Do NOT invent facts that are not in the source. ' +
  'When every atomic claim has been committed, call finish.'

/**
 * 跑 Distiller：读 source → 有界 loop 抽取+提交 → 据终态收尾。source 不存在 → 抛；kind 不支持 / loop 非正常收尾
 * → 标 source 人工待处理并返回 human_pending。
 */
export async function runDistiller(
  deps: DistillerDeps,
  sourceId: string,
  opts: DistillOptions = {},
): Promise<DistillResult> {
  const byRole = opts.byRole ?? DEFAULT_BY_ROLE
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS

  const src = await getSource(deps.db, sourceId)
  if (!src) {
    throw new Error(`distiller: source ${sourceId} not found`)
  }
  if (!SUPPORTED_KINDS.has(src.kind)) {
    await markSourceHumanPending(deps.db, {
      sourceId,
      reason: `unsupported source kind '${src.kind}' (S15 reads structured_spec / human_qa only)`,
      byRole,
    })
    return { sourceId, status: 'human_pending', committed: 0, reason: 'unsupported_kind' }
  }

  let committed = 0

  const commitTool: AgentTool = {
    name: 'commit_claim',
    description:
      'Commit one atomic factual claim extracted from the source. You MUST provide a `locator` citing where ' +
      'in the source the fact is stated; a claim with no locator is rejected. Provide subject/predicate/object ' +
      'when the fact is a structured triple.',
    parameters: {
      type: 'object',
      properties: {
        claimText: { type: 'string', description: 'The atomic claim — exactly one fact.' },
        subject: { type: 'string' },
        predicate: { type: 'string' },
        object: { type: 'string' },
        locator: {
          type: 'string',
          description: 'Where in the source this is stated (line/section/field).',
        },
        excerpt: { type: 'string', description: 'Optional verbatim snippet from the source.' },
      },
      required: ['claimText', 'locator'],
    },
    async execute(args) {
      const claimText = typeof args.claimText === 'string' ? args.claimText.trim() : ''
      const locator = typeof args.locator === 'string' ? args.locator.trim() : ''
      if (!claimText) return { text: 'rejected: claimText is required', isError: true }
      if (!locator) {
        // D1 的工种层兜底：无出处的 claim 当场拒，不进 commit（内核 commitClaim 也会拒，这里先把信号回灌 LLM）。
        return {
          text: 'rejected: a `locator` (provenance into the source) is required — ungrounded claims are not committed',
          isError: true,
        }
      }
      const draft = {
        claimText,
        createdBy: `${byRole}:${sourceId}`,
        ...(typeof args.subject === 'string' ? { subject: args.subject } : {}),
        ...(typeof args.predicate === 'string' ? { predicate: args.predicate } : {}),
        ...(typeof args.object === 'string' ? { object: args.object } : {}),
      }
      const res = await commitClaim(deps.db, deps.embedder, deps.judge, draft, [
        {
          sourceId,
          locator,
          relevance: 'exact',
          ...(typeof args.excerpt === 'string' ? { excerpt: args.excerpt } : {}),
        },
      ])
      committed += 1
      // 工种身份记在产出 claim 的 created_by（athlete 身份）上，不写 claim_verification（自背书违 judge≠athlete）。
      return {
        text: `committed claim ${res.claimId}${res.merged ? ' (merged into an existing same-fact claim)' : ''}`,
      }
    },
  }

  const finishTool: AgentTool = {
    name: 'finish',
    description: 'Call when every atomic claim in the source has been committed.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { text: 'acknowledged — distillation complete' }
    },
  }

  const result = await deps.runtime.run({
    systemPrompt: SYSTEM_PROMPT,
    prompt: `Source kind: ${src.kind}\nSource content:\n${src.content}`,
    tools: [commitTool, finishTool],
    maxTurns,
  })

  if (result.reason !== 'done') {
    // 有界 loop 耗尽 / 出错 / 中断 → 降级人工（已提交的 claim 保留），不无限重试、不阻塞 ingestion。
    await markSourceHumanPending(deps.db, {
      sourceId,
      reason: `bounded distill loop ended with reason='${result.reason}' after ${result.turns} turns`,
      byRole,
    })
    return { sourceId, status: 'human_pending', committed, reason: result.reason }
  }
  return { sourceId, status: 'done', committed, reason: result.reason }
}
