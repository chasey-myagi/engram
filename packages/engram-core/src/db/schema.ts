/**
 * Engram 内核五 primitive 的 Drizzle schema —— 严格对齐 docs/PRD.md 附录 A.1。
 * 内核领域无关：只认 source / claim / relation / provenance / confidence；业务语义经 source.meta 注入，内核不解释。
 * id 由 SPI 显式生成（randomUUID），故 PK 不挂 DB 默认 —— 对齐 A.1 的「UUID PRIMARY KEY」(无默认)。
 */
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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
    // S5(可观测):产出这条 claim 的 agent run 相关键 → join 到 agent_run_trace.run_id(「错误决策→产出它的 run」)。
    // nullable —— 老行 / 非 agent loop 产出(人工/直接 seed)为 null;只在 commit 事务内由产出工种填,绝不进 confidence/状态/召回。
    producingRunId: uuid('producing_run_id'),
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
  // EGR-CR-023：locator 必须能钻回原文锚点 —— DB 层物理拒空/全空白 locator（NOT NULL 挡不住空串），
  // 作为绕过 SPI 直写的兜底（core guard 是第一道，见 spi/append-claim.ts validateProvenanceInput）。
  (t) => [
    index('idx_claim_provenance_claim').on(t.claimId),
    index('idx_claim_provenance_source').on(t.sourceId),
    check('claim_provenance_locator_nonblank', sql`length(btrim(${t.locator})) > 0`),
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
 * calibration_map：校准映射 g' 的**版本化、append-only 持久化**（S27，A.3/A.8 命门）。
 * 沿 standards / governance_state 的「append-only / 活动=createdAt 最新一行」式样，但语义是「换 g」而非「换门」。
 *
 * - 每行 = 一个具名校准版本（version）+ 它的单调 knots（(x,y) 升序结点，分段线性插值）+ 验证依据（ΔECE）。
 * - **活动校准版本** = createdAt 最新一行的 version（表空 → 内核 sentinel 'identity'，g=raw）。
 * - 验收门（确定性、活动版本的唯一写者）原子提交：一个 tx 内 append 新映射定义 + append 一行指向它的活动指针。
 * - g=identity 即时回退（Story 29）= append 一行 version='identity' 的活动指针（knots 空），瞬间让 value 退回 raw。
 *
 * **快照冻结**：claim 写时把当时的 calibrationVersion 钉进 confidence_factors；recall 按该 claim 钉的版本现算 g，
 * 故换活动版本只改**新写入** claim 的版本锚（老快照仍按其锚定的旧 g 算）。详见 confidence/confidence.ts。
 *
 * 不动任何 claim / 冻结枚举（A.1）：独立新表，纯校准配置态。knots/evidence 是离线审计/验证依据，不进任何在线计分。
 */
export const calibrationMap = pgTable(
  'calibration_map',
  {
    id: uuid('id').primaryKey(),
    // 具名校准版本（如 'identity' / 'cal-...'）。同一 version 可被多行引用（定义行 + 活动指针行）；
    // 但这些行的 knots 必须 byte-for-byte 一致（version→knots 不可变，EGR-CR-009）——由 store 幂等门
    // + (version, knots_hash) 唯一索引共同保证：同名同内容幂等放行、同名异内容直接拒（fail-loud）。
    version: text('version').notNull(),
    // 单调升序 (x,y) 结点（CalibrationKnot[]，分段线性插值）。identity 版本为空数组（[]）= 直通 raw。
    knots: jsonb('knots').notNull(),
    // knots 规范化序列的稳定指纹（EGR-CR-009）：(version, knots_hash) 唯一索引把「同 version 多次写同内容」
    // 去重为幂等，并把「同 version 写不同 knots」交给应用层门 fail-loud 拒掉（DB 兜底防 TOCTOU/绕过 store 直写）。
    knotsHash: text('knots_hash').notNull(),
    // 验证依据（A.8）：候选 g' 相对当时活动 g 在 golden 上的 ΔECE 等审计快照（离线，不进在线计分）。
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // 本行来由（'definition' / 'activate' 验收门激活 / 'rollback-identity' 即时回退）+ 说明，审计用。
    reason: text('reason').notNull(),
    // 写入者（'gate:advisor-accept' / 'human:rollback' …）。Advisor 只读，绝不在此出现（能力≠权力，A.8）。
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 活动版本按 created_at 倒序取第一行；按 version 反查某版本定义（hash 等值反查）。
  (t) => [
    index('idx_calibration_map_created').on(t.createdAt),
    index('idx_calibration_map_version').using('hash', t.version),
    // (version, knots_hash) 普通索引（EGR-CR-009）：加速「按 version 查已存在 knots_hash」的应用层幂等门。
    // **不**做唯一约束——同 version 同内容允许多行（活动指针 / 回退复用 'identity' 再 append 即激活）。
    // 「同 version 不同 knots」的 DB 兜底由 migration 0021 的 BEFORE INSERT 触发器守（纯 UNIQUE 表达不了
    // 「同 version 多行但 knots 必须同」，故用触发器）；应用层门是首要防线、触发器防 TOCTOU/绕过 store 直写。
    index('idx_calibration_map_version_knots').on(t.version, t.knotsHash),
  ],
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

/**
 * redteam_generations：**冻结、版本化、append-only 的红队对抗样本世代**（S29，A.9 stories 50/51 + P3「冻结红队代际」）。
 * 免疫力必须对**固定的敌手**纵向度量，故一个 generation = 一个具名版本（version）+ 它定下的对抗样本集（items）：
 *   - 同一 version 至多一行（version UNIQUE）：世代一旦落定即冻结、**不可静默重写**（item 集随版本走）。
 *   - 一个新世代 = **一个新版本**（季度滚动）；旧世代行原样保留（append-only，纵向比较的锚）。
 *   - items = 四类对抗样本（false/contradiction/stale/near-dup-poison）的冻结清单（JSONB，内核不解释其领域语义）。
 * **沿 standards / governance_state / calibration_map 的版本化 append-only 式样**，是独立**新表**——
 * 不碰任何冻结枚举（A.1：claim_status / metrics_event_kind 等），红线#4 天然守住。纯评测配置态，绝不进任何在线计分。
 */
export const redteamGenerations = pgTable(
  'redteam_generations',
  {
    id: uuid('id').primaryKey(),
    // 具名世代版本（如 'rt-2026Q2'）。UNIQUE ⇒ 世代冻结、不可重写；新世代另起新版本。
    version: text('version').notNull().unique(),
    // 冻结的四类对抗样本清单（RedTeamItem[]）。世代落定后此集即不可变（重打分对同一集，纵向可比）。
    items: jsonb('items').notNull(),
    // 本世代来由 / 季度标签（审计）。
    reason: text('reason').notNull(),
    // 写入者（'eval:redteam' / 'human:redteam-curator'…）。
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 按版本反查冻结样本集（等值反查，hash 索引）；按时间列世代史。
  (t) => [
    index('idx_redteam_generations_created').on(t.createdAt),
    index('idx_redteam_generations_version').using('hash', t.version),
  ],
)

/**
 * redteam_immunity_scores：**免疫力作为一个被报告的「维度」**（S29，A.9 story 50 + L3 第六维「★免疫红队」）——
 * append-only 评测埋点，**离线聚合、绝不进任何在线判据/校准 g/纵向趋势**（A3 红线#5 的结构性边界：
 * 拟合器 collectUsageCalibrationSamples 只读 claim_verification(kind='usage_truth')，**从不**读本表，故免疫分无路进 g）。
 *
 * 为何独立新表而非往 metrics_events 加 kind：metrics_event_kind 是**冻结枚举**（红线#4），加值即违红线；
 * 且免疫分天然**属于某个冻结世代**（generationVersion FK 语义），与 calibration_map「分总是某个 g 版本的分」同构。
 * 故沿 governance_state/calibration_map 的版本化 append-only 式样，把维度落进与世代同源的专表 —— 既是「metrics 通道」
 * 的精神延续（只记事件、离线聚合），又零触碰冻结枚举。每类一行：detected/injected → detectionRate（纯报告，不计分）。
 */
export const redteamImmunityScores = pgTable(
  'redteam_immunity_scores',
  {
    id: uuid('id').primaryKey(),
    // 这批分打在哪个**冻结世代**上（纵向比较的锚：同 version 重打分应同分）。FK 到 redteam_generations.version。
    generationVersion: text('generation_version')
      .notNull()
      .references(() => redteamGenerations.version),
    // 对抗类别：'false' | 'contradiction' | 'stale' | 'near_dup_poison'（与四注入器对齐；纯文本标签，内核不解释）。
    redteamClass: text('redteam_class').notNull(),
    // 注入数 / 被对应工种逮到数 → 检出率（detected/injected）。维度报告口径，**不进任何计分**。
    injected: integer('injected').notNull(),
    detected: integer('detected').notNull(),
    detectionRate: doublePrecision('detection_rate').notNull(),
    // 本次打分诊断负载（哪个工种逮到、各 item 命中明细等），离线分析用，不进任何计分。
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 按世代 + 类别取最新一次打分（纵向比较）。
    index('idx_redteam_scores_gen_class').on(t.generationVersion, t.redteamClass),
    // EGR-CR-055：四类是免疫维度的语义不变量，DB 层挡绕过 SPI 的 plain SQL 写未知 class
    // （字面与 REDTEAM_CLASSES 白名单同步；内核不解释 class 语义，故用轻量 check 而非 lookup FK）。
    check(
      'redteam_immunity_scores_redteam_class_check',
      sql`${t.redteamClass} IN ('false', 'contradiction', 'stale', 'near_dup_poison')`,
    ),
  ],
)

/**
 * round_cohort：红蓝对抗回合（runRedBlueRound）A1 题免疫逐条裁决的 **append-only 可审计快照**（EGR-CR-017）。
 *
 * 为何独立新表、且**故意不对工作表建 FK**：A1 晋升证据（golden_questions / promotion_audit）通过 FK 挂在
 * l5_candidates / claim 上，而毒株 per-item 隔离**必须**对这批工作表 TRUNCATE ... CASCADE（否则上一条毒株泄漏进
 * 下一条、污染真值）。CASCADE 会把挂在其上的审计行一并级联删空 ⇒ 回合结束后晋升证据一行不剩，scored cohort 只剩内存
 * 证据、无法跨整回合在持久层审计。本表把每条 item 的裁决（admitted / basis 四检快照 / goldenId / poisonClaimId）以
 * **值快照**形式落进一张**不参与 per-item reset、与工作表零 FG 牵连**的表，使 per-item TRUNCATE 物理上够不着它。
 *
 * 沿 redteam_immunity_scores / redteam_generations 的「回合事实」族式样：generation_version 同锚（FK 到
 * redteam_generations.version），unique(generation_version, item_id) ⇒ 一回合一 item 一行、append-only、撞名抛。
 * scorer 不再从内存 Set 构 cohort，而从本表（generation_version=本回合 ∧ admitted=true）读，二者由同一持久事实驱动。
 */
export const roundCohort = pgTable(
  'round_cohort',
  {
    id: uuid('id').primaryKey(),
    // 本回合世代（与 redteam_immunity_scores 同锚）。FK 到 redteam_generations.version。
    generationVersion: text('generation_version')
      .notNull()
      .references(() => redteamGenerations.version),
    // 红队 item id（= RedTeamItem.id；冻结世代内的稳定标识）。
    itemId: text('item_id').notNull(),
    // 对抗类别（与四注入器对齐；纯文本标签、check 守白名单，与 redteam_immunity_scores 同款）。
    redteamClass: text('redteam_class').notNull(),
    // 是否过了 A1（promoteCandidate.promoted）⇒ 是否进被计分 cohort。
    admitted: boolean('admitted').notNull(),
    // admitted 时 promoteCandidate 回填的 golden / 毒株 claim id（**值快照**，故意无 FK：解耦于会被 TRUNCATE 的
    // golden_questions / claim，证据不随工作表蒸发）。blocked 时为 null。
    goldenId: uuid('golden_id'),
    poisonClaimId: uuid('poison_claim_id'),
    // A1 四检判据快照（= PromoteResult.result）。回合后审计「凭何过/未过的 A1」的权威载体。
    basis: jsonb('basis').notNull(),
    // 谁裁决的（A1 晋升人，'human…' 前缀）。
    decidedBy: text('decided_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 一回合一 item 一行（append-only、撞名抛）。
    unique('round_cohort_generation_item_unique').on(t.generationVersion, t.itemId),
    // 按世代取本回合 cohort（scorer 读 admitted=true 的子集 / 回合后审计）。
    index('idx_round_cohort_generation').on(t.generationVersion),
    // 四类语义不变量（与 redteam_immunity_scores 同款轻量 check）。
    check(
      'round_cohort_redteam_class_check',
      sql`${t.redteamClass} IN ('false', 'contradiction', 'stale', 'near_dup_poison')`,
    ),
  ],
)

/**
 * dimension_events：L3 系统维度的 **append-only 度量脊柱**（S30，A.9 stories 44/47/52，设计稿 FIG 10/10a 八维）。
 * 一行 = 一次 run 在某个**维度**上的一个读数（dimension + value + 诊断 payload + 落库时刻）。
 *
 * 为何独立新表而非往 metrics_events 加 kind：metrics_event_kind 是**冻结枚举**（红线#4），加值即违红线；
 * 且维度天然**属于某次评测 run**（runId 锚），与 redteam_immunity_scores「分总是某个世代的分」、calibration_map
 * 「分总是某个 g 版本的分」同构。故沿 governance_state / calibration_map / redteam_* 的**版本化 append-only 式样**，
 * 把维度落进专表 —— 既是「metrics 通道」的精神延续（只记事件、离线聚合），又零触碰冻结枚举。
 * dimension 用 **text 标签**（与 redteam_class 同款，纯文本、内核不解释），故无需为七维新增任何枚举。
 *
 * **绝不进任何在线判据/校准 g/纵向计分**：拟合器 collectUsageCalibrationSamples 只读 usage_truth，**从不**读本表。
 * 时间序列（ΔECE↓ / Δcoverage↑ 可画曲线）= 按 (dimension, created_at) 升序读出的 value 序列（getDimensionSeries）。
 * raw 事件**绝不可变**：重跑同一 event log 的离线聚合是确定性的（同输入 → 同维度值），不改写历史行。
 */
export const dimensionEvents = pgTable(
  'dimension_events',
  {
    id: uuid('id').primaryKey(),
    // 一次评测 run 的标识（同 run 的七维读数共享它）。纵向 = 跨 run 按 created_at 排。
    runId: text('run_id').notNull(),
    // 维度标签：'precision_at_k' | 'recall_at_k' | 'grounding' | 'ece' | 'coverage' | 'staleness' | 'immunity'
    //（纯文本，内核不解释；A3 边界：immunity 仅被报告、绝不喂 g/纵向计分，与 S29 同款）。
    dimension: text('dimension').notNull(),
    // 该维度本次 run 的标量读数 ∈ [0,1]（P/R@k/grounding/coverage 越高越好；ece/staleness 越低越好；具体语义见 eval 层）。
    value: doublePrecision('value').notNull(),
    // 诊断负载（样本数 / k / 命中明细 / 来源世代等），离线分析用，**不进任何计分**。
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 时间序列按 (dimension, created_at) 升序扫（画 ΔECE↓ / Δcoverage↑ 曲线）；按 run 取一次 run 的全维。
  (t) => [
    index('idx_dimension_events_dim_created').on(t.dimension, t.createdAt),
    index('idx_dimension_events_run').on(t.runId),
  ],
)

/**
 * recompete_events：**第⑧维「纵向越用越好」的 append-only 度量脊柱**（S31，A.9 stories 47/49/51，设计稿 FIG 10/10a 八维
 * 第⑧维 + FIG「外环·release/纵向」）。S30 把第⑧维**刻意迁到 S31**（其生产者是冻结 golden 同卷复考），此表即落它。
 *
 * 一行 = 一次 release 快照在**冻结 golden 同卷**上重考算出的一个**维度读数 + 相对上一快照的 Δ**：
 *   - frozenGoldenVersion：复考所对的**冻结 golden 版本**（同版本 ⇒ 同题 ⇒ 跨 release 可比；防「题变易」冒充「系统变好」）。
 *   - releaseSnapshot：本次复考的 release 标识（T0/T1/T2…，纵向曲线的 x 轴）。
 *   - dimension：复考的维度，**只取 'ece' / 'coverage'**（与 S30 DIMENSION 同定义、跨 release 可比）。**A3 红线**：
 *     绝不取 ELO/胜负率/reward —— 纵向 Δ 只由 ECE/coverage 等八维量构成（结构性边界：本表无 reward 列、写者拒非白名单维度）。
 *   - value：本快照该维的标量读数 ∈ [0,1]。
 *   - delta：相对**上一 release 快照同维**的差（ECE 取 prev−curr=「↓为正」即改善量；coverage 取 curr−prev=「↑为正」）。
 *     首个快照无前序 ⇒ delta=null（基线）。delta 同样 append-only：**绝不回改**任一历史快照（重考新 release 只追新行）。
 *   - ring：三环嵌套（设计稿 FIG）中本读数属哪一环——'inner'（秒级实时消费用当前 g 改召回值）/ 'mid'（分时级校准
 *     回灌重拟 g）/ 'outer'（release 纵向：冻结 golden 同卷复考）。纵向曲线的承重产线是 outer 环。
 *
 * 沿 dimension_events / redteam_immunity_scores 的版本化 append-only 式样，独立**新表**、零触碰冻结枚举（红线#4）；
 * dimension/ring 用 **text 标签**（内核不解释，与 redteam_class 同款）。**绝不进任何在线判据/校准 g**（拟合器只读
 * usage_truth，从不读本表）。纵向曲线（ΔECE↓ / Δcoverage↑）= 按 (frozenGoldenVersion, dimension, created_at) 升序读出。
 */
export const recompeteEvents = pgTable(
  'recompete_events',
  {
    id: uuid('id').primaryKey(),
    // 复考所对的**冻结 golden 版本**（跨 release 可比的锚：同版本 ⇒ 同题）。
    frozenGoldenVersion: text('frozen_golden_version').notNull(),
    // 本次复考的 release 标识（T0/T1/T2…，纵向曲线 x 轴）。
    releaseSnapshot: text('release_snapshot').notNull(),
    // 复考维度（白名单：'ece' | 'coverage'，与 S30 DIMENSION 同定义；A3：绝不含 ELO/胜负率/reward）。
    dimension: text('dimension').notNull(),
    // 本快照该维标量读数 ∈ [0,1]。
    value: doublePrecision('value').notNull(),
    // 相对上一 release 快照同维的改善量（ECE: prev−curr；coverage: curr−prev）。首快照=null（基线）。
    delta: doublePrecision('delta'),
    // 三环：'inner' | 'mid' | 'outer'（纵向承重产线 = outer 环；纯文本标签，内核不解释）。
    ring: text('ring').notNull(),
    // 诊断负载（前序快照 value / runId / golden 题数等），离线分析用，**不进任何计分**。
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 纵向曲线按 (frozen_golden_version, dimension, created_at) 升序扫；按 release 取一次复考全维。
  (t) => [
    index('idx_recompete_events_golden_dim_created').on(
      t.frozenGoldenVersion,
      t.dimension,
      t.createdAt,
    ),
    index('idx_recompete_events_release').on(t.releaseSnapshot),
  ],
)

/**
 * knowledge_grew_events：**L5 缺口题「长出了知识」的 append-only 迁移证据**（S31，A.9 story 49 + PRD A.9：
 * 「若某版本开始能答某 L5 题 → 移出 L5、进归因脊柱（证明长出了知识）」）。
 *
 * 一行 = 一道**曾零召回**的 L5 缺口题，在某 release 上变得可答（recall ≥1 越门 result **且**人确认）后，被迁出 L5
 * 的留痕。l5_question_id UNIQUE ⇒ 同一题至多迁出一次（幂等；重复迁不堆叠）。**绝不删 L5 夹具**（L5 是冻结题集），
 * 「迁出」是逻辑标注（此表存在该行 = 该题已不再算盲点、已进归因脊柱），不物理改 L5_GAP_QUESTIONS。
 *
 * 沿 metrics_events / dimension_events 的「只记事件 + 离线读」式样，独立**新表**、零触碰冻结枚举（红线#4）。
 * **只人能确认**（授权读 migrateL5IfGrew 的 actor.isHuman 受信边界；confirmedBy 落 actor.role 仅审计）—— 与 L5
 * 候选晋升同款 HITL 权威门：knowledge-grew 是「知识真长出来了」的人类架构裁断，不让 agent 自报「我会了」冒充成长
 * （防 Goodhart；agentActor 即便 role 伪装成 'human:fake' 也 isHuman:false 被拒）。
 */
export const knowledgeGrewEvents = pgTable(
  'knowledge_grew_events',
  {
    id: uuid('id').primaryKey(),
    // 迁出的 L5 缺口题 id（L5_GAP_QUESTIONS 的 id）。UNIQUE ⇒ 同题至多迁出一次。
    l5QuestionId: text('l5_question_id').notNull().unique(),
    // 题面（即原 L5 query，留作归因脊柱可读证据）。
    query: text('query').notNull(),
    // 变得可答的 release 标识。
    releaseSnapshot: text('release_snapshot').notNull(),
    // 迁出时越门召回数（≥1 才迁；留作审计）。
    recalledCount: integer('recalled_count').notNull(),
    // 人确认者（须 'human…'：知识长出是人的架构裁断）。
    confirmedBy: text('confirmed_by').notNull(),
    // 诊断负载（越门 claim id 集 / 召回快照值等），离线分析用，**不进任何计分**。
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_knowledge_grew_release').on(t.releaseSnapshot)],
)

/**
 * agent_run_trace：**agent-loop 可观测**(第三层,trace/metric)的 append-only run-LEVEL 留痕(S1 起)。
 * harness-pi AgentSession 一次 runtime.run = 一行:终态 reason / turns / token 用量 / 工具调用 rollup(次数+失败数+名字)。
 * runId 是相关键(S5 起盖到 claim.producing_run_id,使「错误决策→产出它的 agent run」可 join)。
 *
 * **A3 红线(结构性边界)**:本表是**纯 ops/eval 留痕**,**绝不**进任何在线判据/校准 g/纵向趋势——
 * 拟合器(fit-from-usage.ts)只读 claim_verification(kind='usage_truth');calibration/* 与 longitudinal-recompete.ts
 * **永不** import 本表/其 SPI(由 a3-firewall 测试静态钉死)。trace token/turns 这类信号若被接进 recall/confidence,
 * trace 就成了在线信号——firewall 测试 + import-graph 守卫专防此事。per-step 明细(逐 turn 工具 args)是后续切片。
 */
export const agentRunTrace = pgTable(
  'agent_run_trace',
  {
    id: uuid('id').primaryKey(),
    // 一次 runtime.run 的相关键(S5 盖到 claim.producing_run_id 供 join)。
    runId: uuid('run_id').notNull(),
    // 工种标签(如 'agent:distiller')+ 角色(by_role)。
    workerName: text('worker_name').notNull(),
    byRole: text('by_role').notNull(),
    // 归一终态(AgentStopReason:done/max_turns/aborted/error/max_continuations)+ 跑了几轮。
    reason: text('reason').notNull(),
    turns: integer('turns').notNull(),
    // token 用量(RunSummary.usage;自定义 Qwen model cost 占位、可能缺,故 nullable)。
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    // 工具调用 run-level rollup:总次数 / 失败次数 / 调用过的工具名(去重数组)。
    toolCalls: integer('tool_calls').notNull().default(0),
    toolErrors: integer('tool_errors').notNull().default(0),
    toolNames: jsonb('tool_names')
      .notNull()
      .default(sql`'[]'::jsonb`),
    // 诊断负载(model id / 截断标记等),离线分析用,**不进任何计分**。
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_agent_run_trace_run').on(t.runId),
    index('idx_agent_run_trace_worker_created').on(t.workerName, t.createdAt),
  ],
)

/**
 * decision_eval：**Plan A 决策价值实验**的 append-only 计分台(S1 起,S8 填)。一行 = 一次实验 run 某 variant 的一个
 * **有符号**指标读数(decisionLift / roundDelta 可负)——这正是它**不能**塞 dimension_events 的原因(那里 value 硬卡
 * [0,1] 且 DimensionName 冻结)、也不能塞 recompete(白名单只 {ece,coverage})。
 *
 * **A3 红线**:决策动作**不走** report_usage(否则决策会反过来训练 g);决策结局只落本表。本表与 trace 同属 ops/eval,
 * **绝不**被 g/纵向读取(firewall 测试静态钉死)。signed value 让 lift/delta 保号(clamp 到 [0,1] 会丢号、丢掉重点)。
 */
export const decisionEval = pgTable(
  'decision_eval',
  {
    id: uuid('id').primaryKey(),
    // 实验 run 标签(如 'A:R1' / 'A:R2');同 run 多 variant 多指标共享。
    runLabel: text('run_label').notNull(),
    // 基线变体:'identity' | 'fitted' | 'oracle'(纯文本,内核不解释)。
    variant: text('variant').notNull(),
    // 指标名:'answeredAccuracy' | 'coverage' | 'selectiveRisk' | 'regret' | 'decisionLift' | 'roundDelta' …
    metric: text('metric').notNull(),
    // **有符号**读数(lift/delta 可负)。
    value: doublePrecision('value').notNull(),
    // bootstrap 置信区间(可空)+ 样本数:小样本下「lift>0」是否真信靠这俩判。
    ciLow: doublePrecision('ci_low'),
    ciHigh: doublePrecision('ci_high'),
    sampleN: integer('sample_n'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_decision_eval_run').on(t.runLabel, t.metric)],
)

/**
 * worker_failure：dispatcher 吞掉的工种处理器抛错的 **durable dead-letter / 审计专表**（EGR-CR-039）。
 * 沿 redteam_immunity_scores / dimension_events 的独立 append-only 范式，零触碰冻结枚举 metrics_event_kind（红线#4）。
 * 纯审计 / 可恢复性用：记录 workerName、eventType、payload 摘要、error、createdAt。绝不进任何在线判据 / 校准 g / 计分。
 *
 * 总线 EventDispatcher 按设计零 db 依赖（吞错只计内存 failures / traces），落库责任上移到持有 db 的 EngramRunner：
 * 它每次数据面级联后 best-effort 把 result.traces 里 ok:false 的失败行经 recordWorkerFailure 落到本表（审计写库
 * 失败不反噬级联）。这样「吞错保命」与「失败可恢复」解耦——级联仍不掀翻，失败信号不再随进程内存翻篇而永久丢失。
 */
export const workerFailure = pgTable(
  'worker_failure',
  {
    id: uuid('id').primaryKey(),
    // 抛错工种名（'distiller' | 'verifier' | …；纯文本标签，内核不解释）。
    workerName: text('worker_name').notNull(),
    // 触发该工种的事件类型字符串（'source.ingested' / 'conflict.detected' …；EngramEventType 的值）。
    eventType: text('event_type').notNull(),
    // 处理器抛错的 message（被总线吞掉、不掀翻级联的那条原因）。
    error: text('error').notNull(),
    // 事件 payload 摘要（claimIds 计数 / sourceId 等，避免存大块；离线排查用，不进任何计分）。
    payloadDigest: jsonb('payload_digest')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 按工种 + 时间取某工种最近的失败序列（告警 / 重放 / 「谁在持续挂」）。
  (t) => [index('idx_worker_failure_worker_created').on(t.workerName, t.createdAt)],
)

export type SourceKind = (typeof sourceKind.enumValues)[number]
export type ClaimStatus = (typeof claimStatus.enumValues)[number]
export type RelationType = (typeof relationType.enumValues)[number]
export type ProvRelevance = (typeof provRelevance.enumValues)[number]
export type VerificationKind = (typeof verificationKind.enumValues)[number]
export type MetricsEventKind = (typeof metricsEventKind.enumValues)[number]
export type L5CandidateStatus = (typeof l5CandidateStatus.enumValues)[number]
export type PromotionDecision = (typeof promotionDecision.enumValues)[number]
