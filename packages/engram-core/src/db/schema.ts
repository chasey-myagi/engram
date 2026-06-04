/**
 * Engram 内核五 primitive 的 Drizzle schema —— 严格对齐 docs/PRD.md 附录 A.1。
 * 内核领域无关：只认 source / claim / relation / provenance / confidence；业务语义经 source.meta 注入，内核不解释。
 * id 由 SPI 显式生成（randomUUID），故 PK 不挂 DB 默认 —— 对齐 A.1 的「UUID PRIMARY KEY」(无默认)。
 */
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
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
  vector,
} from 'drizzle-orm/pg-core'

/** claim_text 嵌入维度（A.6）。生产侧 DashScope text-embedding-v3 = 1024；测试用同维 fake embedder。 */
export const EMBEDDING_DIM = 1024

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
/**
 * metrics_events 事件类别（A.9 评测埋点）。gap_recorded=召回白卷(S10)；source_human_pending=Distiller 降级标记(S15)；
 * conflict_adjudicated=Arbiter 冲突裁决留痕(S20)：payload.outcome 分流「resolved（机判自裁的采信/信任标记）」与
 * 「escalated（升级主编队列，待人用同一张优先级表 + ① 人工裁定）」。
 * ruling_refused=NC-exact 红线拒判(S21)：判 claim 为 non_compliant/refuted 但缺 ≥1 条 relevance='exact' 反向证据 →
 * 拒判 + 强制升级主编（红线#3）；payload 记被拒的负判 + 承载反向命题的 claim + 路径(verifier/arbiter)，待人核验后才落终判。
 * human_overturn=主编翻案留痕(S22)：主编放松了 agent 的判决（解隔离/赦免/回滚，或驳回 agent 晋升的 claim），
 * append-only 事件——S26 恒温器的 falseQuarantineRate（人工翻案的误隔离率）由它聚合而来，绝不进任何在线计分。
 * 全沿 source_human_pending/conflict_adjudicated 的「事件即标记」式样，不新增 claim_status（A.1 冻结），
 * 故这些留痕**不**改 claim 状态——红线#2「只人能放松」由此天然守住。
 */
export const metricsEventKind = pgEnum('metrics_event_kind', [
  'gap_recorded',
  'source_human_pending',
  'conflict_adjudicated',
  'ruling_refused',
  'human_overturn',
])
/** L5 缺口候选状态：queued（S11 入队）→ promoted（过 A1 免疫晋升 golden）/ rejected（毒株被免疫拒，终态）。 */
export const l5CandidateStatus = pgEnum('l5_candidate_status', ['queued', 'promoted', 'rejected'])
/** 晋升裁决（S12 A1 免疫流水线的可审计事件）。 */
export const promotionDecision = pgEnum('promotion_decision', ['promoted', 'rejected'])

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
  // S14/A.6 独立来源判定：声明本源派生自哪个上游源（自引 FK，可空）。independent() 沿此血缘链判同源，
  // 同链不重复计印证（防同源刷 f3）。内核原生表示（不进 meta —— meta 是领域注入口、内核不解释）。
  derivedFromSourceId: uuid('derived_from_source_id').references((): AnyPgColumn => source.id),
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
    // S9：claim_text 的嵌入（pgvector）+ 版本锚。nullable —— 老行/未嵌入的为 null；写路径(append)落它。
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    embeddingVersion: text('embedding_version'),
  },
  // lineage_id 是跨版本身份，谱系回溯按它查 —— 核心读路径，建索引。HNSW 向量索引在迁移里用裸 SQL 建
  // (CREATE INDEX ... USING hnsw (embedding vector_cosine_ops))，drizzle 0.45 的 op-class 语法不稳。
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

/**
 * governance_state：恒温器派生策略的版本化持久化（S26，A.7/A.8）。**沿 standards 的 append-only/版本化式样**：
 * 每跑一轮 GovernanceController 落一行新版本，「活动策略」= createdAt 最新一行（无则四旋钮归零的基线）。
 * policy = 四旋钮（promotionGateLevel / patrolFrequency / ingestionThrottle / arbiterPriority，皆 [0,1]）；
 * metrics = 触发本步的五指标快照（审计/可解释）；source 标明读到的指标是否降级（silent degrade 时记真）。
 * **可逆**：回滚 = 追一行旧 policy（append-only，不物理改写历史）。**审计**：每步都留痕（含 reason）。
 * 不新增 claim_status / metrics_event_kind（A.1 冻结）——这是独立的**新表**，不碰任何冻结枚举/红边。
 */
export const governanceState = pgTable(
  'governance_state',
  {
    id: uuid('id').primaryKey(),
    promotionGateLevel: doublePrecision('promotion_gate_level').notNull(),
    patrolFrequency: doublePrecision('patrol_frequency').notNull(),
    ingestionThrottle: doublePrecision('ingestion_throttle').notNull(),
    arbiterPriority: doublePrecision('arbiter_priority').notNull(),
    // 触发本步的五指标快照（GovernanceMetrics）+ 各旋钮 target（live derived 平衡点）。离线审计/可解释，不进任何计分。
    metrics: jsonb('metrics').notNull(),
    // 本步来由（'cycle' 周期步 / 'rollback' 回滚 / 'manual'…）+ 人类可读说明，审计用。
    reason: text('reason').notNull(),
    // 写入者（'controller' / 'human:editor' 回滚时）。
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 活动版本按 created_at 倒序取第一行 —— 建索引。
  (t) => [index('idx_governance_state_created').on(t.createdAt)],
)

/**
 * metrics_events：append-only 评测事件流（A.9）。沿 usage_truth 的「只记事件 + 离线聚合」式样。
 * S10 首个用途 gap_recorded：当一次非空 recall 没有任何 claim 越过消费门（库确实没答案），
 * recall 落一条引用该 query 的 gap 事件 —— 盲点的诚实信号，绝不拿杜撰/门下 claim 顶替。
 * 故意挂在 recall 的消费关键路径上（不是旁路遥测）：知识库诚实记录「被问到却答不出」什么，
 * 这正是「越用越准」要回填的缺口。kind 是 enum，后续评测埋点同表扩列即可。
 */
export const metricsEvents = pgTable(
  'metrics_events',
  {
    id: uuid('id').primaryKey(),
    kind: metricsEventKind('kind').notNull(),
    // gap_recorded 引用「问了什么」（无 claim 可引，故按 query 文本归因）；其它埋点可留空。
    queryText: text('query_text'),
    // 诊断负载（如 candidateCount / gatedCount / floor / embedderVersion），离线分析用，不进任何计分。
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 离线聚合按 kind + 时间扫（btree）；按 query 反查盲点频次按 query_text。
  // query_text 用 **hash** 索引而非 btree：query 是 agent 原生输入、长度无界，btree 单项上限 ~8191B
  // 会让够长的 query 在 recordGap 处 INSERT 直接抛错、连带打断正常召回（盲点信号恰在最该记录时记不下）。
  // hash 只索引哈希码、无大小限制，且 getGapEvents 只做等值反查（= 命中），正合 hash 的能力边界。
  (t) => [
    index('idx_metrics_events_kind_created').on(t.kind, t.createdAt),
    index('idx_metrics_events_query').using('hash', t.queryText),
  ],
)

/**
 * regression_pool：生产失败回流成的活回归集（S11，A.2/A.9）。append-only。
 * 反流任务把 usage_truth 里 outcome∈{refuted,corrected} 的事件挖进来，按 claim + 原始 query/task 归档，
 * 保留召回瞬间快照（预测概率 + g 版本）与到失败 claim 的归因（claim_id FK ⇒ 经 claim_provenance 可钻回出处）。
 * source_event_id UNIQUE = 幂等锚：每条 usage_truth 失败事件至多回流一次，反流可反复跑而不重复入池。
 * 池中项经 query 重放过 recall_claims（评测=消费，零专用路径）→ 对当前行为打 pass/fail。
 */
export const regressionPool = pgTable(
  'regression_pool',
  {
    id: uuid('id').primaryKey(),
    // 来源 usage_truth 事件（claim_verification.id）。UNIQUE ⇒ 反流幂等、不重复入池。
    sourceEventId: uuid('source_event_id').notNull().unique(),
    // 失败归因到具体 claim（FK ⇒ 经 claim_provenance 回溯出处谱系）。
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claim.id),
    // 原始召回 query（重放用）；老事件未带则 null（不可重放，记 unreplayable）。
    query: text('query'),
    // 失败结局：refuted / corrected（由反流逻辑保证，adopted/partial 不入池）。
    outcome: text('outcome').notNull(),
    taskId: text('task_id'),
    // 召回瞬间快照：预测概率 + 产生它的 g 版本（usage_truth 当时所存的全部快照位）。
    predictedConfidence: doublePrecision('predicted_confidence'),
    calibrationVersion: text('calibration_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 按 claim 反查该 claim 的全部失败 —— 归因扫描。
  (t) => [index('idx_regression_pool_claim').on(t.claimId)],
)

/**
 * l5_candidates：人确认「KB 真没答案」的缺口候选队列（S11，A.9）。append-only。
 * 反流仅在 by_role 为人（'human…' 前缀）且带 kb_lacks_answer 标记且有 query 时入队 —— 人确认才算数。
 * status 起步只有 queued；晋升进 L5 冻结考卷是 S12 的 QA 门（题=毒株，须先过免疫流水线，红线 A1）。
 */
export const l5Candidates = pgTable(
  'l5_candidates',
  {
    id: uuid('id').primaryKey(),
    // 来源 usage_truth 事件。UNIQUE ⇒ 反流幂等、不重复入队。
    sourceEventId: uuid('source_event_id').notNull().unique(),
    // 候选缺口问题（即原始 query，作 L5 题面）。NOT NULL：没问题就不成题。
    query: text('query').notNull(),
    // 触发的失败 claim（可空，留作溯源；候选本质是「该会而不会的问题」、不绑某条 claim）。
    claimId: uuid('claim_id').references(() => claim.id),
    // 确认人的 by_role（'human…'）。
    confirmedBy: text('confirmed_by').notNull(),
    status: l5CandidateStatus('status').notNull().default('queued'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_l5_candidates_status').on(t.status)],
)

/**
 * golden_questions：过 A1 免疫晋升后的 golden 考题命名空间（S12，A.9）。append-only。
 * **独立表、不在 claim 里** ⇒ recall（只读 claim）结构上永不召回它（防 KB 泄漏分数虚高，红线 A.9）。
 * 只判分（经 S10 runL5Suite 复用打分，零评测专用路径）、永不召回。每条带：源候选、免疫造的毒株 claim、
 * 晋升人（人的架构权威）、免疫判据快照（basis）。candidate_id UNIQUE ⇒ 一候选至多晋升一次。
 */
export const goldenQuestions = pgTable('golden_questions', {
  id: uuid('id').primaryKey(),
  candidateId: uuid('candidate_id')
    .notNull()
    .unique()
    .references(() => l5Candidates.id),
  query: text('query').notNull(),
  // A1 免疫流水线经真 append 造的毒株 claim（draft、永不召回；patrol 巡查记录挂在它上）。
  poisonClaimId: uuid('poison_claim_id')
    .notNull()
    .references(() => claim.id),
  promotedBy: text('promoted_by').notNull(),
  basis: jsonb('basis').notNull(), // 免疫判据快照（四检结果）
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * promotion_audit：A1 免疫晋升的可审计事件流（S12，A.9）。append-only。
 * **每次晋升尝试**（通过/驳回）都落一行：谁（decided_by）、何时（created_at）、凭何（basis 免疫判据）。
 * 「fail ⇒ logged and never promoted」就落在这里；通过的另进 golden_questions。
 */
export const promotionAudit = pgTable(
  'promotion_audit',
  {
    id: uuid('id').primaryKey(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => l5Candidates.id),
    decision: promotionDecision('decision').notNull(),
    decidedBy: text('decided_by').notNull(),
    basis: jsonb('basis').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_promotion_audit_candidate').on(t.candidateId)],
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
export type MetricsEventKind = (typeof metricsEventKind.enumValues)[number]
export type L5CandidateStatus = (typeof l5CandidateStatus.enumValues)[number]
export type PromotionDecision = (typeof promotionDecision.enumValues)[number]
