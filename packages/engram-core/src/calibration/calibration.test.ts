import { describe, expect, it } from 'vitest'

import { computeReliability, type CalibrationSample } from './calibration.js'

describe('computeReliability — pure binning + ECE (P0 GATE, A.3/A.9)', () => {
  it('rejects a non-positive or non-integer binCount', () => {
    expect(() => computeReliability([], 0)).toThrow(/binCount/)
    expect(() => computeReliability([], -3)).toThrow(/binCount/)
    expect(() => computeReliability([], 2.5)).toThrow(/binCount/)
  })

  it('empty input ⇒ ECE 0 (non-NaN) and all-zero bins (no divide-by-zero)', () => {
    const rep = computeReliability([], 10)
    expect(rep.ece).toBe(0)
    expect(Number.isNaN(rep.ece)).toBe(false)
    expect(rep.sampleCount).toBe(0)
    expect(rep.bins).toHaveLength(10)
    expect(rep.bins.every((b) => b.count === 0 && b.observed === 0 && b.meanPredicted === 0)).toBe(
      true,
    )
  })

  it('assigns samples to [lo,hi) bins with correct edges; predicted=1 lands in the last bin', () => {
    const rep = computeReliability(
      [
        { predicted: 0.05, correct: true }, // bin 0 [0,0.1)
        { predicted: 0.42, correct: true }, // bin 4 [0.4,0.5)
        { predicted: 0.95, correct: true }, // bin 9 [0.9,1.0]
        { predicted: 1.0, correct: true }, // bin 9 (last, inclusive of 1.0)
      ],
      10,
    )
    expect(rep.bins[0]!.count).toBe(1)
    expect(rep.bins[4]!.count).toBe(1)
    expect(rep.bins[9]!.count).toBe(2)
    expect(rep.bins[0]!.lo).toBeCloseTo(0)
    expect(rep.bins[0]!.hi).toBeCloseTo(0.1)
    expect(rep.bins[9]!.hi).toBeCloseTo(1.0)
    expect(rep.sampleCount).toBe(4)
  })

  it('clamps out-of-range predicted into the [0,1] end bins (no out-of-bounds index)', () => {
    const rep = computeReliability(
      [
        { predicted: -0.5, correct: true },
        { predicted: 1.7, correct: false },
      ],
      10,
    )
    expect(rep.bins[0]!.count).toBe(1) // -0.5 → 0
    expect(rep.bins[9]!.count).toBe(1) // 1.7 → 1
  })

  it('per-bin observed = correct fraction; ECE = sample-weighted mean |pred−observed| (hand-checked)', () => {
    const rep = computeReliability(
      [
        { predicted: 0.2, correct: true },
        { predicted: 0.2, correct: false }, // bin2: n=2, observed 0.5, predicted 0.2, gap 0.3
        { predicted: 0.8, correct: true },
        { predicted: 0.8, correct: true },
        { predicted: 0.8, correct: true }, // bin8: n=3, observed 1.0, predicted 0.8, gap 0.2
      ],
      10,
    )
    expect(rep.bins[2]!.observed).toBeCloseTo(0.5)
    expect(rep.bins[2]!.meanPredicted).toBeCloseTo(0.2)
    expect(rep.bins[8]!.observed).toBeCloseTo(1.0)
    expect(rep.sampleCount).toBe(5)
    // ECE = (2/5)·0.3 + (3/5)·0.2 = 0.12 + 0.12 = 0.24
    expect(rep.ece).toBeCloseTo(0.24, 10)
  })

  it('zero-sample bins contribute nothing to ECE and never divide by zero', () => {
    // only bin 5 populated, perfectly calibrated → ECE 0, other 9 bins empty + clean
    const rep = computeReliability(
      Array.from({ length: 10 }, (_, i) => ({ predicted: 0.55, correct: i < 5 })),
      10,
    )
    expect(rep.bins[5]!.count).toBe(10)
    expect(rep.bins.filter((b) => b.count === 0)).toHaveLength(9)
    expect(rep.ece).toBeCloseTo(0.05, 10) // observed 0.5 vs predicted 0.55
    expect(Number.isNaN(rep.ece)).toBe(false)
  })

  it('ECE ≈ 0 on perfectly-calibrated synthetic data (non-trivial: computable, not constant-zero by accident)', () => {
    const samples: CalibrationSample[] = []
    for (const [p, total] of [
      [0.55, 20],
      [0.75, 20],
      [0.95, 20],
    ] as const) {
      const adopted = Math.round(p * total) // 11 / 15 / 19 — observed fraction equals predicted
      for (let i = 0; i < total; i++) samples.push({ predicted: p, correct: i < adopted })
    }
    const rep = computeReliability(samples, 10)
    expect(rep.ece).toBeLessThan(0.01)
    expect(rep.sampleCount).toBe(60)
  })

  it('ECE clearly > 0 on deliberately miscalibrated data, and distinguishable from the calibrated case', () => {
    const miscal: CalibrationSample[] = []
    for (let i = 0; i < 20; i++) miscal.push({ predicted: 0.95, correct: i < 10 }) // observed 0.5 vs 0.95 → gap 0.45
    for (let i = 0; i < 20; i++) miscal.push({ predicted: 0.55, correct: i < 19 }) // observed 0.95 vs 0.55 → gap 0.40
    const rep = computeReliability(miscal, 10)
    expect(rep.ece).toBeGreaterThan(0.3) // ≈ 0.425
    expect(Number.isNaN(rep.ece)).toBe(false)

    // calibrated counterpart on the same bins is near zero — the metric separates them
    const cal: CalibrationSample[] = []
    for (let i = 0; i < 20; i++) cal.push({ predicted: 0.95, correct: i < 19 })
    for (let i = 0; i < 20; i++) cal.push({ predicted: 0.55, correct: i < 11 })
    expect(computeReliability(cal, 10).ece).toBeLessThan(rep.ece - 0.3)
  })

  it('honors a custom binCount (coarser bins merge samples)', () => {
    const rep = computeReliability(
      [
        { predicted: 0.1, correct: true },
        { predicted: 0.4, correct: false },
      ],
      2,
    )
    expect(rep.binCount).toBe(2)
    expect(rep.bins).toHaveLength(2)
    expect(rep.bins[0]!.count).toBe(2) // both 0.1 and 0.4 fall in [0,0.5)
    expect(rep.bins[0]!.observed).toBeCloseTo(0.5)
  })
})
