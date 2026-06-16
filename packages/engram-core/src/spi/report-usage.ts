/**
 * 用量回报（Consumer SPI 第三个动作，附录 A.2）—— 消费侧产出校准燃料。
 *
 * report_usage(db, claimId, outcome, ctx?) 追加**恰好一条** claim_verification(kind='usage_truth')：
 *   - verdict JSONB = { outcome, taskId, note, predictedConfidence, calibrationVersion }
 *   - by_role = 上报方身份（judge≠athlete 归因，红线）
 * 这是 append-only 的真值事件流，后续喂 f4（observed_correctness）与失败池。
 * predictedConfidence = 消费时所见的召回快照 conf.value（S5 校准燃料：预测概率与观测结局配对持久化，ECE 算它）。
 *
 * 刻意只**记事件**，绝不在此重算/改动 claim.confidence —— 升信/降信与回报解耦：
 * 真正把 usage_truth 统计成 f4 并重算的是 Harvester（S19），且须独立用户门控（防 Goodhart）。
 * corrected / refuted 两类事件即「失败池」，可枚举回流成回归集（S11）。
 */
import { randomUUID } from 'node:crypto'

import { and, asc, eq, sql } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { claim, claimVerification } from '../db/schema.js'
import { getRecallSnapshot } from './recall-snapshot.js'

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
  /**
   * 绑定本次消费的**一次真实 recall** 的快照 id（EGR-CR-003 方案 A）。给了即按 id 查 recall_snapshot：
   *   - 快照不存在 → 拒（伪造 / 未召回的 claim 上报，fail-loud，不写半条）；
   *   - 快照 by_role ≠ 本次上报 by_role → 拒（决策 c：杜绝 A 召回、B 冒名上报别人的预测）；
   *   - 否则用**表里的** value/calibrationVersion 写 usage_truth 的 predictedConfidence/calibrationVersion。
   * **caller 再也不能自报 confidence/version**——预测概率只能来自一次真实 recall 拍下的快照。
   * 不给 snapshotId（如纯 adopted/refuted 真值上报、不喂校准）→ predictedConfidence/calibrationVersion 记 null。
   */
  recallSnapshotId?: string
  /**
   * 触发本次消费的原始召回 query（消费方在 recall 时已知）。失败回流（S11）据此把池中失败**重放过 recall_claims**
   * 给当前行为打 pass/fail —— 没有它，refuted/corrected 事件就无法回放成活回归集。
   */
  query?: string
  /**
   * 人确认「KB 对这个问题压根没有正确答案」（不是某条 claim 错，而是该会的它不会）。
   * 仅当上报方是人（by_role 'human…' 前缀）时这条信号才被回流路由进 L5 缺口候选队列（S11），等 QA 晋升（S12）。
   */
  kbLacksAnswer?: boolean
  /**
   * 评测 run 的隔离标签（EGR-CR-060）：一次性可复用评测入口（如 runRealWorldEce）给本次写入的 usage_truth 打上
   * 同一个 run id，读端据此只收**本次 run** 的样本，不把库里历史/无关样本混进测量集。
   * **纯归因/隔离标签**——不参与 g 拟合、不进 collectUsageCalibrationSamples 的胜负率通道（A3 红线之外），缺省 null（向后兼容旧行）。
   */
  evalRunId?: string
}

/** usage_truth 事件的读出形状（verdict JSONB 展平 + 列字段）。 */
export interface UsageEvent {
  id: string
  claimId: string
  outcome: UsageOutcome
  byRole: string
  taskId: string | null
  note: string | null
  /** 召回瞬间预测概率（来自绑定的 recall_snapshot.value；无绑定则 null）。 */
  predictedConfidence: number | null
  /** 该预测值的 g 版本（来自绑定的 recall_snapshot.calibration_version；无绑定则 null）。 */
  calibrationVersion: string | null
  /** 绑定的真实 recall 快照 id（EGR-CR-003）；无绑定（裸行）则 null。 */
  recallSnapshotId: string | null
  /** 触发本次消费的原始召回 query（无则 null）—— S11 回放用。 */
  query: string | null
  /** 人确认「KB 压根没有正确答案」（缺省 false）—— S11 路由 L5 候选用。 */
  kbLacksAnswer: boolean
  /** 评测 run 隔离标签（EGR-CR-060）；无则 null —— 读端据此只收本次 run 样本。 */
  evalRunId: string | null
  createdAt: Date
}

/** claim_verification.verdict 对 usage_truth 的 JSONB 形状。 */
interface UsageVerdict {
  outcome: UsageOutcome
  taskId: string | null
  note: string | null
  predictedConfidence: number | null
  calibrationVersion: string | null
  recallSnapshotId: string | null
  query: string | null
  kbLacksAnswer: boolean
  evalRunId: string | null
}

function isUsageOutcome(x: unknown): x is UsageOutcome {
  return typeof x === 'string' && (USAGE_OUTCOMES as readonly string[]).includes(x)
}

function toUsageEvent(row: typeof claimVerification.$inferSelect): UsageEvent {
  // verdict 的形状由 kind 保证（两读函数都 eq(kind,'usage_truth')、写路径是唯一写者且校验过 outcome）。
  // 读侧再兜一道：万一未来有别的写者/手工行混入非法 outcome，这里 fail-loud，而不是吐出 outcome=undefined 的坏事件。
  const verdict = row.verdict as Partial<UsageVerdict>
  if (!isUsageOutcome(verdict.outcome)) {
    throw new Error(
      `report_usage: usage_truth row ${row.id} carries an invalid outcome ${JSON.stringify(verdict.outcome)}`,
    )
  }
  return {
    id: row.id,
    claimId: row.claimId,
    outcome: verdict.outcome,
    byRole: row.byRole,
    taskId: verdict.taskId ?? null,
    note: verdict.note ?? null,
    // 旧行/未带预测的行 → null（防御性读取，不假设字段存在）。
    predictedConfidence:
      typeof verdict.predictedConfidence === 'number' ? verdict.predictedConfidence : null,
    calibrationVersion:
      typeof verdict.calibrationVersion === 'string' ? verdict.calibrationVersion : null,
    recallSnapshotId:
      typeof verdict.recallSnapshotId === 'string' ? verdict.recallSnapshotId : null,
    query: typeof verdict.query === 'string' ? verdict.query : null,
    kbLacksAnswer: verdict.kbLacksAnswer === true,
    // 旧行无此字段 → null（防御性读取，向后兼容）。
    evalRunId: typeof verdict.evalRunId === 'string' ? verdict.evalRunId : null,
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
      `report_usage: invalid outcome ${JSON.stringify(outcome)} (expected one of ${USAGE_OUTCOMES.join(', ')})`,
    )
  }
  // 前置存在性检查：claimId 不存在直接拒、连 insert 都不发（claim_verification.claim_id 的 NOT NULL FK 是兜底）。
  const exists = await db.select({ id: claim.id }).from(claim).where(eq(claim.id, claimId)).limit(1)
  if (exists.length === 0) {
    throw new Error(`report_usage: claim ${claimId} not found`)
  }
  // 预测概率绑定（EGR-CR-003 方案 A）：给了 recallSnapshotId 就按 id 查回**那次真实 recall** 的快照，
  // 校验存在 + by_role 匹配（决策 c），用**表里的** value/version 作预测值；caller 无法自报 confidence/version。
  const reporterRole = ctx.byRole ?? 'consumer:unknown'
  let predictedConfidence: number | null = null
  let calibrationVersion: string | null = null
  if (ctx.recallSnapshotId !== undefined) {
    const snap = await getRecallSnapshot(db, ctx.recallSnapshotId)
    if (snap === null) {
      throw new Error(`report_usage: recall snapshot ${ctx.recallSnapshotId} not found`)
    }
    if (snap.byRole !== reporterRole) {
      throw new Error(
        `report_usage: recall snapshot ${ctx.recallSnapshotId} was recalled by_role ${JSON.stringify(snap.byRole)}, ` +
          `but this usage is reported by_role ${JSON.stringify(reporterRole)} (决策 c: reporter must match recaller)`,
      )
    }
    predictedConfidence = snap.value
    calibrationVersion = snap.calibrationVersion
  }
  const id = randomUUID()
  // query 是 S11 回放的题面：空白串无法形成可回答的问题，归一化为 null（等同省略 query）。
  // 与 note/taskId 的「自由文本原样保留」不同——query 必须是可回答的问题，空白即无问题。
  // 只用 trim 判空白；非空白 query 原样落库，不改写用户的问题文本。
  const normalizedQuery =
    typeof ctx.query === 'string' && ctx.query.trim().length > 0 ? ctx.query : null
  const verdict: UsageVerdict = {
    outcome,
    taskId: ctx.taskId ?? null,
    note: ctx.note ?? null,
    // 预测值/版本来自 recall_snapshot 表（绝非 caller 自报）；无 snapshot 则为 null。
    predictedConfidence,
    calibrationVersion,
    // 绑定的真实 recall 快照 id（校准取样器据此 JOIN recall_snapshot 取 verified 样本）。无绑定为 null（裸行）。
    recallSnapshotId: ctx.recallSnapshotId ?? null,
    query: normalizedQuery,
    kbLacksAnswer: ctx.kbLacksAnswer ?? false,
    evalRunId: ctx.evalRunId ?? null,
  }
  await db.insert(claimVerification).values({
    id,
    claimId,
    kind: 'usage_truth',
    verdict,
    byRole: reporterRole,
  })
  return { verificationId: id }
}

/**
 * 枚举一条 claim 的全部 usage_truth 事件（append-only，按 created_at 升序）。
 * created_at 是微秒级事务时间，每次 reportUsage 一次独立事务 ⇒ 实践中互不相同；次级 id 升序
 * 只是同一瞬间（极罕见）平手时的确定性兜底，并非严格插入序（若 S11/S19 需严格插入序，再加单调 ordinal 列）。
 */
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
        // verdict->>'outcome' ∈ 失败结局；IN 列表从 FAILURE_OUTCOMES 单一真相源参数化生成（不漂移、无注入）。
        sql`(${claimVerification.verdict} ->> 'outcome') in (${sql.join(
          FAILURE_OUTCOMES.map((o) => sql`${o}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(asc(claimVerification.createdAt), asc(claimVerification.id))
  return rows.map(toUsageEvent)
}
