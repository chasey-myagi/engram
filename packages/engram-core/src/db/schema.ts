/**
 * Engram 内核五 primitive 的 Drizzle schema —— 严格对齐 docs/PRD.md 附录 A.1。
 * 内核领域无关：只认 source / claim / relation / provenance / confidence；业务语义经 source.meta 注入，内核不解释。
 * id 由 SPI 显式生成（randomUUID），故 PK 不挂 DB 默认 —— 对齐 A.1 的「UUID PRIMARY KEY」(无默认)。
 */
import { sql } from 'drizzle-orm'
import {
  doublePrecision,
  index,
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
  id: uuid('id').primaryKey(),
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
export const claim = pgTable(
  'claim',
  {
    id: uuid('id').primaryKey(),
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
  },
  // lineage_id 是跨版本身份，谱系回溯按它查 —— 核心读路径，建索引。
  (t) => [index('idx_claim_lineage').on(t.lineageId)],
)

/** claim_provenance：D1 硬门。source_id NOT NULL FK —— 无出处的 claim 物理写不进。 */
export const claimProvenance = pgTable(
  'claim_provenance',
  {
    id: uuid('id').primaryKey(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claim.id),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => source.id),
    locator: text('locator').notNull(),
    excerpt: text('excerpt'),
    relevance: provRelevance('relevance').notNull().default('supporting'),
  },
  // provenance 扇出按 claim / source 查（钻回原文、印证计数）—— 建索引。
  (t) => [
    index('idx_claim_provenance_claim').on(t.claimId),
    index('idx_claim_provenance_source').on(t.sourceId),
  ],
)

/** relation：claim/page 间 typed 边。 */
export const relation = pgTable(
  'relation',
  {
    id: uuid('id').primaryKey(),
    fromClaim: uuid('from_claim')
      .notNull()
      .references(() => claim.id),
    toClaim: uuid('to_claim').references(() => claim.id),
    type: relationType('type').notNull(),
  },
  // 边的双向遍历 —— 建索引。
  (t) => [index('idx_relation_from').on(t.fromClaim), index('idx_relation_to').on(t.toClaim)],
)

/** claim_verification：三用途（D3 巡查标注 / 校准真值 / embedding 版本锚）；by_role 入表（judge≠athlete）。 */
export const claimVerification = pgTable(
  'claim_verification',
  {
    id: uuid('id').primaryKey(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claim.id),
    kind: verificationKind('kind').notNull(),
    verdict: jsonb('verdict').notNull(),
    byRole: text('by_role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Verifier / Harvester 按 claim 查巡查/真值记录 —— 建索引。
  (t) => [index('idx_claim_verification_claim').on(t.claimId)],
)

/**
 * standards：配置态规范表（A.2/A.3，主编设）。append-only —— 每次 setStandards 落一行新版本，
 * 「活动」= createdAt 最新一行。改后**新召回请求**用活动权重/门限即刻重算，历史快照（已返回的值拷贝）冻结。
 * 写时护不变量：authority 权重 >0（护 D1）、Σw ≤1、各权重 ≥0；consume_floor ≥ 内核 0.4 且 ≤ must_verify ≤1。
 */
export const standards = pgTable(
  'standards',
  {
    id: uuid('id').primaryKey(),
    factorWeights: jsonb('factor_weights').notNull(), // FactorWeights
    consumeFloor: doublePrecision('consume_floor').notNull(),
    mustVerifyThreshold: doublePrecision('must_verify_threshold').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 活动版本按 created_at 倒序取第一行 —— 建索引。
  (t) => [index('idx_standards_created').on(t.createdAt)],
)

/** page_claims：page = claim 的 M:N 组装（A.1 未声明 FK，照此实现）。 */
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
