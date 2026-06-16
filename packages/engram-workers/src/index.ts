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
  type AgentRunUsage,
  type AgentRunTrace,
  type AgentStopReason,
} from './runtime/port.js'
export { makeHarnessPiRuntime, type HarnessPiRuntimeOptions } from './runtime/harness-pi.js'
// 生产 agent loop 运行时:DashScope Qwen chat(env-gated,需 DASHSCOPE_API_KEY)。测试用 createFakeModel+makeHarnessPiRuntime。
export { makeQwenRuntime, makeQwenChatModel } from './runtime/dashscope-runtime.js'

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

// S29 · 红队四类对抗样本注入器（经真 append_claim SPI）+ 免疫反应断言（驱动真 Verifier/Arbiter/Reconciler）+
// per-class 免疫力维度打分。冻结世代 fixture 见 ./eval/redteam.gen.ts。
export {
  makeBoundEntailmentOracle,
  makeArbiterFakeRuntime,
  injectAndAssert,
  runRedTeamGeneration,
  type RedTeamRunDeps,
  type InjectionOutcome,
  type ClassScore,
  type RunRedTeamOptions,
  type RedTeamGenerationResult,
} from './eval/redteam-injector.js'
export { REDTEAM_GENERATION_VERSION, REDTEAM_GENERATION_ITEMS } from './eval/redteam.gen.js'

// P4a · 红蓝对抗回合编排（北极星 MVP：单红队 + 冻结世代）。一回合端到端复用 S29 注入器（真工种）+ S12 A1 门 +
// S31 单环归因 + 冻结世代 escalation。两条铁律（A1 题先验真才计分 / A3 检出率禁入 g 与纵向）结构性强制。
export {
  runRedBlueRound,
  type RedBlueRoundDeps,
  type RedBlueRoundOptions,
  type RoundResult,
  type ItemAdmission,
  type BreachAttribution,
} from './eval/red-blue-round.js'

// P4b · EngramRunner —— 把内核 + 五工种 + 控制面(恒温器/校准) + 红蓝对抗接成**可跑自闭环**。S24 choreography 的
// 生产化 + 补齐「内核能力齐了但没运行进程调起来」的缺口（恒温器/校准/dispatcher 真被 tick）。可跑 demo 见 ./runner/main.ts。
export {
  EngramRunner,
  type EngramRunnerDeps,
  type ClosedLoopInput,
  type ClosedLoopReport,
} from './runner/engram-runner.js'
