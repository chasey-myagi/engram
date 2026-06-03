/**
 * 乐观写入路径（Consumer SPI 的写半边，附录 A.2）。S1 walking skeleton：
 *   - addSource：幂等入原文（content_hash UNIQUE 去重，单语句 ON CONFLICT 总返存活 id），meta 透传不解释。
 *   - appendClaim：默认 draft、强制 ≥1 provenance、单事务原子写入（D1 硬门）。
 *   - supersedeClaim：append-only 取代 —— 新版本沿用同 lineage_id + 一条 supersedes 边，旧版标
 *     superseded 而**不物理删**。
 *
 * confidence 三元（confidence / confidence_raw / confidence_factors）本切片填占位值；连续化是 S2（命门）。
 */
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import type { DB, Tx } from '../db/client.js'
import {
  claim,
  claimProvenance,
  relation,
  source,
  type ProvRelevance,
  type SourceKind,
} from '../db/schema.js'

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

async function insertClaim(tx: Tx, draft: DraftClaim, lineageId: string): Promise<string> {
  const id = randomUUID()
  await tx.insert(claim).values({
    id,
    claimText: draft.claimText,
    subject: draft.subject,
    predicate: draft.predicate,
    object: draft.object,
    status: 'draft',
    // 占位值：S2（命门）把 confidence 换成连续多因子 + g
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: {},
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

/**
 * 幂等入原文：content_hash 撞号则复用既有行（不重复落库），单语句 ON CONFLICT 总返存活 id。
 * DO UPDATE 只把 content_hash 写成自身（no-op），既触发 RETURNING 返回既有行、又不动既有 meta / content。
 * meta 原样存、内核不读业务键。
 */
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
      set: { contentHash: input.contentHash },
    })
    .returning({ id: source.id })
  return { sourceId: rows[0]!.id }
}

/** 乐观写入：默认 draft，强制 ≥1 出处，claim + 出处单事务原子写入。新 claim 起一个新 lineage。 */
export async function appendClaim(
  db: DB,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
): Promise<{ claimId: string }> {
  requireProvenance(provenances)
  return db.transaction(async (tx) => {
    const claimId = await insertClaim(tx, draft, randomUUID())
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
    if (old.length === 0) {
      throw new Error(`supersede_claim: claim ${oldClaimId} not found`)
    }
    // 单 head 不变量：只取代当前 head；取代一个已 superseded 的旧版会让同 lineage 出现两个 head（谱系分叉）。
    // （并发取代同一 head 的竞态需 SELECT ... FOR UPDATE / lineage 唯一 head 约束，待引入并发写时处理。）
    if (old[0]!.status === 'superseded') {
      throw new Error(
        `supersede_claim: claim ${oldClaimId} is already superseded (would fork its lineage); supersede the current head`,
      )
    }
    const claimId = await insertClaim(tx, draft, old[0]!.lineageId)
    await insertProvenances(tx, claimId, provenances)
    await tx
      .insert(relation)
      .values({ id: randomUUID(), fromClaim: claimId, toClaim: oldClaimId, type: 'supersedes' })
    await tx.update(claim).set({ status: 'superseded' }).where(eq(claim.id, oldClaimId))
    return { claimId }
  })
}
