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

export interface AgentRunResult {
  reason: AgentStopReason
  /** 本轮跑了多少 turn（步）。 */
  turns: number
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
