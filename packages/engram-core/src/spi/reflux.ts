/**
 * 生产失败回流（S11，A.2/A.9）—— 把真实失败变成自喂的活回归集，点完 P1 评测门。
 *
 * refluxFailures：确定性反流任务。挖 usage_truth 里 outcome∈{refuted,corrected} 的事件（getFailurePool），
 * 按 claim + 原始 query/task 归进 append-only 的 regression_pool，保留召回快照（预测概率 + g 版本）与到失败
 * claim 的归因。source_event_id UNIQUE ⇒ 幂等：反复跑只收新失败、不重复入池。adopted/partial 天然不入
 * （getFailurePool 已只取失败两态）。其中**人确认「KB 真没答案」**（by_role 人 + kbLacksAnswer + 有 query）的，
 * 另入 l5_candidates 队列等 QA 晋升（晋升本身是 S12）。
 *
 * replay：池中每项经其 query **重放过 recall_claims**（评测=消费，零专用路径）→ 对当前行为打 pass/fail。
 * 判据：失败 claim 是否仍被召回。仍召回 = 失败照旧复现（fail）；不再召回（被取代/隔离/跌破门）= 已修复（pass）。
 * 无 query 的老事件不可重放（unreplayable，不计 pass/fail）。
 */
import { asc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import { l5Candidates, regressionPool, type L5CandidateStatus } from '../db/schema.js'
import { getFailurePool } from './report-usage.js'
import { recallClaims } from './recall-claims.js'
import { randomUUID } from 'node:crypto'

/**
 * @internal — **不是实时授权判据**（EGR-CR-002）。这只是个对**已落库** by_role 字符串的格式判别：
 * by_role 是裸 'human' 或 'human:' 前缀才算人。仓内角色都冒号分隔（agent:x / consumer:unknown / human:judge），
 * 刻意不写成宽松的 startsWith('human')，免得把 'humanoid-agent' 之类误判成人。
 *
 * @security-note 纯字符串前缀**可被任意调用方伪造**，绝不可当作「人身份真实性」的实时授权门。所有人专属门
 * （red-edge 放松 / draft→active 旁路 / 写 f1 人审 / human 冲突裁定 / 主编三动作）已收口到受信 `ActorContext.isHuman`
 * （见 spi/actor.ts）。本函数仅供两类**非授权**用途：① 读历史落库的 by_role 事实（reflux L5 入队、human-review 读
 * 过滤、L5 晋升/免疫的 confirmedBy）——这些 by_role 在写入时已由受信门校验过、是既成事实，非实时授权；② factory 内部
 * 可选的 role 串格式校验。已从公共 index.ts 下线，杜绝业务方再拿它当授权判据。
 */
export function isHumanRole(byRole: string): boolean {
  return byRole === 'human' || byRole.startsWith('human:')
}

/** regression_pool 一行的读出形状。 */
export interface RegressionItem {
  id: string
  sourceEventId: string
  claimId: string
  query: string | null
  outcome: string
  taskId: string | null
  predictedConfidence: number | null
  calibrationVersion: string | null
  createdAt: Date
}

/** l5_candidates 一行的读出形状。 */
export interface L5Candidate {
  id: string
  sourceEventId: string
  query: string
  claimId: string | null
  confirmedBy: string
  status: L5CandidateStatus
  createdAt: Date
}

/**
 * 反流：失败事件 → 回归池（+ 人确认缺口 → L5 候选队列）。幂等锚是 **source_event_id UNIQUE**（每条 usage_truth
 * 失败事件至多入池一行）—— **不是**按 (claim, query) 去重：同一 claim、同一 query 的两条独立 refuted 事件是两次
 * 真实生产失败观测，各入一行（回归集要反映真实生产分布，频次本身是信号，对齐 S10 gap 的 append-only 取向）。
 * 「不重复」(AC5) 指的是同一事件反复跑反流不重复入池，不是把同 claim+query 的多次失败折叠成一条。
 * 全部插入包在一个事务里 ⇒ 要么整批落、要么不落，返回的 {pooled,l5Queued} 计数即本次真实新增（权威）。
 * adopted/partial 天然不入（getFailurePool 已只取失败两态）。
 */
export async function refluxFailures(db: DB): Promise<{ pooled: number; l5Queued: number }> {
  const failures = await getFailurePool(db) // 已只含 refuted/corrected，按时间升序
  return db.transaction(async (tx) => {
    let pooled = 0
    let l5Queued = 0
    for (const f of failures) {
      const insPool = await tx
        .insert(regressionPool)
        .values({
          id: randomUUID(),
          sourceEventId: f.id,
          claimId: f.claimId,
          query: f.query,
          outcome: f.outcome,
          taskId: f.taskId,
          predictedConfidence: f.predictedConfidence,
          calibrationVersion: f.calibrationVersion,
        })
        .onConflictDoNothing({ target: regressionPool.sourceEventId })
        .returning({ id: regressionPool.id })
      if (insPool.length > 0) pooled++

      // 人确认「KB 真没答案」且有 query → 入 L5 缺口候选队列（等 S12 QA 晋升）。
      if (f.kbLacksAnswer && isHumanRole(f.byRole) && f.query != null) {
        const insCand = await tx
          .insert(l5Candidates)
          .values({
            id: randomUUID(),
            sourceEventId: f.id,
            query: f.query,
            claimId: f.claimId,
            confirmedBy: f.byRole,
          })
          .onConflictDoNothing({ target: l5Candidates.sourceEventId })
          .returning({ id: l5Candidates.id })
        if (insCand.length > 0) l5Queued++
      }
    }
    return { pooled, l5Queued }
  })
}

/** 读回归池（按时间升序，反映真实生产失败分布）。 */
export async function getRegressionPool(db: DB): Promise<RegressionItem[]> {
  const rows = await db
    .select()
    .from(regressionPool)
    .orderBy(asc(regressionPool.createdAt), asc(regressionPool.id))
  return rows.map((r) => ({
    id: r.id,
    sourceEventId: r.sourceEventId,
    claimId: r.claimId,
    query: r.query,
    outcome: r.outcome,
    taskId: r.taskId,
    predictedConfidence: r.predictedConfidence,
    calibrationVersion: r.calibrationVersion,
    createdAt: r.createdAt,
  }))
}

/** 读 L5 候选队列（可按 status 过滤），按时间升序。 */
export async function getL5Candidates(db: DB, status?: L5CandidateStatus): Promise<L5Candidate[]> {
  const rows = await db
    .select()
    .from(l5Candidates)
    .where(status === undefined ? undefined : eq(l5Candidates.status, status))
    .orderBy(asc(l5Candidates.createdAt), asc(l5Candidates.id))
  return rows.map((r) => ({
    id: r.id,
    sourceEventId: r.sourceEventId,
    query: r.query,
    claimId: r.claimId,
    confirmedBy: r.confirmedBy,
    status: r.status,
    createdAt: r.createdAt,
  }))
}

/** 单条回归项的重放判定。 */
export interface ReplayVerdict {
  poolId: string
  claimId: string
  query: string | null
  /** 有 query 才可重放；无则 false（unreplayable，不计 pass/fail）。 */
  replayable: boolean
  /** 失败 claim 是否仍被当前 recall 召回（仅 replayable 有意义）。 */
  stillRecalled: boolean
  /** pass = 可重放且失败 claim 不再被召回（失败已修复）；fail = 仍被召回（照旧复现）。 */
  pass: boolean
}

/**
 * 重放一条回归项：用其原始 query 走真 recall_claims，看失败 claim 是否仍出现在结果里。
 *
 * pass 判据**刻意很窄**：pass = 那条**具体的失败 claim** 不再被召回（被取代 / 隔离 / 跌破门）。它只回答
 * 「这个失败还复不复现」，**不**断言「KB 现在能给对答案」—— 故隔离/删掉坏 claim 也会判 pass（这点可被 Goodhart：
 * 删库即过回归）。这是有意的边界，不是 bug：别把它误改成「必须召回到正确答案」。「KB 该会而不会」是正交问题，
 * 由 L5 缺口候选（人确认入队、S12 晋升）和 recall 的 gap 信号分别承载，不混进这条窄回归判据。
 * 又：recall_claims 在零召回时会落 gap 信号（S10）—— 这是「评测=消费走同一条缝」的应有副作用，刻意不旁路。
 */
export async function replayRegressionItem(
  db: DB,
  embedder: Embedder,
  item: RegressionItem,
): Promise<ReplayVerdict> {
  if (item.query == null) {
    return {
      poolId: item.id,
      claimId: item.claimId,
      query: null,
      replayable: false,
      stillRecalled: false,
      pass: false,
    }
  }
  const hits = await recallClaims(db, embedder, item.query)
  const stillRecalled = hits.some((h) => h.claim.id === item.claimId)
  return {
    poolId: item.id,
    claimId: item.claimId,
    query: item.query,
    replayable: true,
    stillRecalled,
    pass: !stillRecalled,
  }
}

export interface ReplayReport {
  total: number
  /** 可重放且已修复（失败 claim 不再召回）。 */
  passed: number
  /** 可重放但仍复现（失败 claim 仍被召回）。 */
  failed: number
  /** 无 query、无法重放。 */
  unreplayable: number
  results: ReplayVerdict[]
}

/** 重放整个回归池，聚合成可报告的 pass/fail。顺序跑（每次重放可能落 gap，避免并发交错）。 */
export async function replayRegressionPool(db: DB, embedder: Embedder): Promise<ReplayReport> {
  const items = await getRegressionPool(db)
  const results: ReplayVerdict[] = []
  for (const it of items) {
    results.push(await replayRegressionItem(db, embedder, it))
  }
  const replayable = results.filter((r) => r.replayable)
  return {
    total: results.length,
    passed: replayable.filter((r) => r.pass).length,
    failed: replayable.filter((r) => !r.pass).length,
    unreplayable: results.length - replayable.length,
    results,
  }
}
