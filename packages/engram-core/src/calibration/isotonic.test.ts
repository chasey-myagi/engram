/**
 * S28 isotonic 拟合器纯函数单测 —— PAVA 的确定性 / 单调性 / ECE 下降证明 / A3 输入边界（无 ELO 通道）/ FIX 3 退化拒。
 * 零 DB、零随机。DB 集成（≥200 门 + usage_truth 取样 + 验收门原子换 + 写路径 map 接线）在 __tests__/calibration-isotonic.test.ts。
 */
import { describe, expect, it } from 'vitest'

import { applyGMap, assertCalibrationMap, type CalibrationMap } from '../confidence/confidence.js'
import { computeReliability } from './calibration.js'
import { fitIsotonic, makeIsotonicFitter } from './isotonic.js'
import { runAcceptanceGate, type GateInputs } from './acceptance-gate.js'
import type { GoldenSample } from './advisor.js'

/**
 * 合成「错校准」样本：低 raw 段反而更常正确、高 raw 段反而更常错（identity 下 ECE 大）。
 * 但保持 observed 关于 raw **整体非递减**（isotonic 该能把它单调地拉到接近 observed，显著降 ECE）。
 * 每桶塞足量样本（让验收门 ⑤ 也能过）。
 */
function miscalibratedSamples(): GoldenSample[] {
  const s: GoldenSample[] = []
  // 10 个桶，桶心 raw=0.05..0.95；observed 目标随 raw 单调上升但与 raw **本身偏离**（identity 误差大）。
  // observedTarget: 低 raw 段被低估（实际更准）、高 raw 段被高估（实际更不准）—— 经典 S 形错校准。
  const targets = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.62, 0.64, 0.66]
  for (let b = 0; b < 10; b++) {
    const center = b / 10 + 0.05
    const want = targets[b]!
    // 20 条/桶：want·20 条正确、其余错。
    const correctCount = Math.round(want * 20)
    for (let k = 0; k < 20; k++) s.push({ rawPredicted: center, correct: k < correctCount })
  }
  return s
}

describe('S28 fitIsotonic（PAVA：确定性 + 单调 + 满足写时不变量）', () => {
  it('产出满足 assertCalibrationMap（x 严格升序、y 非递减、值域 [0,1]）且 ≥2 个不同 knot', () => {
    const map = fitIsotonic(miscalibratedSamples(), 'iso-1')
    expect(() => assertCalibrationMap(map)).not.toThrow()
    expect(map.knots.length).toBeGreaterThanOrEqual(2)
    // x 严格升序
    for (let i = 1; i < map.knots.length; i++) {
      expect(map.knots[i]!.x).toBeGreaterThan(map.knots[i - 1]!.x)
      expect(map.knots[i]!.y).toBeGreaterThanOrEqual(map.knots[i - 1]!.y)
    }
  })

  it('确定性：同一组样本（且样本顺序打乱）→ 逐字相同的 knots（PAVA 无随机）', () => {
    const samples = miscalibratedSamples()
    const a = fitIsotonic(samples, 'iso-det')
    const b = fitIsotonic(samples, 'iso-det')
    expect(b.knots).toEqual(a.knots) // rerun 全等
    // 打乱顺序也等（内部稳定排序 ⇒ 顺序无关）。
    const shuffled = [...samples].reverse()
    const c = fitIsotonic(shuffled, 'iso-det')
    expect(c.knots).toEqual(a.knots)
  })

  it('单调性：g′ 保序——raw 升 → g′(raw) 非递减（校准不破坏排序）', () => {
    const map = fitIsotonic(miscalibratedSamples(), 'iso-mono')
    let prev = -1
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const y = applyGMap(x, map)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = y
    }
  })

  it('ECE 下降证明：错校准数据下，isotonic g′ 的 ECE 显著低于 identity 基线', () => {
    const samples = miscalibratedSamples()
    const eceIdentity = computeReliability(
      samples.map((s) => ({ predicted: s.rawPredicted, correct: s.correct })),
      10,
    ).ece
    const map = fitIsotonic(samples, 'iso-ece')
    const eceFitted = computeReliability(
      samples.map((s) => ({ predicted: applyGMap(s.rawPredicted, map), correct: s.correct })),
      10,
    ).ece
    // 核心命门 payoff：拟合后 ECE 严格更低。
    expect(eceFitted).toBeLessThan(eceIdentity)
    // 而且降幅可观（不是浮点噪声）。
    expect(eceIdentity - eceFitted).toBeGreaterThan(0.02)
  })

  it('A3 红线：拟合器输入**只有** {rawPredicted, correct}——无任何 ELO/胜负率字段可进（结构性）', () => {
    // 这条以类型 + 结构断言守边界：GoldenSample 只有两字段；构造样本时多塞的字段会被 TS 拒（编译期），
    // 运行期 fitIsotonic 也只读这两字段。这里断言「即使数据里塞了别的，结果只由这两字段决定」。
    const base: GoldenSample[] = miscalibratedSamples()
    // 给每条样本附加一个伪 winRate/elo 字段（用 any 绕过类型）——拟合结果必须与不带它时逐字一致。
    const withNoise = base.map(
      (s) => ({ ...s, winRate: Math.random(), elo: 1500 + Math.random() * 400 }) as GoldenSample,
    )
    const clean = fitIsotonic(base, 'iso-a3')
    const noisy = fitIsotonic(withNoise, 'iso-a3')
    expect(noisy.knots).toEqual(clean.knots) // ELO/胜负率噪声字段对 g 零影响
  })

  it('退化拒（FIX 3）：全程同一 observed 的样本 → 拟合出常值/单段 g → 验收门 ⑥ output_spread 拒', () => {
    // 所有样本同 observed=0.5（与 raw 无关）→ PAVA 合并成一个 block → 折成同 y 的两端点（spread=0）。
    // 样本 raw 全在 [0.6,0.9]：identity 与拟合出的常值 0.5 都 ≥floor 0.4（无翻转、③ 过）⇒ 首个未过项确是 ⑥。
    const flat: GoldenSample[] = []
    for (const center of [0.65, 0.75, 0.85]) {
      for (let k = 0; k < 20; k++) flat.push({ rawPredicted: center, correct: k % 2 === 0 })
    }
    const map = fitIsotonic(flat, 'iso-flat')
    // 常值 g：所有 knot 同 y（spread=0）。
    const ys = new Set(map.knots.map((k) => k.y))
    expect(ys.size).toBe(1)
    expect(map.knots[0]!.y).toBeCloseTo(0.5, 6)
    const reliability = computeReliability(
      flat.map((s) => ({ predicted: applyGMap(s.rawPredicted, map), correct: s.correct })),
      10,
    )
    const inputs: GateInputs = {
      candidate: map,
      current: { version: 'identity', knots: [] },
      consumeFloor: 0.4,
      promotionGateLevel: 0,
      sampleRaws: flat.map((s) => s.rawPredicted),
      reliability,
    }
    const verdict = runAcceptanceGate(inputs)
    expect(verdict.checks.find((c) => c.id === 'consumption_flip')!.passed).toBe(true)
    expect(verdict.approved).toBe(false)
    expect(verdict.failedCheck).toBe('output_spread')
  })

  it('makeIsotonicFitter 适配 CalibrationFitter 端口：闭包进版本名、与 fitIsotonic 等价', () => {
    const fitter = makeIsotonicFitter('iso-port')
    const samples = miscalibratedSamples()
    const viaPort: CalibrationMap = fitter(samples)
    expect(viaPort).toEqual(fitIsotonic(samples, 'iso-port'))
  })
})
