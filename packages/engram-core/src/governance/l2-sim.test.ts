/**
 * L2 控制面仿真测试（S26，P2 门的 L2 半边）—— 给恒温器喂健康度时序，断言：
 *   (a) 控制信号**收敛/落定**（有界总变差 + N 步内落定 + **零符号翻转**，不振荡）；
 *   (b) 健康好转 → 收紧**在界内回弹**放松；
 *   (c) falseQuarantineRate 上升 → patrol **闭环放松**（counter-force 真的咬合）。
 * 非振荡断言**咬死**：assert signFlips===0 + totalVariation 有界（≤ |终值−起点| + 微小裕度，即单调路径）。
 */
import { describe, expect, it } from 'vitest'

import { BASELINE_POLICY, type GovernanceMetrics } from './control-law.js'
import { constantSeries, simulate } from './l2-sim.js'

const HEALTHY: GovernanceMetrics = {
  distillBacklog: 0,
  entailRejectRate: 0,
  conflictQueueDepth: 0,
  immuneLag: 0,
  falseQuarantineRate: 0,
}

describe('S26 L2 sim — convergence without oscillation (the P2 gate)', () => {
  it('constant stress: every knob settles within N steps, zero sign-flips, bounded total variation', () => {
    const stress: GovernanceMetrics = {
      distillBacklog: 60,
      entailRejectRate: 0.7,
      conflictQueueDepth: 25,
      immuneLag: 5400,
      falseQuarantineRate: 0,
    }
    const sim = simulate(constantSeries(stress, 40))
    expect(sim.convergedWithoutOscillation).toBe(true)
    expect(sim.anySignFlip).toBe(false)
    for (const knob of Object.values(sim.perKnob)) {
      // settles in a small number of steps (geometric: gain 0.5 → ~ a dozen steps to deadband)
      expect(knob.settledAtStep).not.toBeNull()
      expect(knob.settledAtStep!).toBeLessThanOrEqual(20)
      // BITE: monotone path ⇒ total variation equals net displacement (no ringing overshoot)
      const net = Math.abs(knob.finalValue - knob.series[0]!)
      expect(knob.totalVariation).toBeCloseTo(net, 6)
      expect(knob.signFlips).toBe(0)
    }
  })

  it('rising backlog + rising entail-reject (the spec time-series) converges, never oscillates', () => {
    // backlog and entail-reject ramp UP then hold — classic health-decline profile
    const series: GovernanceMetrics[] = []
    for (let i = 0; i < 10; i++) {
      series.push({
        ...HEALTHY,
        distillBacklog: Math.min(50, i * 8),
        entailRejectRate: Math.min(0.6, i * 0.07),
      })
    }
    // hold at the peak long enough to settle
    for (let i = 0; i < 30; i++) {
      series.push({ ...HEALTHY, distillBacklog: 50, entailRejectRate: 0.6 })
    }
    const sim = simulate(series)
    expect(sim.anySignFlip).toBe(false) // monotone climb then flat — never rings
    expect(sim.allSettled).toBe(true)
    // the two stressed knobs end elevated (within deadband of their targets); untouched knobs stay at 0.
    // deadband 0.02 means settle lands ≤ deadband below target — that's the hysteresis, not error.
    expect(sim.perKnob.ingestionThrottle.finalValue).toBeGreaterThan(1 - 0.02)
    expect(sim.perKnob.promotionGateLevel.finalValue).toBeGreaterThan(0.6 - 0.02)
    expect(sim.perKnob.promotionGateLevel.finalValue).toBeLessThanOrEqual(0.6)
    expect(sim.perKnob.arbiterPriority.finalValue).toBe(0)
    expect(sim.perKnob.patrolFrequency.finalValue).toBe(0)
  })

  it('recovery: after settling under stress, health improving relaxes the tightening back toward baseline within bounds', () => {
    const stress: GovernanceMetrics = {
      ...HEALTHY,
      distillBacklog: 60,
      entailRejectRate: 0.7,
      conflictQueueDepth: 25,
    }
    const series = [...constantSeries(stress, 30), ...constantSeries(HEALTHY, 30)]
    const sim = simulate(series)
    // a recovery reverses direction ONCE per knob (up then down) — that's a single, controlled sign-flip,
    // not ringing. Assert at most one flip per knob (deliberate set-point change, not oscillation).
    for (const knob of Object.values(sim.perKnob)) {
      expect(knob.signFlips).toBeLessThanOrEqual(1)
    }
    // and after recovery every knob has relaxed back to (within deadband of) the optimistic baseline
    expect(sim.perKnob.ingestionThrottle.finalValue).toBeLessThanOrEqual(0.02)
    expect(sim.perKnob.promotionGateLevel.finalValue).toBeLessThanOrEqual(0.02)
    expect(sim.perKnob.arbiterPriority.finalValue).toBeLessThanOrEqual(0.02)
  })

  it('closed-loop: a rising falseQuarantineRate demonstrably loosens patrol while immuneLag stays high', () => {
    // immuneLag pinned at full scale (would max out patrol); falseQuarantineRate ramps up over time.
    const series: GovernanceMetrics[] = []
    for (let i = 0; i < 25; i++) {
      series.push({ ...HEALTHY, immuneLag: 3600, falseQuarantineRate: Math.min(0.8, i * 0.04) })
    }
    const sim = simulate(series)
    const patrol = sim.perKnob.patrolFrequency
    // patrol first climbed (lag) then the counter-force pulled it back down → it ends well below the lag-only max
    const lagOnlyMax = 1 // immuneLag at full scale alone would target 1
    expect(patrol.finalValue).toBeLessThan(lagOnlyMax)
    expect(patrol.finalValue).toBeCloseTo(0.2, 1) // target ≈ 1 − 0.8 = 0.2
    // counter-force is the ONLY thing that moved it down; without it patrol would have stayed at 1
    const noCounterForce = simulate(constantSeries({ ...HEALTHY, immuneLag: 3600 }, 25))
    expect(noCounterForce.perKnob.patrolFrequency.finalValue).toBeGreaterThan(1 - 0.02)
    expect(patrol.finalValue).toBeLessThan(noCounterForce.perKnob.patrolFrequency.finalValue)
  })

  it('initial policy is never mutated and trajectory[0] is the untouched start', () => {
    const start = { ...BASELINE_POLICY, promotionGateLevel: 0.3 }
    const sim = simulate(constantSeries(HEALTHY, 5), { initial: start })
    expect(sim.trajectory[0]).toEqual(start)
    // a self-consistency check: deterministic re-run yields the identical trajectory
    const sim2 = simulate(constantSeries(HEALTHY, 5), { initial: { ...start } })
    expect(sim2.trajectory).toEqual(sim.trajectory)
  })
})
