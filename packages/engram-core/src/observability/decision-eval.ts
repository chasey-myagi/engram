/**
 * decision_eval sink SPI(S8,Plan A 决策价值实验的**计分台**写/读端)—— 把固定 τ baseline 对照 + 学习闭环的
 * **有符号**指标读数(decisionLift / roundDelta 可负)落进 decision_eval,并按 runLabel/metric/variant 读回。append-only。
 *
 * **fail-loud 契约**:与 trace sink(best-effort、旁路)相反——decision_eval 是实验记录,丢一行就污染结论,故
 * recordDecisionEval **校验失败即抛、DB 错误向上抛**(同 recordDimension/recordGap 的 eval 写口径)。
 *
 * **A3 红线(承重)**:决策动作/结局**只**落本表,**绝不**走真消费上报口 —— 否则 Plan A 的决策指标会反过来训练 g(Goodhart)。
 * 本模块是**唯一**合法读写 decision_eval 的 core 文件(在 a3-firewall 的 core allowlist 内)。它**不**读真消费真值流、
 * **不** import 任何 calibration / g / 拟合器 / 纵向(静态钉死:firewall ③b 断言本文件不含任何 g-燃料符号)——
 * 决策计分与 g 校准两条路在源码层就不相交。
 */
import { randomUUID } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { decisionEval } from '../db/schema.js'

/** 一条决策实验读数(调用方从 BaselineResult / LearningLoopResult 拆)。value 有符号(lift/delta 可负)。 */
export interface DecisionEvalInput {
  /** 实验 run 标签(如 'A:R1' / 'A:R2')。 */
  runLabel: string
  /** 基线变体:'identity' | 'fitted' | 'oracle' | 'loop'(纯文本,内核不解释)。 */
  variant: string
  /** 指标名:'decisionLift' | 'roundDelta' | 'coverage' | 'regret' | 'promiseError' | …。 */
  metric: string
  /** **有符号**读数(必须有限:NaN/±∞ 是 bug,fail-loud 拒)。 */
  value: number
  ciLow?: number
  ciHigh?: number
  sampleN?: number
  payload?: Record<string, unknown>
}

export interface DecisionEvalRecord {
  id: string
  runLabel: string
  variant: string
  metric: string
  value: number
  ciLow: number | null
  ciHigh: number | null
  sampleN: number | null
  payload: Record<string, unknown>
  createdAt: Date
}

function nonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0
}

/**
 * append-only 记一条决策实验读数。**fail-loud**:runLabel/variant/metric 必非空、value 必有限,否则抛;DB 错误向上抛。
 * 返回新行 id。
 */
export async function recordDecisionEval(db: DB, input: DecisionEvalInput): Promise<string> {
  if (!nonEmpty(input.runLabel) || !nonEmpty(input.variant) || !nonEmpty(input.metric)) {
    throw new Error('recordDecisionEval: runLabel / variant / metric 必须为非空字符串')
  }
  if (!Number.isFinite(input.value)) {
    throw new Error(`recordDecisionEval: value 必须有限(收到 ${input.value};NaN/±∞ 是 bug、不入库)`)
  }
  const id = randomUUID()
  await db.insert(decisionEval).values({
    id,
    runLabel: input.runLabel,
    variant: input.variant,
    metric: input.metric,
    value: input.value,
    ciLow: input.ciLow ?? null,
    ciHigh: input.ciHigh ?? null,
    sampleN: input.sampleN ?? null,
    payload: input.payload ?? {},
  })
  return id
}

/** 按 runLabel / metric / variant 读回决策实验读数,createdAt 降序。无过滤则取最近 limit 条。 */
export async function getDecisionEval(
  db: DB,
  opts: { runLabel?: string; metric?: string; variant?: string; limit?: number } = {},
): Promise<DecisionEvalRecord[]> {
  const conds = []
  if (opts.runLabel !== undefined) conds.push(eq(decisionEval.runLabel, opts.runLabel))
  if (opts.metric !== undefined) conds.push(eq(decisionEval.metric, opts.metric))
  if (opts.variant !== undefined) conds.push(eq(decisionEval.variant, opts.variant))
  const rows = await db
    .select()
    .from(decisionEval)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(decisionEval.createdAt))
    .limit(opts.limit ?? 200)
  return rows.map((r) => ({
    id: r.id,
    runLabel: r.runLabel,
    variant: r.variant,
    metric: r.metric,
    value: r.value,
    ciLow: r.ciLow,
    ciHigh: r.ciHigh,
    sampleN: r.sampleN,
    payload: (r.payload as Record<string, unknown> | null) ?? {},
    createdAt: r.createdAt,
  }))
}
