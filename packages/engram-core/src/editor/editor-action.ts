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

import { getActiveStandards } from '../config/standards.js'
import type { DB, Tx } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import { claim, type ClaimStatus } from '../db/schema.js'
import { supersedeClaimInTx, type DraftClaim, type ProvenanceInput } from '../spi/append-claim.js'
import { transitionClaimInTx } from '../spi/transition.js'
import type { ActorContext } from '../spi/actor.js'
import { writeHumanReview, HUMAN_REVIEW_APPROVE, HUMAN_REVIEW_REJECT } from './human-review.js'
import { recordHumanOverturn, type OverturnKind } from './human-overturn.js'

/** 主编动作的调用上下文。actor 必是受信的人（trustedHumanActor）——三动作都只人可做。 */
export interface EditorActorContext {
  /** 主编身份（受信边界）。actor.isHuman=false（含 role 伪装成 'human:fake' 的 agentActor）直接拒（红线#2）。 */
  actor: ActorContext
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

function requireHuman(actor: ActorContext, action: string): void {
  if (!actor.isHuman) {
    throw new Error(
      `editor:${action}: only a human caller may act (by '${actor.role}' is not human)`,
    )
  }
}

/**
 * 事务内锁定并读取 claim 当前状态（FOR UPDATE）。据当前态决定动作分支必须在「同一事务」里锁着读——
 * 消除未锁读的 TOCTOU：并发同一 claim 的 Approve 不再各自读到旧态、各记一条 spurious 翻案（第二个会阻塞到第一个提交后
 * 读到新态、走「已 active 纯补背书」分支，绝不重复记 un_quarantine 污染 S26 falseQuarantineRate）。
 */
async function lockClaimStatus(tx: Tx, claimId: string): Promise<ClaimStatus> {
  const [row] = await tx
    .select({ status: claim.status })
    .from(claim)
    .where(eq(claim.id, claimId))
    .for('update')
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
 * **原子绑定（一个事务）**：FOR UPDATE 锁行读态 → 投 f1 人审 → （放松/晋升）状态翻转 → **翻转成功之后**才落翻案痕。
 * 任一步抛 → 整事务回滚（绝不留下与真实状态矛盾的孤儿翻案事件；并发也不重复记痕）。放松经红边、内核硬执行人专属。
 */
export async function approveClaim(
  db: DB,
  claimId: string,
  ctx: EditorActorContext,
): Promise<EditorActionResult> {
  requireHuman(ctx.actor, 'approve')
  const std = await getActiveStandards(db) // 配置快照（promote 蓝边判据用；人放松不读它）。事务外读即可。
  return db.transaction(async (tx): Promise<EditorActionResult> => {
    const from = await lockClaimStatus(tx, claimId) // 锁行读态：分支决策不再 TOCTOU
    // ① 投 f1=1 人审背书（append-only 人审行，同事务内）。
    const { verificationId } = await writeHumanReview(tx, {
      claimId,
      actor: ctx.actor,
      verdict: {
        humanReview: HUMAN_REVIEW_APPROVE,
        action: 'approve',
        ...(ctx.note !== undefined ? { note: ctx.note } : {}),
      },
    })
    // ② 按当前态把 status 推到 active（状态机重算；放松走红边、人专属）。
    if (from === 'active') {
      return { claimId, status: 'active', verificationId } // 已 active：纯补背书，无迁移、无翻案
    }
    if (from === 'draft') {
      // 人 Approve 旁路晋升门（A.4「或人 Approve」）。非翻案（draft 是影子区、未被 agent 判过）。
      await transitionClaimInTx(tx, claimId, 'active', { actor: ctx.actor }, std)
      return { claimId, status: 'active', verificationId }
    }
    // quarantined/flagged/superseded：放松 = 翻案 agent 判决。**先红边翻转成功、再落翻案痕**（同事务原子）。
    const overturn: OverturnKind =
      from === 'quarantined' ? 'un_quarantine' : from === 'flagged' ? 'pardon' : 'rollback'
    await transitionClaimInTx(tx, claimId, 'active', { actor: ctx.actor }, std) // 红边放松（仅人）；agent 到这里被拒
    const ov = await recordHumanOverturn(tx, {
      overturn,
      claimId,
      fromStatus: from,
      toStatus: 'active',
      byRole: ctx.actor.role,
      ...(ctx.note !== undefined ? { reason: ctx.note } : {}),
    })
    return { claimId, status: 'active', verificationId, overturnEventId: ov.eventId }
  })
}

/**
 * Edit-Approve（改后背书）：**先 append 新版本**（supersede：同 lineage_id + supersedes 边、旧版标 superseded、
 * 不物理删，谱系保留），**再** Approve 新版本（投 f1=1 + 人 Approve 晋升到 active）。绝不原地改旧版（Story 12 append-only）。
 * 新版本继承一套**全新出处**（编辑必带出处，D1 强制 ≥1）。返回的 claimId 是**新版本**。
 * **原子绑定（一个事务）**：supersede + f1 人审 + 晋升绑进同一事务——任一步抛则整体回滚，绝不留下半截谱系
 * （旧版已 superseded、新版卡 draft、事实静默掉出召回）。嵌入在事务外先算（不持锁做远程嵌入）。
 */
export async function editApproveClaim(
  db: DB,
  embedder: Embedder,
  oldClaimId: string,
  draft: DraftClaim,
  provenances: ProvenanceInput[],
  ctx: EditorActorContext,
): Promise<EditorActionResult> {
  requireHuman(ctx.actor, 'edit_approve')
  const std = await getActiveStandards(db)
  const embedding = await embedder.embed(draft.claimText, 'document') // 事务外算嵌入
  return db.transaction(async (tx): Promise<EditorActionResult> => {
    // ① append 新版本（旧版 → superseded，不删；新版起在 draft）。supersedeClaimInTx 强制 ≥1 出处（D1）。
    const { claimId: newId } = await supersedeClaimInTx(
      tx,
      oldClaimId,
      draft,
      provenances,
      embedding,
      embedder.version,
    )
    // ② Approve 新版本：投 f1=1（标 edit_approve）+ 人 Approve 晋升门旁路 → active。同事务原子。
    const { verificationId } = await writeHumanReview(tx, {
      claimId: newId,
      actor: ctx.actor,
      verdict: {
        humanReview: HUMAN_REVIEW_APPROVE,
        action: 'edit_approve',
        ...(ctx.note !== undefined ? { note: ctx.note } : {}),
      },
    })
    await transitionClaimInTx(tx, newId, 'active', { actor: ctx.actor }, std) // 人 Approve 旁路晋升门
    return { claimId: newId, status: 'active', verificationId }
  })
}

/**
 * Reject（驳回）：投 f1=0（人审否决，压低 f1——这是一次**收紧**性 review），再尽量把 status 收紧到 quarantined
 * （保留可审计，永不物理删）。按当前态走合法蓝边（人也可收紧）：
 *   - active   → flagged → quarantined（驳回一条 agent 已晋升的 claim = 翻案 → 记 reject_agent_promoted 翻案痕）。
 *   - flagged  → quarantined。
 *   - quarantined → 已是 quarantined，只补否决（无迁移）。
 *   - draft    → 留在 draft（A.4 无 draft→quarantined 合法边；f1=0 保证它永不越晋升门、长留影子区、可审计）。
 *   - superseded → 留在 superseded（已是终态旧版，f1=0 否决留痕）。
 * **原子绑定（一个事务）**：f1 否决 + 两段蓝边收紧 + 翻案痕绑进同一事务，**翻案痕在收紧成功之后**才落——
 * 第二段收紧若抛则整体回滚（不留 flagged 半截态 + 说 quarantined 的孤儿翻案）。
 * Reject 永远只收紧、绝不放松（红线#2 天然守住：它压 f1、推向 quarantined，从不调红边）。
 */
export async function rejectClaim(
  db: DB,
  claimId: string,
  ctx: EditorActorContext,
): Promise<EditorActionResult> {
  requireHuman(ctx.actor, 'reject')
  const std = await getActiveStandards(db)
  return db.transaction(async (tx): Promise<EditorActionResult> => {
    const from = await lockClaimStatus(tx, claimId)
    // ① 投 f1=0 人审否决（append-only，同事务内）。
    const { verificationId } = await writeHumanReview(tx, {
      claimId,
      actor: ctx.actor,
      verdict: {
        humanReview: HUMAN_REVIEW_REJECT,
        action: 'reject',
        ...(ctx.note !== undefined ? { note: ctx.note } : {}),
      },
    })
    // ② 尽量收紧到 quarantined（合法蓝边；人也可收紧）。翻案痕在收紧成功之后才落（同事务原子）。
    if (from === 'active') {
      // 驳回 agent 已晋升的 claim = 翻案 → 先 active→flagged→quarantined，**再**记翻案痕。
      await transitionClaimInTx(tx, claimId, 'flagged', { actor: ctx.actor }, std)
      await transitionClaimInTx(tx, claimId, 'quarantined', { actor: ctx.actor }, std)
      const ov = await recordHumanOverturn(tx, {
        overturn: 'reject_agent_promoted',
        claimId,
        fromStatus: 'active',
        toStatus: 'quarantined',
        byRole: ctx.actor.role,
        ...(ctx.note !== undefined ? { reason: ctx.note } : {}),
      })
      return { claimId, status: 'quarantined', verificationId, overturnEventId: ov.eventId }
    }
    if (from === 'flagged') {
      await transitionClaimInTx(tx, claimId, 'quarantined', { actor: ctx.actor }, std)
      return { claimId, status: 'quarantined', verificationId }
    }
    // quarantined/draft/superseded：无更紧的合法迁移可走，f1=0 否决留痕已足（draft 影子区永不召回、可审计）。
    return { claimId, status: from, verificationId }
  })
}
