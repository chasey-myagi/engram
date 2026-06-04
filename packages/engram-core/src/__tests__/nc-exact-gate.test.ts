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

  it('exact reverse proposition present → ruling PROCEEDS (ok=true), no escalation written', async () => {
    const claimId = await mkClaim('exact')
    const res = await assertNcExactEvidence(db, {
      ruledAgainstClaimId: claimId,
      rulingKind: 'non_compliant',
      path: 'verifier',
      byRole: 'agent:verifier',
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.exactCount).toBe(1)
    expect(await getRefusedRulings(db)).toHaveLength(0) // nothing escalated when evidence is exact
  })

  it.each(['supporting', 'tangential', 'irrelevant'] as const)(
    'only %s (no exact) reverse evidence → ruling REFUSED (ok=false) + a ruling_refused escalation generated',
    async (tier) => {
      const claimId = await mkClaim(tier)
      const res = await assertNcExactEvidence(db, {
        ruledAgainstClaimId: claimId,
        rulingKind: 'refuted',
        path: 'verifier',
        byRole: 'agent:verifier',
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.exactCount).toBe(0)
        expect(res.eventId).toBeTruthy()
      }
      // escalation event recorded to the editor-in-chief queue with a faithful payload
      const refused = await getRefusedRulings(db)
      expect(refused).toHaveLength(1)
      expect(refused[0]!.payload.ruledAgainstClaimId).toBe(claimId)
      expect(refused[0]!.payload.reverseEvidenceClaimId).toBe(claimId)
      expect(refused[0]!.payload.rulingKind).toBe('refuted')
      expect(refused[0]!.payload.path).toBe('verifier')
      expect(refused[0]!.payload.exactCount).toBe(0)
    },
  )

  it('a claim with supporting+tangential but NO exact is still refused (mere semantic support ≠ exact reverse)', async () => {
    const claimId = await mkClaim('supporting')
    await addProv(claimId, 'tangential')
    await addProv(claimId, 'irrelevant')
    expect(await countExactProvenances(db, claimId)).toBe(0)
    const res = await assertNcExactEvidence(db, {
      ruledAgainstClaimId: claimId,
      rulingKind: 'non_compliant',
      path: 'arbiter',
      byRole: 'agent:arbiter',
    })
    expect(res.ok).toBe(false)
    expect(await getRefusedRulings(db)).toHaveLength(1)
  })

  it('reverseEvidenceClaimId can differ from ruledAgainstClaimId (Arbiter path: exact lives on the WINNER)', async () => {
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
    const claimId = await mkClaim('supporting')
    const before = (
      await db
        .select({ s: schema.claim.status })
        .from(schema.claim)
        .where(eq(schema.claim.id, claimId))
    )[0]!.s
    await assertNcExactEvidence(db, {
      ruledAgainstClaimId: claimId,
      rulingKind: 'refuted',
      path: 'verifier',
      byRole: 'agent:verifier',
    })
    const after = (
      await db
        .select({ s: schema.claim.status })
        .from(schema.claim)
        .where(eq(schema.claim.id, claimId))
    )[0]!.s
    expect(after).toBe(before) // untouched — gate only writes a metrics event, never a status edge
  })
})
