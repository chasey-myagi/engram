import { describe, expect, it } from 'vitest'

import {
  CALIBRATION_IDENTITY,
  DEFAULT_WEIGHTS,
  NEUTRAL_FACTORS,
  type AdditiveFactors,
  type FactorWeights,
  applyG,
  computeBase,
  computeConfidence,
  computeRaw,
  conflictDecay,
  halfLifeDaysForKind,
  independentSupportScore,
  staleDecay,
} from './confidence.js'

const noPenalty = { ageDays: 0, halfLifeDays: 730, activeContradicts: 0 }
const f = (over: Partial<AdditiveFactors> = {}): AdditiveFactors => ({
  ...NEUTRAL_FACTORS,
  ...over,
})

describe('命门 — continuous 7-factor confidence (A.3)', () => {
  it('is a pure function: same factor vector always yields the same raw, always in [0,1]', () => {
    const factors = f({ authority: 0.7, indepSupport: 0.4 })
    const r1 = computeRaw(factors, noPenalty)
    const r2 = computeRaw(factors, noPenalty)
    expect(r1).toBe(r2)
    expect(r1).toBeGreaterThanOrEqual(0)
    expect(r1).toBeLessThanOrEqual(1)
  })

  it('raw is continuous over an authority sweep — no 5-bucket plateau (replaces min(1,sources×0.3))', () => {
    const xs = Array.from({ length: 51 }, (_, i) => i / 50) // 0.00 .. 1.00
    const raws = xs.map((a) => computeRaw(f({ authority: a }), noPenalty))
    const distinct = new Set(raws.map((r) => r.toFixed(6)))
    expect(distinct.size).toBe(raws.length) // every step changes raw — strictly continuous, not bucketed
  })

  it('raw is strictly monotonic increasing in each additive factor', () => {
    for (const key of [
      'authority',
      'humanReview',
      'entailment',
      'indepSupport',
      'usageCorrect',
    ] as const) {
      const lo = computeRaw(f({ [key]: 0.2 }), noPenalty)
      const hi = computeRaw(f({ [key]: 0.8 }), noPenalty)
      expect(hi).toBeGreaterThan(lo)
    }
  })

  it('staleDecay halves at one half-life and decreases monotonically', () => {
    expect(staleDecay(0, 730)).toBe(1)
    expect(staleDecay(730, 730)).toBeCloseTo(0.5, 10)
    expect(staleDecay(1460, 730)).toBeCloseTo(0.25, 10)
    expect(staleDecay(400, 730)).toBeGreaterThan(staleDecay(800, 730))
  })

  it('conflictDecay is 1 with no conflict and decreases as active contradicts grow', () => {
    expect(conflictDecay(0)).toBe(1)
    expect(conflictDecay(1)).toBeCloseTo(1 / 1.5, 10)
    expect(conflictDecay(2)).toBeLessThan(conflictDecay(1))
  })

  it('a single high-authority (official datasheet) source clears raw > 0.3 — the old stub root cause is gone', () => {
    // old stub locked a single source (even an official datasheet) at 0.300 < 0.6 gate
    const raw = computeRaw(f({ authority: 0.9 }), noPenalty) // entailment neutral 0.5, rest 0
    expect(raw).toBeGreaterThan(0.3)
  })

  it('throws when Σw ≠ 1 or the authority (provenance) weight is 0 (protects D1 + normalization)', () => {
    const badSum: FactorWeights = { ...DEFAULT_WEIGHTS, authority: 0.5 } // Σ = 1.2
    expect(() => computeBase(f({ authority: 1 }), badSum)).toThrow(/Σw|sum/i)
    const zeroAuthority: FactorWeights = {
      authority: 0,
      humanReview: 0.4,
      entailment: 0.3,
      indepSupport: 0.2,
      usageCorrect: 0.1,
    }
    expect(() => computeBase(f({ authority: 1 }), zeroAuthority)).toThrow(/authority|D1/i)
  })

  it('g = identity ⇒ confidence === raw, and the snapshot records 7 factors + weights + calibration version', () => {
    const snap = computeConfidence(f({ authority: 0.8, indepSupport: 0.5 }), {
      ageDays: 100,
      halfLifeDays: 730,
      activeContradicts: 1,
    })
    expect(snap.calibrationVersion).toBe(CALIBRATION_IDENTITY)
    expect(snap.confidence).toBe(snap.confidenceRaw) // identity
    // 7 factors recorded: 5 additive + the 2 penalties (with their decays) for replay
    expect(snap.factors.authority).toBe(0.8)
    expect(snap.factors.indepSupport).toBe(0.5)
    expect(snap.factors.ageDays).toBe(100)
    expect(snap.factors.activeContradicts).toBe(1)
    expect(snap.factors.staleDecay).toBeCloseTo(staleDecay(100, 730), 10)
    expect(snap.factors.conflictDecay).toBeCloseTo(conflictDecay(1), 10)
    expect(snap.weights).toEqual(DEFAULT_WEIGHTS)
  })

  it('applyG rejects an unknown calibration version', () => {
    expect(() => applyG(0.5, 'isotonic-v7')).toThrow(/calibration/i)
  })

  it('clamps out-of-range factors so raw stays in [0,1] (the core invariant guard)', () => {
    const over = computeRaw(f({ authority: 1.5, entailment: 2 }), noPenalty)
    expect(over).toBe(computeRaw(f({ authority: 1, entailment: 1 }), noPenalty)) // 1.5/2 dragged to 1
    expect(over).toBeLessThanOrEqual(1)
    const under = computeRaw(f({ authority: -0.5 }), noPenalty)
    expect(under).toBe(computeRaw(f({ authority: 0 }), noPenalty)) // -0.5 → 0
    expect(under).toBeGreaterThanOrEqual(0)
  })

  it('treats negative ageDays / activeContradicts as no penalty (decay = 1)', () => {
    expect(staleDecay(-10, 730)).toBe(1)
    expect(conflictDecay(-1)).toBe(1)
  })

  it('staleDecay throws on a non-positive half-life', () => {
    expect(() => staleDecay(10, 0)).toThrow(/halfLife/i)
    expect(() => staleDecay(10, -5)).toThrow(/halfLife/i)
  })

  it('independentSupportScore: 1 source = 0 (no corroboration), rising + saturating with more', () => {
    expect(independentSupportScore(1)).toBe(0)
    expect(independentSupportScore(2)).toBeCloseTo(0.5, 10)
    expect(independentSupportScore(3)).toBeCloseTo(0.75, 10)
    expect(independentSupportScore(2)).toBeLessThan(independentSupportScore(4)) // monotonic
    expect(independentSupportScore(0)).toBe(0) // guard (n<1)
  })

  it('applyG default argument is identity', () => {
    expect(applyG(0.42)).toBe(0.42)
  })

  it('honors custom (config-state) weights — base shifts with the weight vector', () => {
    const factors = f({ authority: 1 }) // only authority high
    const heavyAuthority: FactorWeights = {
      authority: 0.6,
      humanReview: 0.1,
      entailment: 0.1,
      indepSupport: 0.1,
      usageCorrect: 0.1,
    }
    expect(computeBase(factors, heavyAuthority)).toBeGreaterThan(
      computeBase(factors, DEFAULT_WEIGHTS),
    )
  })

  it('maps source kinds to A.3 half-lives (formal 730 / artifact 180 / conversation 90; external_feed shortest)', () => {
    expect(halfLifeDaysForKind('formal_document')).toBe(730)
    expect(halfLifeDaysForKind('structured_spec')).toBe(730)
    expect(halfLifeDaysForKind('historical_artifact')).toBe(180)
    expect(halfLifeDaysForKind('agent_synthesis')).toBe(180)
    expect(halfLifeDaysForKind('human_qa')).toBe(90)
    expect(halfLifeDaysForKind('conversation_log')).toBe(90)
    expect(halfLifeDaysForKind('external_feed')).toBe(90) // 近实时/未核实 → 最短，绝不与正式文档同寿
    expect(halfLifeDaysForKind('???unknown')).toBe(180) // default bucket
  })
})
