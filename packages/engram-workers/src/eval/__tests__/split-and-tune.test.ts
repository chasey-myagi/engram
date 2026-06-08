/**
 * S6 · 3-way 切分 + 盲化阈值选择器 CI 守门(纯函数,零 DB)。验:① 按事实切三份(精确 60/20/20)+ 空/小样本边界;
 * ①b 多样本事实整组同份(防 per-fact 退化);② splitSizesOk 真能拦小样本退化份;③ tuneThreshold 选 max-coverage 达标阈值
 * + 空样本兜底;④ target 不可达全弃答(哨兵 +∞);⑤ **严格单调 g 的 ranking-invariance**(校准不帮 ranking);
 * ⑤b **弱单调(isotonic 平台段)g 打破不变式**(平台粗化排序、≠ identity——故价值在 S7 固定 τ,不在调阈值);
 * ⑦ A3 源扫守卫(只 import decision-core,不触 calibration/g);⑧ split3ByFact 对输入行序不敏感(确定性)。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { computeDecisionMetrics } from '../decision-value/decision-core.js'
import {
  split3ByFact,
  splitSizesOk,
  tuneThreshold,
  type LabeledSample,
} from '../decision-value/split-and-tune.js'

const identity = (raw: number) => raw

/** 造 n 个事实、各一条样本(factId 唯一)。 */
function makeFacts(n: number, fn: (i: number) => { rawPredicted: number; correct: boolean }) {
  return Array.from({ length: n }, (_x, i) => ({
    factId: `f-${String(i).padStart(3, '0')}`,
    ...fn(i),
  }))
}

describe('S6 · 3-way 切分 + 盲化调参', () => {
  it('① split3ByFact:按事实整组切三份、零跨份、精确 60/20/20', () => {
    const samples = makeFacts(50, (i) => ({
      rawPredicted: 0.5 + (i % 10) * 0.01,
      correct: i % 2 === 0,
    }))
    const sp = split3ByFact(samples)
    expect(sp.factsInAnyTwoSides).toBe(0)
    expect(sp.fit.length + sp.tune.length + sp.eval.length).toBe(50)
    // 单一模数 5 ⇒ N=50 精确 30/10/10(钉死比例,防 mod 映射回归)。
    expect(sp.eval.length).toBe(10)
    expect(sp.tune.length).toBe(10)
    expect(sp.fit.length).toBe(30)
    // 每个 factId 只出现在一份里。
    const ids = (xs: LabeledSample[]) => new Set(xs.map((s) => s.factId))
    const fitIds = ids(sp.fit)
    const tuneIds = ids(sp.tune)
    const evalIds = ids(sp.eval)
    for (const id of fitIds) expect(tuneIds.has(id) || evalIds.has(id)).toBe(false)
    for (const id of tuneIds) expect(evalIds.has(id)).toBe(false)
  })

  it('①b 多样本事实:同一 factId 的**全部**样本落入同一份(防 per-fact 退化成 per-sample)', () => {
    const samples: LabeledSample[] = []
    for (let f = 0; f < 15; f++) {
      for (let k = 0; k < 3; k++) {
        samples.push({
          factId: `m-${String(f).padStart(2, '0')}`,
          rawPredicted: 0.5 + 0.01 * k,
          correct: k % 2 === 0,
        })
      }
    }
    const sp = split3ByFact(samples)
    expect(sp.factsInAnyTwoSides).toBe(0) // 从实际三份数组独立重算:per-sample 退化会让它 >0
    expect(sp.fit.length + sp.tune.length + sp.eval.length).toBe(45)
    const countByFact = (xs: LabeledSample[]) => {
      const m = new Map<string, number>()
      for (const s of xs) m.set(s.factId, (m.get(s.factId) ?? 0) + 1)
      return m
    }
    const fc = countByFact(sp.fit)
    const tc = countByFact(sp.tune)
    const ec = countByFact(sp.eval)
    for (const id of new Set(samples.map((s) => s.factId))) {
      const present = [fc.get(id) ?? 0, tc.get(id) ?? 0, ec.get(id) ?? 0].filter((c) => c > 0)
      expect(present.length).toBe(1)
      expect(present[0]).toBe(3)
    }
  })

  it('①c 空输入:split3ByFact([]) → 三份皆空、factsInAnyTwoSides=0(不抛、不 NaN)', () => {
    const sp = split3ByFact([])
    expect(sp.fit).toEqual([])
    expect(sp.tune).toEqual([])
    expect(sp.eval).toEqual([])
    expect(sp.factsInAnyTwoSides).toBe(0)
  })

  it('② splitSizesOk:真能拦小样本退化份(min-N 门的存在理由)', () => {
    // N=2:i0→eval、i1→tune ⇒ fit 空。小样本退化 → 不达门。
    const small = split3ByFact(makeFacts(2, (i) => ({ rawPredicted: 0.55, correct: i % 2 === 0 })))
    expect(small.fit.length).toBe(0)
    expect(splitSizesOk(small, 1)).toBe(false) // fit 空 → 拒(就是它该拦的)
    // N=60:eval/tune 各 12、fit 36;等值边界 12>=12 过、13 不过。
    const big = split3ByFact(makeFacts(60, (i) => ({ rawPredicted: 0.55, correct: i % 2 === 0 })))
    expect(splitSizesOk(big, 12)).toBe(true)
    expect(splitSizesOk(big, 13)).toBe(false)
  })

  it('③ tuneThreshold:选 max coverage 且 answeredAccuracy≥target;多档达标取最低(最大 coverage)阈值', () => {
    const samples: LabeledSample[] = [
      ...makeFacts(5, (i) => ({ rawPredicted: 0.6, correct: i < 3 })), // 3/5 对
      ...makeFacts(5, () => ({ rawPredicted: 0.9, correct: true })).map((s, i) => ({
        ...s,
        factId: `g-${i}`,
      })),
    ]
    const th = tuneThreshold(samples, identity, { targetAccuracy: 0.8 })
    // th=0.6:全答 acc 0.8≥0.8 coverage 1.0;th=0.9:coverage 0.5。两者都达标 → 取最低 0.6(最大 coverage)。
    expect(th).toBeCloseTo(0.6, 10)
    const m = computeDecisionMetrics(samples, identity, th)
    expect(m.coverage).toBeCloseTo(1, 10)
    expect(m.answeredAccuracy).toBeGreaterThanOrEqual(0.8)
  })

  it('④ target 不可达 / 空样本 → 全弃答兜底(哨兵 +∞、coverage=0、不抛)', () => {
    const bad = makeFacts(10, (i) => ({ rawPredicted: 0.5, correct: i < 1 })) // acc 0.1
    const thBad = tuneThreshold(bad, identity, { targetAccuracy: 0.8 })
    expect(thBad).toBe(Number.POSITIVE_INFINITY) // 哨兵 = +∞(不依赖 predict∈[0,1] 前置)
    expect(computeDecisionMetrics(bad, identity, thBad).answered).toBe(0)
    // 空样本:无候选 → 同样全弃答兜底。
    const thEmpty = tuneThreshold([], identity, { targetAccuracy: 0.8 })
    expect(thEmpty).toBe(Number.POSITIVE_INFINITY)
    expect(computeDecisionMetrics([], identity, thEmpty).answered).toBe(0)
  })

  it('⑤ 严格单调 g 的 ranking-invariance:identity 与严格单调 fitted-g 经同一调参器 → eval 答案集全等(校准不帮 ranking)', () => {
    // 有 spread 的样本(0.5 多错 / 0.7 半对 / 0.9 全对),切 fit/tune/eval。
    const samples = makeFacts(60, (i) => {
      const lvl = i % 3
      return {
        rawPredicted: [0.5, 0.7, 0.9][lvl]!,
        correct: lvl === 2 ? true : lvl === 1 ? i % 2 === 0 : false,
      }
    })
    const sp = split3ByFact(samples)
    const strictG = (raw: number) => raw * raw // **严格**单调升 on [0,1)、非常数(真重映射值、双射、不改 ranking)
    const thId = tuneThreshold(sp.tune, identity, { targetAccuracy: 0.7 })
    const thG = tuneThreshold(sp.tune, strictG, { targetAccuracy: 0.7 })
    const evalId = computeDecisionMetrics(sp.eval, identity, thId)
    const evalG = computeDecisionMetrics(sp.eval, strictG, thG)
    // 严格单调 g ⇒ 双射 ⇒ 「g(raw)≥th」⟺「raw≥g⁻¹(th)」⇒ 答案集族相同 ⇒ 同一调参器选同一 eval 答案集:coverage/accuracy 全等。
    // ⇒ 校准在「调阈值的选择性预测」上**零增益**;决策价值在 S7 的固定业务 τ promise-keeping,不在这里。
    expect(evalG.coverage).toBeCloseTo(evalId.coverage, 10)
    expect(evalG.answeredAccuracy).toBeCloseTo(evalId.answeredAccuracy, 10)
  })

  it('⑤b 弱单调(isotonic 平台段)g 打破 ranking-invariance:平台池化相邻 raw ⇒ 答案集族变粗、到不了 identity 能选的集', () => {
    // 真实 g 是 isotonic 回归(PAVA)= **弱**单调:把「对准确率非单调」的相邻 raw 档池化进同一平台值。
    // 平台跨过切点时,g 无法再分辨平台内的 raw 次序 ⇒ identity 能选出的某些答案集,g 选不出来。
    const evalSet: LabeledSample[] = [
      { factId: 'a', rawPredicted: 0.5, correct: false },
      { factId: 'b', rawPredicted: 0.6, correct: true },
      { factId: 'c', rawPredicted: 0.9, correct: true },
    ]
    // identity:阈值 ∈ (0.5, 0.6] ⇒ 恰答 {b, c},coverage 2/3。
    const idM = computeDecisionMetrics(evalSet, identity, 0.55)
    expect(idM.coverage).toBeCloseTo(2 / 3, 10)
    // 平台 g:把 0.5、0.6 池化到同一值 0.55(0.9 保留)⇒ 任何阈值下 0.5/0.6 必同进同退。
    const plateauG = (raw: number) => (raw <= 0.6 ? 0.55 : 0.9)
    const reachable = new Set(
      [...new Set(evalSet.map((s) => plateauG(s.rawPredicted)))].flatMap((th) => [
        computeDecisionMetrics(evalSet, plateauG, th).coverage, // 含等号档
        computeDecisionMetrics(evalSet, plateauG, th + 1e-9).coverage, // 紧邻其上档
      ]),
    )
    // 平台 g 可达 coverage ∈ {0, 1/3, 1};identity 的 2/3 **不可达** ⇒ 弱单调下 ranking-invariance 不成立(平台粗化了排序)。
    expect([...reachable].some((c) => Math.abs(c - 2 / 3) < 1e-9)).toBe(false)
    expect([...reachable].sort((x, y) => x - y)).toEqual([0, 1 / 3, 1])
    // 但平台只**粗化** raw 排序(池化的恰是噪声档),不是干净的 ranking 增益 ⇒ 校准的稳健决策价值仍在 S7 的固定 τ promise-keeping。
  })

  it('⑦ A3 源扫守卫:split-and-tune.ts 只 import ./decision-core.js,绝不触 calibration/g/governance', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'decision-value', 'split-and-tune.ts'),
      'utf8',
    )
    const importLines = src.split('\n').filter((l) => /^\s*import\s/.test(l))
    expect(importLines.length).toBeGreaterThan(0) // 它确有 import(decision-core),非空守卫
    // 每条 import 只能引 ./decision-core.js —— 任何新增依赖面(尤其 calibration/g)必须改这条守卫、强制有意识决策。
    for (const l of importLines) expect(l).toContain('./decision-core.js')
  })

  it('⑧ split3ByFact 对输入行序不敏感:打乱行序 → 同一 partition(确定性按 factId 排序)', () => {
    const base = makeFacts(20, (i) => ({ rawPredicted: 0.5 + 0.01 * i, correct: i % 2 === 0 }))
    const reversed = [...base].reverse()
    const a = split3ByFact(base)
    const b = split3ByFact(reversed)
    const sig = (xs: LabeledSample[]) => [...new Set(xs.map((s) => s.factId))].sort().join(',')
    expect(sig(b.fit)).toBe(sig(a.fit))
    expect(sig(b.tune)).toBe(sig(a.tune))
    expect(sig(b.eval)).toBe(sig(a.eval))
  })
})
