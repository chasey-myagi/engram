import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  CALIBRATION_IDENTITY,
  DEFAULT_WEIGHTS,
  type StoredConfidence,
} from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { EMBEDDING_DIM } from '../embedding/embedder.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { claim, claimProvenance, relation, type ClaimStatus } from '../db/schema.js'
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
    expect(objectEquivalent('-1m', '-100cm')).toBe(true) // negative quantities normalize
    expect(objectEquivalent('5lb', '5lb')).toBe(true) // unknown unit ⇒ exact-string fallback
    expect(objectEquivalent('5lb', '5kg')).toBe(false) // unknown unit ⇒ no false numeric merge
    expect(objectEquivalent('1m', '1')).toBe(false) // unit vs bare number ⇒ not equivalent
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
    // transitive chain A <- B <- C collapses to one root; a cycle terminates (visited-guard) without hanging
    const C: SourceIndep = {
      id: 'C',
      contentHash: 'h3',
      kind: 'structured_spec',
      derivedFromSourceId: 'B',
    }
    expect(countIndependentSupports([A, { ...B, derivedFromSourceId: 'A' }, C])).toBe(1)
    expect(
      countIndependentSupports([
        { ...A, derivedFromSourceId: 'B' },
        { ...B, derivedFromSourceId: 'A' },
      ]),
    ).toBe(0) // mutual cycle: both collapse, terminates
  })

  // EGR-CR-024 (#102): two cited siblings sharing an UN-cited common ancestor R must collapse to ONE
  // independent support, not two. The fix feeds the full ancestor chain to countIndependentSupports and
  // passes citedIds so R is only a collapse anchor, never counted as its own corroboration.
  it('countIndependentSupports: cited siblings sharing an un-cited ancestor collapse to ONE (shared ancestor / 未引用 / sibling)', () => {
    const R: SourceIndep = {
      id: 'R',
      contentHash: 'hR',
      kind: 'structured_spec',
      derivedFromSourceId: null,
    }
    const B: SourceIndep = {
      id: 'B',
      contentHash: 'hB',
      kind: 'structured_spec',
      derivedFromSourceId: 'R',
    }
    const C: SourceIndep = {
      id: 'C',
      contentHash: 'hC',
      kind: 'structured_spec',
      derivedFromSourceId: 'R',
    }
    // claim only cites [B, C]; R is pulled in only to complete the lineage (citedIds excludes R).
    expect(countIndependentSupports([R, B, C], new Set(['B', 'C']))).toBe(1)
    // reverse-error guard (A2): when R is ALSO cited, it must still be 1 — R is the root, B/C collapse,
    // and R is not double-counted on top of its own descendants.
    expect(countIndependentSupports([R, B, C], new Set(['R', 'B', 'C']))).toBe(1)
    // sanity: the legacy in-set behaviour (citedIds omitted ⇒ all cited) still collapses to the root R.
    expect(countIndependentSupports([R, B, C])).toBe(1)
  })

  // EGR-CR-024 (#102) — A3: multiple agent_synthesis siblings off one structured_spec root collapse to the
  // root; the 0.5 discount is NOT applied per-sibling (root kind decides the discount, applied once).
  it('countIndependentSupports: multi-level chain + agent_synthesis discount applied AFTER collapse (A3)', () => {
    const R: SourceIndep = {
      id: 'R',
      contentHash: 'hR',
      kind: 'structured_spec',
      derivedFromSourceId: null,
    }
    const S1: SourceIndep = {
      id: 'S1',
      contentHash: 'hS1',
      kind: 'agent_synthesis',
      derivedFromSourceId: 'R',
    }
    const S2: SourceIndep = {
      id: 'S2',
      contentHash: 'hS2',
      kind: 'agent_synthesis',
      derivedFromSourceId: 'R',
    }
    // claim cites [S1, S2]; both collapse to root R (structured_spec) ⇒ 1, NOT 0.5 + 0.5.
    expect(countIndependentSupports([R, S1, S2], new Set(['S1', 'S2']))).toBe(1)
    // contrast: two INDEPENDENT agent_synthesis roots (no shared ancestor) still each take the 0.5 discount.
    expect(
      countIndependentSupports([
        { ...S1, derivedFromSourceId: null },
        { ...S2, derivedFromSourceId: null },
      ]),
    ).toBeCloseTo(1.0) // 0.5 + 0.5
  })

  it('adjudicate spends the gray-zone LLM exactly at the 0.65 boundary (>=)', async () => {
    const j = makeFakeSameFactJudge({ verdictOf: () => 'same' })
    expect(
      await adjudicate(shape(null, null, null, 'a'), shape(null, null, null, 'b'), 0.65, j),
    ).toBe('same')
    expect(j.callCount()).toBe(1) // 0.65 is inclusive
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
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
  pool.on('error', () => {}) // 吞 teardown 期 DROP ... WITH(FORCE) 终止连接的 57P01（测试已结束、连接被服务端杀属预期）
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

function unit(i: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0)
  v[i] = 1
  return v
}
/** A vector whose cosine similarity with unit(0) is exactly `cos`. */
function vec(cos: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0)
  v[0] = cos
  v[1] = Math.sqrt(1 - cos * cos)
  return v
}

/** Directly seed a claim row with chosen S/P/O, status, and embedding (null allowed) — for candidate-recall setups. */
async function seedClaimRow(opts: {
  subject?: string
  predicate?: string
  object?: string
  claimText?: string
  status?: ClaimStatus
  embedding?: number[] | null
  embeddingVersion?: string
}): Promise<string> {
  const id = randomUUID()
  const text =
    opts.claimText ?? `${opts.subject ?? ''} ${opts.predicate ?? ''} ${opts.object ?? ''}`.trim()
  await db.insert(claim).values({
    id,
    claimText: text || 'seeded',
    subject: opts.subject,
    predicate: opts.predicate,
    object: opts.object,
    status: opts.status ?? 'active',
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: {
        authority: 0.8,
        humanReview: 0,
        entailment: 0.5,
        indepSupport: 0,
        usageCorrect: 0,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: DEFAULT_WEIGHTS,
      calibrationVersion: CALIBRATION_IDENTITY,
    },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
    embedding: opts.embedding === undefined ? await embedder.embed(text) : opts.embedding,
    embeddingVersion: opts.embeddingVersion ?? (opts.embedding === null ? null : embedder.version),
  })
  return id
}

/** Active claim with S/P/O + embedding (no edges) — convenience over seedClaimRow. */
async function seedActiveClaim(s: string, p: string, o: string): Promise<string> {
  return seedClaimRow({ subject: s, predicate: p, object: o, status: 'active' })
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

  it('a tangential provenance is NOT a support and does NOT raise f3 (印证只数 supports 源)', async () => {
    const s1 = await aSource()
    const first = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 maxThroughput 500mbps', ...SKU },
      [{ sourceId: s1.sourceId, locator: 'a' }],
    )
    expect(await indepSupportOf(first.claimId)).toBe(0)

    const s2 = await aSource()
    await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-7 maxThroughput 500mbps', ...SKU },
      [
        { sourceId: s2.sourceId, locator: 'b', relevance: 'tangential' }, // not a support
      ],
    )
    expect(await indepSupportOf(first.claimId)).toBe(0) // tangential ⇒ still one supporting source ⇒ f3 unchanged
  })

  it('stage-2 refines: same subject+object, different predicate ⇒ new claim + a refines edge', async () => {
    const s1 = await aSource()
    const a = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-9 maxLen 1m', subject: 'sku-9', predicate: 'maxLen', object: '1m' },
      [{ sourceId: s1.sourceId, locator: 'a' }],
    )
    const s2 = await aSource()
    const b = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      {
        claimText: 'sku-9 ratedLen 100cm',
        subject: 'sku-9',
        predicate: 'ratedLen',
        object: '100cm',
      },
      [{ sourceId: s2.sourceId, locator: 'b' }],
    )
    expect(b.merged).toBe(false) // refines ⇒ a NEW claim
    expect(b.claimId).not.toBe(a.claimId)
    const rows = await db.select().from(relation)
    expect(
      rows.some(
        (r) => r.fromClaim === b.claimId && r.toClaim === a.claimId && r.type === 'refines',
      ),
    ).toBe(true)
  })

  it('a single commit that is "same" as A and "contradicts" B merges into A AND records the A↔B contradiction (no dropped conflict signal)', async () => {
    // seed two pre-existing claims with NO edge between them: A {sku-5,color,red}, B {sku-5,color,blue}
    const a = await seedActiveClaim('sku-5', 'color', 'red')
    const b = await seedActiveClaim('sku-5', 'color', 'blue')
    expect(await db.select().from(relation)).toHaveLength(0) // no contradiction recorded yet

    // commit a new fact identical to A and contradicting B; both are same-subject candidates in ONE commit
    const s = await aSource()
    const res = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-5 color red', subject: 'sku-5', predicate: 'color', object: 'red' },
      [{ sourceId: s.sourceId, locator: 'c' }],
    )
    expect(res.merged).toBe(true)
    expect(res.claimId).toBe(a) // merged into A (deterministic 'same')
    // the contradiction with B must NOT be dropped — an edge now connects A and B
    const rows = await db.select().from(relation)
    expect(
      rows.some(
        (r) =>
          r.type === 'contradicts' &&
          ((r.fromClaim === a && r.toClaim === b) || (r.fromClaim === b && r.toClaim === a)),
      ),
    ).toBe(true)
  })

  it('commitClaim is atomic: a bad provenance sourceId FK-throws and leaves no partial claim', async () => {
    const before = (await db.select().from(claim)).length
    const s1 = await aSource()
    await expect(
      commitClaim(
        db,
        embedder,
        unrelatedJudge,
        { claimText: 'atomic new fact', subject: 'sku-atomic', predicate: 'p', object: 'o' },
        [
          { sourceId: s1.sourceId, locator: 'good' },
          { sourceId: randomUUID(), locator: 'ghost' }, // non-existent source ⇒ FK violation on the 2nd insert
        ],
      ),
    ).rejects.toThrow()
    expect((await db.select().from(claim)).length).toBe(before) // single transaction rolled back — no orphan claim
  })

  it('stage-1 floor: a near-neighbor below the 0.75 candidate similarity is NOT a candidate (no merge, no gray-zone LLM)', async () => {
    // custom embedder: the probe maps to a vector with cosine 0.70 vs the seeded claim's unit(0) — in (0.65,0.75)
    const tunedJudge = makeFakeSameFactJudge({ verdictOf: () => 'same' })
    const tuned = makeFakeEmbedder({
      version: 'fake:tuned',
      vectorOf: (t) => (t === 'probe near neighbor' ? vec(0.7) : unit(0)),
    })
    await seedClaimRow({ claimText: 'seeded near neighbor', embedding: unit(0) }) // no subject ⇒ NN-only candidate path
    const res = await commitClaim(db, tuned, tunedJudge, { claimText: 'probe near neighbor' }, [
      { sourceId: (await aSource()).sourceId, locator: 'a' },
    ])
    expect(res.merged).toBe(false) // similarity 0.70 < 0.75 ⇒ not a candidate ⇒ new claim
    expect(tunedJudge.callCount()).toBe(0) // sub-0.75 NN never reaches stage-2 adjudication
  })

  it('stage-1 guard: a same-subject claim with a NULL embedding is excluded (not pulled into the gray zone)', async () => {
    const judge = makeFakeSameFactJudge({ verdictOf: () => 'same' })
    await seedClaimRow({
      subject: 'sku-null',
      predicate: 'p',
      object: 'o',
      status: 'active',
      embedding: null,
    })
    const res = await commitClaim(
      db,
      embedder,
      judge,
      { claimText: 'sku-null thing', subject: 'sku-null' },
      [{ sourceId: (await aSource()).sourceId, locator: 'a' }],
    )
    // without the isNotNull(embedding) guard, the null-embedding same-subject row would arrive at similarity 1.0
    // and burn a gray-zone LLM call; the guard excludes it ⇒ no candidate, no call, new claim
    expect(judge.callCount()).toBe(0)
    expect(res.merged).toBe(false)
  })

  it('stage-1 guard: a stale-embeddingVersion claim is excluded from same-fact candidates (no merge, no gray-zone LLM)', async () => {
    // commit embedder maps every text to unit(0) ⇒ the new claim's document vector is cosine 1.0 with the seed.
    const ce = makeFakeEmbedder({ vectorOf: () => unit(0) })
    const judge = makeFakeSameFactJudge({ verdictOf: () => 'same' })
    // seed a nearest-neighbor (cosine 1.0) free-text claim, but stamped STALE → different semantic space.
    await seedClaimRow({
      claimText: 'seeded near neighbor',
      embedding: unit(0),
      embeddingVersion: 'fake:OLD',
    })
    const res = await commitClaim(db, ce, judge, { claimText: 'a different free text fact' }, [
      { sourceId: (await aSource()).sourceId, locator: 'a' },
    ])
    // red (pre-fix): stale vector enters the NN candidate set ⇒ gray-zone LLM fires ⇒ merges into a dead-space claim.
    // green: version filter excludes it ⇒ no candidate, no LLM call, a fresh claim.
    expect(res.merged).toBe(false)
    expect(judge.callCount()).toBe(0)
  })

  it('stage-1 guard: a stale-embeddingVersion same-subject claim is NOT pulled into candidates via subjectKey concatenation', async () => {
    const ce = makeFakeEmbedder({ vectorOf: () => unit(0) })
    const judge = makeFakeSameFactJudge({ verdictOf: () => 'same' })
    // same-subject claim with a stale version; subjectKey concatenation does NOT gate on similarity,
    // so without a version filter this stale row is pulled straight into stage-2 as a strong candidate.
    await seedClaimRow({
      subject: 'sku-stale',
      predicate: 'p',
      object: 'o',
      status: 'active',
      embedding: unit(0),
      embeddingVersion: 'fake:OLD',
    })
    const res = await commitClaim(
      db,
      ce,
      judge,
      { claimText: 'sku-stale thing', subject: 'sku-stale' },
      [{ sourceId: (await aSource()).sourceId, locator: 'a' }],
    )
    // red (pre-fix): stale same-subject row arrives via subjectKey ⇒ 'same' verdict ⇒ merge / LLM burn.
    // green: subjectKey query also filters on embeddingVersion ⇒ excluded ⇒ no candidate, no call, new claim.
    expect(judge.callCount()).toBe(0)
    expect(res.merged).toBe(false)
  })

  it('superseded claims are never merge targets: an equivalent fact creates a NEW claim, not a merge into the dead version', async () => {
    const dead = await seedClaimRow({
      subject: 'sku-3',
      predicate: 'p',
      object: 'o',
      status: 'superseded',
    })
    const s1 = await aSource()
    const res = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-3 p o', subject: 'sku-3', predicate: 'p', object: 'o' },
      [{ sourceId: s1.sourceId, locator: 'a' }],
    )
    expect(res.merged).toBe(false) // superseded is excluded from candidates ⇒ new claim
    expect(res.claimId).not.toBe(dead)
    expect((await db.select().from(claim)).length).toBe(2) // the dead version is still there, plus the new claim
  })

  // 红线 #2「只人能放松，agent 只能收紧」+ 防数据丢失：人隔离/收紧过的 claim（quarantined/flagged）不可作 agent 合并目标。
  for (const status of ['quarantined', 'flagged'] as const) {
    it(`${status} claims are never merge targets: an equivalent agent fact creates a NEW draft (no provenance attached to the isolated claim, no confidence raise)`, async () => {
      const isolated = await seedClaimRow({
        subject: 'sku-q',
        predicate: 'p',
        object: 'o',
        status,
      })
      const before = await db.select().from(claim).where(eq(claim.id, isolated))
      const s1 = await aSource()
      const res = await commitClaim(
        db,
        embedder,
        unrelatedJudge,
        {
          claimText: 'sku-q p o',
          subject: 'sku-q',
          predicate: 'p',
          object: 'o',
          createdBy: 'agent:distiller',
        },
        [{ sourceId: s1.sourceId, locator: 'a' }],
      )
      // (1) not swallowed: a real new fact matching an isolated claim becomes its own recallable draft
      expect(res.merged).toBe(false)
      expect(res.claimId).not.toBe(isolated)
      expect((await db.select().from(claim)).length).toBe(2)
      // (2) the isolated claim gained NO provenance — an agent did not strengthen a human-isolated claim
      const isolatedProv = await db
        .select()
        .from(claimProvenance)
        .where(eq(claimProvenance.claimId, isolated))
      expect(isolatedProv).toHaveLength(0)
      // (3) its confidence is untouched (no upward recompute)
      const after = await db.select().from(claim).where(eq(claim.id, isolated))
      expect(after[0]!.confidence).toBe(before[0]!.confidence)
      expect(after[0]!.status).toBe(status) // still isolated
    })
  }

  it('merge prefers a healthy same-fact target over a more-isolated one: an active twin absorbs the merge, the quarantined twin is left untouched', async () => {
    const quarantined = await seedClaimRow({
      subject: 'sku-z',
      predicate: 'p',
      object: 'o',
      status: 'quarantined',
    })
    const active = await seedClaimRow({
      subject: 'sku-z',
      predicate: 'p',
      object: 'o',
      status: 'active',
    })
    const s1 = await aSource()
    const res = await commitClaim(
      db,
      embedder,
      unrelatedJudge,
      { claimText: 'sku-z p o', subject: 'sku-z', predicate: 'p', object: 'o' },
      [{ sourceId: s1.sourceId, locator: 'a' }],
    )
    expect(res.merged).toBe(true)
    expect(res.claimId).toBe(active) // merged into the mergeable twin, skipping the quarantined one
    // the quarantined twin gained no provenance
    const qProv = await db
      .select()
      .from(claimProvenance)
      .where(eq(claimProvenance.claimId, quarantined))
    expect(qProv).toHaveLength(0)
    expect((await db.select().from(claim)).length).toBe(2) // no third claim created
  })

  it('merge edge dedup: committing the same contradicting fact twice into a merge target keeps a single A↔B contradicts edge', async () => {
    const a = await seedActiveClaim('sku-6', 'color', 'red')
    const b = await seedActiveClaim('sku-6', 'color', 'blue')
    const mk = async () =>
      commitClaim(
        db,
        embedder,
        unrelatedJudge,
        { claimText: 'sku-6 color red', subject: 'sku-6', predicate: 'color', object: 'red' },
        [{ sourceId: (await aSource()).sourceId, locator: 'x' }],
      )
    await mk() // merges into A, records A↔B contradiction
    await mk() // merges again — must NOT add a second A↔B contradicts edge
    const rows = await db.select().from(relation)
    const ab = rows.filter(
      (r) =>
        r.type === 'contradicts' &&
        ((r.fromClaim === a && r.toClaim === b) || (r.fromClaim === b && r.toClaim === a)),
    )
    expect(ab).toHaveLength(1)
  })

  it('D1: commitClaim rejects a claim with zero provenance', async () => {
    await expect(
      commitClaim(db, embedder, unrelatedJudge, { claimText: 'no provenance' }, []),
    ).rejects.toThrow(/D1 violation/)
  })
})
