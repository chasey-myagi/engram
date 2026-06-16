/**
 * 乐观写入路径（Consumer SPI 的写半边，附录 A.2）。
 *   - addSource：幂等入原文（content_hash UNIQUE 去重，单语句 ON CONFLICT 总返存活 id），meta 透传不解释。
 *   - appendClaim：默认 draft、强制 ≥1 provenance、单事务原子写入（D1 硬门），并算出连续 confidence（S2 命门）。
 *   - supersedeClaim：append-only 取代 —— 新版本沿用同 lineage_id + 一条 supersedes 边，旧版标 superseded（不物理删）。
 *
 * S2（命门）：写入时按附录 A.3 算连续 confidence（替换 0/0/{} 占位）。此切片 entailment/humanReview/
 * usageCorrect 用中性值、activeContradicts=0、独立性≈不同 source id —— 余下因子来源在后续切片接入
 * （S8 矛盾 / S14 独立判定 / S17 entailment / S19 usage）。g 起步 = identity。
 */
import { createHash, randomUUID } from 'node:crypto'

import { and, eq, ne, sql } from 'drizzle-orm'

import {
  NEUTRAL_FACTORS,
  computeConfidence,
  halfLifeDaysForKind,
  independentSupportScore,
  type ComputedConfidence,
  type StoredConfidence,
} from '../confidence/confidence.js'
import { countIndependentSupports, type SourceIndep } from '../same-fact/independent.js'
import { getActiveCalibrationMap } from '../calibration/calibration-store.js'
import { computeEntailmentFactor } from '../verifier/patrol-verdict.js'
import { computeUsageCorrectFactor } from '../harvest/usage-correct.js'
import { computeHumanReviewFactor } from '../editor/human-review.js'
import type { DB, Tx } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import {
  claim,
  claimProvenance,
  relation,
  source,
  type ProvRelevance,
  type SourceKind,
} from '../db/schema.js'

const MS_PER_DAY = 86_400_000

export interface SourceInput {
  content: string
  kind: SourceKind
  authorityScore?: number
  meta?: Record<string, unknown>
  /** A.6 独立来源血缘：本源派生自哪个上游源（独立印证沿此链折叠，防同源刷 f3）。 */
  derivedFromSourceId?: string
}

/**
 * EGR-CR-012：内容寻址不变量由内核保证 —— content_hash 由内核据 content 自算（裸字节 sha256，不做
 * trim/换行统一/Unicode 归一化，「字节级相同才算同源」最严格语义）。调用方不再提供 hash，杜绝
 * 「同 hash 不同 content 静默复用错误 raw source」的伪造 provenance 通道。
 */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export interface DraftClaim {
  claimText: string
  subject?: string
  predicate?: string
  object?: string
  /** 原文时点（算时效）；默认入库时刻。 */
  asOf?: Date
  /** 写入者 agent_id / user_id。 */
  createdBy?: string
  /** S5(可观测):产出这条 claim 的 agent run 相关键(commit 事务内落 claim.producing_run_id;不影响 confidence/状态)。 */
  producingRunId?: string
}

export interface ProvenanceInput {
  sourceId: string
  locator: string
  excerpt?: string
  relevance?: ProvRelevance
}

/**
 * D1 完整 guard（前置）：provenance 不仅要存在（≥1 条），每条还必须能钻回原文——
 * sourceId 非空、locator 去空白后非空。空/全空白 locator = 不可点击的幽灵出处，连事务都不开就拒。
 * DB 层 NOT NULL FK + CHECK(length(btrim(locator))>0) 是第二道兜底（防绕过 SPI 的直写）。
 * 所有 core 写路径（append / supersede / commit / 红边 evidence）共用这道门，错误语义统一、可测。
 */
export function validateProvenanceInput(provenances: ProvenanceInput[]): void {
  if (!Array.isArray(provenances) || provenances.length < 1) {
    throw new Error(
      'append_claim: D1 violation — a claim requires >=1 provenance (forced provenance)',
    )
  }
  for (const p of provenances) {
    if (typeof p.sourceId !== 'string' || p.sourceId.length < 1) {
      throw new Error('append_claim: D1 violation — provenance.sourceId must be a non-empty string')
    }
    if (typeof p.locator !== 'string' || p.locator.trim().length < 1) {
      throw new Error(
        'append_claim: D1 violation — provenance.locator must be a non-empty, non-whitespace string (drill-back anchor required)',
      )
    }
  }
}

/** 一条出处的 sourceId + relevance（confidence 只数 supports 源，A.6）。 */
export interface ProvenanceRef {
  sourceId: string
  relevance?: ProvRelevance | null
}

/** A.6：只有 exact / supporting 算「supports 源」；tangential / irrelevant 不计 authority / 印证。缺省视为 supporting。 */
function isSupporting(relevance: ProvRelevance | null | undefined): boolean {
  const r = relevance ?? 'supporting'
  return r === 'exact' || r === 'supporting'
}

/** loadSourcesWithAncestors 的返回行：印证字段面 + authority（f0/半衰期用）+ cited（是否本 claim 直接引用）。 */
export interface SourceWithLineage extends SourceIndep {
  authority: number
  /** true=本 claim 直接引用的 supports 源；false=仅为补全血缘链递归拉进来的祖先（只当折叠锚点、不计印证）。 */
  cited: boolean
}

/**
 * 沿 derived_from 自引 FK 递归取出 seedIds 指向的源 **+ 它们的全部祖先链**（EGR-CR-024 根治：让 f3 折叠能看到
 * 跨引用集合的共同祖先，否则 sibling 共享一个未被引用的上游 R 时会被误计成多条独立印证）。单条 WITH RECURSIVE
 * 一次查回（不做 N 次往返）；UNION 去重 + 深度上限 64 防自引环/病态深链。返回行打 cited 标志区分「被引用源」与
 * 「仅补血缘的祖先」——countIndependentSupports 只在 cited 源上计印证，祖先只作折叠锚点。
 */
export async function loadSourcesWithAncestors(
  tx: DB | Tx,
  seedIds: string[],
): Promise<SourceWithLineage[]> {
  if (seedIds.length === 0) return []
  const seedList = sql.join(
    seedIds.map((id) => sql`${id}`),
    sql`, `,
  )
  const rows = await tx.execute<{
    id: string
    authority_score: number
    kind: string
    content_hash: string
    derived_from_source_id: string | null
  }>(sql`
    WITH RECURSIVE lineage(id, depth) AS (
      SELECT s.id, 0
        FROM source s
       WHERE s.id IN (${seedList})
      UNION
      SELECT s.derived_from_source_id, l.depth + 1
        FROM lineage l
        JOIN source s ON s.id = l.id
       WHERE s.derived_from_source_id IS NOT NULL
         AND l.depth < 64
    )
    SELECT s.id, s.authority_score, s.kind, s.content_hash, s.derived_from_source_id
      FROM source s
      JOIN lineage l ON l.id = s.id
  `)
  const seedSet = new Set(seedIds)
  return rows.rows.map((r) => ({
    id: r.id,
    authority: r.authority_score,
    kind: r.kind,
    contentHash: r.content_hash,
    derivedFromSourceId: r.derived_from_source_id,
    cited: seedSet.has(r.id),
  }))
}

/**
 * 命门：从一组**出处**算连续 confidence。只取 relevance∈{exact,supporting} 的 supports 源；authority 取其中最强源、
 * halfLife 看最强源 kind、indepSupport 数**独立** supports 源（A.6：hash 去重 + derived_from 折叠 + agent_synthesis
 * 0.5 折扣，S14）。tangential/irrelevant 出处既不抬 authority 也不计印证（防拿无关源刷 f3）。
 * 既给 appendClaim 写新 claim 用，也给 commitClaim 合并后按全量出处重算用（单一真相源）。
 *
 * opts.claimId（S17 起）：给了**已存在** claim 的 id，则把 f2 entailment 因子接到该 claim 最新 patrol 裁决上
 * （pass→1 / fail→0 / 未跑→中性 0.5）；没给（如 appendClaim 新建、claim 尚不存在）则 entailment 留中性。
 */
export async function computeConfidenceFromProvenances(
  tx: Tx,
  provenances: ProvenanceRef[],
  asOf?: Date,
  opts: { claimId?: string } = {},
): Promise<ComputedConfidence> {
  const ids = [
    ...new Set(provenances.filter((p) => isSupporting(p.relevance)).map((p) => p.sourceId)),
  ]
  // EGR-CR-024：连同祖先链一起取（sources 含被引用源 + 全部 derived_from 祖先），f3 折叠才能看到跨引用集合的共同祖先。
  const sources = await loadSourcesWithAncestors(tx, ids)
  const citedSet = new Set(ids)
  // 最强源（authority 最高）一遍扫出：它的 authority_score 作 f0、它的 kind 定半衰期。**只看被引用源**——
  // 仅为补血缘拉进来的祖先不抬 authority/不定半衰期（祖先未被本 claim 引用，不该影响 f0/时效）。
  const dominant = sources
    .filter((s) => s.cited)
    .reduce<
      (typeof sources)[number] | null
    >((best, s) => (best === null || s.authority > best.authority ? s : best), null)
  const authority = dominant?.authority ?? 0
  const halfLifeDays = dominant ? halfLifeDaysForKind(dominant.kind) : 180
  // A.6 独立印证数：折叠到血缘根，只在被引用源（citedSet）上计数，祖先只作折叠锚点（EGR-CR-024）。
  const indepSupport = independentSupportScore(countIndependentSupports(sources, citedSet))
  const resolvedAsOf = asOf ?? new Date()
  const ageDays = Math.max(0, (Date.now() - resolvedAsOf.getTime()) / MS_PER_DAY)
  // ── 因子接线单一标注点（S17/S19/S22 在此抬可计算因子；不要散落别处）──
  // f1 humanReview（S22）：已存在 claim 取其最新主编人审（Approve→1 / Reject→0）；新建 claim（无 id）
  //   或从未被人审 → 留 NEUTRAL_FACTORS.humanReview(0)（「人审未发生」中性）。与 f2/f4 同款实时口径。
  // f2 entailment（S17）：已存在 claim 取其最新 patrol 裁决；新建 claim（无 id）留 NEUTRAL_FACTORS.entailment(0.5)。
  // f4 usageCorrect（S19）：已存在 claim 按 usage_truth 独立门控统计 observed_correctness→f4；新建 claim（无 id）
  //   或从未被使用 → 留 NEUTRAL_FACTORS.usageCorrect(0)。与 f2 同款实时口径（读最新真值，不吃写时快照）。
  const liveFactors = { ...NEUTRAL_FACTORS, authority, indepSupport }
  if (opts.claimId !== undefined) {
    liveFactors.humanReview = await computeHumanReviewFactor(tx, opts.claimId)
    liveFactors.entailment = await computeEntailmentFactor(tx, opts.claimId)
    liveFactors.usageCorrect = await computeUsageCorrectFactor(tx, opts.claimId)
  }
  // S28 FIX 1（写路径让 g 真正生效）：把新 claim 钉到**当前活动校准版本**、并存 value=activeG(raw)。
  // 在同一事务内解析活动 g（version + 已解析 map）——非 identity 版本必须带 map 喂给 applyG（否则抛）。
  // 这是「越用越准」闭环里 g 对**新写入**生效的口子：fit 出 g' 并过门换上后，此后新 claim 即按 g' 钉版本/算值；
  // 老 claim 各自钉自己当年的版本（recall 按钉的版本现算）→ 换 g 不回溯改写历史（快照冻结，见 confidence.ts）。
  const activeMap = await getActiveCalibrationMap(tx)
  return computeConfidence(
    liveFactors,
    { ageDays, halfLifeDays, activeContradicts: 0 },
    {
      calibrationVersion: activeMap.version,
      map: activeMap,
    },
  )
}

async function computeClaimConfidence(
  tx: Tx,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
): Promise<ComputedConfidence> {
  return computeConfidenceFromProvenances(
    tx,
    provenances.map((p) => ({ sourceId: p.sourceId, relevance: p.relevance ?? null })),
    draft.asOf,
  )
}

async function insertClaim(
  tx: Tx,
  draft: DraftClaim,
  lineageId: string,
  conf: ComputedConfidence,
  embedding: number[],
  embeddingVersion: string,
): Promise<string> {
  const id = randomUUID()
  // 存 raw + 因子/权重/校准版本（不存 value：召回时按当前 g 现算）。类型锁定读写两端一致。
  const stored: StoredConfidence = {
    factors: conf.factors,
    weights: conf.weights,
    calibrationVersion: conf.calibrationVersion,
  }
  await tx.insert(claim).values({
    id,
    claimText: draft.claimText,
    subject: draft.subject,
    predicate: draft.predicate,
    object: draft.object,
    status: 'draft',
    confidence: conf.confidence,
    confidenceRaw: conf.confidenceRaw,
    confidenceFactors: stored,
    lineageId,
    asOf: draft.asOf ?? new Date(),
    createdBy: draft.createdBy ?? 'agent:unknown',
    embedding, // S9：claim_text 的嵌入 + 版本锚
    embeddingVersion,
  })
  return id
}

async function insertProvenances(
  tx: Tx,
  claimId: string,
  provenances: ProvenanceInput[],
): Promise<void> {
  for (const p of provenances) {
    await tx.insert(claimProvenance).values({
      id: randomUUID(),
      claimId,
      sourceId: p.sourceId, // NOT NULL FK = D1（null / 不存在的 source 会被 DB 拒、整事务回滚）
      locator: p.locator,
      excerpt: p.excerpt,
      relevance: p.relevance ?? 'supporting',
    })
  }
}

/**
 * S8 矛盾检测（乐观、不阻塞）：起步判据是 A.5「object 反向→contradicts」的确定性子集——
 * 同 subject ∧ 同 predicate ∧ object 不同 = 矛盾。完整 same_fact 判定（object_equiv / 单位归一 / 灰区 LLM）是 S14。
 * 只在结构化 claim（S/P/O 齐全）上检测；命中则记一条 contradicts 边、**两条 claim 都留**（不合并、不改状态、不拒写）。
 */
async function recordContradictions(tx: Tx, newClaimId: string, draft: DraftClaim): Promise<void> {
  if (draft.subject == null || draft.predicate == null || draft.object == null) return
  const conflicting = await tx
    .select({ id: claim.id })
    .from(claim)
    .where(
      and(
        ne(claim.id, newClaimId),
        ne(claim.status, 'superseded'), // 已被取代的旧版不再参与矛盾
        eq(claim.subject, draft.subject),
        eq(claim.predicate, draft.predicate),
        ne(claim.object, draft.object), // object 反向/不同；既有行 object IS NULL 时 SQL <> 判 NULL → 不算矛盾
      ),
    )
  for (const c of conflicting) {
    await tx.insert(relation).values({
      id: randomUUID(),
      fromClaim: newClaimId,
      toClaim: c.id,
      type: 'contradicts',
    })
  }
}

/** 读一条 source（工种 read_source 用，如 Distiller）。不存在返 null。 */
export async function getSource(
  db: DB,
  sourceId: string,
): Promise<{ id: string; content: string; kind: SourceKind; authorityScore: number } | null> {
  const [row] = await db
    .select({
      id: source.id,
      content: source.content,
      kind: source.kind,
      authorityScore: source.authorityScore,
    })
    .from(source)
    .where(eq(source.id, sourceId))
    .limit(1)
  return row ?? null
}

/** addSource 结果：sourceId + 是否撞号复用既有行 + 撞号时本次带的业务身份/权威是否与既有不一致（被丢弃）。 */
export interface AddSourceResult {
  sourceId: string
  /** false=新建一条 source；true=撞 content_hash、复用既有行（本次原文未重复落库）。 */
  deduped: boolean
  /**
   * 撞号且本次带的 `meta`/`authorityScore`/`kind` 与既有行**语义不一致** → true（EGR-CR-011 fail-loud）。
   * 「原文不可变」锚点不动（既有行不被覆盖），但「你这次带的业务身份/权威被丢了」显式回给调用方——
   * 调用方应据此触发富集（updateSourceMetadata / annotateSourceAuthority）或告警，而非靠重复 addSource 补标。
   * 新建（deduped=false）恒为 false。
   */
  metadataConflict: boolean
}

/** authority_score 比较的容差（doublePrecision 往返；0.5 默认与 caller 显式 0.5 视为相等）。 */
const AUTHORITY_EPS = 1e-9

/**
 * 幂等入原文：content_hash 由内核据 content 自算（EGR-CR-012 内容寻址不变量），撞号即「字节级同 content」
 * → 复用既有行（不重复落库、原文不可变锚点永不覆盖，first-writer-wins）。meta 原样存。
 *
 * EGR-CR-011 fail-loud：撞号时**读出**既有行的 `meta`/`authorityScore`/`kind`，与本次 input 语义比较——不一致则
 * 返回 `metadataConflict=true`。content-hash 去重路径**只对 content 负责**，绝不顺带改业务身份/权威（那是
 * source-metadata.ts 的人授权、留痕富集 SPI 的职责；让去重路径静默吞掉第二次的官方 meta 正是 finding 的危害本身）。
 * 调用方据 `metadataConflict` 触发富集或告警；`deduped` 区分新建 vs 复用。
 */
export async function addSource(db: DB, input: SourceInput): Promise<AddSourceResult> {
  const contentHash = sha256Hex(input.content)
  const meta = input.meta ?? {}
  const authorityScore = input.authorityScore ?? 0.5
  // onConflictDoNothing：新建则 RETURNING 拿到新行；撞号则 RETURNING 空（既有行不被任何 no-op 触动 → 原文锚点不动）。
  const inserted = await db
    .insert(source)
    .values({
      id: randomUUID(),
      content: input.content,
      contentHash,
      kind: input.kind,
      authorityScore,
      meta,
      ...(input.derivedFromSourceId !== undefined
        ? { derivedFromSourceId: input.derivedFromSourceId }
        : {}),
    })
    .onConflictDoNothing({ target: source.contentHash })
    .returning({ id: source.id })
  if (inserted.length > 0) {
    // 新建：无既有行可冲突。
    return { sourceId: inserted[0]!.id, deduped: false, metadataConflict: false }
  }
  // 撞号：读出既有行做语义比较（既有行保持不变 = first-writer-wins）。
  const [existing] = await db
    .select({
      id: source.id,
      kind: source.kind,
      authorityScore: source.authorityScore,
      meta: source.meta,
    })
    .from(source)
    .where(eq(source.contentHash, contentHash))
    .limit(1)
  // 同 content ⇒ 同 hash ⇒ 撞号必有既有行；查不到只可能是并发删除等异常，fail-loud 而非静默吞。
  if (existing === undefined) {
    throw new Error(
      `addSource: content_hash conflict but the existing row vanished (hash=${contentHash}) — concurrent delete?`,
    )
  }
  const metadataConflict =
    existing.kind !== input.kind ||
    Math.abs(existing.authorityScore - authorityScore) > AUTHORITY_EPS ||
    !sourceMetaEqual(existing.meta as Record<string, unknown>, meta)
  return { sourceId: existing.id, deduped: true, metadataConflict }
}

/** meta 语义相等：JSON 规范化（key 排序）后逐字符比较。jsonb 往返不保证 key 序，故不能直接字符串比 input。 */
function sourceMetaEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** 稳定序列化：递归按 key 排序，让「同内容、不同 key 序」的两个对象产出相同字符串。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const entries = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  return `{${entries.join(',')}}`
}

/**
 * 乐观写入：默认 draft，强制 ≥1 出处，连续 confidence + claim + 出处单事务原子写入。新 claim 起一个新 lineage。
 * S9：用 embedder 对 claim_text 算嵌入、随 claim 落库（向量 + embedding_version）。
 */
export async function appendClaim(
  db: DB,
  embedder: Embedder,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
): Promise<{ claimId: string }> {
  validateProvenanceInput(provenances)
  const embedding = await embedder.embed(draft.claimText, 'document') // 嵌入在事务外算（纯计算/远程调用，不持锁）
  return db.transaction(async (tx) => {
    const conf = await computeClaimConfidence(tx, draft, provenances)
    const claimId = await insertClaim(tx, draft, randomUUID(), conf, embedding, embedder.version)
    await insertProvenances(tx, claimId, provenances)
    await recordContradictions(tx, claimId, draft) // 乐观：记矛盾边、保留双方、绝不因冲突拒写
    return { claimId }
  })
}

/** append-only 取代（薄壳）：事务外算嵌入 → 开事务 → 委托 supersedeClaimInTx。 */
export async function supersedeClaim(
  db: DB,
  embedder: Embedder,
  oldClaimId: string,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
): Promise<{ claimId: string }> {
  validateProvenanceInput(provenances)
  const embedding = await embedder.embed(draft.claimText, 'document') // 事务外算（纯计算/远程调用，不持锁）
  return db.transaction((tx) =>
    supersedeClaimInTx(tx, oldClaimId, draft, provenances, embedding, embedder.version),
  )
}

/**
 * append-only 取代的 **Tx 变体**：在调用方已开启的事务内取代，对旧版行加 FOR UPDATE 锁。供 HITL 编排器
 * （editor-action.ts 的 Edit-Approve）把「append 新版本 + 投 f1 人审 + 晋升新版本」绑进**同一事务**，
 * 任一步抛则整体回滚——杜绝半截谱系（旧版已 superseded、新版卡在 draft、事实静默掉出召回）。
 * 嵌入由调用方在事务外先算好传入（不在持锁期间做远程嵌入）。新版本沿用旧 claim 的 lineage_id，加一条 supersedes 边。
 */
export async function supersedeClaimInTx(
  tx: Tx,
  oldClaimId: string,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
  embedding: number[],
  embeddingVersion: string,
): Promise<{ claimId: string }> {
  validateProvenanceInput(provenances)
  const old = await tx
    .select({ lineageId: claim.lineageId, status: claim.status })
    .from(claim)
    .where(eq(claim.id, oldClaimId))
    .for('update') // 锁住旧版行：并发取代同一 head 时序列化，第二个会看到 superseded → 拒，避免谱系分叉
  if (old.length === 0) {
    throw new Error(`supersede_claim: claim ${oldClaimId} not found`)
  }
  // 单 head 不变量：只取代当前 head；取代一个已 superseded 的旧版会让同 lineage 出现两个 head（谱系分叉）。
  if (old[0]!.status === 'superseded') {
    throw new Error(
      `supersede_claim: claim ${oldClaimId} is already superseded (would fork its lineage); supersede the current head`,
    )
  }
  const conf = await computeClaimConfidence(tx, draft, provenances)
  const claimId = await insertClaim(tx, draft, old[0]!.lineageId, conf, embedding, embeddingVersion)
  await insertProvenances(tx, claimId, provenances)
  await tx
    .insert(relation)
    .values({ id: randomUUID(), fromClaim: claimId, toClaim: oldClaimId, type: 'supersedes' })
  await tx.update(claim).set({ status: 'superseded' }).where(eq(claim.id, oldClaimId))
  return { claimId }
}
