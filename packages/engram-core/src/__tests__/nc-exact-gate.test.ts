import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  assertNcExactEvidence,
  countExactProvenances,
  createDb,
  getRefusedRulings,
  schema,
  type DB,
} from '../index.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string

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
  await pool.query('TRUNCATE source, claim, claim_provenance, relation, metrics_events CASCADE')
})

/** Seed a claim with exactly one provenance at the given relevance tier (real claim_provenance rows). */
async function mkClaim(relevance: schema.ProvRelevance): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: `src ${randomUUID()}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
  const claimId = randomUUID()
  await db.insert(schema.claim).values({
    id: claimId,
    claimText: `claim ${claimId}`,
    status: 'active',
    confidence: 0.5,
    confidenceRaw: 0.5,
    confidenceFactors: {},
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'agent:distiller',
  })
  await db
    .insert(schema.claimProvenance)
    .values({ id: randomUUID(), claimId, sourceId, locator: 'L1', relevance })
  return claimId
}

/** Add another provenance row at a chosen tier to an existing claim (to mix tiers on one claim). */
async function addProv(claimId: string, relevance: schema.ProvRelevance): Promise<void> {
  const { sourceId } = await addSource(db, {
    content: `src ${randomUUID()}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
  await db
    .insert(schema.claimProvenance)
    .values({ id: randomUUID(), claimId, sourceId, locator: 'Lx', relevance })
}

describe('S21 NC-exact unified gate — RED LINE #3 / A.6', () => {
  it('distinguishes the four prov_relevance tiers: only exact counts as reverse evidence', async () => {
    const exact = await mkClaim('exact')
    const supporting = await mkClaim('supporting')
    const tangential = await mkClaim('tangential')
    const irrelevant = await mkClaim('irrelevant')

    expect(await countExactProvenances(db, exact)).toBe(1)
    expect(await countExactProvenances(db, supporting)).toBe(0)
    expect(await countExactProvenances(db, tangential)).toBe(0)
    expect(await countExactProvenances(db, irrelevant)).toBe(0)
  })

  it('a DISTINCT peer carrying an exact reverse proposition → ruling PROCEEDS (ok=true), no escalation', async () => {
    const ruledAgainst = await mkClaim('supporting') // the claim being negated — its OWN tier is irrelevant
    const peer = await mkClaim('exact') // a distinct contradicting peer carries the exact reverse proposition
    const res = await assertNcExactEvidence(db, {
      ruledAgainstClaimId: ruledAgainst,
      reverseEvidenceClaimId: peer,
      rulingKind: 'refuted',
      path: 'arbiter',
      byRole: 'agent:arbiter',
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.exactCount).toBe(1)
    expect(await getRefusedRulings(db)).toHaveLength(0) // nothing escalated when the peer is exact
  })

  it.each(['supporting', 'tangential', 'irrelevant'] as const)(
    'a peer carrying only %s (no exact) reverse evidence → ruling REFUSED (ok=false) + a ruling_refused escalation',
    async (tier) => {
      // Even though the ruled-against claim has its OWN exact support, the PEER (the reverse proposition) is weak.
      const ruledAgainst = await mkClaim('exact')
      const peer = await mkClaim(tier)
      const res = await assertNcExactEvidence(db, {
        ruledAgainstClaimId: ruledAgainst,
        reverseEvidenceClaimId: peer,
        rulingKind: 'refuted',
        path: 'arbiter',
        byRole: 'agent:arbiter',
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.exactCount).toBe(0)
        expect(res.eventId).toBeTruthy()
      }
      // escalation event recorded to the editor-in-chief queue with a faithful payload
      const refused = await getRefusedRulings(db)
      expect(refused).toHaveLength(1)
      expect(refused[0]!.payload.ruledAgainstClaimId).toBe(ruledAgainst)
      expect(refused[0]!.payload.reverseEvidenceClaimId).toBe(peer) // the PEER was checked, NEVER self
      expect(refused[0]!.payload.rulingKind).toBe('refuted')
      expect(refused[0]!.payload.path).toBe('arbiter')
      expect(refused[0]!.payload.exactCount).toBe(0)
    },
  )

  it("a claim's OWN exact support is NEVER its own reverse evidence: a well-supported claim is not easier to negate", async () => {
    // The core anti-inversion guarantee. A strongly self-supported claim must NOT become easier to rule negative.
    const wellSupported = await mkClaim('exact')
    await addProv(wellSupported, 'exact') // two exact SUPPORTING provenances on itself
    expect(await countExactProvenances(db, wellSupported)).toBe(2)
    const peer = await mkClaim('supporting') // the reverse proposition (a distinct peer) is only weak
    const res = await assertNcExactEvidence(db, {
      ruledAgainstClaimId: wellSupported,
      reverseEvidenceClaimId: peer,
      rulingKind: 'non_compliant',
      path: 'verifier',
      byRole: 'agent:verifier',
    })
    expect(res.ok).toBe(false) // its own (even doubled) exact support does NOT let it be negated
    expect(await getRefusedRulings(db)).toHaveLength(1)
  })

  it('no contradicting peer (reverseEvidenceClaimId=null) → REFUSED: nothing carries a reverse proposition', async () => {
    const ruledAgainst = await mkClaim('exact') // own exact is support, not reverse evidence
    const res = await assertNcExactEvidence(db, {
      ruledAgainstClaimId: ruledAgainst,
      reverseEvidenceClaimId: null,
      rulingKind: 'refuted',
      path: 'verifier',
      byRole: 'agent:verifier',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.exactCount).toBe(0)
    const refused = await getRefusedRulings(db)
    expect(refused).toHaveLength(1)
    expect(refused[0]!.payload.reverseEvidenceClaimId).toBeNull()
    expect(refused[0]!.payload.exactCount).toBe(0)
  })

  it('passing reverseEvidenceClaimId === ruledAgainstClaimId THROWS (contract misuse: a claim cannot be its own reverse evidence)', async () => {
    const claimId = await mkClaim('exact')
    await expect(
      assertNcExactEvidence(db, {
        ruledAgainstClaimId: claimId,
        reverseEvidenceClaimId: claimId, // the inversion — structurally rejected before any DB write
        rulingKind: 'refuted',
        path: 'verifier',
        byRole: 'agent:verifier',
      }),
    ).rejects.toThrow(/DISTINCT contradicting peer/)
    expect(await getRefusedRulings(db)).toHaveLength(0) // threw before writing any escalation event
  })

  it('a peer with supporting+tangential but NO exact is still refused (mere semantic support ≠ exact reverse)', async () => {
    const ruledAgainst = await mkClaim('exact')
    const peer = await mkClaim('supporting')
    await addProv(peer, 'tangential')
    await addProv(peer, 'irrelevant')
    expect(await countExactProvenances(db, peer)).toBe(0)
    const res = await assertNcExactEvidence(db, {
      ruledAgainstClaimId: ruledAgainst,
      reverseEvidenceClaimId: peer,
      rulingKind: 'non_compliant',
      path: 'arbiter',
      byRole: 'agent:arbiter',
    })
    expect(res.ok).toBe(false)
    expect(await getRefusedRulings(db)).toHaveLength(1)
  })

  it('reverseEvidenceClaimId differs from ruledAgainstClaimId (Arbiter path: exact lives on the WINNER)', async () => {
    const loser = await mkClaim('supporting') // loser itself has no exact
    const winner = await mkClaim('exact') // the reverse proposition lives on the winner
    const res = await assertNcExactEvidence(db, {
      ruledAgainstClaimId: loser,
      reverseEvidenceClaimId: winner,
      rulingKind: 'refuted',
      path: 'arbiter',
      byRole: 'agent:arbiter',
    })
    expect(res.ok).toBe(true) // winner carries the exact reverse proposition → proceeds
    expect(await getRefusedRulings(db)).toHaveLength(0)
  })

  it('gate NEVER mutates claim.status (red line #2: only humans relax; refuse only escalates)', async () => {
    const ruledAgainst = await mkClaim('supporting')
    const before = (
      await db
        .select({ s: schema.claim.status })
        .from(schema.claim)
        .where(eq(schema.claim.id, ruledAgainst))
    )[0]!.s
    await assertNcExactEvidence(db, {
      ruledAgainstClaimId: ruledAgainst,
      reverseEvidenceClaimId: null, // refused for lack of any reverse proposition
      rulingKind: 'refuted',
      path: 'verifier',
      byRole: 'agent:verifier',
    })
    const after = (
      await db
        .select({ s: schema.claim.status })
        .from(schema.claim)
        .where(eq(schema.claim.id, ruledAgainst))
    )[0]!.s
    expect(after).toBe(before) // untouched — gate only writes a metrics event, never a status edge
  })
})
