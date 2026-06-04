import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { StoredConfidence } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { claim, relation } from '../db/schema.js'
import { addSource } from '../spi/append-claim.js'
import { commitClaim } from '../spi/commit-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { transitionClaim } from '../spi/transition.js'
import {
  adjudicate,
  deterministicVerdict,
  objectEquivalent,
  type ClaimShape,
} from '../same-fact/same-fact.js'
import { makeFakeSameFactJudge } from '../same-fact/fake-judge.js'
import {
  countIndependentSupports,
  independent,
  type SourceIndep,
} from '../same-fact/independent.js'

// ---------- pure functions (no DB) ----------

const shape = (
  subject: string | null,
  predicate: string | null,
  object: string | null,
  claimText = 't',
): ClaimShape => ({
  subject,
  predicate,
  object,
  claimText,
})

describe('S14 same-fact pure functions (A.6)', () => {
  it('objectEquivalent: unit-normalized numeric equivalence + exact string fallback', () => {
    expect(objectEquivalent('1m', '100cm')).toBe(true) // length unit normalization
    expect(objectEquivalent('1.5kg', '1500g')).toBe(true) // mass
    expect(objectEquivalent('2h', '7200s')).toBe(true) // time
    expect(objectEquivalent('5', '5.0')).toBe(true) // pure numbers
    expect(objectEquivalent('Red', 'red')).toBe(true) // case-insensitive string
    expect(objectEquivalent('1m', '1kg')).toBe(false) // cross-dimension
    expect(objectEquivalent('red', 'blue')).toBe(false)
    expect(objectEquivalent('1m', '2m')).toBe(false)
  })

  it('deterministicVerdict: same / contradicts / refines / null', () => {
    expect(deterministicVerdict(shape('sku', 'len', '1m'), shape('sku', 'len', '100cm'))).toBe(
      'same',
    ) // S≡P≡ O-equiv
    expect(deterministicVerdict(shape('sku', 'color', 'red'), shape('sku', 'color', 'blue'))).toBe(
      'contradicts',
    ) // S≡P≡ O-diff
    expect(
      deterministicVerdict(shape('sku', 'maxLen', '1m'), shape('sku', 'ratedLen', '100cm')),
    ).toBe('refines') // S≡ O-equiv P≠
    expect(deterministicVerdict(shape('a', 'p', 'o'), shape('b', 'p', 'o'))).toBeNull() // different subject
    expect(
      deterministicVerdict(shape('sku', 'color', 'red'), shape('sku', 'size', 'big')),
    ).toBeNull() // P≠ O≠ → gray zone
    expect(
      deterministicVerdict(
        shape(null, null, null, 'free text'),
        shape(null, null, null, 'free text'),
      ),
    ).toBeNull() // no triples
  })

  it('adjudicate: deterministic short-circuits without an LLM call; gray zone calls exactly once ≥0.65; <0.65 is unrelated with no call', async () => {
    const j1 = makeFakeSameFactJudge({ verdictOf: () => 'same' })
    expect(
      await adjudicate(shape('sku', 'len', '1m'), shape('sku', 'len', '100cm'), 0.99, j1),
    ).toBe('same')
    expect(j1.callCount()).toBe(0) // deterministic rule fired — no LLM

    const j2 = makeFakeSameFactJudge({ verdictOf: () => 'refines' })
    expect(
      await adjudicate(shape(null, null, null, 'a'), shape(null, null, null, 'b'), 0.7, j2),
    ).toBe('refines')
    expect(j2.callCount()).toBe(1) // no rule, sim≥0.65 → exactly one gray-zone call

    const j3 = makeFakeSameFactJudge({ verdictOf: () => 'same' })
    expect(
      await adjudicate(shape(null, null, null, 'a'), shape(null, null, null, 'b'), 0.5, j3),
    ).toBe('unrelated')
    expect(j3.callCount()).toBe(0) // sim<0.65 → unrelated, no LLM spent
  })

  it('independent(): excludes same-id, same-hash, and a direct derived_from link', () => {
    const a: SourceIndep = {
      id: 'a',
      contentHash: 'ha',
      kind: 'structured_spec',
      derivedFromSourceId: null,
    }
    const b: SourceIndep = {
      id: 'b',
      contentHash: 'hb',
      kind: 'structured_spec',
      derivedFromSourceId: null,
    }
    expect(independent(a, b)).toBe(true)
    expect(independent(a, { ...b, id: 'a' })).toBe(false) // same id
    expect(independent(a, { ...b, contentHash: 'ha' })).toBe(false) // same hash
    expect(independent(a, { ...b, derivedFromSourceId: 'a' })).toBe(false) // b derived from a
  })

  it('countIndependentSupports: hash-dedup, derived-chain collapse, agent_synthesis 0.5 discount', () => {
    const A: SourceIndep = {
      id: 'A',
      contentHash: 'h1',
      kind: 'structured_spec',
      derivedFromSourceId: null,
    }
    const B: SourceIndep = {
      id: 'B',
      contentHash: 'h2',
      kind: 'structured_spec',
      derivedFromSourceId: null,
    }
    expect(countIndependentSupports([A])).toBe(1) // one source
    expect(countIndependentSupports([A, B])).toBe(2) // two independent
    expect(countIndependentSupports([A, { ...B, contentHash: 'h1' }])).toBe(1) // same content hash ⇒ deduped
    expect(countIndependentSupports([A, { ...B, derivedFromSourceId: 'A' }])).toBe(1) // B derived from A ⇒ collapsed
    expect(countIndependentSupports([A, { ...B, kind: 'agent_synthesis' }])).toBeCloseTo(1.5) // 1 + 0.5
  })
})

// ---------- commitClaim dedup + f3 (DB) ----------

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder = makeFakeEmbedder()
const unrelatedJudge = makeFakeSameFactJudge() // default 'unrelated' — DB tests below use structured triples (deterministic)

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL })
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE source, claim, claim_provenance, relation, claim_verification CASCADE')
})

async function aSource(
  opts: { kind?: 'structured_spec' | 'agent_synthesis'; derivedFromSourceId?: string } = {},
) {
  return addSource(db, {
    content: `body-${randomUUID()}`,
    contentHash: randomUUID(),
    kind: opts.kind ?? 'structured_spec',
    authorityScore: 0.9, // strong source ⇒ a 2-source merge clears the 0.4 recall floor (f3 assertions are authority-independent)
    ...(opts.derivedFromSourceId ? { derivedFromSourceId: opts.derivedFromSourceId } : {}),
  })
}

async function indepSupportOf(claimId: string): Promise<number> {
  const [row] = await db
    .select({ f: claim.confidenceFactors })
    .from(claim)
    .where(eq(claim.id, claimId))
  return (row!.f as StoredConfidence).factors.indepSupport
}

const SKU = { subject: 'sku-7', predicate: 'maxThroughput', object: '500mbps' }

describe('S14 commitClaim — same-fact dedup + un-inflatable f3 (A.6)', () => {
  it('same fact from two genuinely independent sources merges (single claim) and f3/indepSupport rises', async () => {
    const s1 = await aSource()
    const first = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 maxThroughput 500mbps', ...SKU },
      [{ sourceId: s1.sourceId, locator: 'a' }],
    )
    expect(first.merged).toBe(false)
    expect(await indepSupportOf(first.claimId)).toBe(0) // one source ⇒ no independent corroboration

    const s2 = await aSource()
    const second = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 maxThroughput 500mbps', ...SKU },
      [{ sourceId: s2.sourceId, locator: 'b' }],
    )
    expect(second.merged).toBe(true) // deterministic 'same' (S≡P≡ O-equiv) ⇒ merged, not duplicated
    expect(second.claimId).toBe(first.claimId) // same claim
    expect(await indepSupportOf(first.claimId)).toBeCloseTo(0.5) // two independent sources ⇒ f3 rises

    // the deterministic path spent no LLM call, and recall surfaces exactly ONE claim after promotion
    expect(unrelatedJudge.callCount()).toBe(0)
    await transitionClaim(db, first.claimId, 'active', { by: 'human:editor' })
    const hits = await recallClaims(db, embedder, 'sku-7 maxThroughput 500mbps')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.confidence.factors.indepSupport).toBeCloseTo(0.5) // confSnapshot reflects the merged f3
  })

  it('a hash-identical re-append does NOT raise f3 (no same-source 刷印证)', async () => {
    const s1 = await aSource()
    const first = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 maxThroughput 500mbps', ...SKU },
      [{ sourceId: s1.sourceId, locator: 'a' }],
    )
    expect(await indepSupportOf(first.claimId)).toBe(0)

    // a hash-identical copy resolves (addSource ON CONFLICT) to the SAME source id ⇒ same independent source
    const dup = await addSource(db, {
      content: 'X',
      contentHash: 'HASH-X',
      kind: 'structured_spec',
    })
    const dup2 = await addSource(db, {
      content: 'X',
      contentHash: 'HASH-X',
      kind: 'structured_spec',
    })
    expect(dup2.sourceId).toBe(dup.sourceId) // dedup by content hash
    const merged = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 maxThroughput 500mbps', ...SKU },
      [{ sourceId: dup.sourceId, locator: 'c' }],
    )
    expect(merged.merged).toBe(true)
    await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 maxThroughput 500mbps', ...SKU },
      [
        { sourceId: dup2.sourceId, locator: 'c' }, // same source again
      ],
    )
    // two distinct independent sources (s1 + dup) ⇒ 0.5; re-citing the same source did NOT push it higher
    expect(await indepSupportOf(first.claimId)).toBeCloseTo(0.5)
  })

  it('agent_synthesis derivative source counts 0.5 toward indepSupport', async () => {
    const s1 = await aSource()
    const first = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 maxThroughput 500mbps', ...SKU },
      [{ sourceId: s1.sourceId, locator: 'a' }],
    )
    const synth = await aSource({ kind: 'agent_synthesis' })
    await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 maxThroughput 500mbps', ...SKU },
      [{ sourceId: synth.sourceId, locator: 'b' }],
    )
    // sources {structured(1.0), agent_synthesis(0.5)} ⇒ count 1.5 ⇒ independentSupportScore(1.5) = 1 - 0.5^0.5
    expect(await indepSupportOf(first.claimId)).toBeCloseTo(1 - Math.pow(0.5, 0.5))
  })

  it('stage-2 contradicts: same subject+predicate, different (non-equivalent) object ⇒ new claim + a contradicts edge', async () => {
    const s1 = await aSource()
    const a = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 color red', subject: 'sku-7', predicate: 'color', object: 'red' },
      [{ sourceId: s1.sourceId, locator: 'a' }],
    )
    const s2 = await aSource()
    const b = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 color blue', subject: 'sku-7', predicate: 'color', object: 'blue' },
      [{ sourceId: s2.sourceId, locator: 'b' }],
    )
    expect(b.merged).toBe(false) // contradiction ⇒ a NEW claim, not a merge
    expect(b.claimId).not.toBe(a.claimId)
    const rows = await db.select().from(relation)
    expect(
      rows.some(
        (r) => r.fromClaim === b.claimId && r.toClaim === a.claimId && r.type === 'contradicts',
      ),
    ).toBe(true)
  })

  it('gray zone: a structureless free-text near-duplicate triggers exactly one LLM call and merges on a "same" verdict', async () => {
    const judge = makeFakeSameFactJudge({ verdictOf: () => 'same' })
    const s1 = await aSource()
    const text = 'the relay supports dual band failover'
    const a = await commitClaim(db, embedder, judge, { claimText: text }, [
      { sourceId: s1.sourceId, locator: 'a' },
    ]) // no S/P/O
    expect(judge.callCount()).toBe(0) // first commit: no candidates yet, no LLM

    const s2 = await aSource()
    const b = await commitClaim(db, embedder, judge, { claimText: text }, [
      { sourceId: s2.sourceId, locator: 'b' },
    ])
    expect(judge.callCount()).toBe(1) // exactly one gray-zone call for the single near-duplicate candidate
    expect(b.merged).toBe(true) // 'same' verdict ⇒ merged
    expect(b.claimId).toBe(a.claimId)
  })

  it('gray zone is NOT spent below 0.65: a same-subject but dissimilar, rule-less candidate yields a new claim with no LLM call', async () => {
    const judge = makeFakeSameFactJudge({ verdictOf: () => 'same' })
    const s1 = await aSource()
    // existing claim: subject X, but text trigram-disjoint from the new one; no full triples to fire a rule
    await commitClaim(db, embedder, judge, { claimText: 'alpha bravo charlie', subject: 'X' }, [
      { sourceId: s1.sourceId, locator: 'a' },
    ])
    const s2 = await aSource()
    const b = await commitClaim(
      db,
      embedder,
      judge,
      { claimText: 'xylophone quartz nimbus', subject: 'X' },
      [{ sourceId: s2.sourceId, locator: 'b' }],
    )
    // same subject ⇒ subjectKey candidate, but similarity<0.65 and no deterministic rule ⇒ unrelated, no LLM
    expect(judge.callCount()).toBe(0)
    expect(b.merged).toBe(false)
  })

  it('D1: commitClaim rejects a claim with zero provenance', async () => {
    await expect(
      commitClaim(db, embedder, unrelatedJudge, { claimText: 'no provenance' }, []),
    ).rejects.toThrow(/D1 violation/)
  })
})
