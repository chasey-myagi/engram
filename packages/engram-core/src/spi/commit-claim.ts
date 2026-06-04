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
import { claim, claimProvenance, relation, type ProvRelevance } from '../db/schema.js'
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

interface Candidate extends ClaimShape {
  id: string
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
      if (!sameTarget) sameTarget = c
    } else if (verdict === 'contradicts') {
      edges.push({ to: c.id, type: 'contradicts' })
    } else if (verdict === 'refines') {
      edges.push({ to: c.id, type: 'refines' })
    }
  }

  if (sameTarget) {
    const target = sameTarget
    return db.transaction(async (tx) => {
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
      const all = await tx
        .select({ sourceId: claimProvenance.sourceId, relevance: claimProvenance.relevance })
        .from(claimProvenance)
        .where(eq(claimProvenance.claimId, target.id))
      const conf = await computeConfidenceFromProvenances(tx, all, target.asOf)
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

  // 新建 claim（draft 影子区）+ 记 contradicts/refines 边。
  return db.transaction(async (tx) => {
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
      embeddingVersion: embedder.version,
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
  })
}
