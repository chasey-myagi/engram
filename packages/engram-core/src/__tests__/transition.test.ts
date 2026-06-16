import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { trustedHumanActor, agentActor } from '../spi/actor.js'
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
      actor: agentActor('agent:verifier'),
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
      transitionClaim(db, id, 'active', { actor: agentActor('agent:verifier') }), // entailmentPass omitted
    ).rejects.toThrow(/entailment did not pass/)
    await expect(
      transitionClaim(db, id, 'active', {
        actor: agentActor('agent:verifier'),
        entailmentPass: false,
      }),
    ).rejects.toThrow(/entailment did not pass/)
    expect(await statusOf(id)).toBe('draft')
    expect(await recallClaims(db, embedder, q)).toHaveLength(0)
  })

  it('draft→active (blue) is blocked below the conf floor even with entailment pass — stays draft', async () => {
    const q = 'low-confidence draft'
    const id = await seedClaim({ query: q, status: 'draft', profile: MID }) // conf 0.435 < 0.5
    await expect(
      transitionClaim(db, id, 'active', {
        actor: agentActor('agent:verifier'),
        entailmentPass: true,
      }),
    ).rejects.toThrow(/conf .* < 0\.5/)
    expect(await statusOf(id)).toBe('draft')
  })

  it('human Approve promotes a sub-0.5 draft regardless of the conf/entailment gate (event-driven, not conf-alone)', async () => {
    const q = 'human-approved low-conf draft'
    const id = await seedClaim({ query: q, status: 'draft', profile: MID }) // conf 0.435: blue would be blocked
    // human Approve bypasses BOTH halves of the blue gate: sub-0.5 conf AND an explicit entailment fail
    const res = await transitionClaim(db, id, 'active', {
      actor: trustedHumanActor('human:editor'),
      entailmentPass: false,
    })
    expect(res.to).toBe('active')
    expect(await statusOf(id)).toBe('active')
    // conf 0.435 ≥ kernel floor 0.4 ⇒ recallable once promoted
    expect((await recallClaims(db, embedder, q)).map((r) => r.claim.id)).toContain(id)
  })

  it('blue tightening is free for agents: active→flagged→quarantined', async () => {
    const id = await seedClaim({ query: 'tighten me', status: 'active', profile: HIGH })
    expect(
      (await transitionClaim(db, id, 'flagged', { actor: agentActor('agent:patrol') })).to,
    ).toBe('flagged')
    expect(await statusOf(id)).toBe('flagged')
    expect(
      (await transitionClaim(db, id, 'quarantined', { actor: agentActor('agent:patrol') })).to,
    ).toBe('quarantined')
    expect(await statusOf(id)).toBe('quarantined')
  })

  it('A.4 red line — relaxation (quarantined→active) is human-only; a human amnesty needs NO new evidence (PRD A.4 / FIG 6b)', async () => {
    // agent/blue cannot relax — only humans
    const amnesty = await seedClaim({
      query: 'quarantined claim A',
      status: 'quarantined',
      profile: HIGH,
    })
    await expect(
      transitionClaim(db, amnesty, 'active', { actor: agentActor('agent:rogue') }),
    ).rejects.toThrow(/requires a human caller/)
    expect(await statusOf(amnesty)).toBe('quarantined')

    // amnesty (赦免): a human relaxes WITHOUT any new evidence — authority alone authorizes; no provenance added
    const provBefore = (
      await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, amnesty))
    ).length
    const res = await transitionClaim(db, amnesty, 'active', {
      actor: trustedHumanActor('human:judge'),
    })
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
      actor: trustedHumanActor('human:judge'),
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
        transitionClaim(db, id, 'active', {
          actor: trustedHumanActor('human:judge'),
          evidence: { sourceId, locator },
        }),
      ).rejects.toThrow(/locator/i)
      expect(await statusOf(id)).toBe('quarantined') // relaxation rejected as a whole — NOT flipped to active
      expect(
        (await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, id))).length,
      ).toBe(provBefore) // no ghost evidence row landed
    },
  )

  it('A.4 red line — flagged→active (amnesty) and superseded→active (rollback) are human-only and need no new evidence', async () => {
    const flagged = await seedClaim({ query: 'flagged claim', status: 'flagged', profile: HIGH })
    await expect(
      transitionClaim(db, flagged, 'active', { actor: agentActor('agent:x') }),
    ).rejects.toThrow(/requires a human caller/)
    expect(
      (await transitionClaim(db, flagged, 'active', { actor: trustedHumanActor('human:j') })).to,
    ).toBe('active') // amnesty, no evidence

    const sup = await seedClaim({ query: 'superseded claim', status: 'superseded', profile: HIGH })
    await expect(
      transitionClaim(db, sup, 'active', { actor: agentActor('agent:x') }),
    ).rejects.toThrow(/requires a human caller/)
    expect(
      (await transitionClaim(db, sup, 'active', { actor: trustedHumanActor('human:j') })).to,
    ).toBe('active') // rollback, no evidence
  })

  it('illegal transitions are rejected (draft→quarantined, superseded→flagged, active→quarantined skip); →superseded routes to supersedeClaim', async () => {
    const draft = await seedClaim({ query: 'd', status: 'draft', profile: HIGH })
    await expect(
      transitionClaim(db, draft, 'quarantined', { actor: trustedHumanActor('human:j') }),
    ).rejects.toThrow(/illegal transition draft → quarantined/)

    const sup = await seedClaim({ query: 's', status: 'superseded', profile: HIGH })
    await expect(
      transitionClaim(db, sup, 'flagged', { actor: trustedHumanActor('human:j') }),
    ).rejects.toThrow(/illegal transition superseded → flagged/)

    const active = await seedClaim({ query: 'a', status: 'active', profile: HIGH })
    await expect(
      transitionClaim(db, active, 'quarantined', { actor: agentActor('agent:x') }),
    ).rejects.toThrow(/illegal transition active → quarantined/)
    await expect(
      transitionClaim(db, active, 'active', { actor: agentActor('agent:x') }),
    ).rejects.toThrow(/no-op/)
    await expect(
      transitionClaim(db, active, 'superseded', { actor: agentActor('agent:x') }),
    ).rejects.toThrow(/supersedeClaim/)
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
        actor: trustedHumanActor('human:a'),
        evidence: { sourceId: s1.sourceId, locator: 'ev-a' },
      }),
      transitionClaim(db, id, 'active', {
        actor: trustedHumanActor('human:b'),
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
      transitionClaim(db, id, 'flagged', { actor: agentActor('agent:patrol') }),
    ])
    // whichever ordering won, the claim ends 'superseded' — never stuck in 'flagged' on a taken-over claim
    // (without the row lock a last-write-wins flag could revive a superseded claim back to 'flagged').
    expect(await statusOf(id)).toBe('superseded')
  })

  it('red-edge evidence insert is atomic with the status flip: a bogus sourceId FK-throws and rolls the whole transition back', async () => {
    const id = await seedClaim({ query: 'atomic relax', status: 'quarantined', profile: HIGH })
    await expect(
      transitionClaim(db, id, 'active', {
        actor: trustedHumanActor('human:j'),
        evidence: { sourceId: randomUUID(), locator: 'ghost' }, // no such source ⇒ FK violation
      }),
    ).rejects.toThrow()
    expect(await statusOf(id)).toBe('quarantined') // status did NOT flip — single-transaction rollback
  })

  it('a bare "human" role may relax, and a human may also tighten (belt-and-suspenders on the authority seam)', async () => {
    const relaxId = await seedClaim({ query: 'bare human relax', status: 'flagged', profile: HIGH })
    expect(
      (await transitionClaim(db, relaxId, 'active', { actor: trustedHumanActor('human') })).to,
    ).toBe('active') // bare 'human' counts

    const tightenId = await seedClaim({ query: 'human tightens', status: 'active', profile: HIGH })
    expect(
      (
        await transitionClaim(db, tightenId, 'flagged', {
          actor: trustedHumanActor('human:editor'),
        })
      ).to,
    ).toBe('flagged') // humans tighten too
  })

  it('a transition on a missing claim throws', async () => {
    await expect(
      transitionClaim(db, randomUUID(), 'active', { actor: trustedHumanActor('human:j') }),
    ).rejects.toThrow(/not found/)
  })
})

// EGR-CR-002 · 红线#2 的承重授权边界：人身份的「真实性」由受信 ActorContext 建立，**不再**是可被任意调用方
// 伪造的裸字符串前缀。现有测试只断言 by:'agent:x' 被拒（字符串区分本身生效），刻意回避了「伪造 human:* 身份」
// 这一真正攻击面——这里补上：一个 agentActor 即使把 role 字面量伪造成 'human:fake' 也抬不了权。
describe('EGR-CR-002 authz/actor: a forged human:* role cannot trigger any human-only side effect', () => {
  // T1 — red-edge 放松：伪造 human role 不能放松（quarantined → active）。
  it('T1: a non-human actor with a forged human:* role CANNOT relax a quarantined claim; a trusted human can', async () => {
    const id = await seedClaim({ query: 'forged-relax', status: 'quarantined', profile: HIGH })
    const provBefore = (
      await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, id))
    ).length

    // forged: an AGENT actor whose display role literally says 'human:fake' — must still be rejected.
    await expect(
      transitionClaim(db, id, 'active', { actor: agentActor('human:fake') }),
    ).rejects.toThrow(/requires a human caller/)
    expect(await statusOf(id)).toBe('quarantined') // not relaxed
    expect(
      (await db.select().from(claimProvenance).where(eq(claimProvenance.claimId, id))).length,
    ).toBe(provBefore) // no side effect

    // a genuinely trusted human actor relaxes it (existing behavior preserved)
    expect(
      (await transitionClaim(db, id, 'active', { actor: trustedHumanActor('human:judge') })).to,
    ).toBe('active')
    expect(await statusOf(id)).toBe('active')
  })

  // T2 — draft→active 旁路：伪造 human role 不能旁路晋升门（conf<0.5 仍被拦）。
  it('T2: a forged human:* role CANNOT bypass the draft→active promote gate (conf<0.5 still blocks); a trusted human bypasses it', async () => {
    const id = await seedClaim({ query: 'forged-bypass', status: 'draft', profile: MID }) // conf 0.435 < 0.5
    // forged human actor is treated as blue/agent → hits the conf gate (NOT the human bypass), entailment omitted too.
    await expect(
      transitionClaim(db, id, 'active', { actor: agentActor('human:fake') }),
    ).rejects.toThrow(/conf .* < 0\.5|entailment did not pass/)
    expect(await statusOf(id)).toBe('draft') // did NOT bypass to active

    // a trusted human bypasses both halves of the gate (existing behavior preserved)
    expect(
      (await transitionClaim(db, id, 'active', { actor: trustedHumanActor('human:judge') })).to,
    ).toBe('active')
    expect(await statusOf(id)).toBe('active')
  })
})
