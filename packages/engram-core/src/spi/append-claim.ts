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

import { eq, inArray } from 'drizzle-orm'

import {
  NEUTRAL_FACTORS,
  computeConfidence,
  halfLifeDaysForKind,
  independentSupportScore,
  type ComputedConfidence,
} from '../confidence/confidence.js'
import type { DB, Tx } from '../db/client.js'
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

/**
 * S2 命门：从 claim 的出处源算连续 confidence。authority 取最强源、indepSupport 数独立源
 * （S2 阶段独立≈不同 source id；完整 A.6 独立判定是 S14）、stale 看 as_of、halfLife 看最强源的 kind。
 */
async function computeClaimConfidence(
  tx: Tx,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
): Promise<ComputedConfidence> {
  const sourceIds = [...new Set(provenances.map((p) => p.sourceId))]
  const sources = sourceIds.length
    ? await tx
        .select({ authority: source.authorityScore, kind: source.kind })
        .from(source)
        .where(inArray(source.id, sourceIds))
    : []
  // 最强源（authority 最高）一遍扫出：它的 authority_score 作 f0、它的 kind 定半衰期。
  const dominant = sources.reduce<(typeof sources)[number] | null>(
    (best, s) => (best === null || s.authority > best.authority ? s : best),
    null,
  )
  const authority = dominant?.authority ?? 0
  const halfLifeDays = dominant ? halfLifeDaysForKind(dominant.kind) : 180
  const indepSupport = independentSupportScore(sources.length) // 1 源→0（无独立印证），越多越高
  const asOf = draft.asOf ?? new Date()
  const ageDays = Math.max(0, (Date.now() - asOf.getTime()) / MS_PER_DAY)
  return computeConfidence(
    { ...NEUTRAL_FACTORS, authority, indepSupport },
    { ageDays, halfLifeDays, activeContradicts: 0 },
  )
}

async function insertClaim(
  tx: Tx,
  draft: DraftClaim,
  lineageId: string,
  conf: ComputedConfidence,
): Promise<string> {
  const id = randomUUID()
  await tx.insert(claim).values({
    id,
    claimText: draft.claimText,
    subject: draft.subject,
    predicate: draft.predicate,
    object: draft.object,
    status: 'draft',
    confidence: conf.confidence,
    confidenceRaw: conf.confidenceRaw,
    confidenceFactors: {
      factors: conf.factors,
      weights: conf.weights,
      calibrationVersion: conf.calibrationVersion,
    },
    lineageId,
    asOf: draft.asOf ?? new Date(),
    createdBy: draft.createdBy ?? 'agent:unknown',
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
    })
    .onConflictDoUpdate({
      target: source.contentHash,
      set: { contentHash: input.contentHash }, // no-op update：撞号也触发 RETURNING 返回既有行，且不动既有 meta/content
    })
    .returning({ id: source.id })
  return { sourceId: rows[0]!.id }
}

/** 乐观写入：默认 draft，强制 ≥1 出处，连续 confidence + claim + 出处单事务原子写入。新 claim 起一个新 lineage。 */
export async function appendClaim(
  db: DB,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
): Promise<{ claimId: string }> {
  requireProvenance(provenances)
  return db.transaction(async (tx) => {
    const conf = await computeClaimConfidence(tx, draft, provenances)
    const claimId = await insertClaim(tx, draft, randomUUID(), conf)
    await insertProvenances(tx, claimId, provenances)
    return { claimId }
  })
}

/** append-only 取代：新版本沿用旧 claim 的 lineage_id，加一条 supersedes 边，旧版标 superseded（不物理删）。 */
export async function supersedeClaim(
  db: DB,
  oldClaimId: string,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
): Promise<{ claimId: string }> {
  requireProvenance(provenances)
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
    const claimId = await insertClaim(tx, draft, old[0]!.lineageId, conf)
    await insertProvenances(tx, claimId, provenances)
    await tx
      .insert(relation)
      .values({ id: randomUUID(), fromClaim: claimId, toClaim: oldClaimId, type: 'supersedes' })
    await tx.update(claim).set({ status: 'superseded' }).where(eq(claim.id, oldClaimId))
    return { claimId }
  })
}
