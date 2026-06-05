/**
 * Reconciler 的冲突/投毒升级信号 SPI（S18）—— 补 S17 留下的「关系性 conflict 信号」空位。
 *
 * 由来（路由自 S17）：Verifier 是**单条** claim 判官，判不出「与哪条对端 claim 不可同真」，故 S17 的
 * PatrolVerdict.conflictsWith 字段留空、未被填。Reconciler 是**成对**比较的工种 —— 它是这条关系性 conflict
 * 信号的正主：识别出 near-dup-poison 时，把**对端 claim id**记进信号，交 Arbiter(S20) 消费。
 *
 * 不开新表（A.1 schema FROZEN）：复用 claim_verification(kind='patrol')，沿 writePatrolVerdict 的缝落库
 * （judge≠athlete：by_role=reconciler 角色）。entailment 记 'not_co_true'（A 与对端不可同真，f2→0，保守压低
 * 被投毒 claim 的置信，与 Verifier 的 conflict 同口径），conflictsWith=对端 id，reason 标 'near_dup_poison'。
 * append-only，Arbiter 凭 conflictsWith 把这对拉出来裁（本切片只记不裁，红线：agent 只收紧不放松）。
 */
import { and, desc, eq } from 'drizzle-orm'

import type { DB, Tx } from '../db/client.js'
import { claimVerification } from '../db/schema.js'
import { writePatrolVerdict, type PatrolVerdict } from '../verifier/patrol-verdict.js'

/** Reconciler 升级信号在 patrol 裁决里的 reason 标记（离线/Arbiter 按它筛 Reconciler 的 conflict 行）。 */
export const RECONCILE_POISON_REASON = 'near_dup_poison' as const

/** 一条 Reconciler 升级信号的读出形状（Arbiter S20 消费口）。 */
export interface ReconcileEscalation {
  verificationId: string
  /** 被疑投毒、被 flag 的 claim（A，新/被审）。 */
  claimId: string
  /** 不可同真的对端 claim（B，既有/锚）—— S17 留空、S18 填上的关系性 conflict 信号。 */
  conflictsWith: string
  byRole: string
  createdAt: Date
}

/**
 * 记一条 Reconciler 的 near-dup-poison 升级信号：把对端 id 写进 PatrolVerdict.conflictsWith。
 * 复用 writePatrolVerdict（无新表），by_role=Reconciler 角色（judge≠athlete）。append-only。
 */
export async function recordReconcileEscalation(
  q: DB | Tx,
  opts: { claimId: string; conflictsWith: string; byRole: string; judgeVersion?: string },
): Promise<{ verificationId: string }> {
  const verdict: PatrolVerdict = {
    // A 与对端不可同真（object 被改小/反向）→ 按 conflict 压 f2，保守收紧（与 Verifier not_co_true 同口径）。
    entailment: 'not_co_true',
    reason: RECONCILE_POISON_REASON,
    conflictsWith: opts.conflictsWith,
    ...(opts.judgeVersion != null ? { judgeVersion: opts.judgeVersion } : {}),
  }
  return writePatrolVerdict(q, { claimId: opts.claimId, byRole: opts.byRole, verdict })
}

/**
 * 读 Reconciler 落下的、带对端 id 的升级信号（最新在前）。Arbiter(S20) 取数口；测试断言「带 peer id 已记」。
 * 只取 kind='patrol' ∧ verdict.reason='near_dup_poison' ∧ conflictsWith 非空 的行。
 */
export async function getReconcileEscalations(
  db: DB,
  claimId?: string,
): Promise<ReconcileEscalation[]> {
  const rows = await db
    .select({
      id: claimVerification.id,
      claimId: claimVerification.claimId,
      verdict: claimVerification.verdict,
      byRole: claimVerification.byRole,
      createdAt: claimVerification.createdAt,
    })
    .from(claimVerification)
    .where(
      claimId != null
        ? and(eq(claimVerification.kind, 'patrol'), eq(claimVerification.claimId, claimId))
        : eq(claimVerification.kind, 'patrol'),
    )
    .orderBy(desc(claimVerification.createdAt), desc(claimVerification.id))
  const out: ReconcileEscalation[] = []
  for (const r of rows) {
    const v = (r.verdict ?? {}) as Partial<PatrolVerdict>
    if (v.reason !== RECONCILE_POISON_REASON) continue
    if (v.conflictsWith == null || v.conflictsWith === '') continue
    out.push({
      verificationId: r.id,
      claimId: r.claimId,
      conflictsWith: v.conflictsWith,
      byRole: r.byRole,
      createdAt: r.createdAt,
    })
  }
  return out
}
