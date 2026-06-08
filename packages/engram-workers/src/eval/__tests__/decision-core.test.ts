/**
 * S4 · 决策核 CI 守门(纯函数,零 DB、零网络)。验:① answer/abstain 阈值;② 选择性预测指标手算对账;
 * ③ **置信敏感度门**(Plan A 的前置 gate:任务对校准非平的——按置信选择性回答严格优于全答,否则 A 没意义);
 * ④ predict 注入(identity vs g)改变决策;⑤ 决策核**零 import**(A3:物理上不触达 calibration/g/governance)。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  computeDecisionMetrics,
  decideAnswerOrAbstain,
  overallAccuracy,
  type DecisionSample,
} from '../decision-value/decision-core.js'

const identity = (raw: number) => raw

describe('S4 · 决策核(answer-vs-abstain 选择性预测)', () => {
  it('① 阈值决策:≥ 阈值答、否则弃答', () => {
    expect(decideAnswerOrAbstain(0.7, 0.7)).toBe('answer')
    expect(decideAnswerOrAbstain(0.69, 0.7)).toBe('abstain')
  })

  it('② 选择性预测指标手算对账', () => {
    const samples: DecisionSample[] = [
      { rawPredicted: 0.9, correct: true },
      { rawPredicted: 0.8, correct: true },
      { rawPredicted: 0.75, correct: false },
      { rawPredicted: 0.6, correct: false },
      { rawPredicted: 0.4, correct: false },
    ]
    // 阈值 0.7 identity:答 0.9/0.8/0.75 → answered=3、对 2、错 1。
    const m = computeDecisionMetrics(samples, identity, 0.7)
    expect(m.total).toBe(5)
    expect(m.answered).toBe(3)
    expect(m.coverage).toBeCloseTo(0.6, 10) // 3/5
    expect(m.answeredAccuracy).toBeCloseTo(2 / 3, 10)
    expect(m.selectiveRisk).toBeCloseTo(1 / 3, 10)
    expect(m.regret).toBeCloseTo(0.2, 10) // wrongAnswered 1 / total 5
  })

  it('②b answered=0 时 accuracy/selectiveRisk 为 NaN、regret=0、coverage=0', () => {
    const m = computeDecisionMetrics([{ rawPredicted: 0.3, correct: true }], identity, 0.9)
    expect(m.answered).toBe(0)
    expect(m.coverage).toBe(0)
    expect(Number.isNaN(m.answeredAccuracy)).toBe(true)
    expect(Number.isNaN(m.selectiveRisk)).toBe(true)
    expect(m.regret).toBe(0)
  })

  it('③ 置信敏感度门:中段阈值下 0<coverage<1 且 答对率 > 全答基线(置信携带决策信号)', () => {
    // 高置信组(0.58)多对、低置信组(0.52)多错;全集对率 0.5。
    const samples: DecisionSample[] = [
      ...Array.from({ length: 5 }, (_x, i) => ({ rawPredicted: 0.58, correct: i < 4 })), // 4/5 对
      ...Array.from({ length: 5 }, (_x, i) => ({ rawPredicted: 0.52, correct: i < 1 })), // 1/5 对
    ]
    expect(overallAccuracy(samples)).toBeCloseTo(0.5, 10)
    const m = computeDecisionMetrics(samples, identity, 0.55) // 中段阈值(落在两档之间)
    expect(m.coverage).toBeGreaterThan(0)
    expect(m.coverage).toBeLessThan(1) // 选择性:既不全答也不全弃
    // 关键:按置信选择性回答,答对率严格高于「全答」基线 ⇒ 置信对决策有用、任务非平 ⇒ Plan A 有意义。
    expect(m.answeredAccuracy).toBeGreaterThan(overallAccuracy(samples))
  })

  it('④ predict 注入改变决策:identity vs 一个重排的 g 给出不同 answered 集', () => {
    const samples: DecisionSample[] = [
      { rawPredicted: 0.58, correct: true },
      { rawPredicted: 0.52, correct: false },
    ]
    const threshold = 0.58
    const mId = computeDecisionMetrics(samples, identity, threshold) // 只 0.58 过门 → answered 1
    // g:把 0.52 抬到 0.6、把 0.58 压到 0.56 → answered 集翻转。
    const g = (raw: number) => (raw < 0.55 ? 0.6 : 0.56)
    const mG = computeDecisionMetrics(samples, g, threshold) // 只(原 0.52)过门 → answered 1 但换了对象
    expect(mId.answered).toBe(1)
    expect(mG.answered).toBe(1)
    // identity 答的是对的那条(accuracy 1),g 答的是错的那条(accuracy 0)——predict 实打实改了决策结果。
    expect(mId.answeredAccuracy).toBe(1)
    expect(mG.answeredAccuracy).toBe(0)
  })

  it('⑤ 决策核零 import:物理上不触达 calibration/g/governance(A3)', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'decision-value', 'decision-core.ts'),
      'utf8',
    )
    // 纯函数模块:不含任何 import 语句(predict 经回调注入,绝不 import 校准/治理)。
    expect(/^\s*import\s/m.test(src)).toBe(false)
  })
})
