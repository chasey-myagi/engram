/**
 * 主编三动作（S22，PRD User Stories 12/13/14 + 设计稿 §7「人即主编」）—— 人的红边，**唯一**能放松 claim 态的路。
 * 全部表达成 **confidence 因子移动（投 f1 humanReview）**，绝不直接写 status：status 由门限/状态机重算
 * （界面纪律与内核不变量同构，Story 13）。三动作都 **append-only**，永不原地改事实（Story 12）。
 *
 *   Approve（背书）：投 f1=1（拉满人审因子）。draft 则人 Approve 旁路晋升门 → active（A.4「或人 Approve」）；
 *     quarantined/flagged/superseded 则是**放松**（解隔离/赦免/回滚，仅人）→ 记一条 human_overturn 翻案痕 + 放松到 active。
 *   Edit-Approve（改后背书）：**先 append 新版本**（supersedeClaim：同 lineage_id、旧版标 superseded、不物理删），
 *     **再** Approve 新版本（投 f1=1 + 晋升）。绝不原地改旧版（Story 12）。
 *   Reject（驳回）：投 f1=0（人审否决，压低 f1，是一次**收紧**性 review）→ 尽量收紧到 quarantined（保留可审计，永不物理删）。
 *     驳回一条 agent 已晋升（active）的 claim = 翻案 agent 判决 → 记一条 human_overturn。
 *
 * 红线#2「只人能放松」：放松全程走 transitionClaim 红边（内核硬执行人专属），agent 调本模块的放松动作会在那里被拒。
 * f1 本身也只人能投（writeHumanReview 校验 by_role 必是人）。本模块只编排既有缝（human-review.ts / transition.ts /
 * append-claim.ts / human-overturn.ts），不新开状态/不碰 schema 不变量。
 */
import { eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import { claim, type ClaimStatus } from '../db/schema.js'
import { supersedeClaim, type DraftClaim, type ProvenanceInput } from '../spi/append-claim.js'
import { transitionClaim } from '../spi/transition.js'
import { isHumanRole } from '../spi/reflux.js'
import { writeHumanReview, HUMAN_REVIEW_APPROVE, HUMAN_REVIEW_REJECT } from './human-review.js'
import { recordHumanOverturn, type OverturnKind } from './human-overturn.js'

/** 主编动作的调用上下文。by 必是人（'human…' / 裸 'human'）——三动作都只人可做。 */
export interface EditorActorContext {
  /** 主编身份（'human:<id>'）。非人调用直接拒（红线#2）。 */
  by: string
  /** 人类可读备注（可选，落人审 verdict.note / 翻案 reason，离线审计用）。 */
  note?: string
}

/** 主编动作结果：被作用的 claim、最终状态、人审 verificationId、（若发生翻案）翻案事件 id。 */
export interface EditorActionResult {
  /** 被作用（背书/驳回）的 claim id。Edit-Approve 时是**新版本**的 id。 */
  claimId: string
  /** 该 claim 动作后的状态（由状态机重算，不是动作直接写的）。 */
  status: ClaimStatus
  /** 本次投下的人审行 id（f1 producer 落的 claim_verification 行）。 */
  verificationId: string
  /** 若本动作翻案了 agent 的判决（放松/驳回 agent 晋升），翻案事件 id；否则 undefined。 */
  overturnEventId?: string
}

function requireHuman(by: string, action: string): void {
  if (!isHumanRole(by)) {
    throw new Error(`editor:${action}: only a human caller may act (by '${by}' is not human)`)
  }
}

async function statusOf(db: DB, claimId: string): Promise<ClaimStatus> {
  const [row] = await db.select({ status: claim.status }).from(claim).where(eq(claim.id, claimId))
  if (!row) throw new Error(`editor: claim ${claimId} not found`)
  return row.status
}

/**
 * Approve（背书）一条 claim：投 f1=1，再按当前态把 status 推到 active（由状态机驱动，非直接写）。
 *   - draft       → 人 Approve 旁路晋升门 → active（A.4）。
 *   - quarantined → 解隔离（放松，仅人）→ active + 记 un_quarantine 翻案痕（S26 falseQuarantineRate 主信号）。
 *   - flagged     → 赦免（放松，仅人）→ active + 记 pardon 翻案痕。
 *   - superseded  → 回滚（放松，仅人）→ active + 记 rollback 翻案痕。
 *   - active      → 已是 active，只补背书（无状态迁移、不记翻案）。
 * 放松全程经 transitionClaim 红边（内核硬执行人专属）。背书与状态翻转分两步但均 fail-loud（任一抛即整体失败）。
 */
export async function approveClaim(
  db: DB,
  claimId: string,
  ctx: EditorActorContext,
): Promise<EditorActionResult> {
  requireHuman(ctx.by, 'approve')
  const from = await statusOf(db, claimId)

  // ① 投 f1=1 人审背书（append-only 人审行）。
  const { verificationId } = await writeHumanReview(db, {
    claimId,
    byRole: ctx.by,
    verdict: {
      humanReview: HUMAN_REVIEW_APPROVE,
      action: 'approve',
      ...(ctx.note !== undefined ? { note: ctx.note } : {}),
    },
  })

  // ② 按当前态把 status 推到 active（状态机重算；放松走红边、人专属）。
  let overturnEventId: string | undefined
  if (from === 'active') {
    // 已 active：纯补背书，无迁移、无翻案。
    return { claimId, status: 'active', verificationId }
  }
  if (from === 'draft') {
    // 人 Approve 旁路晋升门（A.4「或人 Approve」）。非翻案（draft 是影子区、未被 agent 判过）。
    await transitionClaim(db, claimId, 'active', { by: ctx.by })
    return { claimId, status: 'active', verificationId }
  }
  // quarantined/flagged/superseded：放松 = 翻案 agent 判决。同一逻辑动作里：记翻案痕 + 红边放松到 active。
  const overturn: OverturnKind =
    from === 'quarantined' ? 'un_quarantine' : from === 'flagged' ? 'pardon' : 'rollback'
  const ov = await recordHumanOverturn(db, {
    overturn,
    claimId,
    fromStatus: from,
    toStatus: 'active',
    byRole: ctx.by,
    ...(ctx.note !== undefined ? { reason: ctx.note } : {}),
  })
  overturnEventId = ov.eventId
  await transitionClaim(db, claimId, 'active', { by: ctx.by }) // 红边放松（仅人）；agent 调到这里会被拒
  return { claimId, status: 'active', verificationId, overturnEventId }
}

/**
 * Edit-Approve（改后背书）：**先 append 新版本**（supersedeClaim：同 lineage_id + supersedes 边、旧版标 superseded、
 * 不物理删，谱系保留），**再** Approve 新版本（投 f1=1 + 人 Approve 晋升到 active）。绝不原地改旧版（Story 12 append-only）。
 * 新版本继承一套**全新出处**（编辑必带出处，D1 强制 ≥1）。返回的 claimId 是**新版本**。
 */
export async function editApproveClaim(
  db: DB,
  embedder: Embedder,
  oldClaimId: string,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
  ctx: EditorActorContext,
): Promise<EditorActionResult> {
  requireHuman(ctx.by, 'edit_approve')
  // ① append 新版本（旧版 → superseded，不删；新版起在 draft）。supersedeClaim 强制 ≥1 出处（D1）。
  const { claimId: newId } = await supersedeClaim(db, embedder, oldClaimId, draft, provenances)
  // ② Approve 新版本：投 f1=1（标 edit_approve）+ 人 Approve 晋升门旁路 → active。
  const { verificationId } = await writeHumanReview(db, {
    claimId: newId,
    byRole: ctx.by,
    verdict: {
      humanReview: HUMAN_REVIEW_APPROVE,
      action: 'edit_approve',
      ...(ctx.note !== undefined ? { note: ctx.note } : {}),
    },
  })
  await transitionClaim(db, newId, 'active', { by: ctx.by }) // 人 Approve 旁路晋升门
  return { claimId: newId, status: 'active', verificationId }
}

/**
 * Reject（驳回）：投 f1=0（人审否决，压低 f1——这是一次**收紧**性 review），再尽量把 status 收紧到 quarantined
 * （保留可审计，永不物理删）。按当前态走合法蓝边（人也可收紧）：
 *   - active   → flagged → quarantined（驳回一条 agent 已晋升的 claim = 翻案 → 记 reject_agent_promoted 翻案痕）。
 *   - flagged  → quarantined。
 *   - quarantined → 已是 quarantined，只补否决（无迁移）。
 *   - draft    → 留在 draft（A.4 无 draft→quarantined 合法边；f1=0 保证它永不越晋升门、长留影子区、可审计）。
 *   - superseded → 留在 superseded（已是终态旧版，f1=0 否决留痕）。
 * Reject 永远只收紧、绝不放松（红线#2 天然守住：它压 f1、推向 quarantined，从不调红边）。
 */
export async function rejectClaim(
  db: DB,
  claimId: string,
  ctx: EditorActorContext,
): Promise<EditorActionResult> {
  requireHuman(ctx.by, 'reject')
  const from = await statusOf(db, claimId)

  // ① 投 f1=0 人审否决（append-only）。
  const { verificationId } = await writeHumanReview(db, {
    claimId,
    byRole: ctx.by,
    verdict: {
      humanReview: HUMAN_REVIEW_REJECT,
      action: 'reject',
      ...(ctx.note !== undefined ? { note: ctx.note } : {}),
    },
  })

  // ② 尽量收紧到 quarantined（合法蓝边；人也可收紧）。
  let overturnEventId: string | undefined
  if (from === 'active') {
    // 驳回 agent 已晋升的 claim = 翻案 agent 判决 → 记翻案痕，再 active→flagged→quarantined。
    const ov = await recordHumanOverturn(db, {
      overturn: 'reject_agent_promoted',
      claimId,
      fromStatus: 'active',
      toStatus: 'quarantined',
      byRole: ctx.by,
      ...(ctx.note !== undefined ? { reason: ctx.note } : {}),
    })
    overturnEventId = ov.eventId
    await transitionClaim(db, claimId, 'flagged', { by: ctx.by })
    await transitionClaim(db, claimId, 'quarantined', { by: ctx.by })
    return { claimId, status: 'quarantined', verificationId, overturnEventId }
  }
  if (from === 'flagged') {
    await transitionClaim(db, claimId, 'quarantined', { by: ctx.by })
    return { claimId, status: 'quarantined', verificationId }
  }
  // quarantined/draft/superseded：无更紧的合法迁移可走，f1=0 否决留痕已足（draft 影子区永不召回、可审计）。
  return { claimId, status: from, verificationId }
}
