/**
 * S9 重嵌版本锚。模型/版本 bump（embedder.version 变了）时：把 embedding_version ≠ 当前版本（或为 null）的 claim
 * 标记成 claim_verification(kind='reembed_marker')，使历史 stale 向量可枚举；后台 cron 只重嵌被标记且仍 stale 的，
 * 已是当前版本的跳过。embedding_version 随召回快照（RecallResult.embeddingVersion）一同暴露。
 */
import { randomUUID } from 'node:crypto'

import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { claim, claimVerification } from '../db/schema.js'
import type { Embedder } from './embedder.js'

/**
 * 标记所有 embedding_version ≠ currentVersion（含 null）的 claim 需重嵌。已标记过的不重复标。返回新增标记数。
 */
export async function markStaleForReembed(db: DB, currentVersion: string): Promise<number> {
  const stale = await db
    .select({ id: claim.id, version: claim.embeddingVersion })
    .from(claim)
    .where(or(isNull(claim.embeddingVersion), ne(claim.embeddingVersion, currentVersion)))
  if (stale.length === 0) return 0
  const staleIds = stale.map((s) => s.id)
  const existing = await db
    .select({ claimId: claimVerification.claimId })
    .from(claimVerification)
    .where(
      and(
        eq(claimVerification.kind, 'reembed_marker'),
        inArray(claimVerification.claimId, staleIds),
      ),
    )
  const alreadyMarked = new Set(existing.map((e) => e.claimId))
  const toMark = stale.filter((s) => !alreadyMarked.has(s.id))
  for (const s of toMark) {
    await db.insert(claimVerification).values({
      id: randomUUID(),
      claimId: s.id,
      kind: 'reembed_marker',
      verdict: { fromVersion: s.version, toVersion: currentVersion },
      byRole: 'system:reembed',
    })
  }
  return toMark.length
}

export interface ReembedMarker {
  claimId: string
  createdAt: Date
}

/** 枚举 reembed 标记（cron 取数口；append-only，按时间升序）。 */
export async function getReembedMarkers(db: DB): Promise<ReembedMarker[]> {
  const rows = await db
    .select({ claimId: claimVerification.claimId, createdAt: claimVerification.createdAt })
    .from(claimVerification)
    .where(eq(claimVerification.kind, 'reembed_marker'))
    .orderBy(claimVerification.createdAt, claimVerification.id)
  return rows
}

/**
 * 重嵌被标记的 claim：用 embedder 重算 claim_text 向量、更新 embedding + embedding_version。
 * 已是 embedder.version 的**跳过**（幂等、可重复跑）。返回实际重嵌数。
 */
export async function reembedMarked(db: DB, embedder: Embedder): Promise<number> {
  const markers = await db
    .select({ claimId: claimVerification.claimId })
    .from(claimVerification)
    .where(eq(claimVerification.kind, 'reembed_marker'))
  const ids = [...new Set(markers.map((m) => m.claimId))]
  if (ids.length === 0) return 0
  const rows = await db
    .select({ id: claim.id, claimText: claim.claimText, version: claim.embeddingVersion })
    .from(claim)
    .where(inArray(claim.id, ids))
  let reembedded = 0
  for (const r of rows) {
    if (r.version === embedder.version) continue // 已是当前版本 → 跳过
    const vector = await embedder.embed(r.claimText)
    await db
      .update(claim)
      .set({ embedding: vector, embeddingVersion: embedder.version })
      .where(eq(claim.id, r.id))
    reembedded += 1
  }
  return reembedded
}
