import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { claim, claimProvenance, relation, type ClaimStatus } from '../db/schema.js'
import { addSource, supersedeClaim } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { transitionClaim } from '../spi/transition.js'

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
  await pool.query('TRUNCATE source, claim, claim_provenance, relation, claim_verification CASCADE')
})

// base = Σ wᵢ·fᵢ over DEFAULT_WEIGHTS (g=identity, decays=1):
const HIGH = {
  authority: 0.8,
  humanReview: 0.8,
  entailment: 0.8,
  indepSupport: 0.8,
  usageCorrect: 0.8,
} // ⇒ 0.80 (≥0.5)
const MID = { authority: 0.6, humanReview: 0.6, entailment: 0.5, indepSupport: 0, usageCorrect: 0 } // ⇒ 0.435 (<0.5, ≥0.4)

async function aSource() {
  return addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
}

/** Seed a claim at a chosen status + factor profile (recallable embedding = query) + one exact provenance. */
async function seedClaim(opts: {
  query: string
  status: ClaimStatus
  profile: typeof HIGH
}): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: `claim for ${opts.query}`,
    status: opts.status,
    confidence: 0.5,
    confidenceRaw: 0.5,
    confidenceFactors: {
      factors: {
        ...opts.profile,
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
    embedding: await embedder.embed(opts.query),
    embeddingVersion: embedder.version,
  })
  const { sourceId } = await aSource()
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

async function statusOf(id: string): Promise<ClaimStatus> {
  const [row] = await db.select({ status: claim.status }).from(claim).where(eq(claim.id, id))
  return row!.status
}

describe('S13 claim state machine (A.4): blue tightens only, red relaxes, lineage preserved', () => {
  it('draft→active (blue) promotes only with conf≥0.5 AND entailment pass, then becomes recallable', async () => {
    const q = 'promotable draft about the relay'
    const id = await seedClaim({ query: q, status: 'draft', profile: HIGH })
    expect(await recallClaims(db, embedder, q)).toHaveLength(0) // draft shadow zone: not recalled

    const res = await transitionClaim(db, id, 'active', {
      by: 'agent:verifier',
      entailmentPass: true,
    })
    expect(res).toEqual({ from: 'draft', to: 'active' })
    expect(await statusOf(id)).toBe('active')
    expect((await recallClaims(db, embedder, q)).map((r) => r.claim.id)).toContain(id) // now recallable
  })

  it('draft→active (blue) is blocked when entailment did not pass — stays draft, not recalled', async () => {
    const q = 'draft with conf but no entailment'
    const id = await seedClaim({ query: q, status: 'draft', profile: HIGH }) // conf 0.8 ≥ 0.5
    await expect(
      transitionClaim(db, id, 'active', { by: 'agent:verifier' }), // entailmentPass omitted
    ).rejects.toThrow(/entailment did not pass/)
    await expect(
      transitionClaim(db, id, 'active', { by: 'agent:verifier', entailmentPass: false }),
    ).rejects.toThrow(/entailment did not pass/)
    expect(await statusOf(id)).toBe('draft')
    expect(await recallClaims(db, embedder, q)).toHaveLength(0)
  })

  it('draft→active (blue) is blocked below the conf floor even with entailment pass — stays draft', async () => {
    const q = 'low-confidence draft'
    const id = await seedClaim({ query: q, status: 'draft', profile: MID }) // conf 0.435 < 0.5
    await expect(
      transitionClaim(db, id, 'active', { by: 'agent:verifier', entailmentPass: true }),
    ).rejects.toThrow(/conf .* < 0\.5/)
    expect(await statusOf(id)).toBe('draft')
  })

  it('human Approve promotes a sub-0.5 draft regardless of the conf/entailment gate (event-driven, not conf-alone)', async () => {
    const q = 'human-approved low-conf draft'
    const id = await seedClaim({ query: q, status: 'draft', profile: MID }) // conf 0.435: blue would be blocked
    const res = await transitionClaim(db, id, 'active', { by: 'human:editor' }) // human Approve, no entailment
    expect(res.to).toBe('active')
    expect(await statusOf(id)).toBe('active')
    // conf 0.435 ≥ kernel floor 0.4 ⇒ recallable once promoted
    expect((await recallClaims(db, embedder, q)).map((r) => r.claim.id)).toContain(id)
  })

  it('blue tightening is free for agents: active→flagged→quarantined', async () => {
    const id = await seedClaim({ query: 'tighten me', status: 'active', profile: HIGH })
    expect((await transitionClaim(db, id, 'flagged', { by: 'agent:patrol' })).to).toBe('flagged')
    expect(await statusOf(id)).toBe('flagged')
    expect((await transitionClaim(db, id, 'quarantined', { by: 'agent:patrol' })).to).toBe(
      'quarantined',
    )
    expect(await statusOf(id)).toBe('quarantined')
  })

  it('A.4 red line — relaxation (quarantined→active) is rejected for an agent but succeeds for a human with recorded new positive exact evidence', async () => {
    const id = await seedClaim({ query: 'quarantined claim', status: 'quarantined', profile: HIGH })

    // blue/agent cannot relax
    await expect(transitionClaim(db, id, 'active', { by: 'agent:rogue' })).rejects.toThrow(
      /requires a human caller/,
    )
    // a human still cannot relax WITHOUT recorded new positive exact evidence
    await expect(transitionClaim(db, id, 'active', { by: 'human:judge' })).rejects.toThrow(
      /new positive exact evidence/,
    )
    expect(await statusOf(id)).toBe('quarantined') // still tight

    // a human WITH new positive exact evidence succeeds, and that evidence is recorded
    const { sourceId } = await aSource()
    const before = (await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, id)))
      .length
    const res = await transitionClaim(db, id, 'active', {
      by: 'human:judge',
      evidence: { sourceId, locator: 'rehab-doc#1' },
    })
    expect(res).toEqual({ from: 'quarantined', to: 'active' })
    expect(await statusOf(id)).toBe('active')
    const provs = await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, id))
    expect(provs.length).toBe(before + 1) // a new provenance row was recorded
    expect(provs.some((p) => p.locator === 'rehab-doc#1' && p.relevance === 'exact')).toBe(true)
  })

  it('A.4 red line — flagged→active and superseded→active are human-only relaxations too', async () => {
    const { sourceId } = await aSource()
    const flagged = await seedClaim({ query: 'flagged claim', status: 'flagged', profile: HIGH })
    await expect(transitionClaim(db, flagged, 'active', { by: 'agent:x' })).rejects.toThrow(
      /requires a human caller/,
    )
    expect(
      (
        await transitionClaim(db, flagged, 'active', {
          by: 'human:j',
          evidence: { sourceId, locator: 'l' },
        })
      ).to,
    ).toBe('active')

    const sup = await seedClaim({ query: 'superseded claim', status: 'superseded', profile: HIGH })
    await expect(transitionClaim(db, sup, 'active', { by: 'agent:x' })).rejects.toThrow(
      /requires a human caller/,
    )
    expect(
      (
        await transitionClaim(db, sup, 'active', {
          by: 'human:j',
          evidence: { sourceId, locator: 'l2' },
        })
      ).to,
    ).toBe('active')
  })

  it('illegal transitions are rejected (draft→quarantined, superseded→flagged, active→quarantined skip); →superseded routes to supersedeClaim', async () => {
    const draft = await seedClaim({ query: 'd', status: 'draft', profile: HIGH })
    await expect(transitionClaim(db, draft, 'quarantined', { by: 'human:j' })).rejects.toThrow(
      /illegal transition draft → quarantined/,
    )

    const sup = await seedClaim({ query: 's', status: 'superseded', profile: HIGH })
    await expect(transitionClaim(db, sup, 'flagged', { by: 'human:j' })).rejects.toThrow(
      /illegal transition superseded → flagged/,
    )

    const active = await seedClaim({ query: 'a', status: 'active', profile: HIGH })
    await expect(transitionClaim(db, active, 'quarantined', { by: 'agent:x' })).rejects.toThrow(
      /illegal transition active → quarantined/,
    )
    await expect(transitionClaim(db, active, 'active', { by: 'agent:x' })).rejects.toThrow(/no-op/)
    await expect(transitionClaim(db, active, 'superseded', { by: 'agent:x' })).rejects.toThrow(
      /supersedeClaim/,
    )
  })

  it('append-only supersede: new version reuses lineage_id + supersedes relation; old marked superseded, not deleted', async () => {
    const { sourceId } = await aSource()
    const oldId = await seedClaim({ query: 'v1 fact', status: 'active', profile: HIGH })

    const [oldRow] = await db
      .select({ lineageId: claim.lineageId })
      .from(claim)
      .where(eq(claim.id, oldId))
    const oldLineage = oldRow!.lineageId

    const { claimId: newId } = await supersedeClaim(
      db,
      embedder,
      oldId,
      { claimText: 'v2 fact (corrected)' },
      [{ sourceId, locator: 'v2-doc' }],
    )

    // new version reuses the SAME lineage_id
    const [newRow] = await db
      .select({ lineageId: claim.lineageId })
      .from(claim)
      .where(eq(claim.id, newId))
    expect(newRow!.lineageId).toBe(oldLineage)
    // a supersedes relation new→old exists
    const sup = await db
      .select()
      .from(relation)
      .where(
        and(
          eq(relation.fromClaim, newId),
          eq(relation.toClaim, oldId),
          eq(relation.type, 'supersedes'),
        ),
      )
    expect(sup).toHaveLength(1)
    // the OLD claim is superseded, NOT physically deleted (still queryable)
    expect(await statusOf(oldId)).toBe('superseded')
    const [stillThere] = await db.select({ id: claim.id }).from(claim).where(eq(claim.id, oldId))
    expect(stillThere!.id).toBe(oldId)
  })

  it('a transition on a missing claim throws', async () => {
    await expect(transitionClaim(db, randomUUID(), 'active', { by: 'human:j' })).rejects.toThrow(
      /not found/,
    )
  })
})
