/**
 * AgentRuntime 端口 —— 抽象「跑一轮有界 agent loop」，把具体 agent loop（harness-pi / pi-coding-agent / 任意）
 * 隔在 adapter 之后。工种逻辑（Distiller…）**只依赖本端口 + @engram/core SPI**，绝不直接 import 任何 agent runtime。
 * 换 loop = 换一个 adapter（见 runtime/harness-pi.ts），工种逻辑一行不动。
 *
 * 与 Embedder / SameFactJudge 同一套注入式样：core 定接口、调用方注入实现、底层细节不外泄。
 * 本文件刻意零外部 import（连 schema 库都不碰）：tool 入参用 plain JSON Schema（pi-ai 校验器有 JSON-Schema 回退路径）。
 */

/** 工具执行结果（回灌给 LLM 的文本 + 是否出错）。 */
export interface AgentToolResult {
  text: string
  /** true = 工具出错；LLM 会看到并可重试。 */
  isError?: boolean
}

/** 一个供 agent loop 调用的工具（loop 无关）。 */
export interface AgentTool {
  name: string
  description: string
  /** 入参的 **plain JSON Schema**（如 {type:'object', properties, required}）。adapter 原样透传给底层 loop。 */
  parameters: Record<string, unknown>
  /** 执行。throw 视为错误（adapter 转成 isError 回灌 LLM）。 */
  execute(args: Record<string, unknown>): Promise<AgentToolResult>
}

/** 归一化终态原因（对齐 harness-pi RunSummary.reason）。done 之外都表示异常/耗尽收尾。 */
export type AgentStopReason = 'done' | 'max_turns' | 'aborted' | 'error' | 'max_continuations'

/**
 * 本轮 token 用量(来自 harness-pi RunSummary.usage)。一次 run = 一个独立 session,故该「session 累计」即本轮量、
 * 无跨 run 重复计数。adapter 取得到才填;fake/旧 adapter 省略(可选,向后兼容)。
 */
export interface AgentRunUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** reasoning/thinking token(provider 提供才有)。 */
  reasoningTokens?: number
}

/**
 * 本轮工具调用的 run-level rollup。adapter 在工具 execute 包装里**纯观测**计数(不改执行顺序/结果 ⇒ 决策不变),
 * 与是否采集无关、对工种透明。per-step 明细(逐 turn args)是后续切片。
 */
export interface AgentRunTrace {
  toolCalls: number
  toolErrors: number
  /** 调用过的工具名(去重、按首次出现序)。 */
  toolNames: string[]
}

export interface AgentRunResult {
  reason: AgentStopReason
  /** 本轮跑了多少 turn（步）。 */
  turns: number
  /** 本轮 token 用量(adapter 能取到才填)。可观测第三层(S2 起)。 */
  usage?: AgentRunUsage
  /** 本轮工具调用 rollup(adapter 能取到才填)。可观测第三层(S2 起)。 */
  trace?: AgentRunTrace
}

export interface AgentRunRequest {
  systemPrompt: string
  prompt: string
  tools: AgentTool[]
  /** 有界 loop 的步数硬上限（防失控）；耗尽 → reason='max_turns'，工种据此降级。 */
  maxTurns: number
}

/** 有界 agent loop 运行时。一次 run = 一个独立 session。 */
export interface AgentRuntime {
  run(req: AgentRunRequest): Promise<AgentRunResult>
}
