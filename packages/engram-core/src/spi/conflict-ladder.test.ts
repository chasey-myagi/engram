import { describe, expect, it } from 'vitest'

import { MACHINE_RUNGS, adjudicateConflict, type ConflictSide } from './conflict-ladder.js'

/** 造一条裁决侧快照；缺省字段都「相等」，便于单独激活某一阶。 */
function side(claimId: string, over: Partial<Omit<ConflictSide, 'claimId'>> = {}): ConflictSide {
  return {
    claimId,
    asOf: over.asOf ?? new Date('2025-01-01T00:00:00.000Z'),
    authority: over.authority ?? 0.5,
    indepSupport: over.indepSupport ?? 1,
    supersedes: over.supersedes ?? new Set<string>(),
  }
}

describe('A.5 deterministic conflict priority ladder (pure, replayable)', () => {
  it('② supersede beats everything below it: the superseding claim wins even if older / weaker / less-supported', () => {
    // a supersedes b, but a is OLDER, WEAKER authority, FEWER supports — supersede (②) still wins (先命中先裁).
    const a = side('a', {
      asOf: new Date('2020-01-01T00:00:00.000Z'),
      authority: 0.1,
      indepSupport: 0,
      supersedes: new Set(['b']),
    })
    const b = side('b', {
      asOf: new Date('2025-01-01T00:00:00.000Z'),
      authority: 0.9,
      indepSupport: 5,
    })
    const r = adjudicateConflict(a, b)
    expect(r.outcome).toBe('winner')
    expect(r.winnerId).toBe('a')
    expect(r.loserId).toBe('b')
    expect(r.rung).toBe('supersede')
  })

  it('③ recency: with no supersede, the newer as_of wins (regardless of authority / indepSupport below it)', () => {
    // equal supersede(none); a newer; a WEAKER authority + FEWER supports — recency (③) is the first to break the tie.
    const a = side('a', {
      asOf: new Date('2025-06-01T00:00:00.000Z'),
      authority: 0.2,
      indepSupport: 1,
    })
    const b = side('b', {
      asOf: new Date('2025-01-01T00:00:00.000Z'),
      authority: 0.9,
      indepSupport: 9,
    })
    const r = adjudicateConflict(a, b)
    expect(r.outcome).toBe('winner')
    expect(r.winnerId).toBe('a')
    expect(r.rung).toBe('recency')
  })

  it('④ authority: equal supersede + equal recency → stronger source authority wins', () => {
    const a = side('a', { authority: 0.9, indepSupport: 1 })
    const b = side('b', { authority: 0.4, indepSupport: 9 }) // more supports but weaker authority → loses at ④
    const r = adjudicateConflict(a, b)
    expect(r.outcome).toBe('winner')
    expect(r.winnerId).toBe('a')
    expect(r.rung).toBe('authority')
  })

  it('⑤ indepSupport: equal supersede + recency + authority → more independent supports wins (last machine rung)', () => {
    const a = side('a', { indepSupport: 3 })
    const b = side('b', { indepSupport: 1 })
    const r = adjudicateConflict(a, b)
    expect(r.outcome).toBe('winner')
    expect(r.winnerId).toBe('a')
    expect(r.rung).toBe('indepSupport')
  })

  it('tie (equal supersede AND recency AND authority AND indepSupport) → escalate to human (① human-only), not auto-picked', () => {
    const a = side('a')
    const b = side('b') // identical on every machine rung
    const r = adjudicateConflict(a, b)
    expect(r.outcome).toBe('escalate')
    expect(r.winnerId).toBeUndefined()
    expect(r.rung).toBe('human') // machine ladder exhausted → only ① human ruling remains
  })

  it('mutual supersede (pathological) does NOT self-adjudicate at ② — falls through to lower rungs', () => {
    // both claim to supersede the other → ambiguous at ②, so ③ recency decides instead.
    const a = side('a', { asOf: new Date('2025-06-01T00:00:00.000Z'), supersedes: new Set(['b']) })
    const b = side('b', { asOf: new Date('2025-01-01T00:00:00.000Z'), supersedes: new Set(['a']) })
    const r = adjudicateConflict(a, b)
    expect(r.outcome).toBe('winner')
    expect(r.rung).toBe('recency') // not 'supersede'
    expect(r.winnerId).toBe('a')
  })

  it('replayable / explainable: same pair + same state ⇒ same winner, and order of arguments does not flip the verdict', () => {
    const a = side('a', { authority: 0.8 })
    const b = side('b', { authority: 0.3 })
    // same inputs, many runs → identical verdict (deterministic, no LLM / randomness / clock).
    const runs = Array.from({ length: 25 }, () => adjudicateConflict(a, b))
    for (const r of runs) {
      expect(r.outcome).toBe('winner')
      expect(r.winnerId).toBe('a')
      expect(r.rung).toBe('authority')
      expect(r.reason).toBe(runs[0]!.reason) // identical explanation string too
    }
    // swapping argument order yields the SAME winner (the ladder is symmetric on the pair, not on position).
    const swapped = adjudicateConflict(b, a)
    expect(swapped.winnerId).toBe('a')
    expect(swapped.rung).toBe('authority')
  })

  it('a claim cannot conflict with itself', () => {
    expect(() => adjudicateConflict(side('x'), side('x'))).toThrow(/cannot conflict with itself/)
  })

  it('MACHINE_RUNGS lists exactly ②③④⑤ in priority order (① human excluded from the machine path)', () => {
    expect(MACHINE_RUNGS).toEqual(['supersede', 'recency', 'authority', 'indepSupport'])
    expect(MACHINE_RUNGS).not.toContain('human')
  })
})
