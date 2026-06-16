/**
 * f1 humanReview 生产者（命门 A.3，**最后一个休眠因子**）—— 主编三动作（Approve/Edit-Approve/Reject）
 * 与命门(f1 humanReview)之间的缝。镜像 S17 f2 entailment（patrol-verdict.ts）/ S19 f4 usageCorrect。
 *
 * 数据源（A.3 七因子表 f1 行）：`claim_verification(kind='patrol', by_role='human:<id>')`。主编的人审背书与
 * Verifier 的 entailment 巡查**共用** kind='patrol' 通道，但落不同字段、由不同 by_role 产出：
 *   - 人审行：verdict 带 `humanReview` 标量（Approve→1 / Reject→0），by_role 必是人（'human…'）。
 *   - entailment 行（S17）：verdict 带 `entailment` 三态，by_role 是 Verifier。
 * 两类行用 verdict 里的字段判别，互不串读（f1 只读带 humanReview 的行；f2 只读带 entailment 的行）。
 *
 * f1 映射（A.3）：
 *   Approve      → 1.0（人审背书拉满，最高单位权重因子）
 *   Reject       → 0.0（人审否决，压到地板；同时是一次收紧性 review）
 *   无任何人审    → NEUTRAL_FACTORS.humanReview = 0（「人审未发生」中性，与 A.3 一致）
 * 取一条 claim **最新**一条人审行为准（append-only，多次人审留多行，最新覆盖语义同 f2/f4）。
 *
 * 纯读、确定性。在因子装配处（computeConfidenceFromProvenances，**单一标注点**）与召回 live-override 各调一次，
 * 与 S17 f2 / S19 f4 同款实时口径（不吃写时快照、反映最新人审）。editor-action.ts 是它的写入外壳。
 */
import { randomUUID } from 'node:crypto'

import { and, desc, eq, inArray } from 'drizzle-orm'

import { NEUTRAL_FACTORS } from '../confidence/confidence.js'
import type { DB, Tx } from '../db/client.js'
import { claimVerification } from '../db/schema.js'
import type { ActorContext } from '../spi/actor.js'
import { isHumanRole } from '../spi/reflux.js'

/** DB 或事务 Tx（recall 用前者、commit 合并重算用后者；drizzle select 链在两者上同形）。 */
type Queryable = DB | Tx

/** Approve 的 f1 值：人审背书拉满（A.3「最高单位权重因子」/ 设计稿 FIG「Approve · endorse 1.0」）。 */
export const HUMAN_REVIEW_APPROVE = 1
/** Reject 的 f1 值：人审否决压到地板（设计稿 FIG「Reject · 0.0」）。 */
export const HUMAN_REVIEW_REJECT = 0

/**
 * 人审行落库的 verdict jsonb 形状（claim_verification.verdict）。**带 humanReview 标量即判为人审行**——
 * 这是它与 entailment 巡查行（带 entailment 字段）在共用 kind='patrol' 通道上的判别位。
 */
export interface HumanReviewVerdict {
  /** f1 因子值：Approve→1 / Reject→0（A.3 加性因子，归一到 [0,1]）。 */
  humanReview: number
  /** 主编动作（approve / edit_approve / reject），可审计/离线分析用，不另进计分（计分只看 humanReview 标量）。 */
  action?: 'approve' | 'edit_approve' | 'reject'
  /** 人类可读备注（如 Edit-Approve 的修订理由 / Reject 的驳回理由）。 */
  note?: string
}

function isHumanReviewVerdict(v: unknown): v is HumanReviewVerdict {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { humanReview?: unknown }).humanReview === 'number'
  )
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/**
 * 落一条人审背书（claim_verification, kind='patrol'，带 humanReview 字段）。授权**只读受信 `actor.isHuman`**
 * （EGR-CR-002）——f1 是「只人能投」的因子，非人 actor 一律拒，且 agent 把 role 写成 'human:fake' 也抬不了权
 * （红线#2：只人能放松；人审背书亦只人可投）。落库 by_role 仍写 `actor.role`（审计字段不变）。
 * append-only，多次人审各留一行；最新一行由 latestHumanReview 取。
 */
export async function writeHumanReview(
  q: Queryable,
  opts: { claimId: string; actor: ActorContext; verdict: HumanReviewVerdict },
): Promise<{ verificationId: string }> {
  if (!opts.actor.isHuman) {
    throw new Error(
      `writeHumanReview: human review must be cast by a human caller (actor '${opts.actor.role}' is not human)`,
    )
  }
  const id = randomUUID()
  await q.insert(claimVerification).values({
    id,
    claimId: opts.claimId,
    kind: 'patrol',
    verdict: { ...opts.verdict, humanReview: clamp01(opts.verdict.humanReview) },
    byRole: opts.actor.role,
  })
  return { verificationId: id }
}

/**
 * 取一条 claim **最新**一条人审行的 humanReview 标量。无人审 → null（调用方退回 NEUTRAL_FACTORS.humanReview=0）。
 * 只看带 humanReview 字段的 patrol 行（entailment 巡查行被天然过滤，不串读）。接受 DB 或 Tx。
 */
export async function latestHumanReview(q: Queryable, claimId: string): Promise<number | null> {
  const rows = await q
    .select({ verdict: claimVerification.verdict, byRole: claimVerification.byRole })
    .from(claimVerification)
    .where(and(eq(claimVerification.kind, 'patrol'), eq(claimVerification.claimId, claimId)))
    .orderBy(desc(claimVerification.createdAt), desc(claimVerification.id))
  for (const r of rows) {
    // 倒序扫：取第一条「带 humanReview 字段 且 由人产出」的行（=最新人审）；entailment 行跳过，不让它压住人审。
    if (isHumanReviewVerdict(r.verdict) && isHumanRole(r.byRole)) {
      return clamp01(r.verdict.humanReview)
    }
  }
  return null
}

/**
 * 命门 f1 接线：读一条 claim 最新人审 → humanReview 因子值。无人审退回中性 0。
 * 在因子装配处（computeConfidenceFromProvenances，单一标注点）与召回 live-override 各调一次（与 f2/f4 同一标注点）。
 */
export async function computeHumanReviewFactor(q: Queryable, claimId: string): Promise<number> {
  const v = await latestHumanReview(q, claimId)
  return v ?? NEUTRAL_FACTORS.humanReview
}

/**
 * 批量读多条 claim 各自最新人审的 **f1 humanReview 因子值**（召回路径用：一次查回所有候选，避免 N 次往返）。
 * 返回 Map<claimId, factor>；**只有有人审行的 claim 入 Map**（无人审 → 不入，调用方沿用存档/中性，
 * 与 latestEntailmentFactors / latestUsageCorrectFactors 同口径：无信号不覆盖）。倒序逐 claim 取首条人审行（=最新）。
 */
export async function latestHumanReviewFactors(
  db: DB,
  claimIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (claimIds.length === 0) return out
  const rows = await db
    .select({
      claimId: claimVerification.claimId,
      verdict: claimVerification.verdict,
      byRole: claimVerification.byRole,
    })
    .from(claimVerification)
    .where(and(eq(claimVerification.kind, 'patrol'), inArray(claimVerification.claimId, claimIds)))
    .orderBy(desc(claimVerification.createdAt), desc(claimVerification.id))
  for (const r of rows) {
    if (out.has(r.claimId)) continue // 已倒序：每个 claim 第一次见到的人审行即最新
    if (isHumanReviewVerdict(r.verdict) && isHumanRole(r.byRole)) {
      out.set(r.claimId, clamp01(r.verdict.humanReview))
    }
  }
  return out
}
