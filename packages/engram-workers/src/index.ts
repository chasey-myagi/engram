/**
 * Engram 五工种（跑在 harness-pi 上、经 Consumer SPI 自养知识库）。领域无关。
 * S15：Distiller 上线（有界 agent loop + AgentRuntime 端口）。S16：read_source 全 kind（SourceReader 端口，含图走 VLM）。
 * S17：Verifier 上线（函数/统计 + 点状一次 LLM，非 loop；EntailmentJudge 端口）。
 * 工种逻辑只依赖 @engram/core SPI + 端口（AgentRuntime / SourceReader / EntailmentJudge）；agent loop / VLM / LLM 都隔在端口后。
 */
export const WORKERS_VERSION = '0.0.0' as const

export {
  runDistiller,
  type DistillerDeps,
  type DistillOptions,
  type DistillResult,
} from './distiller.js'
export {
  runVerifier,
  verifyEnqueued,
  VERIFIER_TRIGGER,
  type VerifierDeps,
  type VerifierOptions,
  type VerifierResult,
  type PatrolOutcome,
} from './verifier.js'
export {
  type AgentRuntime,
  type AgentTool,
  type AgentToolResult,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentStopReason,
} from './runtime/port.js'
export { makeHarnessPiRuntime } from './runtime/harness-pi.js'

// S16 · read_source 端口 + 实现（按 kind 选读法；含图走 VLM，经注入端口，零硬编码模型）。
export {
  type SourceReader,
  type ReadRequest,
  type ReadResult,
  type ReadSegment,
  READABLE_KINDS,
  defaultHasImages,
} from './read/source-reader.js'
export { makeFakeSourceReader, type FakeSourceReaderOptions } from './read/fake-source-reader.js'
export { makeVlmSourceReader } from './read/vlm-source-reader.js'
