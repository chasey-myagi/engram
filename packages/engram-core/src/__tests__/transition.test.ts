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
import {
  claim,
  claimProvenance,
  claimVerification,
  relation,
  type ClaimStatus,
} from '../db/schema.js'
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
    // human Approve bypasses BOTH halves of the blue gate: sub-0.5 conf AND an explicit entailment fail
    const res = await transitionClaim(db, id, 'active', {
      by: 'human:editor',
      entailmentPass: false,
    })
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

  it('A.4 red line — relaxation (quarantined→active) is human-only; a human amnesty needs NO new evidence (PRD A.4 / FIG 6b)', async () => {
    // agent/blue cannot relax — only humans
    const amnesty = await seedClaim({
      query: 'quarantined claim A',
      status: 'quarantined',
      profile: HIGH,
    })
    await expect(transitionClaim(db, amnesty, 'active', { by: 'agent:rogue' })).rejects.toThrow(
      /requires a human caller/,
    )
    expect(await statusOf(amnesty)).toBe('quarantined')

    // amnesty (赦免): a human relaxes WITHOUT any new evidence — authority alone authorizes; no provenance added
    const provBefore = (
      await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, amnesty))
    ).length
    const res = await transitionClaim(db, amnesty, 'active', { by: 'human:judge' })
    expect(res).toEqual({ from: 'quarantined', to: 'active' })
    expect(await statusOf(amnesty)).toBe('active')
    expect(
      (await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, amnesty))).length,
    ).toBe(provBefore) // pure amnesty records no new provenance

    // the "found new positive exact evidence" path: when a human DOES cite evidence, it is recorded append-only
    const withEv = await seedClaim({
      query: 'quarantined claim B',
      status: 'quarantined',
      profile: HIGH,
    })
    const { sourceId } = await aSource()
    const evBefore = (
      await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, withEv))
    ).length
    await transitionClaim(db, withEv, 'active', {
      by: 'human:judge',
      evidence: { sourceId, locator: 'rehab-doc#1', excerpt: 'p.4: the figure was re-measured' },
    })
    expect(await statusOf(withEv)).toBe('active')
    const provs = await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, withEv))
    expect(provs.length).toBe(evBefore + 1) // the supplied evidence was recorded
    const rec = provs.find((p) => p.locator === 'rehab-doc#1')!
    expect(rec.relevance).toBe('exact')
    expect(rec.excerpt).toBe('p.4: the figure was re-measured') // excerpt round-trips on the relax path
  })

  // EGR-CR-023: red-edge evidence must be drill-back-able. A blank locator makes the "leave a trail" exact
  // evidence a ghost — the whole relaxation is rejected, the claim stays quarantined, no ghost provenance lands.
  it.each([
    ['empty string', ''],
    ['all whitespace', '   '],
  ])(
    'A.4 red line — evidence with a blank locator (%s) is rejected; claim stays quarantined, no ghost provenance (EGR-CR-023)',
    async (_label, locator) => {
      const id = await seedClaim({
        query: 'quarantined claim C',
        status: 'quarantined',
        profile: HIGH,
      })
      const { sourceId } = await aSource()
      const provBefore = (
        await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, id))
      ).length
      await expect(
        transitionClaim(db, id, 'active', { by: 'human:judge', evidence: { sourceId, locator } }),
      ).rejects.toThrow(/locator/i)
      expect(await statusOf(id)).toBe('quarantined') // relaxation rejected as a whole — NOT flipped to active
      expect(
        (await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, id))).length,
      ).toBe(provBefore) // no ghost evidence row landed
    },
  )

  it('A.4 red line — flagged→active (amnesty) and superseded→active (rollback) are human-only and need no new evidence', async () => {
    const flagged = await seedClaim({ query: 'flagged claim', status: 'flagged', profile: HIGH })
    await expect(transitionClaim(db, flagged, 'active', { by: 'agent:x' })).rejects.toThrow(
      /requires a human caller/,
    )
    expect((await transitionClaim(db, flagged, 'active', { by: 'human:j' })).to).toBe('active') // amnesty, no evidence

    const sup = await seedClaim({ query: 'superseded claim', status: 'superseded', profile: HIGH })
    await expect(transitionClaim(db, sup, 'active', { by: 'agent:x' })).rejects.toThrow(
      /requires a human caller/,
    )
    expect((await transitionClaim(db, sup, 'active', { by: 'human:j' })).to).toBe('active') // rollback, no evidence
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

  it('FOR UPDATE serializes concurrent transitions of the same claim: exactly one wins, no double side-effect', async () => {
    // two humans race to amnesty the SAME quarantined claim, both citing evidence
    const id = await seedClaim({
      query: 'contended quarantined claim',
      status: 'quarantined',
      profile: HIGH,
    })
    const s1 = await aSource()
    const s2 = await aSource()
    const results = await Promise.allSettled([
      transitionClaim(db, id, 'active', {
        by: 'human:a',
        evidence: { sourceId: s1.sourceId, locator: 'ev-a' },
      }),
      transitionClaim(db, id, 'active', {
        by: 'human:b',
        evidence: { sourceId: s2.sourceId, locator: 'ev-b' },
      }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1) // exactly one amnesty applied
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1) // the loser observes post-lock 'active' and is rejected as a no-op
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/no-op/)
    expect(await statusOf(id)).toBe('active')
    // exactly ONE evidence row was inserted — the lock prevented a lost-update double-insert
    const evRows = (
      await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, id))
    ).filter((p) => p.locator === 'ev-a' || p.locator === 'ev-b')
    expect(evRows).toHaveLength(1)
  })

  it("FOR UPDATE prevents the docstring's TOCTOU: a tighten racing a concurrent supersede never leaves the claim illegitimately revived", async () => {
    const { sourceId } = await aSource()
    const id = await seedClaim({
      query: 'claim taken over by a supersede',
      status: 'active',
      profile: HIGH,
    })
    // race: an agent tries to flag the claim while it is concurrently superseded by a new version
    await Promise.allSettled([
      supersedeClaim(db, embedder, id, { claimText: 'v2 supersedes it' }, [
        { sourceId, locator: 'v2' },
      ]),
      transitionClaim(db, id, 'flagged', { by: 'agent:patrol' }),
    ])
    // whichever ordering won, the claim ends 'superseded' — never stuck in 'flagged' on a taken-over claim
    // (without the row lock a last-write-wins flag could revive a superseded claim back to 'flagged').
    expect(await statusOf(id)).toBe('superseded')
  })

  it('red-edge evidence insert is atomic with the status flip: a bogus sourceId FK-throws and rolls the whole transition back', async () => {
    const id = await seedClaim({ query: 'atomic relax', status: 'quarantined', profile: HIGH })
    await expect(
      transitionClaim(db, id, 'active', {
        by: 'human:j',
        evidence: { sourceId: randomUUID(), locator: 'ghost' }, // no such source ⇒ FK violation
      }),
    ).rejects.toThrow()
    expect(await statusOf(id)).toBe('quarantined') // status did NOT flip — single-transaction rollback
  })

  it('a bare "human" role may relax, and a human may also tighten (belt-and-suspenders on the authority seam)', async () => {
    const relaxId = await seedClaim({ query: 'bare human relax', status: 'flagged', profile: HIGH })
    expect((await transitionClaim(db, relaxId, 'active', { by: 'human' })).to).toBe('active') // bare 'human' counts

    const tightenId = await seedClaim({ query: 'human tightens', status: 'active', profile: HIGH })
    expect((await transitionClaim(db, tightenId, 'flagged', { by: 'human:editor' })).to).toBe(
      'flagged',
    ) // humans tighten too
  })

  it('a transition on a missing claim throws', async () => {
    await expect(transitionClaim(db, randomUUID(), 'active', { by: 'human:j' })).rejects.toThrow(
      /not found/,
    )
  })

  // EGR-CR-025: draft→active (agent promote) must recompute conf with the LIVE active-conflictDecay (same gauge as
  // recall), not the archival snapshot (new drafts seed conflictDecay=1). A draft whose bare base ≥0.5 but whose
  // live conf drops <0.5 once an active contradicts edge exists must stay draft. Human Approve still bypasses.
  describe('EGR-CR-025 — promote gate honours the live active-conflictDecay (parity with recall)', () => {
    // base under DEFAULT_WEIGHTS with the gate's live overrides (humanReview→0 no review, entailment→1 patrol pass):
    //   0.3·1(auth) + 0.3·0(hr) + 0.15·1(entail) + 0.15·0.75(indep) + 0.1·0(usage) = 0.5625  (≥0.5 with NO conflict)
    // one active contradicts edge ⇒ conflictDecay = 1/(1+0.5·1) = 0.6667 ⇒ conf = 0.5625·0.6667 ≈ 0.375 (<0.5)
    const CONFLICT_BASE = {
      authority: 1,
      humanReview: 0,
      entailment: 1,
      indepSupport: 0.75,
      usageCorrect: 0,
    }

    // The gate reads f2 from the latest patrol verdict (no patrol row ⇒ neutral 0.5 would overwrite seed entailment).
    // Seed a {entailment:'pass'} patrol row so live-f2=1, matching the production path (Verifier writes patrol then promotes).
    async function seedPatrolPass(claimId: string) {
      await db.insert(claimVerification).values({
        id: randomUUID(),
        claimId,
        kind: 'patrol',
        verdict: { entailment: 'pass' },
        byRole: 'agent:verifier',
      })
    }

    it('agent promote of a draft with an ACTIVE contradicts edge is blocked (live conf<0.5) — stays draft', async () => {
      const peer = await seedClaim({ query: 'active peer', status: 'active', profile: HIGH })
      const draft = await seedClaim({
        query: 'contradicting draft',
        status: 'draft',
        profile: CONFLICT_BASE,
      })
      await seedPatrolPass(draft)
      // a live contradicts edge to an ACTIVE peer ⇒ activeContradicts=1 ⇒ conflictDecay pulls conf below the floor
      await db
        .insert(relation)
        .values({ id: randomUUID(), fromClaim: draft, toClaim: peer, type: 'contradicts' })

      // red (pre-fix): gate used archival conflictDecay=1 ⇒ conf 0.5625≥0.5 ⇒ promoted (assertion fails)
      // green (post-fix): live conflictDecay 0.6667 ⇒ conf ≈0.375 <0.5 ⇒ thrown, stays draft
      await expect(
        transitionClaim(db, draft, 'active', { by: 'agent:verifier', entailmentPass: true }),
      ).rejects.toThrow(/conf .* < 0\.5/)
      expect(await statusOf(draft)).toBe('draft')
    })

    it('control — same factor profile WITHOUT a contradicts edge still promotes (fix does not break clean promotion)', async () => {
      const draft = await seedClaim({
        query: 'clean draft',
        status: 'draft',
        profile: CONFLICT_BASE,
      })
      await seedPatrolPass(draft)
      // no contradicts edge ⇒ live conflictDecay=1 ⇒ conf 0.5625 ≥ 0.5 ⇒ promotes
      const res = await transitionClaim(db, draft, 'active', {
        by: 'agent:verifier',
        entailmentPass: true,
      })
      expect(res).toEqual({ from: 'draft', to: 'active' })
      expect(await statusOf(draft)).toBe('active')
    })

    it('human Approve still bypasses the gate for a sub-0.5 (live) contradicting draft (red line #2 intact)', async () => {
      const peer = await seedClaim({ query: 'active peer 2', status: 'active', profile: HIGH })
      const draft = await seedClaim({
        query: 'human-approved contradicting draft',
        status: 'draft',
        profile: CONFLICT_BASE,
      })
      await seedPatrolPass(draft)
      await db
        .insert(relation)
        .values({ id: randomUUID(), fromClaim: draft, toClaim: peer, type: 'contradicts' })

      // human relaxation does not run the conf/conflictDecay gate — Approve promotes regardless
      const res = await transitionClaim(db, draft, 'active', {
        by: 'human:editor',
        entailmentPass: false,
      })
      expect(res.to).toBe('active')
      expect(await statusOf(draft)).toBe('active')
    })
  })
})
