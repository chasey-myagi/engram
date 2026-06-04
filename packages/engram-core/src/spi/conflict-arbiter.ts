/**
 * 冲突裁决落库 SPI（S20）—— 把 A.5 纯阶梯（conflict-ladder.ts）的裁决结果落到库里 + 读出。
 * Arbiter worker 经此缝裁决，不直插内核表。
 *
 * 三件事：
 *   ① loadConflictSide：从库现拍一条 claim 的裁决输入快照（as_of / 最强源 authority / 独立印证数 / 取代的对端集合），
 *      喂纯阶梯 adjudicateConflict。**确定性可重建** —— 同一 claim + 同一库状态恒得同一快照（可回归红线的输入半边）。
 *   ② resolveConflict：机判自裁（唯一胜者）—— 记一条 contradicts 边（双方都留，不删败者、不改其状态）
 *      + 一条 conflict_adjudicated(outcome='resolved') 采信/信任标记（指明 winner/loser/rung，可解释）。
 *      **绝不动 claim.status**（红线#2「只人能放松」：Arbiter 标信任、不放松/隔离/复活任何 claim）。
 *   ③ escalateConflict：并列/不可机判 —— 记一条 contradicts 边 + 一条 conflict_adjudicated(outcome='escalated')
 *      入主编队列（待人用同一张优先级表 + ① 人工裁定手裁）。同样不动 claim.status，双方仍可召回。
 *
 * contradicts 边幂等：同一对（无序）至多一条边——裁决可反复跑（重放/重触发）而不堆叠重复边。
 */
import { randomUUID } from 'node:crypto'

import { and, desc, eq, inArray, or } from 'drizzle-orm'

import {
  claim,
  claimProvenance,
  metricsEvents,
  relation,
  source,
  type ClaimStatus,
} from '../db/schema.js'
import type { DB, Tx } from '../db/client.js'
import { countIndependentSupports, type SourceIndep } from '../same-fact/independent.js'
import type { Adjudication, ConflictSide, LadderRung } from './conflict-ladder.js'

/** conflict_adjudicated 事件的 metrics_event_kind 值（S20）。 */
export const CONFLICT_ADJUDICATED = 'conflict_adjudicated' as const

type Queryable = DB | Tx

/** conflict_adjudicated 的 payload 形状（离线分析/审计/主编队列读出用，绝不进任何计分）。 */
export interface ConflictAdjudicatedPayload {
  /** resolved=机判自裁（采信/信任标记）；escalated=升级主编队列。 */
  outcome: 'resolved' | 'escalated'
  /** 冲突对（无序）。 */
  claimA: string
  claimB: string
  /** 机判自裁时的胜/败者（escalated 时省略——待人裁）。 */
  winnerId?: string
  loserId?: string
  /** 在哪一阶定的（resolved=②③④⑤；escalated='human' 待人在 ① 手裁）。可解释锚点。 */
  rung: LadderRung
  /** 人类可读理由（来自纯阶梯）。 */
  reason: string
  /** 裁决者身份（agent:arbiter / 测试角色）。 */
  byRole: string
}

/**
 * 从库现拍一条 claim 的裁决输入快照（ConflictSide）。**确定性、纯读**：
 *   - asOf：claim.as_of（A.5 ③ 时效）。
 *   - authority：本 claim 全部 exact/supporting 出处对应源里最强 authority_score（A.5 ④；无 supports 源 → 0）。
 *   - indepSupport：独立印证数（A.5 ⑤；与 confidence 同口径——hash 去重 + 血缘折叠 + agent_synthesis 0.5 折扣）。
 *   - supersedes：本 claim 经 supersedes 边直接/传递取代掉的对端 claimId 集合（A.5 ②）。
 * claim 不存在 → 抛。
 */
export async function loadConflictSide(q: Queryable, claimId: string): Promise<ConflictSide> {
  const [c] = await q.select({ asOf: claim.asOf }).from(claim).where(eq(claim.id, claimId)).limit(1)
  if (!c) {
    throw new Error(`loadConflictSide: claim ${claimId} not found`)
  }

  // A.5 ④/⑤：本 claim 的 supports 出处 → 对应源的 authority/kind/血缘，算最强 authority + 独立印证数。
  // tangential/irrelevant 不计（与 computeConfidenceFromProvenances 同口径，防无关源刷权威/印证）。
  const provs = await q
    .select({ sourceId: claimProvenance.sourceId, relevance: claimProvenance.relevance })
    .from(claimProvenance)
    .where(eq(claimProvenance.claimId, claimId))
  const supportSourceIds = [
    ...new Set(
      provs
        .filter((p) => p.relevance === 'exact' || p.relevance === 'supporting')
        .map((p) => p.sourceId),
    ),
  ]
  const sources = supportSourceIds.length
    ? await q
        .select({
          id: source.id,
          contentHash: source.contentHash,
          kind: source.kind,
          authorityScore: source.authorityScore,
          derivedFromSourceId: source.derivedFromSourceId,
        })
        .from(source)
        .where(inArray(source.id, supportSourceIds))
    : []
  const authority = sources.reduce((max, s) => (s.authorityScore > max ? s.authorityScore : max), 0)
  // countIndependentSupports 只看 SourceIndep 的字段面（id/contentHash/kind/derivedFromSourceId）；authorityScore 是 f0 用、不入印证。
  const indepSupport = countIndependentSupports(sources)

  // A.5 ②：本 claim 作为 supersedes 边的 from 端时取代的 to 端集合（append 新版本时 supersedeClaim 落的边）。
  const superRows = await q
    .select({ to: relation.toClaim })
    .from(relation)
    .where(and(eq(relation.type, 'supersedes'), eq(relation.fromClaim, claimId)))
  const supersedes = new Set<string>()
  for (const r of superRows) if (r.to != null) supersedes.add(r.to)

  return { claimId, asOf: c.asOf, authority, indepSupport, supersedes }
}

/** 一对 claim 已有 contradicts 边？（无序：a↔b / b↔a 都算）。幂等记边用。 */
async function hasContradictsEdge(q: Queryable, a: string, b: string): Promise<boolean> {
  const rows = await q
    .select({ id: relation.id })
    .from(relation)
    .where(
      and(
        eq(relation.type, 'contradicts'),
        or(
          and(eq(relation.fromClaim, a), eq(relation.toClaim, b)),
          and(eq(relation.fromClaim, b), eq(relation.toClaim, a)),
        ),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** 幂等记一条 contradicts 边（双方都留）。已存在（任一方向）则不重复落。 */
async function ensureContradictsEdge(tx: Tx, a: string, b: string): Promise<void> {
  if (await hasContradictsEdge(tx, a, b)) return
  await tx.insert(relation).values({
    id: randomUUID(),
    fromClaim: a,
    toClaim: b,
    type: 'contradicts',
  })
}

/** 写一条 conflict_adjudicated 事件（采信标记 / 升级队列共用，payload.outcome 分流）。 */
async function writeAdjudicatedEvent(tx: Tx, payload: ConflictAdjudicatedPayload): Promise<string> {
  const id = randomUUID()
  await tx.insert(metricsEvents).values({
    id,
    kind: CONFLICT_ADJUDICATED,
    queryText: null,
    payload,
  })
  return id
}

export interface ConflictPersistResult {
  outcome: 'resolved' | 'escalated'
  eventId: string
  winnerId?: string
  loserId?: string
  rung: LadderRung
}

/**
 * 机判自裁（唯一胜者）落库：① 幂等记 contradicts 边（双方都留），② 写 conflict_adjudicated(resolved) 采信标记。
 * **不改任何 claim.status**（红线#2）：Arbiter 只标「该信谁」，不放松/隔离/复活。单事务原子。
 * adj.outcome 必须是 'winner'（否则抛——调用方先用纯阶梯判好）。
 */
export async function resolveConflict(
  db: DB,
  opts: { a: string; b: string; adjudication: Adjudication; byRole: string },
): Promise<ConflictPersistResult> {
  const adj = opts.adjudication
  if (adj.outcome !== 'winner' || adj.winnerId === undefined || adj.loserId === undefined) {
    throw new Error('resolveConflict: adjudication must have a unique winner')
  }
  // 收窄成 string（exactOptionalPropertyTypes：守卫后捕进局部，避免 spread 把 undefined 带回 optional 字段）。
  const winnerId: string = adj.winnerId
  const loserId: string = adj.loserId
  return db.transaction(async (tx) => {
    await ensureContradictsEdge(tx, opts.a, opts.b)
    const payload: ConflictAdjudicatedPayload = {
      outcome: 'resolved',
      claimA: opts.a,
      claimB: opts.b,
      winnerId,
      loserId,
      rung: adj.rung,
      reason: adj.reason,
      byRole: opts.byRole,
    }
    const eventId = await writeAdjudicatedEvent(tx, payload)
    return { outcome: 'resolved', eventId, winnerId, loserId, rung: adj.rung }
  })
}

/**
 * 升级主编（并列/证据不足/预算耗尽）落库：① 幂等记 contradicts 边（双方都留），
 * ② 写 conflict_adjudicated(escalated) 入主编队列。**不改任何 claim.status**：双方仍可召回（recall 双返矛盾）。
 * 主编日后用同一张优先级表 + ① 人工裁定手裁。单事务原子。
 */
export async function escalateConflict(
  db: DB,
  opts: { a: string; b: string; rung: LadderRung; reason: string; byRole: string },
): Promise<ConflictPersistResult> {
  return db.transaction(async (tx) => {
    await ensureContradictsEdge(tx, opts.a, opts.b)
    const payload: ConflictAdjudicatedPayload = {
      outcome: 'escalated',
      claimA: opts.a,
      claimB: opts.b,
      rung: opts.rung,
      reason: opts.reason,
      byRole: opts.byRole,
    }
    const eventId = await writeAdjudicatedEvent(tx, payload)
    return { outcome: 'escalated', eventId, rung: opts.rung }
  })
}

/** conflict_adjudicated 事件的读出形状（payload 已校验）。 */
export interface ConflictAdjudication {
  eventId: string
  payload: ConflictAdjudicatedPayload
  createdAt: Date
}

function isAdjudicatedPayload(p: unknown): p is ConflictAdjudicatedPayload {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  return (
    (o.outcome === 'resolved' || o.outcome === 'escalated') &&
    typeof o.claimA === 'string' &&
    typeof o.claimB === 'string' &&
    typeof o.rung === 'string' &&
    typeof o.reason === 'string' &&
    typeof o.byRole === 'string'
  )
}

function toAdjudication(row: typeof metricsEvents.$inferSelect): ConflictAdjudication {
  if (!isAdjudicatedPayload(row.payload)) {
    throw new Error(
      `conflict-arbiter: conflict_adjudicated row ${row.id} carries a malformed payload ${JSON.stringify(row.payload)}`,
    )
  }
  return { eventId: row.id, payload: row.payload, createdAt: row.createdAt }
}

/**
 * 读主编裁决队列（outcome='escalated' 的 conflict_adjudicated 事件），最新在前。
 * 主编（人）从这里取待裁冲突，用同一张优先级表 + ① 人工裁定手裁。
 */
export async function getEditorConflictQueue(db: DB): Promise<ConflictAdjudication[]> {
  const rows = await db
    .select()
    .from(metricsEvents)
    .where(eq(metricsEvents.kind, CONFLICT_ADJUDICATED))
    .orderBy(desc(metricsEvents.createdAt), desc(metricsEvents.id))
  return rows.map(toAdjudication).filter((a) => a.payload.outcome === 'escalated')
}

/** 读机判自裁的采信/信任标记（outcome='resolved'），最新在前。可解释/审计用。 */
export async function getResolvedConflicts(db: DB): Promise<ConflictAdjudication[]> {
  const rows = await db
    .select()
    .from(metricsEvents)
    .where(eq(metricsEvents.kind, CONFLICT_ADJUDICATED))
    .orderBy(desc(metricsEvents.createdAt), desc(metricsEvents.id))
  return rows.map(toAdjudication).filter((a) => a.payload.outcome === 'resolved')
}

/** （工具）读一条 claim 的当前状态——Arbiter worker/测试断言「裁决未动 status」用。 */
export async function getClaimStatus(db: DB, claimId: string): Promise<ClaimStatus | null> {
  const [row] = await db
    .select({ status: claim.status })
    .from(claim)
    .where(eq(claim.id, claimId))
    .limit(1)
  return row?.status ?? null
}
