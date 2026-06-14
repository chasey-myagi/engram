/**
 * Distiller 工种（S15 脊柱 + S16 read_source 全 kind）—— 第一个上线的内核工种。source.ingested 触发，
 * 跑一轮**有界** agent loop，把 source 蒸馏成有出处的 claim。**只依赖 @engram/core SPI + AgentRuntime 端口 +
 * SourceReader 端口**，不直接 import 任何 agent loop / VLM。
 *
 * 五阶段脊柱（A.7）：① read_source（S16 起按 kind 选读法：layout/table/turns/qa/segments/sections/items/VLM，
 * 经注入的 SourceReader 端口归一成带 locator 锚的分块——含图走 VLM，零硬编码模型）→
 * ② extract（LLM 在 loop 里逐条 commit_claim）→ ③ 跨源去重 / ④ 冲突探测 / ⑤ 单事务 commit —— ③④⑤ 全由
 * commitClaim(S14) 承担（等价→合并出处升印证、矛盾→contradicts 边留双方、claim+出处+关系单事务）。
 * **② 起的脊柱 + 降级路径与 S15 一字不动**：S16 只长「① 按 kind 选哪个读法」，不开第二条管线。
 * 无出处的 claim 当场拒（commit_claim 工具要求 locator）。低置信/冲突不阻塞写——留 draft 影子区 + contradicts 边，
 * 异步交 Verifier/人（S17 起）。有界：maxTurns 硬上限；耗尽/源畸形/kind 不支持/读不出块 → 把 source 标人工待处理
 * （markSourceHumanPending），**不无限重试、不阻塞 ingestion**。工种身份（by_role）记在产出 claim 的
 * created_by（athlete 身份）上；Distiller **不**写 claim_verification（自背书违 judge≠athlete，那是 Verifier 的活）。
 */
import { randomUUID } from 'node:crypto'

import {
  commitClaim,
  getSource,
  markSourceHumanPending,
  recordAgentRun,
  type AgentRunTraceInput,
  type DB,
  type Embedder,
  type SameFactJudge,
} from '@engram/core'

import {
  READABLE_KINDS,
  type ReadResult,
  type ReadSegment,
  type SourceReader,
} from './read/source-reader.js'
import type { AgentRuntime, AgentTool } from './runtime/port.js'

const DEFAULT_MAX_TURNS = 12
const DEFAULT_BY_ROLE = 'agent:distiller'

export interface DistillerDeps {
  db: DB
  embedder: Embedder
  judge: SameFactJudge
  /** 有界 agent loop 运行时（端口）。测试注 harness-pi+fake model，生产注 harness-pi+真 model。 */
  runtime: AgentRuntime
  /**
   * read_source 读法端口（S16）。按 kind 把异构源归一成带 locator 锚的分块；含图走 VLM。
   * 测试注 makeFakeSourceReader（确定性、零网络），生产含图 kind 注 makeVlmSourceReader（env-gated）。
   */
  reader: SourceReader
}

export interface DistillOptions {
  /** 有界 loop 步数上限；耗尽 → 降级人工。默认 12。 */
  maxTurns?: number
  /** 工种身份（by_role / createdBy）。默认 'agent:distiller'。 */
  byRole?: string
  /** 显式标注此源含图、应走 reader 的视觉通道（缺省由 reader 按 kind 默认判定）。 */
  hasImages?: boolean
}

export interface DistillResult {
  sourceId: string
  status: 'done' | 'human_pending'
  /** 成功提交的 claim 次数（每次 commit_claim 工具调用成功 +1；同一事实合并仍计一次提交）。 */
  committed: number
  /**
   * done / max_turns / aborted / error / unsupported_kind / empty_read /
   * no_claims（loop 干净收尾但 0 claim 提交）/ unknown_locator（loop 干净收尾但出现过编造/未命中 read 分块的 locator）。
   * 后两者也走 markSourceHumanPending 降级 —— 见 runDistiller 收尾段（EGR-CR-022）。
   */
  reason: string
  /** S5:本次蒸馏的 agent run 相关键(盖到产出 claim 的 producing_run_id + agent_run_trace.run_id)。 */
  runId: string
  /** S5:本次 run trace 是否成功落库(best-effort;false=被吞,调用方可据此计失败数,不影响蒸馏本身)。 */
  traceRecorded: boolean
}

const SYSTEM_PROMPT =
  'You are the Distiller. Read the given source and extract its atomic factual claims. ' +
  'For EACH claim, call commit_claim with the claim text and a `locator` pointing to where in the source ' +
  'the fact is stated — a claim with no locator is rejected and not committed. Prefer structured triples ' +
  '(subject/predicate/object) when the fact is structured. Do NOT invent facts that are not in the source. ' +
  'When every atomic claim has been committed, call finish.'

/**
 * loop prompt 里「分块正文」段的起始标记 —— 渲染(本文件 renderForLoop)与离线 fake 抽取器(eval 的
 * makeExtractingFakeRuntime,靠解析 prompt 还原分块)共用的**单一真相源**,杜绝两处各写一份 marker 跨模块漂移。
 * 标记后紧跟每块一行「<locator>\t<text>」(真 tab 分隔)。
 */
export const LOOP_SEGMENTS_MARKER = 'Source content (each line is "<locator>\\t<text>"):\n'

/**
 * 把 read_source 的分块渲染成 loop prompt：每块一行「<locator>\t<text>」，loop 据此逐块 cite。
 * 同时把本 kind 的 locator 形状提示拼进 system prompt，告诉 LLM 该 cite 成什么样（cell/turn/page…）。
 */
function renderForLoop(kind: string, read: ReadResult): { systemPrompt: string; prompt: string } {
  const systemPrompt = `${SYSTEM_PROMPT}\nLocators for this source: ${read.locatorHint}`
  const body = read.segments.map((s) => `${s.locator}\t${s.text}`).join('\n')
  return {
    systemPrompt,
    prompt: `Source kind: ${kind}\nRead strategy: ${read.strategy}\n${LOOP_SEGMENTS_MARKER}${body}`,
  }
}

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
  // S5:本次蒸馏的 agent run 相关键。盖到产出 claim 的 producing_run_id + agent_run_trace.run_id ⇒ 「错误决策 → 产出它的 run」可 join。
  const runId = randomUUID()

  const src = await getSource(deps.db, sourceId)
  if (!src) {
    throw new Error(`distiller: source ${sourceId} not found`)
  }
  if (!READABLE_KINDS.has(src.kind)) {
    // reader 不认这个 kind → 降级人工（沿用 S15 同一条降级路径，不新开第二条）。
    await markSourceHumanPending(deps.db, {
      sourceId,
      reason: `unsupported source kind '${src.kind}'`,
      byRole,
    })
    return {
      sourceId,
      status: 'human_pending',
      committed: 0,
      reason: 'unsupported_kind',
      runId,
      traceRecorded: false, // 未进 loop、无 agent run 可记
    }
  }

  // ① read_source（S16）：按 kind 选读法，归一成带 locator 锚的分块（含图走 VLM，经注入端口，零硬编码模型）。
  const read = await deps.reader.read({
    kind: src.kind,
    content: src.content,
    ...(opts.hasImages !== undefined ? { hasImages: opts.hasImages } : {}),
  })
  if (read.segments.length === 0) {
    // 源畸形 / 读不出任何可定位块 → 降级人工（同一条降级路径，不进 loop，不无限重试）。
    await markSourceHumanPending(deps.db, {
      sourceId,
      reason: `read_source (strategy='${read.strategy}') yielded no locatable segments`,
      byRole,
    })
    return {
      sourceId,
      status: 'human_pending',
      committed: 0,
      reason: 'empty_read',
      runId,
      traceRecorded: false, // 未进 loop、无 agent run 可记
    }
  }

  // read 产出的合法 locator 集合：commit_claim 的 locator 必须命中其一，否则视为无出处（拒写 + 回灌 LLM），
  // 不进 commitClaim。这是唯一同时掌握「read 产出的 locator」与「模型自报 locator」的层，根因修复落在此（EGR-CR-022）。
  const segmentByLocator = new Map<string, ReadSegment>()
  for (const s of read.segments) segmentByLocator.set(s.locator, s)

  let committed = 0
  // 模型自报了一个不在 read 分块里的 locator（含空 locator）的次数。>0 即「出现过编造锚」→ 收尾降级人工 + 留 audit 信号。
  let unknownLocatorCount = 0

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
        unknownLocatorCount += 1
        return {
          text: 'rejected: a `locator` (provenance into the source) is required — ungrounded claims are not committed',
          isError: true,
        }
      }
      const segment = segmentByLocator.get(locator)
      if (!segment) {
        // 未知 locator：模型编了一个不在本次 read 分块里的锚 → 拒写 + 回灌 LLM（带上合法锚提示），不进 commitClaim。
        unknownLocatorCount += 1
        const known = [...segmentByLocator.keys()]
        return {
          text: `rejected: locator '${locator}' is not a known segment of this source — cite one of the read locators (${known.slice(0, 12).join(', ')}${known.length > 12 ? ', …' : ''})`,
          isError: true,
        }
      }
      let excerpt: string | undefined
      if (typeof args.excerpt === 'string' && args.excerpt.trim() !== '') {
        const provided = args.excerpt.trim()
        if (!segment.text.includes(provided)) {
          // excerpt 必须逐字出自命中 segment；否则拒写 + 回灌（不静默改写，让 LLM 自纠），不进 commitClaim。
          return {
            text: `rejected: excerpt is not a verbatim substring of segment '${locator}' — quote text that actually appears there, or omit excerpt`,
            isError: true,
          }
        }
        excerpt = provided
      }
      const draft = {
        claimText,
        createdBy: `${byRole}:${sourceId}`,
        producingRunId: runId, // S5:盖 join 键到 claim.producing_run_id(纯元数据,不进 confidence/状态/召回)
        ...(typeof args.subject === 'string' ? { subject: args.subject } : {}),
        ...(typeof args.predicate === 'string' ? { predicate: args.predicate } : {}),
        ...(typeof args.object === 'string' ? { object: args.object } : {}),
      }
      const res = await commitClaim(deps.db, deps.embedder, deps.judge, draft, [
        {
          sourceId,
          locator,
          relevance: 'exact',
          ...(excerpt !== undefined ? { excerpt } : {}),
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

  const { systemPrompt, prompt } = renderForLoop(src.kind, read)
  const result = await deps.runtime.run({
    systemPrompt,
    prompt,
    tools: [commitTool, finishTool],
    maxTurns,
  })

  // S5:把本次 run 的 usage + 工具 rollup 落 agent_run_trace(best-effort、永不抛;ok=false 仅记一笔、不影响蒸馏)。
  const traceInput: AgentRunTraceInput = {
    runId,
    workerName: byRole,
    byRole,
    reason: result.reason,
    turns: result.turns,
    ...(result.usage !== undefined
      ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          ...(result.usage.reasoningTokens !== undefined
            ? { reasoningTokens: result.usage.reasoningTokens }
            : {}),
        }
      : {}),
    ...(result.trace !== undefined
      ? {
          toolCalls: result.trace.toolCalls,
          toolErrors: result.trace.toolErrors,
          toolNames: result.trace.toolNames,
        }
      : {}),
    payload: { sourceId, committed },
  }
  const traceRecorded = (await recordAgentRun(deps.db, traceInput)).ok

  if (result.reason !== 'done') {
    // 有界 loop 耗尽 / 出错 / 中断 → 降级人工（已提交的 claim 保留），不无限重试、不阻塞 ingestion。
    await markSourceHumanPending(deps.db, {
      sourceId,
      reason: `bounded distill loop ended with reason='${result.reason}' after ${result.turns} turns`,
      byRole,
    })
    return {
      sourceId,
      status: 'human_pending',
      committed,
      reason: result.reason,
      runId,
      traceRecorded,
    }
  }

  // loop 正常收尾，但若全程一条都没提交、或反复编造未命中 read 分块的 locator → 不算干净 done，
  // 降级人工 + 留可观测信号（unknown_locator 即便最终有部分合法 claim 也降级 —— 出现过编造锚本身就是需人看的 audit）。EGR-CR-022。
  if (unknownLocatorCount > 0 || committed === 0) {
    // 「出现过编造锚」是更具体、更需人看的 audit 信号，优先于「0 claim」归因。
    const reason = unknownLocatorCount > 0 ? 'unknown_locator' : 'no_claims'
    await markSourceHumanPending(deps.db, {
      sourceId,
      reason:
        unknownLocatorCount > 0
          ? `distill loop attempted ${unknownLocatorCount} unknown-locator commit(s)`
          : 'distill loop finished with zero committed claims',
      byRole,
    })
    return { sourceId, status: 'human_pending', committed, reason, runId, traceRecorded }
  }
  return { sourceId, status: 'done', committed, reason: result.reason, runId, traceRecorded }
}
