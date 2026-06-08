/**
 * Plan A 的 3-way 切分 + 盲化阈值**选择器**(纯函数,零 import-calibration、零 DB)。
 *
 * 为什么 3-way:阈值若在用于评测的同一批样本上选,就偷看了答案。故按**事实**切三份:fit(拟合 g)/ tune(选阈值)/
 * eval(报指标)。任一事实的**全部样本只进一份**(factsInAnyTwoSides==0,从实际三份数组独立重算)——校准泛化的单元
 * 是事实,绝不让同一事实跨份(否则评测=查表)。
 *
 * **重要(决策价值从哪来)**:tuneThreshold 是个**盲化阈值选择器**(只吃 samples+predict+target、对用哪个 g 无感知)。
 * 「在固定准确率目标下选最大 coverage 的阈值」对**严格单调** g 是 **ranking-invariant**——g 严格单调 ⇒ 双射 ⇒
 * 「g(raw)≥th」⟺「raw≥g⁻¹(th)」,答案集族完全一样,故 identity 与严格单调 fitted-g 经同一调参器得**同一** eval 答案集
 * (coverage/accuracy 全等,见测⑤)。⚠ 真实 g 是 isotonic 回归(PAVA)= **弱**单调:平台段把相邻 raw 池化进同一 g 值;
 * 平台跨切点时 g 选不出 identity 能选的某些答案集 ⇒ 弱单调下该不变式**不成立**(测⑤b 实证)。但平台只**粗化** raw 排序
 * (PAVA 池化的恰是「对准确率非单调」的噪声档),不构成干净的 ranking 增益通道。⇒ 校准的稳健决策价值不在调阈值,
 * 而在**固定业务风险门 τ 的 promise-keeping**(S7):identity@τ 过度承诺,fitted-g@τ 守住「≥τ 自信 = ≥τ 正确」。
 * 本模块只提供切分 + 选择器,价值证明在 S7。
 * A3:本模块只 import decision-core(纯指标),绝不 import calibration/g/governance —— predict 由调用方注入(测⑦有源扫守卫)。
 */
import { computeDecisionMetrics } from './decision-core.js'

/** 带事实归属的标注样本(= FactSample 结构子集;本地定义以与 calibration 模块解耦)。 */
export interface LabeledSample {
  factId: string
  rawPredicted: number
  correct: boolean
}

export interface ThreeWaySplit {
  fit: LabeledSample[]
  tune: LabeledSample[]
  eval: LabeledSample[]
  /** 结构性自检:同一事实跨任意两份的事实数。必为 0(切分按事实整组)。 */
  factsInAnyTwoSides: number
}

/**
 * 按 factId **整组**切三份(≈60/20/20)。确定性:按排序 factId 的 index 取单一模数 5——0→eval、1→tune、2/3/4→fit
 * (单除数自洽,无脱钩魔法常数)。**同一事实的所有样本同进一份** ⇒ factsInAnyTwoSides==0
 * (钉死防回归:别把同一事实拆到两份冒充泛化——校准泛化的单元是事实,不是样本)。
 */
export function split3ByFact(samples: LabeledSample[]): ThreeWaySplit {
  const factIds = [...new Set(samples.map((s) => s.factId))].sort()
  const role = new Map<string, 'fit' | 'tune' | 'eval'>()
  factIds.forEach((id, i) => {
    const r = i % 5
    role.set(id, r === 0 ? 'eval' : r === 1 ? 'tune' : 'fit')
  })
  const fit: LabeledSample[] = []
  const tune: LabeledSample[] = []
  const evalSet: LabeledSample[] = []
  for (const s of samples) {
    const r = role.get(s.factId)
    if (r === 'eval') evalSet.push(s)
    else if (r === 'tune') tune.push(s)
    else fit.push(s)
  }
  // 从**实际三份数组**独立重算(不读 role map)——这样若哪天分组退化成 per-sample(把一事实的样本拆到多份),
  // 这里会真抓出来(读 role map 则恒为 0、是空守卫)。某 factId 出现在 ≥2 个数组里即记一次跨份。
  const inFit = new Set(fit.map((s) => s.factId))
  const inTune = new Set(tune.map((s) => s.factId))
  const inEval = new Set(evalSet.map((s) => s.factId))
  let factsInAnyTwoSides = 0
  for (const id of new Set([...inFit, ...inTune, ...inEval])) {
    const sides = (inFit.has(id) ? 1 : 0) + (inTune.has(id) ? 1 : 0) + (inEval.has(id) ? 1 : 0)
    if (sides > 1) factsInAnyTwoSides += 1
  }
  return { fit, tune, eval: evalSet, factsInAnyTwoSides }
}

/** 三份样本量是否都达最小可解读门(防小样本下 lift 落在噪声里)。 */
export function splitSizesOk(split: ThreeWaySplit, minPerPartition: number): boolean {
  return (
    split.fit.length >= minPerPartition &&
    split.tune.length >= minPerPartition &&
    split.eval.length >= minPerPartition
  )
}

/**
 * 盲化阈值调参:在 tune 集上,用注入的 predict,选**让 coverage 最大、同时 answeredAccuracy≥target** 的阈值
 * (风险受控的选择性预测标准目标)。候选 = tune 集预测值的去重排序;都达不到 target → 返回「全弃答」阈值(最安全)。
 * 对 identity / fitted-g 用**同一**调参器 ⇒ 公平。
 */
export function tuneThreshold(
  samples: LabeledSample[],
  predict: (raw: number) => number,
  opts: { targetAccuracy: number },
): number {
  // 全弃答哨兵:严格高于任何**有限**预测值 ⇒ 一个样本都不过门(target 不可达 / 空候选时最安全兜底)。
  // 用 +∞ 而非 1.0000001:不依赖「predict 输出 ∈ [0,1]」这一前置(否则 S7 若注入越界 g 会被静默击穿)。
  const ABSTAIN_ALL = Number.POSITIVE_INFINITY
  const candidates = [...new Set(samples.map((s) => predict(s.rawPredicted)))].sort((a, b) => a - b)
  let best = ABSTAIN_ALL
  let bestCoverage = 0
  for (const th of candidates) {
    const m = computeDecisionMetrics(samples, predict, th)
    if (m.answered > 0 && m.answeredAccuracy >= opts.targetAccuracy && m.coverage > bestCoverage) {
      best = th
      bestCoverage = m.coverage
    }
  }
  return best
}
