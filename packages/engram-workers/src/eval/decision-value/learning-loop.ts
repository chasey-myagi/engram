/**
 * S8 · Plan A 学习闭环(R1 → fit g1 → R2 held-out)+ 轮次隔离 + decision_eval 持久化 —— 证明「g 从 R1 真消费学到的校准,
 * 在**未见**的 R2 事实上仍兑现固定 τ 承诺」(越用越准 → 在新事实上越用越有用),且决策评测**绝不**污染 g 燃料。
 *
 * 闭环 = 复用 S7 runBaselines 的 fit/eval 分离:
 *   - R1 in-sample:runBaselines({fit:R1, tune:R1, eval:R1}) —— g1 拟在 R1、阈值 tune 在 R1、量在 R1(乐观、参照)。
 *   - R2 held-out:runBaselines({fit:R1, tune:R1, eval:R2}) —— **同一 g1**(确定性拟合,fit 输入相同)、**R1 冻结的阈值复用**、量在**未见的 R2**。
 *   roundDelta = R2.decisionLift − R1.decisionLift(泛化差:≈0 或正 ⇒ 校准价值不是 R1 过拟合,迁到 R2 仍在)。
 *
 * **轮次隔离(钉死)**:R1 与 R2 的 factId 集必须**不相交**(assertRoundsDisjoint;负对照:注入重叠事实 → 抛 RoundOverlapError)。
 * 否则「R2 是未见事实」这个前提塌了,held-out lift 就是查表自欺。
 *
 * **A3 污染防护(承重)**:决策结局**只**经 recordDecisionEval 落 decision_eval(有符号),**绝不**走 report_usage ——
 * 否则 Plan A 决策指标会反过来训练 g(Goodhart)。g1 只从「真消费」的 {rawPredicted,correct} 拟(= usage_truth 燃料的形状;
 * usage_truth→拟合→泛化的真 DB 闭环已在 M2 calibration-pilot 证;本片证**决策侧**闭环 + 决策↛g 的隔离)。
 * 行为铁证(见测试):persist 一批 decision_eval 后,生产 g 取样器 collectUsageCalibrationSamples 仍取不到任何样本
 * ⇒ 决策没渗进 g 燃料。静态:本文件在 workers a3-firewall allowlist(它引用 recordDecisionEval),且 core firewall ③b 钉死
 * decision_eval sink 不触 g 燃料。
 */
import { recordDecisionEval, type DB } from '@engram/core'

import { runBaselines, type BaselineResult } from './baselines.js'
import type { LabeledSample } from './split-and-tune.js'

/** 轮次重叠(R1∩R2≠∅)—— held-out 前提被破坏,fail-loud。 */
export class RoundOverlapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoundOverlapError'
  }
}

/** R1/R2 的事实集必须不相交;否则抛 RoundOverlapError(列出前几个重叠 factId 便于定位)。 */
export function assertRoundsDisjoint(r1FactIds: string[], r2FactIds: string[]): void {
  const s1 = new Set(r1FactIds)
  const overlap = [...new Set(r2FactIds)].filter((id) => s1.has(id))
  if (overlap.length > 0) {
    const head = overlap.slice(0, 5).join(', ')
    throw new RoundOverlapError(
      `轮次隔离失败:R1∩R2≠∅ —— ${overlap.length} 个事实跨两轮(${head}${overlap.length > 5 ? ', …' : ''})`,
    )
  }
}

export interface LearningLoopResult {
  tau: number
  /** R1 内样本对照(乐观参照)。 */
  r1: BaselineResult
  /** R2 留出对照(g1 + R1 冻结阈值,量在未见事实)—— 闭环的真结论。 */
  r2: BaselineResult
  /** R2.decisionLift − R1.decisionLift:泛化差(≈0/正 ⇒ 价值迁得动、非 R1 过拟合)。 */
  roundDelta: number
}

/**
 * 跑一轮学习闭环。纯函数(g 拟合确定、bootstrap 种子化):同输入同输出。**不**触 DB —— 落库交 persistLoopResult。
 * R1=第一轮真消费结局({rawPredicted,correct});R2=后续轮**全新事实**。两轮 factId 必不相交。
 */
export function runLearningLoop(input: {
  r1: LabeledSample[]
  r2: LabeledSample[]
  tau: number
  seed?: number
  bootstrapIterations?: number
}): LearningLoopResult {
  const { r1, r2, tau } = input
  assertRoundsDisjoint(
    r1.map((s) => s.factId),
    r2.map((s) => s.factId),
  )
  const opts = {
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.bootstrapIterations !== undefined
      ? { bootstrapIterations: input.bootstrapIterations }
      : {}),
  }
  // 同一 g1:两次 runBaselines 的 fit 输入都是 R1 ⇒ fitIsotonic 确定性 ⇒ gMap 逐位相同。阈值 tune 在 R1 ⇒ 对 R2 是冻结复用。
  const r1Result = runBaselines({ fit: r1, tune: r1, eval: r1 }, tau, opts)
  const r2Result = runBaselines({ fit: r1, tune: r1, eval: r2 }, tau, opts)
  return {
    tau,
    r1: r1Result,
    r2: r2Result,
    roundDelta: r2Result.decisionLift - r1Result.decisionLift,
  }
}

/**
 * 把一轮闭环结果落 decision_eval(**只** decision_eval、绝不 report_usage —— A3)。runLabel 形如 `<base>:R1` / `<base>:R2`。
 * 写:R2 的 loop decisionLift(带 CI + sampleN)+ roundDelta,R1/R2 各 variant 的 coverage/regret/promiseError。返回写入行数。
 * fail-loud:任一 recordDecisionEval 校验/DB 失败即向上抛(实验记录不容静默丢行)。
 */
export async function persistLoopResult(
  db: DB,
  runLabelBase: string,
  result: LearningLoopResult,
): Promise<number> {
  let written = 0
  const write = async (
    runLabel: string,
    variant: string,
    metric: string,
    value: number,
    extra: { ciLow?: number; ciHigh?: number; sampleN?: number } = {},
  ): Promise<void> => {
    await recordDecisionEval(db, { runLabel, variant, metric, value, ...extra })
    written += 1
  }

  // 闭环头条:R2 留出 decisionLift(带 bootstrap CI + 样本数)+ roundDelta。
  await write(`${runLabelBase}:R2`, 'loop', 'decisionLift', result.r2.decisionLift, {
    ciLow: result.r2.ci.lo,
    ciHigh: result.r2.ci.hi,
    sampleN: result.r2.identity.total,
  })
  await write(`${runLabelBase}:R2`, 'loop', 'roundDelta', result.roundDelta)
  // R1 内样本 lift(乐观参照,用于读出泛化差)。
  await write(`${runLabelBase}:R1`, 'loop', 'decisionLift', result.r1.decisionLift, {
    ciLow: result.r1.ci.lo,
    ciHigh: result.r1.ci.hi,
    sampleN: result.r1.identity.total,
  })
  // 每轮 × 每 variant 的恒有限指标(coverage/regret/promiseError;realizedAccuracy 可能 NaN,故不落)。
  for (const [runLabel, r] of [
    [`${runLabelBase}:R1`, result.r1],
    [`${runLabelBase}:R2`, result.r2],
  ] as const) {
    for (const [variant, p] of [
      ['identity', r.identity],
      ['fitted', r.fitted],
      ['oracle', r.oracle],
    ] as const) {
      await write(runLabel, variant, 'coverage', p.coverage)
      await write(runLabel, variant, 'regret', p.regret)
      await write(runLabel, variant, 'promiseError', p.promiseError)
    }
  }
  return written
}
