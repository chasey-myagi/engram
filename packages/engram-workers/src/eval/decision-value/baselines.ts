/**
 * S7 · Plan A 价值证明:固定业务风险门 τ 下的 baseline 对照(identity vs fitted-g vs oracle)+ 种子化 cluster-bootstrap CI。
 *
 * **为什么是固定 τ 而非调阈值**(承 S6 的 ranking-invariance):严格单调 g 下「调阈值到某 accuracy 目标」是 ranking-invariant
 * (g 改不了答案集)⇒ 校准在「调阈值的选择性预测」上零增益。校准的稳健决策价值只在**固定业务风险门 τ**(value-语义、不重调)处显现:
 *   - identity@τ:把 raw 当概率,raw≥τ 即答。engram 的 raw = 因子聚合(非概率),系统性高估 ⇒ realizedAccuracy ≪ τ
 *     ⇒ **过度承诺**(promiseError 高、错答 regret 高)。
 *   - fitted-g@τ:g(raw)≥τ 才答;isotonic g 把「raw 高但其实不准」的档压到 τ 之下 ⇒ 只答**真有 τ 把握**的 ⇒ realizedAccuracy≈τ
 *     ⇒ **守住承诺**(promiseError 低)。两者在 eval 上答的是**不同**集合——因为 τ 钉死在 value 空间,不随 g 平移。
 *   - oracle@τ:在 eval 自身上选「达 τ 的最大 coverage 门」(用了 eval 标签、作弊)⇒ 守约能力上界;fitted 逼近它即证 g 拟到位。
 *
 * promiseError = **shortfall** = max(0, τ − realizedAccuracy)(单边:只罚「实测<承诺」的违诺缺口;超额达标是守约、零误差;保守的代价单列在 coverage)。
 *   —— 这是对最初「|realizedAcc − τ|」设想的有意修正:对称绝对值会把 fitted 的**有益超额**也罚成误差,掩盖「identity 违诺 vs fitted 守约」的真实对比。
 * decisionLift = identity.promiseError − fitted.promiseError(>0 ⇒ 校准把违诺缺口收得更小)。
 * **诚实对照** tunedCoverageLift:把 identity / fitted 各自用 S6 调参器 tune 到 targetAccuracy=τ 后、eval coverage 之差 ≈ 0
 *   —— 实证「校准不帮 ranking、只守固定风险承诺」(strict-monotone ⇒ 严格 0;isotonic 平台 ⇒ 近 0)。这是把 S6 的不变式落到实数上。
 * bootstrap:**按事实** resample eval(cluster bootstrap,尊重同一事实多次召回的相关)、种子化确定性、**阈值固定 τ 不重调**、
 *   **g 固定**(原 fit,不在 resample 上重拟)⇒ 得 decisionLift 的 95% CI。CI 下界 >0 = 校准价值在抽样噪声之上显著。
 *
 * A3:本模块**消费** calibration(fitIsotonic / applyGMap,consumer 方向合法),**不写**任何 trace/usage/落库表(纯内存、返回值);
 * g 的拟合只吃 {rawPredicted,correct}(GoldenSample 边界,结构上无 ELO/胜负率通道)。价值产物的落库在 S8(走独立 decision 评测表,不进 report_usage)。
 */
import { applyGMap, fitIsotonic, IDENTITY_MAP, type CalibrationMap } from '@engram/core'

import { computeDecisionMetrics } from './decision-core.js'
import { tuneThreshold, type LabeledSample } from './split-and-tune.js'

/** g 拟合的具名版本(仅 CalibrationMap 标签,不影响 g 值)。 */
const FIT_VERSION = 's7-baseline-fit'
/**
 * bootstrap 默认重抽次数 + 默认种子(确定性:同种子恒产同一 CI)。
 * 注意:iterations 过小(≲100)CI 退化——iterations=1 时 lo/hi 折成同一点(percentile 单元素分支),「区间」名存实亡;生产用默认 1000。
 */
const DEFAULT_ITERATIONS = 1000
const DEFAULT_SEED = 0x5eed

/** 确定性 PRNG(mulberry32):种子化、零时钟、零 Math.random ⇒ bootstrap 逐位可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 升序数组的 p 分位(线性插值,同 numpy 默认);空数组 → NaN。 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN
  if (sortedAsc.length === 1) return sortedAsc[0]!
  const idx = (sortedAsc.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo]!
  const frac = idx - lo
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac
}

/** 在固定 τ 下、某 predict 的承诺守约画像。 */
export interface PromiseProfile {
  /** 业务风险门(承诺的准确率下界)。 */
  tau: number
  answered: number
  total: number
  coverage: number
  /** answered 上的答对率;answered=0 → NaN(全弃答无可谈准确率)。 */
  realizedAccuracy: number
  /** 错答 / 全体(常害 regret)。 */
  regret: number
  /**
   * 承诺误差 = **shortfall** = max(0, τ − realizedAccuracy):实测准确率**低于**承诺门 τ 的缺口(违诺幅度)。
   * 刻意**单边**(不是 |realizedAcc − τ|):承诺是「≥τ 准确率」,**超额**达标(realized>τ)是守约甚至超约、零误差;
   * 只有**欠额**(realized<τ)才是危险的过度承诺、才产生错答 regret。超约的代价是「本可多答却保守」——它体现在**coverage 偏低**
   * (单列在 coverage 字段),不算进 promiseError。answered=0 → 0(弃答=不作承诺=不违诺)。
   */
  promiseError: number
}

/** decisionLift 的种子化 cluster-bootstrap 95% CI。 */
export interface BootstrapCI {
  /** 全 eval 上的点估计(= identity.promiseError − fitted.promiseError)。 */
  estimate: number
  /** 2.5 分位。 */
  lo: number
  /** 97.5 分位。 */
  hi: number
  iterations: number
  seed: number
}

export interface BaselineResult {
  tau: number
  /** fit-set 上拟出的 g(consumer 直接 applyGMap 用)。 */
  gMap: CalibrationMap
  /** raw 当概率、阈值 τ。 */
  identity: PromiseProfile
  /** g(raw)、阈值 τ。 */
  fitted: PromiseProfile
  /** eval 自身上达 τ 的最大 coverage 门(用 eval 标签,守约上界)。 */
  oracle: PromiseProfile
  /** identity.promiseError − fitted.promiseError;>0 ⇒ 校准更守承诺。 */
  decisionLift: number
  /** 诚实对照:identity/fitted 各 tune 到 acc=τ 后 eval coverage 差;≈0 ⇒ 校准不帮 ranking,只守固定风险承诺。 */
  tunedCoverageLift: number
  /** decisionLift 的 95% CI。 */
  ci: BootstrapCI
}

const identityPredict = (raw: number): number => applyGMap(raw, IDENTITY_MAP)

/** 在 `threshold` 上决策、按 `tau` 衡量承诺误差,得一个 PromiseProfile。threshold 与 tau 解耦(oracle 的 threshold≠τ)。 */
function promiseProfile(
  samples: LabeledSample[],
  predict: (raw: number) => number,
  threshold: number,
  tau: number,
): PromiseProfile {
  const m = computeDecisionMetrics(samples, predict, threshold)
  // answered=0 ⇒ 不作承诺 ⇒ 不违诺(promiseError=0);否则 shortfall = max(0, τ − 实测准确率)(单边,只罚欠额、不罚超额——见字段注释)。
  const promiseError = m.answered > 0 ? Math.max(0, tau - m.answeredAccuracy) : 0
  return {
    tau,
    answered: m.answered,
    total: m.total,
    coverage: m.coverage,
    realizedAccuracy: m.answeredAccuracy,
    regret: m.regret,
    promiseError,
  }
}

/**
 * decisionLift 的 cluster-bootstrap CI:**按事实**重抽 eval(同一 factId 的样本整簇同进同出,尊重 within-fact 相关),
 * 阈值固定 τ、g 固定(传入的 fittedPredict),逐次重算 lift。种子化 ⇒ 确定性。
 */
export function bootstrapDecisionLift(
  evalSamples: LabeledSample[],
  fittedPredict: (raw: number) => number,
  tau: number,
  opts: { iterations: number; seed: number },
): BootstrapCI {
  const liftOf = (s: LabeledSample[]): number =>
    promiseProfile(s, identityPredict, tau, tau).promiseError -
    promiseProfile(s, fittedPredict, tau, tau).promiseError
  const estimate = liftOf(evalSamples)

  // 按 factId 聚簇(单样本/事实时退化为普通 bootstrap;多样本/事实时整簇重抽)。
  const byFact = new Map<string, LabeledSample[]>()
  for (const s of evalSamples) {
    const arr = byFact.get(s.factId)
    if (arr) arr.push(s)
    else byFact.set(s.factId, [s])
  }
  const clusters = [...byFact.values()]
  const rng = mulberry32(opts.seed)
  const lifts: number[] = []
  for (let b = 0; b < opts.iterations; b++) {
    const resample: LabeledSample[] = []
    for (let i = 0; i < clusters.length; i++) {
      resample.push(...clusters[Math.floor(rng() * clusters.length)]!)
    }
    lifts.push(liftOf(resample)) // promiseError 恒有限(answered=0→0),lift 不会 NaN
  }
  lifts.sort((x, y) => x - y)
  return {
    estimate,
    lo: percentile(lifts, 0.025),
    hi: percentile(lifts, 0.975),
    iterations: opts.iterations,
    seed: opts.seed,
  }
}

/**
 * 跑 baseline 对照:fit 拟 g → eval 在固定 τ 比 identity / fitted / oracle 的承诺守约 → decisionLift + tunedCoverageLift + CI。
 * 纯函数:同输入同输出(g 拟合确定、bootstrap 种子化)。split 由 S6 split3ByFact 产、splitSizesOk 把门后传入。
 */
export function runBaselines(
  split: { fit: LabeledSample[]; tune: LabeledSample[]; eval: LabeledSample[] },
  tau: number,
  opts: { bootstrapIterations?: number; seed?: number } = {},
): BaselineResult {
  const iterations = opts.bootstrapIterations ?? DEFAULT_ITERATIONS
  const seed = opts.seed ?? DEFAULT_SEED

  // fit-set 拟 g(只吃 {rawPredicted,correct});eval 上 applyGMap。
  const gMap = fitIsotonic(
    split.fit.map((s) => ({ rawPredicted: s.rawPredicted, correct: s.correct })),
    FIT_VERSION,
  )
  const fittedPredict = (raw: number): number => applyGMap(raw, gMap)

  const identity = promiseProfile(split.eval, identityPredict, tau, tau)
  const fitted = promiseProfile(split.eval, fittedPredict, tau, tau)
  // oracle:在 eval 自身 tune 到 acc≥τ 的最大 coverage 门(ranking-invariant ⇒ 用 identity 排序即可),measured on eval ⇒ 守约上界。
  const oracleThreshold = tuneThreshold(split.eval, identityPredict, { targetAccuracy: tau })
  const oracle = promiseProfile(split.eval, identityPredict, oracleThreshold, tau)

  const decisionLift = identity.promiseError - fitted.promiseError

  // 诚实对照:各自 tune 到 acc=τ(S6 盲化选择器)再比 eval coverage —— 期望 ≈ 0(校准不帮 ranking)。
  const thIdentity = tuneThreshold(split.tune, identityPredict, { targetAccuracy: tau })
  const thFitted = tuneThreshold(split.tune, fittedPredict, { targetAccuracy: tau })
  const tunedCoverageLift =
    computeDecisionMetrics(split.eval, fittedPredict, thFitted).coverage -
    computeDecisionMetrics(split.eval, identityPredict, thIdentity).coverage

  const ci = bootstrapDecisionLift(split.eval, fittedPredict, tau, { iterations, seed })

  return { tau, gMap, identity, fitted, oracle, decisionLift, tunedCoverageLift, ci }
}
