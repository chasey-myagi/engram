import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  CALIBRATION_IDENTITY,
  DEFAULT_WEIGHTS,
  KERNEL_CONFIDENCE_FLOOR,
} from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { claim, claimProvenance } from '../db/schema.js'
import { addSource } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { GAP_RECORDED, getGapEvents, getMetricsEvents } from '../spi/metrics.js'
import { L5_GAP_NAMESPACE, L5_GAP_QUESTIONS, runGapQuestion, runL5Suite } from '../eval/l5-gap.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder = makeFakeEmbedder()

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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, claim_verification, metrics_events CASCADE',
  )
})

async function aSource() {
  return addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
}

/** Factor profiles whose recomputed value (DEFAULT_WEIGHTS, g=identity, decays=1) lands on either side of the 0.4 floor. */
const ABOVE_FLOOR = {
  authority: 0.8,
  humanReview: 0.8,
  entailment: 0.8,
  indepSupport: 0.8,
  usageCorrect: 0.8,
} // base = 0.8 ⇒ value 0.8 (above floor, not mustVerify)
const JUST_BELOW_FLOOR = {
  authority: 0.55,
  humanReview: 0.5,
  entailment: 0.5,
  indepSupport: 0,
  usageCorrect: 0,
} // base = 0.3·0.55 + 0.3·0.5 + 0.15·0.5 = 0.39 ⇒ value 0.39 (just under the 0.4 floor)

/** Insert an active claim with an explicit embedding vector + factor profile (no provenance attached). */
async function seedActiveClaimRow(
  text: string,
  vector: number[],
  profile: typeof ABOVE_FLOOR,
): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: text,
    status: 'active',
    confidence: 0.5,
    confidenceRaw: 0.5,
    confidenceFactors: {
      factors: { ...profile, ageDays: 0, activeContradicts: 0, staleDecay: 1, conflictDecay: 1 },
      weights: DEFAULT_WEIGHTS,
      calibrationVersion: CALIBRATION_IDENTITY,
    },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
    embedding: vector,
    embeddingVersion: embedder.version,
  })
  return id
}

/** Seed a recallable active claim with an explicit embedding vector + factor profile + one exact provenance. */
async function seedActive(
  text: string,
  vector: number[],
  profile: typeof ABOVE_FLOOR,
): Promise<string> {
  const id = await seedActiveClaimRow(text, vector, profile)
  const { sourceId } = await aSource()
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

describe('S10 gap honesty signal + L5 blind-spot suite (A.9)', () => {
  it('a fresh KB answers every L5 question as a gap: recall [] + a gap_recorded referencing the query; blind-spot score = 1', async () => {
    const report = await runL5Suite(db, embedder)

    expect(report.total).toBe(L5_GAP_QUESTIONS.length)
    expect(report.correct).toBe(report.total)
    expect(report.blindSpotScore).toBe(1) // every gap question correctly answered as "don't know"
    expect(report.results.every((r) => r.recalled === 0 && r.gapRecorded)).toBe(true)

    // every question's query is referenced by at least one gap_recorded row
    for (const q of L5_GAP_QUESTIONS) {
      expect((await getGapEvents(db, q.query)).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('on an empty KB the gap payload shows no candidate existed (candidateCount 0), not a fabricated/below-floor pick', async () => {
    const q = 'totally unknown subject with no claims in the kb'
    const hits = await recallClaims(db, embedder, q)
    expect(hits).toHaveLength(0)
    const gaps = await getGapEvents(db, q)
    expect(gaps).toHaveLength(1) // exactly one gap per recall — no double-write
    const p = gaps[0]!.payload
    expect(gaps[0]!.queryText).toBe(q)
    expect(p.candidateCount).toBe(0)
    expect(p.gatedCount).toBe(0)
    expect(p.floor).toBe(KERNEL_CONFIDENCE_FLOOR) // default consumption floor faithfully recorded
    expect(p.embedderVersion).toBe(embedder.version)
  })

  it('door-behind: a claim seeded JUST below the 0.4 floor still yields zero recall + a gap (a candidate existed but was gated, not similarity-blind)', async () => {
    const q = 'precise spec lookup for the gated widget'
    // embed the claim with the query's own vector ⇒ it is unambiguously a similarity candidate.
    const qVec = await embedder.embed(q, 'query')
    await seedActive('the gated widget spec answer lives here', qVec, JUST_BELOW_FLOOR)

    const hits = await recallClaims(db, embedder, q)
    expect(hits).toHaveLength(0) // door is behind the floor, not absent

    const gaps = await getGapEvents(db, q)
    expect(gaps).toHaveLength(1)
    const p = gaps[0]!.payload
    expect(p.candidateCount).toBeGreaterThanOrEqual(1) // similarity DID surface it
    expect(p.gatedCount).toBe(0) // …but nothing cleared the floor ⇒ honest gap (door-behind sub-kind)
  })

  it('D1 fallback gap: an above-floor candidate with NO provenance is dropped and yields an honest gap with gatedCount ≥ 1 (distinct from door-behind)', async () => {
    const q = 'spec lookup whose only answer lacks any provenance'
    const qVec = await embedder.embed(q, 'query')
    // above the floor AND a similarity candidate, but deliberately zero provenance rows ⇒ recall drops it (D1 兜底)
    await seedActiveClaimRow('the answer exists but has no provenance', qVec, ABOVE_FLOOR)

    const hits = await recallClaims(db, embedder, q)
    expect(hits).toHaveLength(0) // no-provenance claim never surfaces (D1)

    const gaps = await getGapEvents(db, q)
    expect(gaps).toHaveLength(1)
    const p = gaps[0]!.payload
    expect(p.candidateCount).toBeGreaterThanOrEqual(1)
    expect(p.gatedCount).toBeGreaterThanOrEqual(1) // it CLEARED the floor (gated) but was dropped for no provenance
  })

  it('the recorded floor reflects a consumer-tightened ctx.confidenceFloor (the blind-spot stream attributes the actual gate)', async () => {
    const q = 'unanswerable query asked under a tightened floor'
    await recallClaims(db, embedder, q, { confidenceFloor: 0.7 })
    const gaps = await getGapEvents(db, q)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.payload.floor).toBe(0.7) // not the kernel 0.4 — the consumer raised it and that is what was applied
  })

  it('mixed population still recalls (no gap): one above-floor + one below-floor candidate ⇒ a hit, no whiteout', async () => {
    const q = 'mixed population query'
    const qVec = await embedder.embed(q, 'query')
    const good = await seedActive('mixed population strong answer', qVec, ABOVE_FLOOR)
    await seedActive('mixed population weak answer', qVec, JUST_BELOW_FLOOR)

    const hits = await recallClaims(db, embedder, q)
    expect(hits.map((r) => r.claim.id)).toEqual([good]) // only the above-floor one
    expect(await getGapEvents(db, q)).toHaveLength(0) // gap fires only on total whiteout, not partial
  })

  it('a very long query records its gap without throwing (hash index, not the 8191-byte btree limit)', async () => {
    const q = 'x'.repeat(20_000) // far past the btree single-entry limit; agent-native KBs pass long context as query
    await expect(recallClaims(db, embedder, q)).resolves.toHaveLength(0) // must not throw on the metrics write
    expect(await getGapEvents(db, q)).toHaveLength(1) // the blind-spot signal still lands on the extreme input
  })

  it('control: a real above-floor answer recalls normally and records NO gap', async () => {
    const q = 'control query with a real answer present'
    const qVec = await embedder.embed(q, 'query')
    const answer = await seedActive('the real answer to the control query', qVec, ABOVE_FLOOR)

    const before = (await getGapEvents(db, q)).length
    const hits = await recallClaims(db, embedder, q)
    const after = (await getGapEvents(db, q)).length

    expect(hits.map((r) => r.claim.id)).toContain(answer)
    expect(hits[0]!.mustVerify).toBe(false) // value 0.8 ≥ mustVerify threshold
    expect(after).toBe(before) // a recall that returns something records no gap
  })

  it('the suite is live, not hard-coded: adding a real above-floor answer flips an L5 question from gap to normal recall', async () => {
    const target = L5_GAP_QUESTIONS[10]! // l5-11 (warranty period…)

    const beforeAnswer = await runGapQuestion(db, embedder, target)
    expect(beforeAnswer.correct).toBe(true) // initially a gap (no answer in the KB)

    // graft a real above-floor answer addressable by this exact query
    const qVec = await embedder.embed(target.query, 'query')
    await seedActive(
      'the field-replaceable photonics module warranty is 36 months',
      qVec,
      ABOVE_FLOOR,
    )

    const afterAnswer = await runGapQuestion(db, embedder, target)
    expect(afterAnswer.recalled).toBeGreaterThanOrEqual(1)
    expect(afterAnswer.gapRecorded).toBe(false) // no new gap once the KB can answer
    expect(afterAnswer.correct).toBe(false) // the gold answer flipped from don't-know to recall
  })

  it('an empty query is not a question: returns [] and records NO gap', async () => {
    const hits = await recallClaims(db, embedder, '')
    expect(hits).toHaveLength(0)
    expect(await getGapEvents(db)).toHaveLength(0) // malformed input must not pollute the blind-spot stream
  })

  it('L5 questions are a frozen suite of 10–20 in an isolated namespace, never written as claims (so recall structurally cannot surface them)', async () => {
    expect(L5_GAP_NAMESPACE).toBe('eval:l5-gap')
    expect(L5_GAP_QUESTIONS.length).toBeGreaterThanOrEqual(10)
    expect(L5_GAP_QUESTIONS.length).toBeLessThanOrEqual(20)
    expect(Object.isFrozen(L5_GAP_QUESTIONS)).toBe(true)
    expect(L5_GAP_QUESTIONS.every((q) => Object.isFrozen(q))).toBe(true)
    expect(new Set(L5_GAP_QUESTIONS.map((q) => q.id)).size).toBe(L5_GAP_QUESTIONS.length) // unique ids

    // running the whole scored suite must never insert a claim — the namespace is firewalled from the store
    await runL5Suite(db, embedder)
    const rows = (await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM claim'))
      .rows
    expect(rows[0]!.count).toBe('0')
  })

  it('metrics events read back ordered: getMetricsEvents ascending, getGapEvents descending (same set, reversed)', async () => {
    // three distinct gaps, recorded in sequence
    await recallClaims(db, embedder, 'first unanswerable query alpha')
    await recallClaims(db, embedder, 'second unanswerable query beta')
    await recallClaims(db, embedder, 'third unanswerable query gamma')

    const asc = await getMetricsEvents(db, GAP_RECORDED)
    const desc = await getGapEvents(db)
    expect(asc).toHaveLength(3)
    expect(desc).toHaveLength(3)
    // A dropped/reversed orderBy on either side breaks this: desc must be asc reversed. The secondary
    // id tiebreaker (both sides) is what makes "asc reversed === desc" deterministic even if two inserts
    // share a created_at — don't simplify the orderBy to created_at alone or this reintroduces flakiness.
    expect(desc.map((e) => e.id)).toEqual(asc.map((e) => e.id).reverse())
    // and ascending really is non-decreasing in time
    expect(asc[0]!.createdAt.getTime()).toBeLessThanOrEqual(asc[2]!.createdAt.getTime())
  })

  it('repeated unanswered asks accumulate (append-only): asking the same gap twice records two gap rows for that query', async () => {
    const q = 'persistently unanswered question'
    await recallClaims(db, embedder, q)
    await recallClaims(db, embedder, q)
    expect(await getGapEvents(db, q)).toHaveLength(2) // frequency of asking = strength of the blind-spot signal
  })
})
