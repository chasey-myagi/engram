/**
 * 用量回报（Consumer SPI 第三个动作，附录 A.2）—— 消费侧产出校准燃料。
 *
 * report_usage(db, claimId, outcome, ctx?) 追加**恰好一条** claim_verification(kind='usage_truth')：
 *   - verdict JSONB = { outcome, taskId, note }
 *   - by_role = 上报方身份（judge≠athlete 归因，红线）
 * 这是 append-only 的真值事件流，后续喂 f4（observed_correctness）与失败池。
 *
 * 刻意只**记事件**，绝不在此重算/改动 claim.confidence —— 升信/降信与回报解耦：
 * 真正把 usage_truth 统计成 f4 并重算的是 Harvester（S19），且须独立用户门控（防 Goodhart）。
 * corrected / refuted 两类事件即「失败池」，可枚举回流成回归集（S11）。
 */
import { randomUUID } from 'node:crypto'

import { and, asc, eq, sql } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { claim, claimVerification } from '../db/schema.js'

/** 消费结局四态（A.2）。 */
export const USAGE_OUTCOMES = ['adopted', 'corrected', 'refuted', 'partial'] as const
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number]

/** 失败池 = 这两类结局（claim 被用错/被推翻）。 */
export const FAILURE_OUTCOMES = ['corrected', 'refuted'] as const satisfies readonly UsageOutcome[]

export interface ReportUsageContext {
  /** 上报方身份（judge≠athlete 归因）。缺省记 'consumer:unknown'。 */
  byRole?: string
  /** 触发本次消费的任务 id（归因到具体任务）。 */
  taskId?: string
  /** 自由文本备注。 */
  note?: string
}

/** usage_truth 事件的读出形状（verdict JSONB 展平 + 列字段）。 */
export interface UsageEvent {
  id: string
  claimId: string
  outcome: UsageOutcome
  byRole: string
  taskId: string | null
  note: string | null
  createdAt: Date
}

/** claim_verification.verdict 对 usage_truth 的 JSONB 形状。 */
interface UsageVerdict {
  outcome: UsageOutcome
  taskId: string | null
  note: string | null
}

function isUsageOutcome(x: unknown): x is UsageOutcome {
  return typeof x === 'string' && (USAGE_OUTCOMES as readonly string[]).includes(x)
}

function toUsageEvent(row: typeof claimVerification.$inferSelect): UsageEvent {
  const verdict = row.verdict as UsageVerdict
  return {
    id: row.id,
    claimId: row.claimId,
    outcome: verdict.outcome,
    byRole: row.byRole,
    taskId: verdict.taskId ?? null,
    note: verdict.note ?? null,
    createdAt: row.createdAt,
  }
}

/**
 * 追加一条 usage_truth 事件。outcome 非法 / claimId 不存在 → 拒（不写入半条）。
 * 不动 claim.confidence（解耦）。返回新事件 id。
 */
export async function reportUsage(
  db: DB,
  claimId: string,
  outcome: UsageOutcome,
  ctx: ReportUsageContext = {},
): Promise<{ verificationId: string }> {
  if (!isUsageOutcome(outcome)) {
    throw new Error(
      `report_usage: invalid outcome "${outcome}" (expected one of ${USAGE_OUTCOMES.join(', ')})`,
    )
  }
  // 前置存在性检查：claimId 不存在直接拒、连 insert 都不发（claim_verification.claim_id 的 NOT NULL FK 是兜底）。
  const exists = await db.select({ id: claim.id }).from(claim).where(eq(claim.id, claimId)).limit(1)
  if (exists.length === 0) {
    throw new Error(`report_usage: claim ${claimId} not found`)
  }
  const id = randomUUID()
  const verdict: UsageVerdict = {
    outcome,
    taskId: ctx.taskId ?? null,
    note: ctx.note ?? null,
  }
  await db.insert(claimVerification).values({
    id,
    claimId,
    kind: 'usage_truth',
    verdict,
    byRole: ctx.byRole ?? 'consumer:unknown',
  })
  return { verificationId: id }
}

/** 枚举一条 claim 的全部 usage_truth 事件（append-only，按时间升序）。 */
export async function getUsageEvents(db: DB, claimId: string): Promise<UsageEvent[]> {
  const rows = await db
    .select()
    .from(claimVerification)
    .where(and(eq(claimVerification.claimId, claimId), eq(claimVerification.kind, 'usage_truth')))
    .orderBy(asc(claimVerification.createdAt), asc(claimVerification.id))
  return rows.map(toUsageEvent)
}

/**
 * 失败池：跨所有 claim 的 corrected / refuted 事件（用错 / 被推翻），按时间升序。
 * 这是 S11「生产失败回流成回归集」的取数口。
 */
export async function getFailurePool(db: DB): Promise<UsageEvent[]> {
  const rows = await db
    .select()
    .from(claimVerification)
    .where(
      and(
        eq(claimVerification.kind, 'usage_truth'),
        // verdict->>'outcome' ∈ 失败结局；常量内联无注入风险。
        sql`(${claimVerification.verdict} ->> 'outcome') in ('corrected', 'refuted')`,
      ),
    )
    .orderBy(asc(claimVerification.createdAt), asc(claimVerification.id))
  return rows.map(toUsageEvent)
}
