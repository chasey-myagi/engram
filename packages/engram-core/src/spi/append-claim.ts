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
import { randomUUID } from 'node:crypto'

import { and, eq, inArray, ne } from 'drizzle-orm'

import {
  NEUTRAL_FACTORS,
  computeConfidence,
  halfLifeDaysForKind,
  independentSupportScore,
  type ComputedConfidence,
  type StoredConfidence,
} from '../confidence/confidence.js'
import { countIndependentSupports } from '../same-fact/independent.js'
import { computeEntailmentFactor } from '../verifier/patrol-verdict.js'
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
  contentHash: string
  kind: SourceKind
  authorityScore?: number
  meta?: Record<string, unknown>
  /** A.6 独立来源血缘：本源派生自哪个上游源（独立印证沿此链折叠，防同源刷 f3）。 */
  derivedFromSourceId?: string
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
}

export interface ProvenanceInput {
  sourceId: string
  locator: string
  excerpt?: string
  relevance?: ProvRelevance
}

/** D1 硬门（前置 guard）：无出处直接拒，连事务都不开。DB 层 NOT NULL FK 是第二道兜底。 */
function requireProvenance(provenances: ProvenanceInput[]): void {
  if (!Array.isArray(provenances) || provenances.length < 1) {
    throw new Error(
      'append_claim: D1 violation — a claim requires >=1 provenance (forced provenance)',
    )
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
  const sources = ids.length
    ? await tx
        .select({
          id: source.id,
          authority: source.authorityScore,
          kind: source.kind,
          contentHash: source.contentHash,
          derivedFromSourceId: source.derivedFromSourceId,
        })
        .from(source)
        .where(inArray(source.id, ids))
    : []
  // 最强源（authority 最高）一遍扫出：它的 authority_score 作 f0、它的 kind 定半衰期。
  const dominant = sources.reduce<(typeof sources)[number] | null>(
    (best, s) => (best === null || s.authority > best.authority ? s : best),
    null,
  )
  const authority = dominant?.authority ?? 0
  const halfLifeDays = dominant ? halfLifeDaysForKind(dominant.kind) : 180
  const indepSupport = independentSupportScore(countIndependentSupports(sources)) // A.6 独立印证数
  const resolvedAsOf = asOf ?? new Date()
  const ageDays = Math.max(0, (Date.now() - resolvedAsOf.getTime()) / MS_PER_DAY)
  // ── 因子接线单一标注点（S17/S19 在此抬可计算因子；不要散落别处）──
  // f2 entailment（S17）：已存在 claim 取其最新 patrol 裁决；新建 claim（无 id）留 NEUTRAL_FACTORS.entailment(0.5)。
  // 兄弟切片 S19 在同处加 f4 usageCorrect（读 usage_truth），保持本处最小、易扩展。
  const liveFactors = { ...NEUTRAL_FACTORS, authority, indepSupport }
  if (opts.claimId !== undefined) {
    liveFactors.entailment = await computeEntailmentFactor(tx, opts.claimId)
  }
  return computeConfidence(liveFactors, { ageDays, halfLifeDays, activeContradicts: 0 })
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

/** 幂等入原文：content_hash 撞号则复用既有行（不重复落库），单语句 ON CONFLICT 总返存活 id。meta 原样存。 */
export async function addSource(db: DB, input: SourceInput): Promise<{ sourceId: string }> {
  const rows = await db
    .insert(source)
    .values({
      id: randomUUID(),
      content: input.content,
      contentHash: input.contentHash,
      kind: input.kind,
      authorityScore: input.authorityScore ?? 0.5,
      meta: input.meta ?? {},
      ...(input.derivedFromSourceId !== undefined
        ? { derivedFromSourceId: input.derivedFromSourceId }
        : {}),
    })
    .onConflictDoUpdate({
      target: source.contentHash,
      set: { contentHash: input.contentHash }, // no-op update：撞号也触发 RETURNING 返回既有行，且不动既有 meta/content
    })
    .returning({ id: source.id })
  return { sourceId: rows[0]!.id }
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
  requireProvenance(provenances)
  const embedding = await embedder.embed(draft.claimText, 'document') // 嵌入在事务外算（纯计算/远程调用，不持锁）
  return db.transaction(async (tx) => {
    const conf = await computeClaimConfidence(tx, draft, provenances)
    const claimId = await insertClaim(tx, draft, randomUUID(), conf, embedding, embedder.version)
    await insertProvenances(tx, claimId, provenances)
    await recordContradictions(tx, claimId, draft) // 乐观：记矛盾边、保留双方、绝不因冲突拒写
    return { claimId }
  })
}

/** append-only 取代：新版本沿用旧 claim 的 lineage_id，加一条 supersedes 边，旧版标 superseded（不物理删）。 */
export async function supersedeClaim(
  db: DB,
  embedder: Embedder,
  oldClaimId: string,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
): Promise<{ claimId: string }> {
  requireProvenance(provenances)
  const embedding = await embedder.embed(draft.claimText, 'document')
  return db.transaction(async (tx) => {
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
    const claimId = await insertClaim(
      tx,
      draft,
      old[0]!.lineageId,
      conf,
      embedding,
      embedder.version,
    )
    await insertProvenances(tx, claimId, provenances)
    await tx
      .insert(relation)
      .values({ id: randomUUID(), fromClaim: claimId, toClaim: oldClaimId, type: 'supersedes' })
    await tx.update(claim).set({ status: 'superseded' }).where(eq(claim.id, oldClaimId))
    return { claimId }
  })
}
