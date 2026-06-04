/**
 * Engram 内核 — agent 原生可生长知识库。
 * 一条 claim = 一个 engram。不是 RAG。要建什么见 docs/PRD.md（附录 A = build-from 契约）。
 * 内核领域无关：只认 source / claim / relation / provenance / confidence。
 */
export const ENGRAM_VERSION = '0.0.0' as const

export * as schema from './db/schema.js'
export { createPool, createDb, type DB } from './db/client.js'
export {
  addSource,
  appendClaim,
  supersedeClaim,
  type SourceInput,
  type DraftClaim,
  type ProvenanceInput,
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
