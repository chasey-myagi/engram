/**
 * source 业务身份/权威治理 SPI（EGR-CR-011）—— 把「原文不可变」与「业务身份/权威可治理」彻底分开。
 *
 * `source.content`/`content_hash` 是 immutable 原文（addSource 撞号 first-writer-wins，永不覆盖、去重锚点）；
 * `source.meta`（领域身份注入口，adapter 用 `source_type`）/`authority_score`（消费方可覆盖的权威信号）是与
 * content **正交、可后续演进**的维度。「先裸 ingest 原文、后富集业务身份」是常规接入顺序——本 SPI 是给那条
 * 「首写未带业务身份」的逃生口：显式改 `meta`/`authority_score` + 一条 append-only 审计事件留痕，可恢复、可回溯。
 *
 * **只人能富集**（红线#2 同精神：业务身份补标是人的治理裁断，不让 agent 自报身份冒充）—— 授权只看
 * `actor.isHuman`（EGR-CR-002 同款受信边界；agent 即便 role 伪装成 'human:fake' 也 isHuman:false 被拒）。
 * by_role 落 `actor.role` 仅审计。事件落独立 append-only 表 `source_metadata_events`（不碰冻结枚举 metrics_event_kind）。
 */
import { randomUUID } from 'node:crypto'

import { asc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { source, sourceMetadataEvents } from '../db/schema.js'
import type { ActorContext } from './actor.js'

/** 一条 source 治理审计事件的读出形状。 */
export interface SourceMetadataEvent {
  eventId: string
  sourceId: string
  field: 'meta' | 'authority_score'
  before: unknown
  after: unknown
  byRole: string
  reason: string
  createdAt: Date
}

/**
 * 富集 source 的业务身份 `meta`（**整体替换**——meta 是领域注入口的一份完整快照，shallow-merge 会留下
 * 「半新半旧」的歧义身份，整体替换让「这条源现在的业务身份」单义可读；调用方要保留旧 key 自行带齐）。
 *
 * 受信门：`actor.isHuman` 为 true 才放行（agent 拒）。source 不存在则拒（不留空审计）。reason/role trim 后非空。
 * 写一条 `field='meta'` 的 append-only 审计事件（before=旧 meta / after=新 meta），返回 eventId。
 */
export async function updateSourceMetadata(
  db: DB,
  opts: { sourceId: string; meta: Record<string, unknown>; actor: ActorContext; reason: string },
): Promise<{ eventId: string }> {
  const byRole = opts.actor.role.trim()
  const reason = opts.reason.trim()
  if (!opts.actor.isHuman) {
    throw new Error(
      'source-metadata: refusing to update source meta — enrichment is human-only (actor.isHuman=false)',
    )
  }
  if (byRole.length === 0) {
    throw new Error('source-metadata: refusing to update source meta with empty actor.role')
  }
  if (reason.length === 0) {
    throw new Error('source-metadata: refusing to update source meta with empty reason')
  }
  return db.transaction(async (tx) => {
    // FOR UPDATE 锁住该行：并发富集序列化，before 快照与实际改写在同一锁内一致。
    const [row] = await tx
      .select({ meta: source.meta })
      .from(source)
      .where(eq(source.id, opts.sourceId))
      .for('update')
    if (row === undefined) {
      throw new Error(
        `source-metadata: refusing to update meta — source ${opts.sourceId} not found`,
      )
    }
    await tx.update(source).set({ meta: opts.meta }).where(eq(source.id, opts.sourceId))
    const eventId = randomUUID()
    await tx.insert(sourceMetadataEvents).values({
      id: eventId,
      sourceId: opts.sourceId,
      field: 'meta',
      before: row.meta,
      after: opts.meta,
      byRole,
      reason,
    })
    return { eventId }
  })
}

/**
 * 调整 source 的 `authority_score`（schema 注释「连续、消费方可覆盖」的显式治理口）。
 *
 * 受信门 + 留痕同 updateSourceMetadata。authorityScore 须是 [0,1] 内的有限数（与权威信号语义一致）。
 * 写一条 `field='authority_score'` 的 append-only 审计事件（before=旧分 / after=新分），返回 eventId。
 */
export async function annotateSourceAuthority(
  db: DB,
  opts: { sourceId: string; authorityScore: number; actor: ActorContext; reason: string },
): Promise<{ eventId: string }> {
  const byRole = opts.actor.role.trim()
  const reason = opts.reason.trim()
  if (!opts.actor.isHuman) {
    throw new Error(
      'source-metadata: refusing to annotate authority — enrichment is human-only (actor.isHuman=false)',
    )
  }
  if (byRole.length === 0) {
    throw new Error('source-metadata: refusing to annotate authority with empty actor.role')
  }
  if (reason.length === 0) {
    throw new Error('source-metadata: refusing to annotate authority with empty reason')
  }
  if (!Number.isFinite(opts.authorityScore) || opts.authorityScore < 0 || opts.authorityScore > 1) {
    throw new Error(
      `source-metadata: refusing to annotate authority — score must be a finite number in [0,1], got ${opts.authorityScore}`,
    )
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ authorityScore: source.authorityScore })
      .from(source)
      .where(eq(source.id, opts.sourceId))
      .for('update')
    if (row === undefined) {
      throw new Error(
        `source-metadata: refusing to annotate authority — source ${opts.sourceId} not found`,
      )
    }
    await tx
      .update(source)
      .set({ authorityScore: opts.authorityScore })
      .where(eq(source.id, opts.sourceId))
    const eventId = randomUUID()
    await tx.insert(sourceMetadataEvents).values({
      id: eventId,
      sourceId: opts.sourceId,
      field: 'authority_score',
      before: row.authorityScore,
      after: opts.authorityScore,
      byRole,
      reason,
    })
    return { eventId }
  })
}

/** 读一条 source 的治理审计史（按时间升序：before/after 链可还原从首写到当前的每一步改动，append-only 永不删改）。 */
export async function getSourceMetadataEvents(
  db: DB,
  sourceId: string,
): Promise<SourceMetadataEvent[]> {
  const rows = await db
    .select()
    .from(sourceMetadataEvents)
    .where(eq(sourceMetadataEvents.sourceId, sourceId))
    .orderBy(asc(sourceMetadataEvents.createdAt), asc(sourceMetadataEvents.id))
  return rows.map((r) => ({
    eventId: r.id,
    sourceId: r.sourceId,
    field: r.field as 'meta' | 'authority_score',
    before: r.before,
    after: r.after,
    byRole: r.byRole,
    reason: r.reason,
    createdAt: r.createdAt,
  }))
}
