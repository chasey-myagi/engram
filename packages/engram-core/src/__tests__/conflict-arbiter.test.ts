import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { claim, claimProvenance, relation, type SourceKind } from '../db/schema.js'
import { addSource, appendClaim, supersedeClaim } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { transitionClaim } from '../spi/transition.js'
import { adjudicateConflict } from '../spi/conflict-ladder.js'
import {
  escalateConflict,
  getEditorConflictQueue,
  getResolvedConflicts,
  loadConflictSide,
  resolveConflict,
} from '../spi/conflict-arbiter.js'

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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events CASCADE',
  )
})

async function aSource(opts: { kind?: SourceKind; authority?: number } = {}) {
  return addSource(db, {
    content: `body-${randomUUID()}`,
    contentHash: randomUUID(),
    kind: opts.kind ?? 'structured_spec',
    authorityScore: opts.authority ?? 0.5,
  })
}

/** Append an active S/P/O claim from a given source with a chosen as_of, then promote to active. */
async function activeClaim(opts: {
  subject: string
  predicate: string
  object: string
  sourceId: string
  asOf: Date
}): Promise<string> {
  const { claimId } = await appendClaim(
    db,
    embedder,
    {
      claimText: `${opts.subject} ${opts.predicate} ${opts.object}`,
      subject: opts.subject,
      predicate: opts.predicate,
      object: opts.object,
      asOf: opts.asOf,
      createdBy: 'test:author',
    },
    [{ sourceId: opts.sourceId, locator: 'L1', relevance: 'exact' }],
  )
  // human Approve bypasses the promote gate so we can recall the claim.
  await transitionClaim(db, claimId, 'active', { by: 'human:editor' })
  return claimId
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.select({ status: claim.status }).from(claim).where(eq(claim.id, id))
  return row!.status
}

// HIGH factor profile that clears the recall floor (0.4) even under one active contradiction (conflictDecay 0.667):
// base ≈ 0.8 ⇒ raw ≈ 0.53 ≥ 0.4. Mirrors transition.test.ts's direct-seed pattern so recall is deterministic,
// isolating the Arbiter behavior from confidence-gate fiddliness while still exercising the real recall seam.
const HIGH = {
  authority: 0.8,
  humanReview: 0.8,
  entailment: 0.8,
  indepSupport: 0.8,
  usageCorrect: 0.8,
}

/** Directly seed an ACTIVE, recallable S/P/O claim (HIGH profile) + one exact provenance from a chosen source. */
async function seedActiveClaim(opts: {
  query: string
  subject: string
  predicate: string
  object: string
  asOf: Date
  authority: number
}): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: opts.query,
    subject: opts.subject,
    predicate: opts.predicate,
    object: opts.object,
    status: 'active',
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: { ...HIGH, ageDays: 0, activeContradicts: 0, staleDecay: 1, conflictDecay: 1 },
      weights: DEFAULT_WEIGHTS,
      calibrationVersion: CALIBRATION_IDENTITY,
    },
    lineageId: randomUUID(),
    asOf: opts.asOf,
    createdBy: 'test:author',
    embedding: await embedder.embed(opts.query),
    embeddingVersion: embedder.version,
  })
  const { sourceId } = await aSource({ authority: opts.authority })
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'L1', relevance: 'exact' })
  return id
}

/** Seed two contradicting active claims with the SAME query text (so recall returns both) + a contradicts edge. */
async function seedConflictPair(opts: {
  query: string
  aAsOf: Date
  bAsOf: Date
  aAuthority: number
  bAuthority: number
}): Promise<{ a: string; b: string }> {
  const a = await seedActiveClaim({
    query: opts.query,
    subject: 'k',
    predicate: 'p',
    object: 'A',
    asOf: opts.aAsOf,
    authority: opts.aAuthority,
  })
  const b = await seedActiveClaim({
    query: opts.query,
    subject: 'k',
    predicate: 'p',
    object: 'B',
    asOf: opts.bAsOf,
    authority: opts.bAuthority,
  })
  await db
    .insert(relation)
    .values({ id: randomUUID(), fromClaim: a, toClaim: b, type: 'contradicts' })
  return { a, b }
}

describe('S20 conflict-arbiter SPI (A.5): deterministic adjudication, no status relax, recall dual-returns', () => {
  it('loadConflictSide snapshots the deterministic ladder inputs (as_of / strongest authority / indepSupport / supersedes)', async () => {
    const strong = await aSource({ authority: 0.9 })
    const asOf = new Date('2025-03-01T00:00:00.000Z')
    const id = await activeClaim({
      subject: 'sku-1',
      predicate: 'price',
      object: '10',
      sourceId: strong.sourceId,
      asOf,
    })
    const s = await loadConflictSide(db, id)
    expect(s.claimId).toBe(id)
    expect(s.asOf.getTime()).toBe(asOf.getTime())
    expect(s.authority).toBe(0.9) // strongest supporting source authority
    expect(s.indepSupport).toBe(1) // one independent supporting source
    expect(s.supersedes.size).toBe(0)
  })

  it('loadConflictSide ignores tangential/irrelevant provenance when scoring authority/indepSupport (anti-Goodhart: an off-relevance source cannot inflate the ladder ④/⑤)', async () => {
    // one LOW-authority EXACT source (counts) + a HIGH-authority TANGENTIAL and a HIGH-authority IRRELEVANT (must NOT count)
    const id = randomUUID()
    await db.insert(claim).values({
      id,
      claimText: 'sku-rel relevance filter',
      subject: 'sku-rel',
      predicate: 'p',
      object: 'o',
      status: 'active',
      confidence: 0.5,
      confidenceRaw: 0.5,
      confidenceFactors: {
        factors: { ...HIGH, ageDays: 0, activeContradicts: 0, staleDecay: 1, conflictDecay: 1 },
        weights: DEFAULT_WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      lineageId: randomUUID(),
      asOf: new Date(),
      createdBy: 'test:author',
      embedding: null,
      embeddingVersion: null,
    })
    const exact = await aSource({ authority: 0.2 })
    const tangential = await aSource({ authority: 0.99 })
    const irrelevant = await aSource({ authority: 0.95 })
    await db.insert(claimProvenance).values([
      {
        id: randomUUID(),
        claimId: id,
        sourceId: exact.sourceId,
        locator: 'L1',
        relevance: 'exact',
      },
      {
        id: randomUUID(),
        claimId: id,
        sourceId: tangential.sourceId,
        locator: 'L2',
        relevance: 'tangential',
      },
      {
        id: randomUUID(),
        claimId: id,
        sourceId: irrelevant.sourceId,
        locator: 'L3',
        relevance: 'irrelevant',
      },
    ])
    const s = await loadConflictSide(db, id)
    // ④ authority = the EXACT source's 0.2, NOT the tangential 0.99 / irrelevant 0.95 (off-relevance excluded)
    expect(s.authority).toBe(0.2)
    // ⑤ indepSupport counts only the one exact (supporting) source — off-relevance sources don't pad it
    expect(s.indepSupport).toBe(1)
  })

  it('loadConflictSide reflects a supersedes edge: the new head supersedes the old version', async () => {
    const src = await aSource()
    const oldId = await activeClaim({
      subject: 's',
      predicate: 'p',
      object: 'v1',
      sourceId: src.sourceId,
      asOf: new Date('2024-01-01T00:00:00.000Z'),
    })
    const { claimId: newId } = await supersedeClaim(
      db,
      embedder,
      oldId,
      { claimText: 's p v2', subject: 's', predicate: 'p', object: 'v2', createdBy: 'test:author' },
      [{ sourceId: src.sourceId, locator: 'L2', relevance: 'exact' }],
    )
    const sNew = await loadConflictSide(db, newId)
    expect(sNew.supersedes.has(oldId)).toBe(true)
    const sOld = await loadConflictSide(db, oldId)
    expect(sOld.supersedes.size).toBe(0)
  })

  it('resolveConflict (unique winner): records a contradicts edge + a resolved believed/trust marker, and does NOT change either claim status', async () => {
    const t = new Date('2025-01-01T00:00:00.000Z')
    // equal recency; a has stronger source authority → wins at ④ authority
    const { a, b } = await seedConflictPair({
      query: 'k p A',
      aAsOf: t,
      bAsOf: t,
      aAuthority: 0.95,
      bAuthority: 0.3,
    })

    const adj = adjudicateConflict(await loadConflictSide(db, a), await loadConflictSide(db, b))
    expect(adj.outcome).toBe('winner')
    expect(adj.winnerId).toBe(a) // stronger authority, equal recency
    expect(adj.rung).toBe('authority')

    const res = await resolveConflict(db, { a, b, adjudication: adj, byRole: 'agent:arbiter' })
    expect(res.outcome).toBe('resolved')
    expect(res.winnerId).toBe(a)
    expect(res.loserId).toBe(b)

    // a contradicts edge connects the two; resolve is idempotent (the seed edge is reused, not duplicated)
    const edges = await db.select().from(relation).where(eq(relation.type, 'contradicts'))
    expect(edges.length).toBe(1)

    // believed/trust marker recorded, NO escalation
    const resolved = await getResolvedConflicts(db)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.payload.winnerId).toBe(a)
    expect(resolved[0]!.payload.rung).toBe('authority')
    expect(await getEditorConflictQueue(db)).toHaveLength(0)

    // RED LINE #2: Arbiter marks trust but does NOT relax/quarantine/revive — both stay active
    expect(await statusOf(a)).toBe('active')
    expect(await statusOf(b)).toBe('active')
  })

  it("recall still dual-returns BOTH sides with contradicts + each side's as_of after a resolved verdict (no auto-pick at recall)", async () => {
    const tA = new Date('2025-02-01T00:00:00.000Z')
    const tB = new Date('2025-01-01T00:00:00.000Z')
    const { a, b } = await seedConflictPair({
      query: 'k p A',
      aAsOf: tA,
      bAsOf: tB,
      aAuthority: 0.95,
      bAuthority: 0.3,
    })

    const adj = adjudicateConflict(await loadConflictSide(db, a), await loadConflictSide(db, b))
    expect(adj.rung).toBe('recency') // a is newer → recency decides before authority
    await resolveConflict(db, { a, b, adjudication: adj, byRole: 'agent:arbiter' })

    // recall the conflicted fact: BOTH sides come back, each carrying the contradicts pointer + its own as_of
    const hits = await recallClaims(db, embedder, 'k p A')
    const byId = new Map(hits.map((h) => [h.claim.id, h]))
    expect(byId.has(a)).toBe(true)
    expect(byId.has(b)).toBe(true)
    expect(byId.get(a)!.contradicts).toContain(b)
    expect(byId.get(b)!.contradicts).toContain(a)
    expect(byId.get(a)!.claim.asOf.getTime()).toBe(tA.getTime())
    expect(byId.get(b)!.claim.asOf.getTime()).toBe(tB.getTime())
  })

  it('escalateConflict (tie / insufficient evidence): enqueues to the editor-in-chief, keeps both recallable, does NOT change status', async () => {
    const t = new Date('2025-01-01T00:00:00.000Z')
    // identical authority, recency, indepSupport, no supersede → tie → escalate
    const { a, b } = await seedConflictPair({
      query: 'k p A',
      aAsOf: t,
      bAsOf: t,
      aAuthority: 0.5,
      bAuthority: 0.5,
    })

    const adj = adjudicateConflict(await loadConflictSide(db, a), await loadConflictSide(db, b))
    expect(adj.outcome).toBe('escalate')

    const res = await escalateConflict(db, {
      a,
      b,
      rung: adj.rung,
      reason: adj.reason,
      byRole: 'agent:arbiter',
    })
    expect(res.outcome).toBe('escalated')

    const queue = await getEditorConflictQueue(db)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.payload.outcome).toBe('escalated')
    expect(queue[0]!.payload.rung).toBe('human') // waits for the human to apply ① human ruling
    expect(new Set([queue[0]!.payload.claimA, queue[0]!.payload.claimB])).toEqual(new Set([a, b]))
    expect(await getResolvedConflicts(db)).toHaveLength(0)

    // both stay active and both still recallable with the contradicts pointer
    expect(await statusOf(a)).toBe('active')
    expect(await statusOf(b)).toBe('active')
    const hits = await recallClaims(db, embedder, 'k p A')
    expect(hits.map((h) => h.claim.id).sort()).toEqual([a, b].sort())
  })

  it('loadConflictSide throws for a missing claim', async () => {
    await expect(loadConflictSide(db, randomUUID())).rejects.toThrow(/not found/)
  })

  it('resolveConflict refuses an adjudication that is not a unique winner', async () => {
    await expect(
      resolveConflict(db, {
        a: randomUUID(),
        b: randomUUID(),
        adjudication: { outcome: 'escalate', rung: 'human', reason: 'tie' },
        byRole: 'agent:arbiter',
      }),
    ).rejects.toThrow(/unique winner/)
  })
})
