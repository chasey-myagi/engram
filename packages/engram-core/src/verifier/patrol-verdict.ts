/**
 * D3 巡查裁决的落库 / 读出 / f2 映射（S17）—— Verifier(judge) 与命门(f2 entailment) 之间的缝。
 *
 * - writePatrolVerdict：把一次 entailment 巡查结果落成 claim_verification(kind='patrol', by_role=verifier 角色)。
 *   judge≠athlete：by_role 是 Verifier 的判官身份，与产出 claim 的 athlete(created_by) 不同。append-only，多轮巡查留多行。
 * - latestPatrolVerdict：取一条 claim **最新**一条 patrol 裁决（按 createdAt/id 倒序）。无则 null。
 * - computeEntailmentFactor：把最新 patrol 裁决映射成 f2 entailment 因子（命门 A.3）：
 *     pass        → 1.0（出处可推导，抬 f2）
 *     fail        → 0.0（疑似幻觉，压 f2）
 *     not_co_true → 0.0（与他 claim 不可同真，按未支撑压 f2；冲突另记信号交 Arbiter）
 *     无 patrol   → 0.5（NEUTRAL_FACTORS.entailment，「未跑过」中性）
 *   纯读、确定性；在因子装配处（commit-time 与 recall-time）各调用一次，让 f2 反映最新巡查结果。
 */
import { randomUUID } from 'node:crypto'

import { and, desc, eq, inArray } from 'drizzle-orm'

import { NEUTRAL_FACTORS } from '../confidence/confidence.js'
import type { DB, Tx } from '../db/client.js'
import { claimVerification } from '../db/schema.js'
import type { EntailmentVerdict } from './entailment-judge.js'

/** patrol 裁决落库的 verdict jsonb 形状（claim_verification.verdict）。entailment 是 A.6 三态。 */
export interface PatrolVerdict {
  /** entailment 三态：pass | fail | not_co_true（A.6）。 */
  entailment: EntailmentVerdict
  /** 触发本次巡查的原因（low_conf / conflict / stale / draft / flagged …），离线分析用，不进计分。 */
  reason?: string
  /** not_co_true 时记下不可同真的对端 claim（conflict 信号，交 Arbiter S20；本切片只记不裁）。 */
  conflictsWith?: string
  /** 判官版本（可审计：哪个模型/版本判的）。 */
  judgeVersion?: string
}

/** DB 或事务 Tx（recall 用前者、commit 合并重算用后者；drizzle select 链在两者上同形）。 */
type Queryable = DB | Tx

/**
 * 落一条 patrol 裁决（claim_verification, kind='patrol'）。by_role = Verifier 判官身份（judge≠athlete）。
 * append-only，多轮巡查各留一行；最新一行由 latestPatrolVerdict 取。
 */
export async function writePatrolVerdict(
  q: Queryable,
  opts: { claimId: string; byRole: string; verdict: PatrolVerdict },
): Promise<{ verificationId: string }> {
  const id = randomUUID()
  await q.insert(claimVerification).values({
    id,
    claimId: opts.claimId,
    kind: 'patrol',
    verdict: opts.verdict,
    byRole: opts.byRole,
  })
  return { verificationId: id }
}

/**
 * 取一条 claim 最新一条 **entailment** 巡查裁决的 entailment 态。无 entailment 巡查 → null。
 * 接受 DB 或 Tx（recall 用前者、commit 合并重算用后者）。
 *
 * S22：kind='patrol' 通道与主编人审（f1，verdict 带 humanReview、无 entailment）共用，故倒序逐行扫、
 * 取第一条**带 entailment 字段**的行（=最新 entailment 巡查）——人审行被天然跳过，绝不让一次人审 Approve/Reject
 * 把已有的 entailment 巡查结果误清成 null（f1/f2 各读各的字段，互不串读）。
 */
export async function latestPatrolVerdict(
  q: Queryable,
  claimId: string,
): Promise<EntailmentVerdict | null> {
  const rows = await q
    .select({ verdict: claimVerification.verdict, createdAt: claimVerification.createdAt })
    .from(claimVerification)
    .where(and(eq(claimVerification.kind, 'patrol'), eq(claimVerification.claimId, claimId)))
    .orderBy(desc(claimVerification.createdAt), desc(claimVerification.id))
  for (const r of rows) {
    const v = r.verdict as Partial<PatrolVerdict> | null
    const e = v?.entailment
    if (e === 'pass' || e === 'fail' || e === 'not_co_true') return e
  }
  return null
}

/** entailment 三态 → f2 因子值（确定性映射，命门 A.3）。无裁决用中性 0.5。 */
export function entailmentVerdictToFactor(verdict: EntailmentVerdict | null): number {
  switch (verdict) {
    case 'pass':
      return 1
    case 'fail':
    case 'not_co_true':
      return 0
    default:
      // 未跑过巡查：中性（A.3「entail 未跑=0.5」，与 NEUTRAL_FACTORS 单一真相源）。
      return NEUTRAL_FACTORS.entailment
  }
}

/**
 * 命门 f2 接线：读一条 claim 最新 patrol 裁决 → 映射成 entailment 因子值。
 * 在因子装配处（computeConfidenceFromProvenances）与召回重算处各调一次（**单一标注点**）。
 * 没有 claimId（如 appendClaim 新建、claim 尚不存在）的场景由调用方退回 NEUTRAL_FACTORS.entailment，不调本函数。
 */
export async function computeEntailmentFactor(q: DB | Tx, claimId: string): Promise<number> {
  return entailmentVerdictToFactor(await latestPatrolVerdict(q, claimId))
}

/**
 * 批量读多条 claim 各自最新 patrol 裁决的 **f2 entailment 因子值**（召回路径用：一次查回所有候选，避免 N 次往返）。
 * 返回 Map<claimId, factor>；某 claim 无 patrol 则不入 Map（调用方退回存档值/中性）。
 * createdAt/id 倒序排序后逐 claim 取首条（=最新），保证与 latestPatrolVerdict 同口径。
 */
export async function latestEntailmentFactors(
  db: DB,
  claimIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (claimIds.length === 0) return out
  const rows = await db
    .select({
      claimId: claimVerification.claimId,
      verdict: claimVerification.verdict,
    })
    .from(claimVerification)
    .where(and(eq(claimVerification.kind, 'patrol'), inArray(claimVerification.claimId, claimIds)))
    .orderBy(desc(claimVerification.createdAt), desc(claimVerification.id))
  for (const r of rows) {
    if (out.has(r.claimId)) continue // 已倒序：每个 claim 第一次见到的即最新一条
    const v = r.verdict as Partial<PatrolVerdict> | null
    const e = v?.entailment
    if (e === 'pass' || e === 'fail' || e === 'not_co_true') {
      out.set(r.claimId, entailmentVerdictToFactor(e))
    }
  }
  return out
}
