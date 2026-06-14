import { describe, expect, it } from 'vitest'

import { applyAdapter, DEFAULT_ADAPTER_EPSILON, type RecallAdapter } from './adapter.js'
import type { RecallResult } from './recall-claims.js'

/** Minimal synthetic kernel recall result — only the fields applyAdapter inspects matter. */
function makeResult(id: string, value: number, sourceId = `src-${id}`): RecallResult {
  return {
    claim: {
      id,
      claimText: `claim ${id}`,
      subject: null,
      predicate: null,
      object: null,
      status: 'active',
      lineageId: `lin-${id}`,
      asOf: new Date('2025-01-01T00:00:00Z'),
    },
    confidence: {
      value,
      raw: value,
      factors: {
        authority: 0.5,
        humanReview: 0,
        entailment: 0.5,
        indepSupport: 0,
        usageCorrect: 0,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: {
        authority: 0.3,
        humanReview: 0.3,
        entailment: 0.15,
        indepSupport: 0.15,
        usageCorrect: 0.1,
      },
      calibrationVersion: 'identity',
      takenAt: new Date('2025-01-01T00:00:00Z'),
    },
    provenances: [{ sourceId, locator: 'p1', relevance: 'exact' }],
    mustVerify: value < 0.6,
    contradicts: [],
    embeddingVersion: null,
  }
}

const kernel = (): RecallResult[] => [
  makeResult('a', 0.9),
  makeResult('b', 0.7),
  makeResult('c', 0.5),
]

describe('applyAdapter — monotone-tightening operator (A.2/A.6)', () => {
  it('passes a legitimate tightening adapter: lowers conf and drops results → adaptedConf ≤ gConf for all, recall subset', () => {
    const tighten: RecallAdapter = (rs) =>
      rs
        .filter((r) => r.claim.id !== 'c') // drop one
        .map((r) => {
          const value = r.confidence.value * 0.5
          return { ...r, confidence: { ...r.confidence, value }, mustVerify: value < 0.6 }
        })
    const out = applyAdapter(kernel(), tighten)
    expect(out.map((r) => r.claim.id)).toEqual(['a', 'b']) // subset
    expect(out[0]!.confidence.value).toBeCloseTo(0.45)
    expect(out[1]!.confidence.value).toBeCloseTo(0.35)
    expect(out.every((r) => r.mustVerify)).toBe(true) // both fell below 0.6 → flagged
  })

  it('passes an identity adapter (returns results unchanged)', () => {
    const out = applyAdapter(kernel(), (rs) => rs.map((r) => ({ ...r })))
    expect(out).toHaveLength(3)
    expect(out.map((r) => r.confidence.value)).toEqual([0.9, 0.7, 0.5])
  })

  it("throws 'adapter relaxed' when the adapter raises any conf above kernel g", () => {
    const raise: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'b' ? { ...r, confidence: { ...r.confidence, value: 0.95 } } : { ...r },
      )
    expect(() => applyAdapter(kernel(), raise)).toThrow(/adapter relaxed.*raised confidence/i)
  })

  it("throws 'adapter relaxed' when the adapter fabricates a result (claim not in kernel recall)", () => {
    const fabricate: RecallAdapter = (rs) => [...rs.map((r) => ({ ...r })), makeResult('zzz', 0.5)]
    expect(() => applyAdapter(kernel(), fabricate)).toThrow(/adapter relaxed/i)
  })

  it("throws 'adapter relaxed' when the adapter increases the recall count (duplication)", () => {
    const dup: RecallAdapter = (rs) => [...rs.map((r) => ({ ...r })), { ...rs[0]! }]
    expect(() => applyAdapter(kernel(), dup)).toThrow(/adapter relaxed.*increase recall count/i)
  })

  it("throws 'adapter relaxed' when the adapter returns the same claim twice within the count bound", () => {
    // 3 results in / 3 out, but two are claim 'a' and one is dropped → no count increase, still a dup
    const dupNoGrow: RecallAdapter = (rs) => [{ ...rs[0]! }, { ...rs[0]! }, { ...rs[1]! }]
    expect(() => applyAdapter(kernel(), dupNoGrow)).toThrow(/adapter relaxed.*duplicated/i)
  })

  it("throws 'adapter relaxed' when the adapter rewrites provenance (sourceId / locator / relevance / count)", () => {
    const rewriteSource: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'a'
          ? { ...r, provenances: [{ sourceId: 'forged', locator: 'p1', relevance: 'exact' }] }
          : { ...r },
      )
    expect(() => applyAdapter(kernel(), rewriteSource)).toThrow(/adapter relaxed.*provenance/i)

    const addProv: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'a'
          ? {
              ...r,
              provenances: [
                ...r.provenances,
                { sourceId: 'extra', locator: 'p2', relevance: 'supporting' },
              ],
            }
          : { ...r },
      )
    expect(() => applyAdapter(kernel(), addProv)).toThrow(/adapter relaxed.*provenance/i)
  })

  it("throws 'adapter relaxed' when the adapter under-flags mustVerify (same conf, true→false on a sub-0.6 result)", () => {
    // c has value 0.5 (<0.6) ⇒ kernel mustVerify=true; flipping it false at the same conf relaxes the gate
    const downgrade: RecallAdapter = (rs) =>
      rs.map((r) => (r.claim.id === 'c' ? { ...r, mustVerify: false } : { ...r }))
    expect(() => applyAdapter(kernel(), downgrade)).toThrow(/adapter relaxed.*mustVerify/i)
  })

  it('allows over-flagging mustVerify (true on a ≥0.6 result is more cautious, not a relaxation)', () => {
    const overflag: RecallAdapter = (rs) => rs.map((r) => ({ ...r, mustVerify: true }))
    expect(() => applyAdapter(kernel(), overflag)).not.toThrow()
  })

  it("throws 'adapter relaxed: rewrote claim body' when the adapter rewrites claimText (core exploit: forge a fact under unchanged provenance)", () => {
    // 改 claimText、其余字段（id / provenance / conf.value）全合规 → 旧契约放行（拿真出处引假事实），新守卫拦截。
    const tamper: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'b' ? { ...r, claim: { ...r.claim, claimText: 'rewritten' } } : { ...r },
      )
    expect(() => applyAdapter(kernel(), tamper)).toThrow(/adapter relaxed.*claim body/i)
  })

  it("throws 'adapter relaxed: rewrote claim body' when the adapter rewrites status / subject / predicate / object / lineageId", () => {
    const cases: Array<[string, RecallResult['claim']]> = [
      ['status', { status: 'flagged' } as Partial<RecallResult['claim']> as RecallResult['claim']],
      ['subject', { subject: 'forged' } as Partial<RecallResult['claim']> as RecallResult['claim']],
      [
        'predicate',
        { predicate: 'forged' } as Partial<RecallResult['claim']> as RecallResult['claim'],
      ],
      ['object', { object: 'forged' } as Partial<RecallResult['claim']> as RecallResult['claim']],
      [
        'lineageId',
        { lineageId: 'forged' } as Partial<RecallResult['claim']> as RecallResult['claim'],
      ],
    ]
    for (const [, patch] of cases) {
      const tamper: RecallAdapter = (rs) =>
        rs.map((r) => (r.claim.id === 'a' ? { ...r, claim: { ...r.claim, ...patch } } : { ...r }))
      expect(() => applyAdapter(kernel(), tamper)).toThrow(/adapter relaxed.*claim body/i)
    }
  })

  it("throws 'adapter relaxed: rewrote claim body' when the adapter changes claim.asOf to a different instant", () => {
    const shift: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'a'
          ? { ...r, claim: { ...r.claim, asOf: new Date('2099-01-01T00:00:00Z') } }
          : { ...r },
      )
    expect(() => applyAdapter(kernel(), shift)).toThrow(/adapter relaxed.*claim body/i)
  })

  it('allows rebuilding claim.asOf as a fresh Date at the same instant (compared by getTime, not reference)', () => {
    const rebuild: RecallAdapter = (rs) =>
      rs.map((r) => ({ ...r, claim: { ...r.claim, asOf: new Date(r.claim.asOf.getTime()) } }))
    expect(() => applyAdapter(kernel(), rebuild)).not.toThrow()
  })

  it("throws 'adapter relaxed: rewrote confidence snapshot' when the adapter rewrites raw / a factor / calibrationVersion (value not raised)", () => {
    const tamperRaw: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'a' ? { ...r, confidence: { ...r.confidence, raw: 0.123 } } : { ...r },
      )
    expect(() => applyAdapter(kernel(), tamperRaw)).toThrow(/adapter relaxed.*confidence snapshot/i)

    const tamperFactor: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'a'
          ? {
              ...r,
              confidence: {
                ...r.confidence,
                factors: { ...r.confidence.factors, entailment: 0.999 },
              },
            }
          : { ...r },
      )
    expect(() => applyAdapter(kernel(), tamperFactor)).toThrow(
      /adapter relaxed.*confidence snapshot/i,
    )

    const tamperCalib: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'a'
          ? { ...r, confidence: { ...r.confidence, calibrationVersion: 'forged-v2' } }
          : { ...r },
      )
    expect(() => applyAdapter(kernel(), tamperCalib)).toThrow(
      /adapter relaxed.*confidence snapshot/i,
    )
  })

  it("throws 'adapter relaxed: rewrote confidence snapshot' when the adapter rewrites weights or takenAt", () => {
    const tamperWeights: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'a'
          ? {
              ...r,
              confidence: {
                ...r.confidence,
                weights: { ...r.confidence.weights, authority: 0.99 },
              },
            }
          : { ...r },
      )
    expect(() => applyAdapter(kernel(), tamperWeights)).toThrow(
      /adapter relaxed.*confidence snapshot/i,
    )

    const tamperTakenAt: RecallAdapter = (rs) =>
      rs.map((r) =>
        r.claim.id === 'a'
          ? { ...r, confidence: { ...r.confidence, takenAt: new Date('2099-01-01T00:00:00Z') } }
          : { ...r },
      )
    expect(() => applyAdapter(kernel(), tamperTakenAt)).toThrow(
      /adapter relaxed.*confidence snapshot/i,
    )
  })

  it('tolerates a conf within ε of kernel g, but rejects one clearly above', () => {
    const withinEps: RecallAdapter = (rs) =>
      rs.map((r) => ({
        ...r,
        confidence: { ...r.confidence, value: r.confidence.value + DEFAULT_ADAPTER_EPSILON / 2 },
      }))
    expect(() => applyAdapter(kernel(), withinEps)).not.toThrow() // floating-point slack

    const aboveEps: RecallAdapter = (rs) =>
      rs.map((r) => ({ ...r, confidence: { ...r.confidence, value: r.confidence.value + 1e-3 } }))
    expect(() => applyAdapter(kernel(), aboveEps)).toThrow(/adapter relaxed.*raised confidence/i)
  })

  it('an empty adapter (drops everything) is valid tightening', () => {
    expect(applyAdapter(kernel(), () => [])).toEqual([])
  })

  it("throws 'adapter relaxed' when the adapter DROPS a contradicts annotation (矛盾显式 red line, enforced)", () => {
    const withContra: RecallResult = { ...makeResult('x', 0.8), contradicts: ['rival-1'] }
    // a compliant-looking adapter that hides the conflict must be rejected — not merely "happen to pass"
    const hide: RecallAdapter = (rs) => rs.map((r) => ({ ...r, contradicts: [] }))
    expect(() => applyAdapter([withContra], hide)).toThrow(/adapter relaxed.*contradicts/i)
  })

  it('allows a tightening adapter that preserves (or adds to) contradicts', () => {
    const withContra: RecallResult = { ...makeResult('x', 0.8), contradicts: ['rival-1'] }
    const keep = applyAdapter([withContra], (rs) =>
      rs.map((r) => ({ ...r, confidence: { ...r.confidence, value: 0.7 } })),
    )
    expect(keep[0]!.contradicts).toEqual(['rival-1']) // preserved
    const add = applyAdapter([withContra], (rs) =>
      rs.map((r) => ({ ...r, contradicts: [...r.contradicts, 'rival-2'] })),
    )
    expect(add[0]!.contradicts).toEqual(['rival-1', 'rival-2']) // superset (more cautious) allowed
  })

  it("throws 'adapter relaxed' when the adapter reorders provenances (positional check, conservative-by-design)", () => {
    const twoProv: RecallResult = {
      ...makeResult('m', 0.9),
      provenances: [
        { sourceId: 's1', locator: 'l1', relevance: 'exact' },
        { sourceId: 's2', locator: 'l2', relevance: 'supporting' },
      ],
    }
    const reorder: RecallAdapter = (rs) =>
      rs.map((r) => ({ ...r, provenances: [...r.provenances].reverse() }))
    expect(() => applyAdapter([twoProv], reorder)).toThrow(/adapter relaxed.*provenance/i)
  })
})
