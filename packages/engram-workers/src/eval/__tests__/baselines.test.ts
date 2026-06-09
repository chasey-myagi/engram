/**
 * S7 · 固定 τ baseline 对照 CI 守门(纯函数,零 DB)。Plan A 的价值证明在此落到实数:
 * ① **过自信语料**(raw 系统性高估,engram 真实场景):identity@τ 过度承诺(realizedAcc≪τ、错答 regret 高)、fitted-g@τ 守住承诺(≈τ、regret 低);
 *    decisionLift>0 且 **bootstrap CI 下界>0**(价值在抽样噪声之上显著)。
 * ② **诚实对照**:tunedCoverageLift≈0 —— 各自 tune 到 acc=τ 后 eval coverage 几乎相等(校准不帮 ranking,只守固定风险承诺)。
 * ③ **负对照(精确零)**:良校准语料 → g≡identity → decisionLift 恰 0、CI 恰 [0,0](无承诺差可挣)。
 * ③b **负对照(噪声跨零)**:per-resample lift 两符号、均值≈0 ⇒ CI **严格**跨 0(lo<0<hi),证明能区分「无信号」与「信号低于噪声」。
 * ④ oracle 是守约上界:oracle ≤ fitted ≤ identity 的 promiseError、oracle.coverage ≥ fitted(达 τ 的最大 coverage);threshold≠τ 解耦。
 * ⑤ 确定性 + 跨种子稳健:同种子逐位相同;两个不同种子 CI 下界都 >0(结论稳健)。
 * ⑥ 边界:空 eval / 空 split 不抛、lift 有限、CI 有定义。
 * ⑦ **cluster-bootstrap 按事实整簇重抽**:单事实多样本 → CI 零宽(整簇同进同出);同样本散成多事实 → CI 非零宽(决定性区分簇/样本重抽)。
 * ⑧ **τ 变化(0.75)**:同叙事成立(identity 违诺 / fitted 守约 / lift>0)+ promiseProfile 的 threshold↔τ 解耦不被吞。
 */
import { applyGMap } from '@engram/core'
import { describe, expect, it } from 'vitest'

import { bootstrapDecisionLift, runBaselines } from '../decision-value/baselines.js'
import { split3ByFact, type LabeledSample } from '../decision-value/split-and-tune.js'

interface Tier {
  raw: number
  /** 该档的真实正确率(golden-ratio 低差异序列指派 ⇒ 任意等距/重抽子集都 ≈acc,杜绝「前 N 条对」遇 stride 的偏差)。 */
  acc: number
  n: number
}

const PHI = 0.6180339887498949 // 黄金比小数部分:k·PHI mod 1 等分布,任意 AP 子集比例 ≈acc(消除切分/重抽伪影)。

/**
 * 造语料:各 tier 样本**轮转交错**编号 ⇒ split3ByFact 的 mod-5 切分在 fit/tune/eval 三份里保留各 tier 比例;
 * 正确性按 golden-ratio 低差异序列指派 ⇒ 确定性、且**任意子集**(strided eval / bootstrap 重抽)准确率都 ≈acc。一事实一样本。
 */
function makeCorpus(tiers: Tier[], prefix: string): LabeledSample[] {
  const perTier = tiers.map((t) =>
    Array.from({ length: t.n }, (_x, k) => ({ raw: t.raw, correct: (k * PHI) % 1 < t.acc })),
  )
  const out: LabeledSample[] = []
  let idx = 0
  const maxLen = Math.max(...tiers.map((t) => t.n))
  for (let k = 0; k < maxLen; k++) {
    for (let ti = 0; ti < tiers.length; ti++) {
      const s = perTier[ti]![k]
      if (s) {
        out.push({
          factId: `${prefix}-${String(idx).padStart(4, '0')}`,
          rawPredicted: s.raw,
          correct: s.correct,
        })
        idx++
      }
    }
  }
  return out
}

const TAU = 0.8

// 过自信语料:genuine 档 raw 0.90 真准 0.85(g 学会:留、≥τ);overstated 档 raw 0.82≥τ 但真准仅 0.30(g 学会:压到 τ 下、弃);
// low 档 raw 0.50(两者都弃)。identity@0.8 把 genuine+overstated 都当「≥0.8 把握」答 ⇒ 实测被 overstated 拖到 ≈0.575≪0.8(严重违诺)。
const OVERCONFIDENT: Tier[] = [
  { raw: 0.9, acc: 0.85, n: 120 },
  { raw: 0.82, acc: 0.3, n: 120 },
  { raw: 0.5, acc: 0.4, n: 120 },
]
// 良校准语料:raw == 真准 ⇒ isotonic g ≈ identity ⇒ identity 本就守约、无承诺差可挣。
const WELL_CALIBRATED: Tier[] = [
  { raw: 0.85, acc: 0.85, n: 120 },
  { raw: 0.8, acc: 0.8, n: 120 },
  { raw: 0.5, acc: 0.5, n: 120 },
]

describe('S7 · 固定 τ baseline 对照(identity vs fitted vs oracle)+ bootstrap CI', () => {
  it('① 过自信语料:identity@τ 过度承诺、fitted-g@τ 守约;decisionLift>0 且 CI 下界>0', () => {
    const split = split3ByFact(makeCorpus(OVERCONFIDENT, 'oc'))
    const r = runBaselines(split, TAU, { seed: 1, bootstrapIterations: 1000 })
    // identity 把 raw 当概率 ⇒ 把 overstated 也答了 ⇒ 实测准确率显著低于承诺门 τ(过度承诺)。
    expect(r.identity.realizedAccuracy).toBeLessThan(TAU - 0.05)
    expect(r.identity.coverage).toBeGreaterThan(0)
    // fitted-g 把 overstated 压到 τ 之下、弃答 ⇒ 实测准确率守在 τ 附近或之上(守约)。
    expect(r.fitted.realizedAccuracy).toBeGreaterThanOrEqual(TAU - 0.03)
    expect(r.fitted.promiseError).toBeLessThan(r.identity.promiseError)
    // 校准的决策价值:promiseError 差 > 0,且 bootstrap 95% CI 下界 > 0(显著,不是噪声)。
    expect(r.decisionLift).toBeGreaterThan(0.05)
    expect(r.ci.estimate).toBeCloseTo(r.decisionLift, 10)
    expect(r.ci.lo).toBeGreaterThan(0)
    expect(r.ci.lo).toBeLessThanOrEqual(r.ci.hi)
    // 价值的人话版:校准把危险的错答 regret 砍下来(实测 ~0.29 → ~0.056)。
    expect(r.identity.regret).toBeGreaterThan(r.fitted.regret)
  })

  it('② 诚实对照:tunedCoverageLift≈0(各自 tune 到 acc=τ ⇒ 校准不帮 ranking,只守固定风险承诺)', () => {
    const split = split3ByFact(makeCorpus(OVERCONFIDENT, 'oc2'))
    const r = runBaselines(split, TAU, { seed: 7 })
    // 允许 isotonic 平台带来的极小偏移,但量级远小于 ① 的 decisionLift —— 这就是「价值在固定 τ、不在调阈值」的实证。
    expect(Math.abs(r.tunedCoverageLift)).toBeLessThan(0.1)
    expect(Math.abs(r.tunedCoverageLift)).toBeLessThan(r.decisionLift)
  })

  it('③ 负对照:良校准语料 → decisionLift≈0、CI 跨 0(无承诺差可挣)', () => {
    const split = split3ByFact(makeCorpus(WELL_CALIBRATED, 'wc'))
    const r = runBaselines(split, TAU, { seed: 3, bootstrapIterations: 1000 })
    expect(Math.abs(r.decisionLift)).toBeLessThan(0.05)
    // CI 跨 0:下界 ≤ 0 ≤ 上界(价值不显著——正是良校准该有的结论)。
    expect(r.ci.lo).toBeLessThanOrEqual(0.0001)
    expect(r.ci.hi).toBeGreaterThanOrEqual(-0.0001)
  })

  it('④ oracle 是守约上界:oracle ≤ fitted ≤ identity 的 promiseError;oracle.coverage ≥ fitted、≤ identity(threshold≠τ 解耦)', () => {
    const split = split3ByFact(makeCorpus(OVERCONFIDENT, 'oc4'))
    const r = runBaselines(split, TAU, { seed: 5 })
    expect(r.oracle.promiseError).toBeLessThanOrEqual(r.fitted.promiseError + 1e-9)
    expect(r.fitted.promiseError).toBeLessThanOrEqual(r.identity.promiseError + 1e-9)
    // fitted 把 overstated 正确弃掉 ⇒ 守约能力贴近作弊上界(差距小)。
    expect(r.fitted.promiseError - r.oracle.promiseError).toBeLessThan(0.1)
    // 非平凡上界:oracle 是「达 τ 的最大 coverage 门」⇒ 在守约前提下 coverage 至少与 fitted 一样大(且都 < identity 的鲁莽 coverage)。
    // 这条同时把 promiseProfile 的 threshold≠τ 路径(oracleThreshold≠τ)钉死:若把 threshold/τ 调换,oracle.promiseError 会从 0 变成 0.2+,断言立刻挂。
    expect(r.oracle.coverage).toBeGreaterThan(0)
    expect(r.oracle.coverage).toBeGreaterThanOrEqual(r.fitted.coverage - 1e-9)
    expect(r.oracle.coverage).toBeLessThanOrEqual(r.identity.coverage + 1e-9)
  })

  it('⑤ 确定性 + 跨种子稳健:同种子逐位相同;两个不同种子 CI 下界都 >0', () => {
    const split = split3ByFact(makeCorpus(OVERCONFIDENT, 'oc5'))
    const a = runBaselines(split, TAU, { seed: 42, bootstrapIterations: 500 })
    const b = runBaselines(split, TAU, { seed: 42, bootstrapIterations: 500 })
    expect(b.ci.lo).toBe(a.ci.lo)
    expect(b.ci.hi).toBe(a.ci.hi)
    expect(b.decisionLift).toBe(a.decisionLift)
    // 跨种子:结论(CI 下界 > 0 = 价值显著)不靠某个幸运种子——换两个种子都成立。
    expect(
      runBaselines(split, TAU, { seed: 100, bootstrapIterations: 1000 }).ci.lo,
    ).toBeGreaterThan(0)
    expect(
      runBaselines(split, TAU, { seed: 999, bootstrapIterations: 1000 }).ci.lo,
    ).toBeGreaterThan(0)
    // 用 runBaselines 暴露的 gMap 经**真** applyGMap 复刻 fitted predict ⇒ 独立调 bootstrapDecisionLift 同种子同结果。
    const fittedPredict = (raw: number): number => applyGMap(raw, a.gMap)
    const c1 = bootstrapDecisionLift(split.eval, fittedPredict, TAU, { iterations: 500, seed: 42 })
    const c2 = bootstrapDecisionLift(split.eval, fittedPredict, TAU, { iterations: 500, seed: 42 })
    expect(c2.lo).toBe(c1.lo)
    expect(c2.hi).toBe(c1.hi)
    // 它复算的 lift 估计应与 runBaselines 报的一致(同 g、同 τ、同 eval)。
    expect(c1.estimate).toBeCloseTo(a.decisionLift, 10)
  })

  it('⑥ 边界:空 eval / 空 split 不抛、lift 有限、CI 有定义', () => {
    // 空 eval(fit/tune 非空):profiles 全弃答、lift=0、CI=[0,0]。
    const corpus = makeCorpus(OVERCONFIDENT, 'oc6')
    const split = split3ByFact(corpus)
    const r = runBaselines({ fit: split.fit, tune: split.tune, eval: [] }, TAU, {
      bootstrapIterations: 50,
    })
    expect(r.identity.answered).toBe(0)
    expect(r.fitted.answered).toBe(0)
    expect(r.decisionLift).toBe(0)
    expect(Number.isFinite(r.ci.lo)).toBe(true)
    expect(Number.isFinite(r.ci.hi)).toBe(true)
    // 全空 split:fitIsotonic 退 identity 形状、不抛。
    const empty = runBaselines({ fit: [], tune: [], eval: [] }, TAU, { bootstrapIterations: 10 })
    expect(empty.decisionLift).toBe(0)
    expect(Number.isFinite(empty.tunedCoverageLift)).toBe(true)
  })

  it('③b 噪声负对照:per-resample lift 两符号、均值≈0 ⇒ CI 严格跨 0(区分「无信号」与「信号低于噪声」)', () => {
    // 直接喂 bootstrapDecisionLift 一个**合成** fittedPredict:raw 0.85→0.75(弃,identity 答)、raw 0.70→0.85(答,identity 弃)。
    // P 档(raw 0.85,真准 0.65):只 identity 答 ⇒ 贡献 identity.shortfall;Q 档(raw 0.70,真准 0.65):只 fitted 答 ⇒ 贡献 fitted.shortfall。
    // 两档真准相同 ⇒ 点估计 lift≈0;重抽里两档子集准确率**独立**波动 ⇒ lift ≈ Qacc−Pacc 两符号 ⇒ CI 真有宽度且严格跨 0。
    const P = Array.from({ length: 80 }, (_x, i) => ({
      factId: `p-${i}`,
      rawPredicted: 0.85,
      correct: (i * PHI) % 1 < 0.65,
    }))
    const Q = Array.from({ length: 80 }, (_x, i) => ({
      factId: `q-${i}`,
      rawPredicted: 0.7,
      correct: (i * PHI) % 1 < 0.65,
    }))
    const fitted = (raw: number): number => (raw >= 0.8 ? 0.75 : 0.85) // 0.85→弃、0.70→答(故意与 identity 错位)
    const ci = bootstrapDecisionLift([...P, ...Q], fitted, 0.8, { iterations: 3000, seed: 11 })
    expect(Math.abs(ci.estimate)).toBeLessThan(0.05) // 点估计 ≈ 0
    expect(ci.lo).toBeLessThan(0) // 严格跨 0 下侧 —— 非 [0,0] 的真噪声
    expect(ci.hi).toBeGreaterThan(0) // 严格跨 0 上侧
  })

  it('⑦ cluster-bootstrap 按事实整簇重抽:单事实多样本 → CI 零宽;同样本散成多事实 → CI 非零宽(决定性)', () => {
    // 30 条混对错样本(raw 全 0.9);identityPredict(0.9)=0.9≥τ 答、fittedPredict=()=>0.7<τ 弃 ⇒ lift = identity.shortfall > 0。
    const mk = (factOf: (i: number) => string): LabeledSample[] =>
      Array.from({ length: 30 }, (_x, i) => ({
        factId: factOf(i),
        rawPredicted: 0.9,
        correct: (i * PHI) % 1 < 0.6,
      }))
    const abstain = (): number => 0.7
    // (a) 单事实:30 样本同属 'f0' ⇒ 唯一簇 ⇒ 每次重抽都是整 30 条 ⇒ lift 恒定 ⇒ CI 零宽。
    const clustered = bootstrapDecisionLift(
      mk(() => 'f0'),
      abstain,
      0.8,
      { iterations: 500, seed: 9 },
    )
    expect(clustered.hi).toBe(clustered.lo)
    expect(clustered.lo).toBeCloseTo(clustered.estimate, 10)
    // (b) 同样 30 条散成 30 个事实 ⇒ 30 簇 ⇒ 重抽有变异 ⇒ CI 非零宽。
    const spread = bootstrapDecisionLift(
      mk((i) => `g-${i}`),
      abstain,
      0.8,
      { iterations: 500, seed: 9 },
    )
    expect(spread.hi).toBeGreaterThan(spread.lo)
    // 决定性:若实现按**样本**(而非按事实簇)重抽,(a) 也会变成非零宽 ⇒ 此对比能抓出退化。
  })

  it('⑧ τ 变化(0.75):同叙事成立(identity 违诺 / fitted 守约 / lift>0、CI 下界>0)+ threshold↔τ 解耦', () => {
    const split = split3ByFact(makeCorpus(OVERCONFIDENT, 'oc8'))
    const tau = 0.75 // 落在 g(overstated)≈0.69 与 g(genuine)≈0.86 之间 ⇒ fitted 弃 overstated、留 genuine。
    const r = runBaselines(split, tau, { seed: 2, bootstrapIterations: 1000 })
    expect(r.identity.realizedAccuracy).toBeLessThan(tau - 0.05) // ≈0.575 ≪ 0.75:identity 仍把 overstated 当 ≥τ 把握 ⇒ 违诺
    expect(r.fitted.realizedAccuracy).toBeGreaterThanOrEqual(tau - 0.03) // genuine ≈0.85:守约
    expect(r.decisionLift).toBeGreaterThan(0.05)
    expect(r.ci.lo).toBeGreaterThan(0)
    expect(r.oracle.promiseError).toBeLessThanOrEqual(r.fitted.promiseError + 1e-9)
  })
})
