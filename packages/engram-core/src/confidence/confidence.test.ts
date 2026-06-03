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

  it('maps source kinds to A.3 half-lives (formal 730 / artifact 180 / conversation 90)', () => {
    expect(halfLifeDaysForKind('formal_document')).toBe(730)
    expect(halfLifeDaysForKind('structured_spec')).toBe(730)
    expect(halfLifeDaysForKind('historical_artifact')).toBe(180)
    expect(halfLifeDaysForKind('agent_synthesis')).toBe(180)
    expect(halfLifeDaysForKind('human_qa')).toBe(90)
    expect(halfLifeDaysForKind('conversation_log')).toBe(90)
  })
})
