/**
 * commit_claim（A.6/A.7 ⑤）—— 带「同一事实」去重的写入：等价 claim **合并出处 + 升印证**，而非重复造一条。
 *
 * stage 1 召候选：claim_text 嵌入近邻 top-k=50 且相似度≥0.75，并 subjectKey 串联（同 subject 也拉进来）。
 * stage 2 判同（每候选）：确定性规则 → 不中且相似度≥0.65 灰区一次 LLM。
 *   命中 same  → 合并：把本次出处挂到既有 claim、按全量源重算 confidence（f3 自然升），不造新 claim。
 *   命中 contradicts/refines → 新建 claim + 记一条对应 typed 边。
 *   全 unrelated → 新建 claim。
 * 新 claim 默认 draft（D2 影子区，晋升走 S13 状态机）。强制 ≥1 出处（D1）。
 */
import { randomUUID } from 'node:crypto'

import { and, cosineDistance, eq, inArray, isNotNull, ne, or } from 'drizzle-orm'

import type { StoredConfidence } from '../confidence/confidence.js'
import type { DB, Tx } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import {
  claim,
  claimProvenance,
  relation,
  type ClaimStatus,
  type ProvRelevance,
} from '../db/schema.js'
import {
  adjudicate,
  SAME_FACT_CANDIDATE_SIMILARITY,
  SAME_FACT_TOPK,
  type ClaimShape,
  type SameFactJudge,
} from '../same-fact/same-fact.js'
import { computeConfidenceFromProvenances } from './append-claim.js'
import type { DraftClaim, ProvenanceInput } from './append-claim.js'

export interface CommitResult {
  claimId: string
  /** true = 并入了既有同一事实 claim（合并出处 + 升印证）；false = 新建。 */
  merged: boolean
}

/**
 * 红线 #2「只人能放松，agent 只能收紧」：只有处于健康生命周期 {draft, active} 的 claim 能吸收本次印证（合并出处 +
 * 升 confidence）。flagged/quarantined（人/Verifier 已收紧或隔离）与 superseded 一律不可作合并目标——否则 agent 会
 * 反向强化被隔离 claim（违红线），且会把本应独立可召回的新事实吞进死 claim（数据丢失）。判同命中不可合并目标时，新事实
 * 改为新建 draft，重新进流水线由人/Verifier 评判。
 */
const MERGEABLE_STATUSES: ReadonlySet<ClaimStatus> = new Set(['draft', 'active'])
function isMergeable(status: ClaimStatus): boolean {
  return MERGEABLE_STATUSES.has(status)
}

interface Candidate extends ClaimShape {
  id: string
  status: ClaimStatus
  asOf: Date
  similarity: number
}

function shapeOf(d: DraftClaim): ClaimShape {
  return {
    subject: d.subject ?? null,
    predicate: d.predicate ?? null,
    object: d.object ?? null,
    claimText: d.claimText,
  }
}

/** stage 1：近邻 top-k(≥0.75) ∪ subjectKey 串联（同 subject），均带相似度，排除 superseded / 无嵌入。 */
async function findCandidates(
  db: DB,
  embedding: number[],
  subject: string | null,
): Promise<Candidate[]> {
  const distance = cosineDistance(claim.embedding, embedding)
  const cols = {
    id: claim.id,
    status: claim.status,
    subject: claim.subject,
    predicate: claim.predicate,
    object: claim.object,
    claimText: claim.claimText,
    asOf: claim.asOf,
    distance,
  }
  const nn = await db
    .select(cols)
    .from(claim)
    .where(and(ne(claim.status, 'superseded'), isNotNull(claim.embedding)))
    .orderBy(distance)
    .limit(SAME_FACT_TOPK)
  const byId = new Map<string, Candidate>()
  for (const c of nn) {
    const similarity = 1 - Number(c.distance)
    if (similarity >= SAME_FACT_CANDIDATE_SIMILARITY) {
      byId.set(c.id, { ...c, similarity })
    }
  }
  // subjectKey 串联：同 subject 的也拉进来（不卡相似度门 —— 同主语本身就是强候选信号）。
  // 同样要求有嵌入（否则 cosineDistance(null) ⇒ similarity 1.0 假高，会把无嵌入的同主语项误送进灰区烧一次 LLM）。
  if (subject != null) {
    const subjMatches = await db
      .select(cols)
      .from(claim)
      .where(
        and(ne(claim.status, 'superseded'), isNotNull(claim.embedding), eq(claim.subject, subject)),
      )
    for (const c of subjMatches) {
      if (!byId.has(c.id)) byId.set(c.id, { ...c, similarity: 1 - Number(c.distance) })
    }
  }
  // 相似度降序：多个 same 候选时，合并目标确定地选最相似的（而非 Map 插入序）。
  return [...byId.values()].sort((a, b) => b.similarity - a.similarity)
}

function storedFrom(
  conf: Awaited<ReturnType<typeof computeConfidenceFromProvenances>>,
): StoredConfidence {
  return {
    factors: conf.factors,
    weights: conf.weights,
    calibrationVersion: conf.calibrationVersion,
  }
}

/**
 * 合并后从 fromId 补记 contradicts/refines 边（去重，不漏冲突信号）。contradicts 对称：任一方向已存在即跳过；
 * refines 取 fromId→对端方向。
 */
async function insertMergeEdges(
  tx: Tx,
  fromId: string,
  edges: { to: string; type: 'contradicts' | 'refines' }[],
): Promise<void> {
  if (edges.length === 0) return
  const present = await tx
    .select({ from: relation.fromClaim, to: relation.toClaim, type: relation.type })
    .from(relation)
    .where(
      and(
        inArray(relation.type, ['contradicts', 'refines']),
        or(eq(relation.fromClaim, fromId), eq(relation.toClaim, fromId)),
      ),
    )
  const has = new Set<string>()
  for (const r of present) {
    if (r.from === fromId && r.to) has.add(`${r.type}:out:${r.to}`)
    if (r.to === fromId) has.add(`${r.type}:in:${r.from}`)
  }
  for (const e of edges) {
    const dup =
      e.type === 'contradicts'
        ? has.has(`contradicts:out:${e.to}`) || has.has(`contradicts:in:${e.to}`)
        : has.has(`refines:out:${e.to}`)
    if (dup) continue
    await tx
      .insert(relation)
      .values({ id: randomUUID(), fromClaim: fromId, toClaim: e.to, type: e.type })
    has.add(`${e.type}:out:${e.to}`)
  }
}

/** 新建一条 draft claim（D2 影子区）+ 写出处（≥1，D1）+ 记 contradicts/refines 边。返回 {merged:false}。 */
async function insertNewClaim(
  tx: Tx,
  draft: DraftClaim,
  embedding: number[],
  embeddingVersion: string,
  provenances: ProvenanceInput[],
  edges: { to: string; type: 'contradicts' | 'refines' }[],
): Promise<CommitResult> {
  const conf = await computeConfidenceFromProvenances(
    tx,
    provenances.map((p) => ({ sourceId: p.sourceId, relevance: p.relevance ?? null })),
    draft.asOf,
  )
  const claimId = randomUUID()
  await tx.insert(claim).values({
    id: claimId,
    claimText: draft.claimText,
    subject: draft.subject,
    predicate: draft.predicate,
    object: draft.object,
    status: 'draft',
    confidence: conf.confidence,
    confidenceRaw: conf.confidenceRaw,
    confidenceFactors: storedFrom(conf),
    lineageId: randomUUID(),
    asOf: draft.asOf ?? new Date(),
    createdBy: draft.createdBy ?? 'agent:unknown',
    embedding,
    embeddingVersion,
  })
  for (const p of provenances) {
    await tx.insert(claimProvenance).values({
      id: randomUUID(),
      claimId,
      sourceId: p.sourceId, // NOT NULL FK = D1
      locator: p.locator,
      excerpt: p.excerpt,
      relevance: (p.relevance ?? 'supporting') as ProvRelevance,
    })
  }
  for (const e of edges) {
    await tx.insert(relation).values({
      id: randomUUID(),
      fromClaim: claimId,
      toClaim: e.to,
      type: e.type,
    })
  }
  return { claimId, merged: false }
}

/**
 * 写入一条 claim（带同一事实去重）。返回 {claimId, merged}。
 * judge 仅在确定性规则不中且相似度≥0.65 时被调用（灰区一次 LLM）。
 */
export async function commitClaim(
  db: DB,
  embedder: Embedder,
  judge: SameFactJudge,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
): Promise<CommitResult> {
  if (!Array.isArray(provenances) || provenances.length < 1) {
    throw new Error(
      'commit_claim: D1 violation — a claim requires >=1 provenance (forced provenance)',
    )
  }
  const embedding = await embedder.embed(draft.claimText, 'document') // 事务外算（纯计算/远程）
  const me = shapeOf(draft)
  const candidates = await findCandidates(db, embedding, me.subject)

  // stage 2：逐候选判同。命中 same → 合并目标；contradicts/refines → 记边。
  let sameTarget: Candidate | null = null
  const edges: { to: string; type: 'contradicts' | 'refines' }[] = []
  for (const c of candidates) {
    const verdict = await adjudicate(me, c, c.similarity, judge)
    if (verdict === 'same') {
      // 只把健康生命周期 {draft, active} 的同一事实选为合并目标；命中 flagged/quarantined 的 same 不强化、不吞，
      // 该新事实留到下面新建 draft（红线 #2 + 防数据丢失）。最相似的若不可合并，继续找次相似的可合并目标。
      if (!sameTarget && isMergeable(c.status)) sameTarget = c
    } else if (verdict === 'contradicts') {
      edges.push({ to: c.id, type: 'contradicts' })
    } else if (verdict === 'refines') {
      edges.push({ to: c.id, type: 'refines' })
    }
  }

  if (sameTarget) {
    const target = sameTarget
    return db.transaction(async (tx) => {
      // 红线 #2 + 防 TOCTOU：事务内对目标行加 FOR UPDATE 锁并复核状态——候选拉取后到此若已被人/Verifier
      // 收紧/隔离（flagged/quarantined/superseded），不再强化它，改为把新事实新建为 draft（既守红线又不丢数据）。
      const [locked] = await tx
        .select({ status: claim.status, asOf: claim.asOf })
        .from(claim)
        .where(eq(claim.id, target.id))
        .for('update')
      if (!locked || !isMergeable(locked.status)) {
        return insertNewClaim(tx, draft, embedding, embedder.version, provenances, edges)
      }
      // 合并：把本次出处挂到既有 claim（跳过已存在的同 source 出处，避免同源重复行）。
      const existing = await tx
        .select({ sourceId: claimProvenance.sourceId })
        .from(claimProvenance)
        .where(eq(claimProvenance.claimId, target.id))
      const have = new Set(existing.map((e) => e.sourceId))
      for (const p of provenances) {
        if (have.has(p.sourceId)) continue
        await tx.insert(claimProvenance).values({
          id: randomUUID(),
          claimId: target.id,
          sourceId: p.sourceId,
          locator: p.locator,
          excerpt: p.excerpt,
          relevance: p.relevance ?? 'supporting',
        })
        have.add(p.sourceId)
      }
      // 按全量出处重算 confidence（只数 supports 源；f3 随独立印证数升；保持原 claim 的 asOf，不刷新年龄）。
      // target 已是既存 claim → 传 claimId，让 f2 entailment 反映它最新的 patrol 裁决（S17）。
      const all = await tx
        .select({ sourceId: claimProvenance.sourceId, relevance: claimProvenance.relevance })
        .from(claimProvenance)
        .where(eq(claimProvenance.claimId, target.id))
      const conf = await computeConfidenceFromProvenances(tx, all, locked.asOf, {
        claimId: target.id,
      })
      await tx
        .update(claim)
        .set({
          confidence: conf.confidence,
          confidenceRaw: conf.confidenceRaw,
          confidenceFactors: storedFrom(conf),
        })
        .where(eq(claim.id, target.id))
      // 别把对其它候选的 contradicts/refines 信号丢在地上：本次新事实并入 target 后，这些关系归属 target。
      // 从 target 补上缺失的边（contradicts 对称：任一方向已存在即跳过；refines 取 target→对端方向）。
      await insertMergeEdges(tx, target.id, edges)
      return { claimId: target.id, merged: true }
    })
  }

  // 全 unrelated（或同一事实命中的都不可合并）→ 新建 claim（draft 影子区）+ 记 contradicts/refines 边。
  return db.transaction((tx) =>
    insertNewClaim(tx, draft, embedding, embedder.version, provenances, edges),
  )
}
