/**
 * Engram 内核五 primitive 的 Drizzle schema —— 严格对齐 docs/PRD.md 附录 A.1。
 * 内核领域无关：只认 source / claim / relation / provenance / confidence；业务语义经 source.meta 注入，内核不解释。
 */
import { sql } from 'drizzle-orm'
import {
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

export const sourceKind = pgEnum('source_kind', [
  'formal_document',
  'structured_spec',
  'human_qa',
  'conversation_log',
  'historical_artifact',
  'agent_synthesis',
  'external_feed',
])
export const claimStatus = pgEnum('claim_status', [
  'draft',
  'active',
  'flagged',
  'quarantined',
  'superseded',
])
export const relationType = pgEnum('relation_type', [
  'supports',
  'contradicts',
  'refines',
  'derived_from',
  'supersedes',
])
export const provRelevance = pgEnum('prov_relevance', [
  'exact',
  'supporting',
  'tangential',
  'irrelevant',
])
export const verificationKind = pgEnum('verification_kind', [
  'patrol',
  'usage_truth',
  'reembed_marker',
])

/** source：不可变原文。content_hash 幂等去重；authority_score 连续、消费方可覆盖；meta 是领域身份注入口。 */
export const source = pgTable('source', {
  id: uuid('id').primaryKey().defaultRandom(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull().unique(),
  kind: sourceKind('kind').notNull(),
  authorityScore: doublePrecision('authority_score').notNull().default(0.5),
  meta: jsonb('meta')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** claim：事实原子。confidence 是一套（raw / g / 因子快照）；S1 暂存占位值，连续化在 S2（命门）接管。 */
export const claim = pgTable('claim', {
  id: uuid('id').primaryKey().defaultRandom(),
  claimText: text('claim_text').notNull(),
  subject: text('subject'),
  predicate: text('predicate'),
  object: text('object'),
  status: claimStatus('status').notNull().default('draft'),
  confidence: doublePrecision('confidence').notNull(),
  confidenceRaw: doublePrecision('confidence_raw').notNull(),
  confidenceFactors: jsonb('confidence_factors').notNull(),
  lineageId: uuid('lineage_id').notNull(),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** claim_provenance：D1 硬门。source_id NOT NULL FK —— 无出处的 claim 物理写不进。 */
export const claimProvenance = pgTable('claim_provenance', {
  id: uuid('id').primaryKey().defaultRandom(),
  claimId: uuid('claim_id')
    .notNull()
    .references(() => claim.id),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => source.id),
  locator: text('locator').notNull(),
  excerpt: text('excerpt'),
  relevance: provRelevance('relevance').notNull().default('supporting'),
})

/** relation：claim/page 间 typed 边。 */
export const relation = pgTable('relation', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromClaim: uuid('from_claim')
    .notNull()
    .references(() => claim.id),
  toClaim: uuid('to_claim').references(() => claim.id),
  type: relationType('type').notNull(),
})

/** claim_verification：三用途（D3 巡查标注 / 校准真值 / embedding 版本锚）；by_role 入表（judge≠athlete）。 */
export const claimVerification = pgTable('claim_verification', {
  id: uuid('id').primaryKey().defaultRandom(),
  claimId: uuid('claim_id')
    .notNull()
    .references(() => claim.id),
  kind: verificationKind('kind').notNull(),
  verdict: jsonb('verdict').notNull(),
  byRole: text('by_role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** page_claims：page = claim 的 M:N 组装。 */
export const pageClaims = pgTable(
  'page_claims',
  {
    pageId: uuid('page_id').notNull(),
    claimId: uuid('claim_id').notNull(),
    ord: integer('ord'),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.claimId] })],
)

export type SourceKind = (typeof sourceKind.enumValues)[number]
export type ClaimStatus = (typeof claimStatus.enumValues)[number]
export type RelationType = (typeof relationType.enumValues)[number]
export type ProvRelevance = (typeof provRelevance.enumValues)[number]
export type VerificationKind = (typeof verificationKind.enumValues)[number]
