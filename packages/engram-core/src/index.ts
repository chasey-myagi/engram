/**
 * Engram 内核 — agent 原生可生长知识库。
 * 一条 claim = 一个 engram。不是 RAG。要建什么见 docs/PRD.md（附录 A = build-from 契约）。
 * 内核领域无关：只认 source / claim / relation / provenance / confidence。
 */
export const ENGRAM_VERSION = '0.0.0' as const

export * as schema from './db/schema.js'
export type { SourceKind, ClaimStatus } from './db/schema.js'
export { createPool, createDb, type DB, type Tx } from './db/client.js'
export { halfLifeDaysForKind } from './confidence/confidence.js'
export {
  addSource,
  getSource,
  appendClaim,
  supersedeClaim,
  computeConfidenceFromProvenances,
  type SourceInput,
  type AddSourceResult,
  type DraftClaim,
  type ProvenanceInput,
  type ProvenanceRef,
} from './spi/append-claim.js'
export {
  updateSourceMetadata,
  annotateSourceAuthority,
  getSourceMetadataEvents,
  type SourceMetadataEvent,
} from './spi/source-metadata.js'
export {
  recallClaims,
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
  DEFAULT_RECALL_LIMIT,
  RECALL_SOURCE_META_KEYS,
  type RecallResult,
  type RecallContext,
  type ConfidenceSnapshot,
  type RecalledProvenance,
} from './spi/recall-claims.js'
export {
  reportUsage,
  getUsageEvents,
  getFailurePool,
  USAGE_OUTCOMES,
  FAILURE_OUTCOMES,
  type UsageOutcome,
  type ReportUsageContext,
  type UsageEvent,
} from './spi/report-usage.js'
// EGR-CR-003 方案 A：recall_snapshot 读写口 + test-only seed-真快照 helper（让预测概率只能来自真实 recall）。
export {
  persistRecallSnapshot,
  getRecallSnapshot,
  type RecallSnapshotRow,
  type PersistRecallSnapshotInput,
} from './spi/recall-snapshot.js'
export {
  computeReliability,
  computeCalibrationFromUsage,
  DEFAULT_BIN_COUNT,
  type CalibrationSample,
  type ReliabilityBin,
  type ReliabilityReport,
} from './calibration/calibration.js'
// S27 · g′ 表示 + applyG-by-version（命门 A.3）：单调校准映射（升序非递减 knots，分段线性插值）。
export {
  applyG,
  applyGMap,
  assertCalibrationMap,
  CALIBRATION_IDENTITY,
  CALIBRATION_CODE_VERSION,
  IDENTITY_MAP,
  type CalibrationKnot,
  type CalibrationMap,
} from './confidence/confidence.js'
// S27 · 校准映射版本化 store（append-only / 活动=最新一行）+ 原子激活（验收门唯一写者）+ g=identity 即时回退（Story 29）。
export {
  appendCalibrationMapTx,
  commitCalibrationMap,
  rollbackToIdentity,
  getActiveCalibrationVersion,
  getActiveCalibrationMap,
  getActiveCalibrationRow,
  loadCalibrationMaps,
  getCalibrationHistory,
  StaleActiveCalibrationError,
  CalibrationVersionRedefineError,
  type CommitCalibrationInput,
  type CalibrationMapRow,
} from './calibration/calibration-store.js'
// S27 · 旁挂只读 Advisor（能力：诊断 + 绑 ΔECE，无写权）+ 拟合端口（S28 isotonic 从此接入；S27 不实现）。
export {
  advise,
  identityLikeCandidate,
  type GoldenSample,
  type CalibrationFitter,
  type CalibrationProposal,
  type AdvisorOptions,
} from './calibration/advisor.js'
// S27 · 确定性验收门（权力：全项通过才 approve，逐项可咬；A.8 否决在线 meta-orchestrator）。
export {
  runAcceptanceGate,
  GATE_CHECK_IDS,
  MAX_GATE_FLIP_FRACTION,
  MIN_SAMPLES_PER_BIN,
  MIN_OUTPUT_SPREAD,
  type GateCheckId,
  type GateCheck,
  type GateVerdict,
  type GateInputs,
} from './calibration/acceptance-gate.js'
// S27 · 控制面链路：Advisor→验收门→（验收门全项通过则原子换 / 否则 fail-silent HOLD）。活动 g 的唯一写入路径（除即时回退）。
export {
  evaluateAndMaybeSwap,
  type SwapResult,
  type EvaluateOptions,
} from './calibration/recalibrate.js'
// S28 · isotonic 拟合器（PAVA，确定性单调；A3 红线在 {rawPredicted,correct} 输入边界守）—— S27 CalibrationFitter 落地。
export { fitIsotonic, makeIsotonicFitter } from './calibration/isotonic.js'
// S28 · 「首次校准」触发外壳（Harvester 校准半边）：usage_truth 独立门控取样 → ≥200 门 → fit → 验收门原子换。
export {
  fitAndMaybeRecalibrate,
  collectUsageCalibrationSamples,
  MIN_FIT_SAMPLES,
  type FitFromUsageOptions,
  type FitResult,
} from './calibration/fit-from-usage.js'
export { applyAdapter, DEFAULT_ADAPTER_EPSILON, type RecallAdapter } from './spi/adapter.js'
export {
  setStandards,
  getActiveStandards,
  DEFAULT_STANDARDS,
  type Standards,
  type StandardsRow,
  type StandardsInput,
} from './config/standards.js'
export {
  EMBEDDING_DIM,
  DEFAULT_RECALL_TOPK,
  DEFAULT_RECALL_MIN_SIMILARITY,
  type Embedder,
  type EmbedKind,
} from './embedding/embedder.js'
export { makeFakeEmbedder, type FakeEmbedderOptions } from './embedding/fake-embedder.js'
export { makeDashScopeEmbedder } from './embedding/dashscope.js'
export {
  markStaleForReembed,
  reembedMarked,
  getReembedMarkers,
  type ReembedMarker,
} from './embedding/reembed.js'
export {
  recordGap,
  getMetricsEvents,
  getGapEvents,
  GAP_RECORDED,
  METRICS_EVENT_KINDS,
  type GapPayload,
  type MetricsEvent,
  type GapEvent,
} from './spi/metrics.js'
export {
  runGapQuestion,
  runL5Suite,
  L5_GAP_QUESTIONS,
  L5_GAP_NAMESPACE,
  type L5Question,
  type GapObservation,
  type L5SuiteReport,
} from './eval/l5-gap.js'
export {
  refluxFailures,
  getRegressionPool,
  getL5Candidates,
  replayRegressionItem,
  replayRegressionPool,
  isHumanRole,
  type RegressionItem,
  type L5Candidate,
  type ReplayVerdict,
  type ReplayReport,
} from './spi/reflux.js'
export {
  promoteCandidate,
  getGoldenQuestions,
  getPromotionAudit,
  getRoundCohort,
  type ImmunityResult,
  type PromoteOptions,
  type PromoteResult,
  type GoldenQuestion,
  type PromotionAuditRow,
  type RoundCohortRow,
} from './spi/exam-immunity.js'
// S29 · 冻结红队世代（版本化 append-only，纵向比较的固定敌手）+ 免疫力维度（detection rate，离线报告、不进计分）。
export {
  freezeRedTeamGeneration,
  getRedTeamGeneration,
  getRedTeamGenerations,
  recordImmunityScore,
  getImmunityScores,
  REDTEAM_CLASSES,
  isRedTeamClass,
  type RedTeamClass,
  type RedTeamItem,
  type RedTeamGeneration,
  type ImmunityScore,
} from './spi/redteam-generation.js'
// 可观测第三层(S3)· agent-loop trace sink:把 harness-pi 采到的 run-level 留痕落库 + 按 runId 读回(S9 诊断 join 用)。
// best-effort、永不抛进 worker;A3 边界——只写/读留痕,绝不进 g/纵向(a3-firewall allowlist 内的唯一 trace 引用点)。
export {
  recordAgentRun,
  getAgentRunTrace,
  type AgentRunTraceInput,
  type AgentRunTraceRecord,
} from './observability/agent-trace.js'
// 可观测第三层(S8)· decision_eval sink:把 Plan A 决策价值实验的有符号读数(lift/delta 可负)落库 + 按 runLabel 读回。
// fail-loud(实验记录、丢行即污染结论);A3 红线——决策只落本表、绝不走 report_usage,且本模块不读 usage_truth/不触 g(firewall ③b 钉死)。
export {
  recordDecisionEval,
  getDecisionEval,
  type DecisionEvalInput,
  type DecisionEvalRecord,
} from './observability/decision-eval.js'

// S30 · L3 系统维度（substrate-ready 七维）的 append-only 度量脊柱 + 离线幂等聚合 + 时间序列读路径。
export {
  recordDimension,
  getDimensionEvents,
  getDimensionSeries,
  DIMENSION,
  DIMENSION_NAMES,
  isDimensionName,
  type DimensionName,
  type DimensionEvent,
  type RecordDimensionInput,
  type DimensionSeriesPoint,
} from './spi/dimension-events.js'
// EGR-CR-039 · dispatcher 吞掉的工种失败的 durable dead-letter / 审计 SPI：record/get 对 + 非空门 + 确定性排序。
// 落库责任由 EngramRunner best-effort 承接（总线保持零 db 依赖）；纯审计、绝不进任何在线判据/校准 g/计分。
export {
  recordWorkerFailure,
  getWorkerFailures,
  type WorkerFailure,
  type RecordWorkerFailureInput,
} from './spi/worker-failure.js'
export {
  computeSystemDimensions,
  runSystemDimensions,
  runGoldenItem,
  aggregateLatest,
  L3_GOLDEN,
  L3_GOLDEN_NAMESPACE,
  L3_GOLDEN_MIN_SIMILARITY,
  DEFAULT_K,
  RELOCATED_TO_S31,
  type SystemGoldenItem,
  type GoldenObservation,
  type SystemDimensions,
  type ComputeOptions,
  type RunReport,
} from './eval/system-dimensions.js'
// S31 · 归因脊柱（P3 门）：单环失败归因——任一已落库失败确定性追溯回恰好一个 loop/工种（确定性 + 单环优先级表）。
export {
  attributeFailure,
  loopForRedTeamClass,
  claimCreatedBy,
  lineageEdges,
  RESPONSIBLE_LOOP,
  RESPONSIBLE_LOOPS,
  PRECEDENCE,
  type ResponsibleLoop,
  type FailureKind,
  type FailureInput,
  type Attribution,
} from './eval/attribution-spine.js'
// S31 · 纵向冻结-golden 同卷复考（第⑧维，S30 迁来）：跨 release append-only ΔECE↓/Δcoverage↑ + 内/中/外三环 + A3 边界。
export {
  recordRecompete,
  runRecompeteSnapshot,
  getRecompeteSeries,
  getRecompeteEvents,
  RECOMPETE_DIMENSIONS,
  RING,
  RINGS,
  FROZEN_GOLDEN_VERSION,
  type RecompeteDimension,
  type Ring,
  type RecompeteEvent,
  type RecordRecompeteInput,
  type RecompeteReport,
  type RunRecompeteOptions,
  type RecompeteSeriesPoint,
} from './eval/longitudinal-recompete.js'
// S31 · L5 → 归因脊柱迁移「长出了知识」：曾零召回的 L5 题变可答（recall≥1 + 人确认）→ append-only 迁出 L5。
export {
  migrateL5IfGrew,
  getKnowledgeGrewEvents,
  isMigratedOutOfL5,
  liveL5Questions,
  runLiveL5Suite,
  type KnowledgeGrewEvent,
  type MigrateL5Options,
  type MigrateL5Result,
} from './eval/l5-migration.js'
export { trustedHumanActor, agentActor, type ActorContext } from './spi/actor.js'
export {
  transitionClaim,
  transitionClaimInTx,
  PROMOTE_CONFIDENCE_FLOOR,
  type TransitionOptions,
  type PositiveEvidence,
} from './spi/transition.js'
export { commitClaim, type CommitResult } from './spi/commit-claim.js'
export {
  markSourceHumanPending,
  getHumanPendingSources,
  type HumanPendingSource,
} from './spi/worker-audit.js'
export {
  objectEquivalent,
  deterministicVerdict,
  adjudicate,
  SAME_FACT_CANDIDATE_SIMILARITY,
  SAME_FACT_TOPK,
  SAME_FACT_GRAY_ZONE_SIMILARITY,
  type SameFactVerdict,
  type SameFactJudge,
  type ClaimShape,
} from './same-fact/same-fact.js'
export { makeFakeSameFactJudge, type FakeJudgeOptions } from './same-fact/fake-judge.js'
export { makeDashScopeSameFactJudge } from './same-fact/dashscope-judge.js'
export {
  independent,
  countIndependentSupports,
  independentSupportFactor,
  type SourceIndep,
} from './same-fact/independent.js'
export {
  reconcilePair,
  isReconcileCandidate,
  objectSubsetViaEntailment,
  hasNonIndependentPair,
  RECONCILE_PAIR_SIMILARITY,
  type ReconcileVerdict,
} from './same-fact/reconcile.js'
export {
  recordReconcileEscalation,
  getReconcileEscalations,
  RECONCILE_POISON_REASON,
  type ReconcileEscalation,
} from './spi/reconcile-signal.js'
export {
  type EntailmentJudge,
  type EntailmentQuery,
  type EntailmentEvidence,
  type EntailmentVerdict,
} from './verifier/entailment-judge.js'
export {
  makeFakeEntailmentJudge,
  type FakeEntailmentJudgeOptions,
} from './verifier/fake-entailment-judge.js'
export { makeDashScopeEntailmentJudge } from './verifier/dashscope-entailment-judge.js'
export {
  writePatrolVerdict,
  markPatrolVerdictRefused,
  latestPatrolVerdict,
  computeEntailmentFactor,
  latestEntailmentFactors,
  entailmentVerdictToFactor,
  type PatrolVerdict,
} from './verifier/patrol-verdict.js'
// S19 · f4 usageCorrect 生产者（usage_truth 独立门控统计 → observed_correctness → f4）。Harvester 工种调它。
export {
  computeUsageCorrectStats,
  computeUsageCorrectFactor,
  latestUsageCorrectFactors,
  usageCorrectStatsFromCounts,
  USAGE_CORRECT_K,
  USAGE_CORRECT_MIN_SAMPLES,
  type UsageCorrectStats,
} from './harvest/usage-correct.js'
export { recomputeClaimConfidence, type RecomputeResult } from './harvest/recompute.js'
// S22 · f1 humanReview 生产者（最后一个休眠因子）：主编人审 → claim_verification(kind=patrol, human) → f1。
export {
  writeHumanReview,
  latestHumanReview,
  computeHumanReviewFactor,
  latestHumanReviewFactors,
  HUMAN_REVIEW_APPROVE,
  HUMAN_REVIEW_REJECT,
  type HumanReviewVerdict,
} from './editor/human-review.js'
// S22 · 主编三动作（Approve / Edit-Approve / Reject）：因子-only、append-only、状态由门限重算（人的红边）。
export {
  approveClaim,
  editApproveClaim,
  rejectClaim,
  type EditorActorContext,
  type EditorActionResult,
} from './editor/editor-action.js'
// S22 · human_overturn 翻案事件（S26 恒温器 falseQuarantineRate 的生产者）。
export {
  recordHumanOverturn,
  getHumanOverturns,
  HUMAN_OVERTURN,
  type OverturnKind,
  type HumanOverturnPayload,
  type HumanOverturn,
} from './editor/human-overturn.js'
export {
  adjudicateConflict,
  MACHINE_RUNGS,
  type ConflictSide,
  type Adjudication,
  type LadderRung,
} from './spi/conflict-ladder.js'
export {
  loadConflictSide,
  resolveConflict,
  escalateConflict,
  humanAdjudicateConflict,
  getEditorConflictQueue,
  getResolvedConflicts,
  getClaimStatus,
  adjudicatedPairKeys,
  CONFLICT_ADJUDICATED,
  type ConflictAdjudicatedPayload,
  type ConflictAdjudication,
  type ConflictPersistResult,
} from './spi/conflict-arbiter.js'
// S23 · 主编工作台读半边：审阅队列（按实时 confidence 升序）+ 单条 claim 谱系视图（出处/引用 page/版本史）。
export {
  getEditorInbox,
  getClaimLineage,
  EDITOR_INBOX_STATUSES,
  DEFAULT_INBOX_LIMIT,
  type EditorInboxRow,
  type EditorInboxQuery,
  type ClaimLineage,
  type LineageProvenance,
  type CitingPage,
  type LineageVersion,
} from './editor/editor-inbox.js'
// S23 · recall / editor-inbox 的实时 confidence 重算单一口径（抽取，防漂移）。
export {
  recomputeLiveConfidence,
  loadLiveConfidence,
  liveContradictsByClaim,
  type LiveConfidence,
  type RecomputeCandidate,
} from './confidence/live-recompute.js'
// S21 · NC-exact 红线统一闸门（红线#3 / A.6）：判 non_compliant/refuted 须 ≥1 条 relevance='exact' 反向证据，
// 否则拒判 + 强制升级主编。Verifier 与 Arbiter 共用此一处闸门（无分叉）。
export {
  assertNcExactEvidence,
  countExactProvenances,
  getRefusedRulings,
  RULING_REFUSED,
  type NcExactGateResult,
  type RefusedRulingKind,
  type RulingRefusedPayload,
  type RefusedRuling,
} from './spi/nc-exact-gate.js'
// S26 · GovernanceController 恒温器（A.7/A.8）：确定性闭环控制律（proportional + deadband + bounded damped step，
// 收敛不振荡）→ 五指标映射 D2 收紧 + falseQuarantineRate 反向放宽巡查（counter-force）；版本化持久化 + fail-silent
// 编排 + L2 仿真谐波。全经 governance barrel 导出。
export * from './governance/index.js'
