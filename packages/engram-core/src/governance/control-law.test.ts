/**
 * 纯控制律单测（S26）—— 无 DB。证明：确定性、live-derived 平衡点、收敛收缩律、闭环 counter-force、gate 映射不变量。
 */
import { describe, expect, it } from 'vitest'

import { KERNEL_CONFIDENCE_FLOOR, MUST_VERIFY_THRESHOLD } from '../confidence/confidence.js'
import {
  BASELINE_POLICY,
  DEFAULT_CONTROL_CONFIG,
  deriveTargets,
  stepController,
  type GovernanceMetrics,
  type GovernancePolicy,
} from './control-law.js'
import { gateThresholdsFor, gateWouldTighten, standardsInputFromPolicy } from './gate-policy.js'

const HEALTHY: GovernanceMetrics = {
  distillBacklog: 0,
  entailRejectRate: 0,
  conflictQueueDepth: 0,
  immuneLag: 0,
  falseQuarantineRate: 0,
}

const STRESSED: GovernanceMetrics = {
  distillBacklog: 100, // > backlogScale 50 → 满压
  entailRejectRate: 0.8,
  conflictQueueDepth: 40, // > conflictScale 20 → 满压
  immuneLag: 7200, // 2h > lagScale 3600 → 满压
  falseQuarantineRate: 0,
}

describe('S26 control law — determinism', () => {
  it('is reproducible: same (prev, metrics, config) → identical policy', () => {
    const a = stepController(BASELINE_POLICY, STRESSED, DEFAULT_CONTROL_CONFIG)
    const b = stepController(BASELINE_POLICY, STRESSED, DEFAULT_CONTROL_CONFIG)
    expect(a.policy).toEqual(b.policy)
    expect(a.targets).toEqual(b.targets)
  })

  it('is a pure function: it does not mutate the previous policy object', () => {
    const prev: GovernancePolicy = { ...BASELINE_POLICY }
    const snapshot = { ...prev }
    stepController(prev, STRESSED)
    expect(prev).toEqual(snapshot)
  })
})

describe('S26 control law — live-derived balance point (NOT a hardcoded constant)', () => {
  it('two different health profiles produce demonstrably different derived policy', () => {
    const healthyStep = stepController(BASELINE_POLICY, HEALTHY)
    const stressedStep = stepController(BASELINE_POLICY, STRESSED)
    // healthy: targets all 0 (within deadband of baseline 0) → policy unchanged, gate stays optimistic
    expect(healthyStep.targets.promotionGateLevel).toBe(0)
    expect(healthyStep.changed).toBe(false)
    // stressed: every tightening knob's target is high, policy moves up
    expect(stressedStep.targets.promotionGateLevel).toBeGreaterThan(0.5)
    expect(stressedStep.targets.ingestionThrottle).toBe(1)
    expect(stressedStep.targets.arbiterPriority).toBe(1)
    expect(stressedStep.policy.promotionGateLevel).toBeGreaterThan(0)
    expect(stressedStep.changed).toBe(true)
    // the derived gate threshold differs between the two health inputs (live, not constant)
    const healthyGate = gateThresholdsFor(healthyStep.policy.promotionGateLevel)
    const stressedGate = gateThresholdsFor(stressedStep.policy.promotionGateLevel)
    expect(stressedGate.consumeFloor).toBeGreaterThan(healthyGate.consumeFloor)
  })

  it('promotionGateLevel target tracks entailRejectRate monotonically (not fixed)', () => {
    const low = deriveTargets({ ...HEALTHY, entailRejectRate: 0.2 }).promotionGateLevel
    const mid = deriveTargets({ ...HEALTHY, entailRejectRate: 0.5 }).promotionGateLevel
    const high = deriveTargets({ ...HEALTHY, entailRejectRate: 0.9 }).promotionGateLevel
    expect(low).toBeLessThan(mid)
    expect(mid).toBeLessThan(high)
  })
})

describe('S26 control law — deadband + contraction (non-oscillation math)', () => {
  it('within deadband: knob does not move (hysteresis stops chatter)', () => {
    // target tiny vs prev 0 → |error| ≤ deadband → no change
    const step = stepController(BASELINE_POLICY, { ...HEALTHY, entailRejectRate: 0.01 })
    expect(step.policy.promotionGateLevel).toBe(0) // 0.01 ≤ deadband 0.02
    expect(step.changed).toBe(false)
  })

  it('outside deadband: |next−target| = |prev−target|·(1−gain) (strict contraction, no overshoot)', () => {
    const target = 0.8
    const prev: GovernancePolicy = { ...BASELINE_POLICY, promotionGateLevel: 0 }
    // entailRejectRate 0.8 → target 0.8; gain 0.5 capped at maxStep 0.25 → step is +0.25 (maxStep-limited)
    const s1 = stepController(prev, { ...HEALTHY, entailRejectRate: target })
    expect(s1.policy.promotionGateLevel).toBeCloseTo(0.25, 9) // min(gain·0.8, maxStep)=0.25
    // step never overshoots the target and always moves toward it
    expect(s1.policy.promotionGateLevel).toBeLessThanOrEqual(target)
    expect(s1.policy.promotionGateLevel).toBeGreaterThan(prev.promotionGateLevel)
  })

  it('once close, gain (not maxStep) governs and the error shrinks geometrically', () => {
    // prev near target so gain·error < maxStep: error must shrink by exactly (1−gain)
    const cfg = DEFAULT_CONTROL_CONFIG
    const target = 0.5
    const prev: GovernancePolicy = { ...BASELINE_POLICY, promotionGateLevel: 0.4 }
    const s = stepController(prev, { ...HEALTHY, entailRejectRate: target }, cfg)
    const errBefore = target - prev.promotionGateLevel // 0.1
    const errAfter = target - s.policy.promotionGateLevel
    expect(errAfter).toBeCloseTo(errBefore * (1 - cfg.gain), 9) // 0.05
  })
})

describe('S26 control law — closed-loop counter-force (falseQuarantineRate loosens patrol)', () => {
  it('rising falseQuarantineRate lowers the patrol target (opposes immuneLag tightening)', () => {
    const base = deriveTargets({ ...HEALTHY, immuneLag: 3600, falseQuarantineRate: 0 })
    const loosened = deriveTargets({ ...HEALTHY, immuneLag: 3600, falseQuarantineRate: 0.6 })
    expect(base.patrolFrequency).toBe(1) // lag at full scale → max patrol
    expect(loosened.patrolFrequency).toBeLessThan(base.patrolFrequency) // counter-force engaged
    expect(loosened.patrolFrequency).toBeCloseTo(0.4, 9) // 1 − 1·0.6
  })

  it('high falseQuarantineRate with no lag pins patrol target at 0 (fully loosened)', () => {
    const t = deriveTargets({ ...HEALTHY, immuneLag: 0, falseQuarantineRate: 0.9 })
    expect(t.patrolFrequency).toBe(0)
  })
})

describe('S26 gate mapping — only RAISE above kernel floors (red line #2 / S7 invariants)', () => {
  it('level 0 → kernel baseline (0.4 / 0.6); never below kernel floors', () => {
    const g0 = gateThresholdsFor(0)
    expect(g0.consumeFloor).toBe(KERNEL_CONFIDENCE_FLOOR)
    expect(g0.mustVerifyThreshold).toBe(MUST_VERIFY_THRESHOLD)
  })

  it('is monotone non-decreasing and always satisfies floor ≤ consume ≤ mustVerify ≤ 1', () => {
    let prevC = -1
    let prevV = -1
    for (let level = 0; level <= 1.0001; level += 0.1) {
      const g = gateThresholdsFor(level)
      expect(g.consumeFloor).toBeGreaterThanOrEqual(KERNEL_CONFIDENCE_FLOOR)
      expect(g.mustVerifyThreshold).toBeGreaterThanOrEqual(MUST_VERIFY_THRESHOLD)
      expect(g.consumeFloor).toBeLessThanOrEqual(g.mustVerifyThreshold)
      expect(g.mustVerifyThreshold).toBeLessThanOrEqual(1)
      expect(g.consumeFloor).toBeGreaterThanOrEqual(prevC)
      expect(g.mustVerifyThreshold).toBeGreaterThanOrEqual(prevV)
      prevC = g.consumeFloor
      prevV = g.mustVerifyThreshold
    }
  })

  it('a clamped negative/over level still stays within kernel bounds (silent-safe)', () => {
    expect(gateThresholdsFor(-5)).toEqual(gateThresholdsFor(0))
    expect(gateThresholdsFor(99)).toEqual(gateThresholdsFor(1))
  })

  it('standardsInputFromPolicy carries the active weights unchanged (controller only raises the gate, never touches weights)', () => {
    const weights = {
      authority: 0.3,
      humanReview: 0.3,
      entailment: 0.15,
      indepSupport: 0.15,
      usageCorrect: 0.1,
    }
    const input = standardsInputFromPolicy({ ...BASELINE_POLICY, promotionGateLevel: 0.5 }, weights)
    expect(input.factorWeights).toEqual(weights)
    expect(input.consumeFloor).toBeGreaterThan(KERNEL_CONFIDENCE_FLOOR)
  })

  it('gateWouldTighten is false at baseline and true when the derived gate exceeds the active standards', () => {
    const active = {
      factorWeights: {
        authority: 0.3,
        humanReview: 0.3,
        entailment: 0.15,
        indepSupport: 0.15,
        usageCorrect: 0.1,
      },
      consumeFloor: KERNEL_CONFIDENCE_FLOOR,
      mustVerifyThreshold: MUST_VERIFY_THRESHOLD,
    }
    expect(gateWouldTighten(BASELINE_POLICY, active)).toBe(false)
    expect(gateWouldTighten({ ...BASELINE_POLICY, promotionGateLevel: 0.5 }, active)).toBe(true)
  })
})
