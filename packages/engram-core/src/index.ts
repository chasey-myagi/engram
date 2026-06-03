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
