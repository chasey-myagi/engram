/**
 * 主编工作台读半边（S23，PRD User Stories 10/11/15/16 + 设计稿 §7「人即主编」）—— 内核只交两件**读** SPI +
 * 一件人专属**写**动作（humanAdjudicateConflict，见 conflict-arbiter.ts），供 consumer UI 的 j/k 导航 + a/e/r
 * 动作 + 谱系钻取去渲染。**Engram 是后端内核**：键位流与「暖蓝图」视觉是 consumer UI 的事，本切片不造 GUI。
 *
 * 两件读 SPI：
 *   ① getEditorInbox：审阅队列 —— 按**实时重算**的 confidence **升序**（最可疑在最前）。排序用的 value 与 recall
 *      **同一口径**（recomputeLiveConfidence，单一真相源）：用活动权重 × 存档因子 × 实时 f1/f2/f4 覆盖 × 实时
 *      conflictDecay → applyG，**绝不**读可能过期的 claim.confidence 存档列（S23 红线：被重新 flag/压低的 claim
 *      重算后会浮回队首，可测）。审阅范围 = draft|active|flagged|quarantined（superseded 旧版只在谱系里看，
 *      不进审阅队列——它已被取代、不是「待审的当前事实」）。每行映射 UI 的 j/k + a/e/r 所需的最小面（claim 本体 +
 *      实时 conf + 出处条数 + 矛盾对端 + 状态）；a/e/r 动作本身是 S22（approveClaim/editApproveClaim/rejectClaim）。
 *   ② getClaimLineage：单条 claim 的完整家谱 —— (a) 出处（source id + locator + excerpt + relevance，够 UI 钻回
 *      原文）；(b) 经 page_claims 引用本 claim 的 page（含 ord；改 claim 即改 page）；(c) 版本史 / supersede 链
 *      （沿同 lineage_id 走 supersedes 边），append-only：被取代的旧版**可见**（返回）、永不删，oldest→newest 排序。
 *
 * 末端用户**无** Engram 直达面：他们只看 consumer agent 引用过的答案（recall_claims 结果）。本模块是**主编专属**
 * 读面，与消费 recall 路径**分离**——inbox/lineage 暴露的审阅元信息（队列、矛盾对端、被隔离/草稿态 claim、谱系旧版）
 * recall 一概不返。纯读、确定性（给定库状态 + 活动规范）。
 */
import { and, asc, eq, inArray } from 'drizzle-orm'

import { getActiveStandards } from '../config/standards.js'
import { loadLiveConfidence, type LiveConfidence } from '../confidence/live-recompute.js'
import type { DB } from '../db/client.js'
import {
  claim,
  claimProvenance,
  pageClaims,
  relation,
  type ClaimStatus,
  type ProvRelevance,
} from '../db/schema.js'

/**
 * 主编审阅的状态集（A.4）：draft（影子区待晋升/驳回）、active（已晋升、可复核/驳回）、flagged（疑似幻觉待裁）、
 * quarantined（已隔离待赦免/确认）。**不含 superseded**——旧版已被取代，只在谱系视图里看，不是待审的当前事实。
 */
export const EDITOR_INBOX_STATUSES: readonly ClaimStatus[] = [
  'draft',
  'active',
  'flagged',
  'quarantined',
]

/** inbox 默认页大小（防无界返回）。consumer 可经 limit 调整。 */
export const DEFAULT_INBOX_LIMIT = 50

/** UI 的 j/k 导航 + a/e/r 动作所需的最小一行（动作本身是 S22）。 */
export interface EditorInboxRow {
  claimId: string
  claimText: string
  subject: string | null
  predicate: string | null
  object: string | null
  status: ClaimStatus
  /** 跨版本身份（谱系视图的 key；UI 可据此跳 getClaimLineage）。 */
  lineageId: string
  asOf: Date
  createdBy: string
  /**
   * **实时重算**的 confidence（与 recall 同口径）。inbox 按它升序（最可疑在前）；不是存档 claim.confidence 列。
   */
  confidence: {
    value: number
    raw: number
    /** 实时活跃矛盾对端数（喂 conflictDecay）。 */
    activeContradicts: number
  }
  /** 本 claim 的出处条数（D1 保证 ≥1）；UI 用来提示「有几条出处可钻回」。 */
  provenanceCount: number
  /** 与本 claim 矛盾、对端仍 active 的 claim id（A.5「矛盾显式」双返；UI 可并排展示冲突待裁）。 */
  contradicts: string[]
}

export interface EditorInboxQuery {
  /** 返回上限（默认 50）。 */
  limit?: number
  /** 翻页偏移（默认 0）。 */
  offset?: number
  /** 缩小到指定状态子集（默认 = EDITOR_INBOX_STATUSES）；传入值会与审阅集取交（superseded 永不入队）。 */
  statuses?: readonly ClaimStatus[]
}

/**
 * 主编审阅队列：按**实时重算**的 confidence 升序（最可疑在最前）、平手按 claimId 升序（确定性，可分页）。
 *
 * **口径红线**：排序用的 value 走 recomputeLiveConfidence（recall 的同一处合成），用活动权重 × 存档因子 ×
 * 实时 f1/f2/f4 × 实时 conflictDecay 现算——**不读** claim.confidence 存档列。故一条 claim 被 Verifier 重新 flag /
 * 新增矛盾边 / 主编 Reject 压低 f1 后，下次取 inbox 会重算并**浮回队首**（可测）。
 *
 * 分页：先按实时 value 全量排序，再 slice(offset, offset+limit)。审阅集通常不大（draft/flagged/quarantined +
 * active）；有真消费方放大后再做按 value 的下推排序优化（届时仍须守口径，不得退回读存档列）。
 */
export async function getEditorInbox(
  db: DB,
  query: EditorInboxQuery = {},
): Promise<EditorInboxRow[]> {
  const limit =
    typeof query.limit === 'number' && query.limit > 0 ? query.limit : DEFAULT_INBOX_LIMIT
  const offset = typeof query.offset === 'number' && query.offset > 0 ? query.offset : 0
  // 审阅状态集：默认全集；给了 statuses 则取交（永不放进 superseded——它不在审阅集，交集天然排除）。
  const requested = query.statuses ?? EDITOR_INBOX_STATUSES
  const statuses = EDITOR_INBOX_STATUSES.filter((s) => requested.includes(s))
  if (statuses.length === 0) return []

  const std = await getActiveStandards(db)

  const rows = await db
    .select({
      id: claim.id,
      claimText: claim.claimText,
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      status: claim.status,
      lineageId: claim.lineageId,
      asOf: claim.asOf,
      createdBy: claim.createdBy,
      confidenceFactors: claim.confidenceFactors,
    })
    .from(claim)
    .where(inArray(claim.status, [...statuses]))

  if (rows.length === 0) return []

  // 实时重算（与 recall 同一处口径）：活动权重 × 存档因子 × 实时 f1/f2/f4 × 实时 conflictDecay → applyG。
  const liveById = await loadLiveConfidence(
    db,
    rows.map((r) => ({ id: r.id, confidenceFactors: r.confidenceFactors })),
    std.factorWeights,
  )

  // 出处条数：一次查回所有审阅 claim 的出处，按 claim 计数（D1 保证 ≥1；UI 用来提示可钻回条数）。
  const ids = rows.map((r) => r.id)
  const provRows = await db
    .select({ claimId: claimProvenance.claimId })
    .from(claimProvenance)
    .where(inArray(claimProvenance.claimId, ids))
  const provCount = new Map<string, number>()
  for (const p of provRows) provCount.set(p.claimId, (provCount.get(p.claimId) ?? 0) + 1)

  const out: EditorInboxRow[] = rows.map((r) => {
    const live: LiveConfidence = liveById.get(r.id)!
    return {
      claimId: r.id,
      claimText: r.claimText,
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      status: r.status,
      lineageId: r.lineageId,
      asOf: r.asOf,
      createdBy: r.createdBy,
      confidence: {
        value: live.value,
        raw: live.raw,
        activeContradicts: live.activeContradicts,
      },
      provenanceCount: provCount.get(r.id) ?? 0,
      contradicts: live.contradicts,
    }
  })

  // 实时 confidence **升序**（最可疑在前），平手按 claimId 升序（确定性、可分页）。
  out.sort((a, b) =>
    a.confidence.value !== b.confidence.value
      ? a.confidence.value - b.confidence.value
      : a.claimId < b.claimId
        ? -1
        : 1,
  )
  return out.slice(offset, offset + limit)
}

/** 谱系视图：一条出处（钻回原文的最小面：source id + locator + excerpt + relevance）。 */
export interface LineageProvenance {
  provenanceId: string
  sourceId: string
  locator: string
  excerpt: string | null
  relevance: ProvRelevance
}

/** 谱系视图：经 page_claims 引用本 claim 的一个 page（改 claim 即改 page）。 */
export interface CitingPage {
  pageId: string
  /** 本 claim 在该 page 内的次序（page_claims.ord，可空）。 */
  ord: number | null
}

/** 谱系视图：版本史里的一个版本（沿同 lineage_id 的 supersede 链）。oldest→newest。 */
export interface LineageVersion {
  claimId: string
  claimText: string
  status: ClaimStatus
  asOf: Date
  createdBy: string
  createdAt: Date
  /** 本版本是否被某个新版取代（=有一条 supersedes 边 from 新版 to 本版）。终态旧版 true，当前 head false。 */
  superseded: boolean
}

/** 一条 claim 的完整家谱（出处 / 引用 page / 版本史）。 */
export interface ClaimLineage {
  claimId: string
  lineageId: string
  /** 该 claim 自身的出处（钻回原文）。 */
  provenances: LineageProvenance[]
  /** 引用该 claim 的 page（M:N）。改 claim 即改这些 page —— UI 据此提示「改它会动哪些 page」。 */
  citingPages: CitingPage[]
  /**
   * 同 lineage_id 的全部版本，oldest→newest（append-only：被取代的旧版**可见**、永不删）。
   * 末位通常是当前 head（未被取代的那版）。
   */
  versions: LineageVersion[]
}

/**
 * 组装一条 claim 的谱系视图。claim 不存在 → 抛。
 *   (a) 出处：本 claim 的 claim_provenance 全量（含 locator/excerpt/relevance，UI 钻回原文）。
 *   (b) 引用 page：经 page_claims 引用本 claim 的 page（注：page 落库持久，改 claim 即改 page；page 草稿态若建模在
 *       page_claims 之外，待 page 实体落地后在此补 join——当前 schema 的 page 仅经 page_claims M:N 体现，故只回 pageId+ord）。
 *   (c) 版本史：沿同 lineage_id 取全部版本，按 supersedes 边判每版是否被取代，createdAt 升序（oldest→newest）。
 */
export async function getClaimLineage(db: DB, claimId: string): Promise<ClaimLineage> {
  const [self] = await db
    .select({ lineageId: claim.lineageId })
    .from(claim)
    .where(eq(claim.id, claimId))
    .limit(1)
  if (!self) {
    throw new Error(`getClaimLineage: claim ${claimId} not found`)
  }
  const lineageId = self.lineageId

  // (a) 本 claim 的出处（钻回原文）。
  const provRows = await db
    .select({
      id: claimProvenance.id,
      sourceId: claimProvenance.sourceId,
      locator: claimProvenance.locator,
      excerpt: claimProvenance.excerpt,
      relevance: claimProvenance.relevance,
    })
    .from(claimProvenance)
    .where(eq(claimProvenance.claimId, claimId))
  const provenances: LineageProvenance[] = provRows.map((p) => ({
    provenanceId: p.id,
    sourceId: p.sourceId,
    locator: p.locator,
    excerpt: p.excerpt,
    relevance: p.relevance,
  }))

  // (b) 引用本 claim 的 page（M:N）。改本 claim 即改这些 page。
  const pageRows = await db
    .select({ pageId: pageClaims.pageId, ord: pageClaims.ord })
    .from(pageClaims)
    .where(eq(pageClaims.claimId, claimId))
    .orderBy(asc(pageClaims.pageId))
  const citingPages: CitingPage[] = pageRows.map((p) => ({ pageId: p.pageId, ord: p.ord }))

  // (c) 版本史：同 lineage_id 全部版本（append-only，旧版可见）。oldest→newest（createdAt 升序，平手 id 升序）。
  const versionRows = await db
    .select({
      id: claim.id,
      claimText: claim.claimText,
      status: claim.status,
      asOf: claim.asOf,
      createdBy: claim.createdBy,
      createdAt: claim.createdAt,
    })
    .from(claim)
    .where(eq(claim.lineageId, lineageId))
    .orderBy(asc(claim.createdAt), asc(claim.id))
  const versionIds = versionRows.map((v) => v.id)
  // supersede 链：哪些版本被某新版取代（=作为 supersedes 边的 to 端出现）。沿这些 to 端标 superseded。
  const supRows = versionIds.length
    ? await db
        .select({ to: relation.toClaim })
        .from(relation)
        .where(and(eq(relation.type, 'supersedes'), inArray(relation.toClaim, versionIds)))
    : []
  const supersededIds = new Set<string>()
  for (const r of supRows) if (r.to != null) supersededIds.add(r.to)
  const versions: LineageVersion[] = versionRows.map((v) => ({
    claimId: v.id,
    claimText: v.claimText,
    status: v.status,
    asOf: v.asOf,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    superseded: supersededIds.has(v.id),
  }))

  return { claimId, lineageId, provenances, citingPages, versions }
}
