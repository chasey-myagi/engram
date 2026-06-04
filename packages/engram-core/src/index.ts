/**
 * Engram 内核 — agent 原生可生长知识库。
 * 一条 claim = 一个 engram。不是 RAG。要建什么见 docs/PRD.md（附录 A = build-from 契约）。
 * 内核领域无关：只认 source / claim / relation / provenance / confidence。
 */
export const ENGRAM_VERSION = '0.0.0' as const

export * as schema from './db/schema.js'
export type { SourceKind, ClaimStatus } from './db/schema.js'
export { createPool, createDb, type DB } from './db/client.js'
export { halfLifeDaysForKind } from './confidence/confidence.js'
export {
  addSource,
  getSource,
  appendClaim,
  supersedeClaim,
  computeConfidenceFromProvenances,
  type SourceInput,
  type DraftClaim,
  type ProvenanceInput,
  type ProvenanceRef,
} from './spi/append-claim.js'
export {
  recallClaims,
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
  DEFAULT_RECALL_LIMIT,
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
export {
  computeReliability,
  computeCalibrationFromUsage,
  DEFAULT_BIN_COUNT,
  type CalibrationSample,
  type ReliabilityBin,
  type ReliabilityReport,
} from './calibration/calibration.js'
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
  type ImmunityResult,
  type PromoteOptions,
  type PromoteResult,
  type GoldenQuestion,
  type PromotionAuditRow,
} from './spi/exam-immunity.js'
export {
  transitionClaim,
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
