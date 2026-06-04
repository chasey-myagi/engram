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

import { and, cosineDistance, eq, isNotNull, ne } from 'drizzle-orm'

import type { StoredConfidence } from '../confidence/confidence.js'
import type { DB } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import { claim, claimProvenance, relation, type ProvRelevance } from '../db/schema.js'
import {
  adjudicate,
  SAME_FACT_CANDIDATE_SIMILARITY,
  SAME_FACT_TOPK,
  type ClaimShape,
  type SameFactJudge,
} from '../same-fact/same-fact.js'
import { computeConfidenceFromSourceIds } from './append-claim.js'
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
  if (subject != null) {
    const subjMatches = await db
      .select(cols)
      .from(claim)
      .where(and(ne(claim.status, 'superseded'), eq(claim.subject, subject)))
    for (const c of subjMatches) {
      if (!byId.has(c.id)) byId.set(c.id, { ...c, similarity: 1 - Number(c.distance) })
    }
  }
  return [...byId.values()]
}

function storedFrom(
  conf: Awaited<ReturnType<typeof computeConfidenceFromSourceIds>>,
): StoredConfidence {
  return {
    factors: conf.factors,
    weights: conf.weights,
    calibrationVersion: conf.calibrationVersion,
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
      // 按全量源重算 confidence（f3 随独立印证数升；保持原 claim 的 asOf，不刷新年龄）。
      const all = await tx
        .select({ sourceId: claimProvenance.sourceId })
        .from(claimProvenance)
        .where(eq(claimProvenance.claimId, target.id))
      const conf = await computeConfidenceFromSourceIds(
        tx,
        all.map((a) => a.sourceId),
        target.asOf,
      )
      await tx
        .update(claim)
        .set({
          confidence: conf.confidence,
          confidenceRaw: conf.confidenceRaw,
          confidenceFactors: storedFrom(conf),
        })
        .where(eq(claim.id, target.id))
      return { claimId: target.id, merged: true }
    })
  }

  // 新建 claim（draft 影子区）+ 记 contradicts/refines 边。
  return db.transaction(async (tx) => {
    const conf = await computeConfidenceFromSourceIds(
      tx,
      provenances.map((p) => p.sourceId),
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
