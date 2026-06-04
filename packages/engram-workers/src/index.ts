/**
 * Engram 五工种（跑在 harness-pi 上、经 Consumer SPI 自养知识库）。领域无关。
 * S15：Distiller 上线。工种逻辑只依赖 @engram/core SPI + AgentRuntime 端口；agent loop 隔在 runtime adapter 后。
 */
export const WORKERS_VERSION = '0.0.0' as const

export {
  runDistiller,
  type DistillerDeps,
  type DistillOptions,
  type DistillResult,
} from './distiller.js'
export {
  type AgentRuntime,
  type AgentTool,
  type AgentToolResult,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentStopReason,
} from './runtime/port.js'
export { makeHarnessPiRuntime } from './runtime/harness-pi.js'
