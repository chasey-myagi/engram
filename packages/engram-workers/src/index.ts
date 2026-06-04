/**
 * Engram 五工种（跑在 harness-pi 上、经 Consumer SPI 自养知识库）。领域无关。
 * S15：Distiller 上线（有界 agent loop + AgentRuntime 端口）。S16：read_source 全 kind（SourceReader 端口，含图走 VLM）。
 * S17：Verifier 上线（函数/统计 + 点状一次 LLM，非 loop；EntailmentJudge 端口）。
 * S18：Reconciler 上线（函数 + 灰区一次 LLM，非 loop；batch_appended 触发；复用 EntailmentJudge 端口）。
 * S19：Harvester 上线（**纯统计、无 LLM、无 agent loop**；usage_truth 独立门控 → f4，闭合「使用→升信」）。
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
  runReconciler,
  reconcileBatch,
  RECONCILER_TRIGGER,
  type ReconcilerDeps,
  type ReconcilerOptions,
  type ReconcilerResult,
  type PairOutcome,
  type IndepAuditOutcome,
} from './reconciler.js'
export {
  runHarvester,
  harvestBatch,
  HARVESTER_TRIGGER,
  type HarvesterDeps,
  type HarvesterOptions,
  type HarvesterResult,
  type HarvestOutcome,
} from './harvester.js'
export {
  runArbiter,
  arbitrateConflicts,
  ARBITER_TRIGGER,
  type ArbiterDeps,
  type ArbiterOptions,
  type ArbiterResult,
  type ArbiterOutcome,
} from './arbiter.js'
export {
  type AgentRuntime,
  type AgentTool,
  type AgentToolResult,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentStopReason,
} from './runtime/port.js'
export { makeHarnessPiRuntime } from './runtime/harness-pi.js'

// S24 · choreography 数据面路由器（极简确定性事件总线；按工种**声明的触发**路由，非在线 meta-orchestrator）。
export {
  EventDispatcher,
  routeKeys,
  DISTILLER_TRIGGER,
  type EngramEvent,
  type EngramEventType,
  type WorkerHandler,
  type RegisteredWorker,
  type DispatchTrace,
  type RunToConvergenceResult,
} from './runtime/dispatcher.js'

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
