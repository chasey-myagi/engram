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
import { addSource } from '../spi/append-claim.js'
import { claim, claimProvenance, claimVerification } from '../db/schema.js'
import { recallClaims } from '../spi/recall-claims.js'
import {
  FAILURE_OUTCOMES,
  USAGE_OUTCOMES,
  getFailurePool,
  getUsageEvents,
  reportUsage,
} from '../spi/report-usage.js'

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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, page_claims CASCADE',
  )
})

function factorsBlob(): StoredConfidence {
  return {
    factors: {
      authority: 0.5,
      humanReview: 0,
      entailment: 0.5,
      indepSupport: 0,
      usageCorrect: 0, // f4 neutral — Harvester (S19) is the only producer
      ageDays: 0,
      activeContradicts: 0,
      staleDecay: 1,
      conflictDecay: 1,
    },
    weights: DEFAULT_WEIGHTS,
    calibrationVersion: CALIBRATION_IDENTITY,
  }
}

/** Seed a recallable (active, grounded) claim at a known confidence; returns its id. */
async function seedActiveClaim(text: string, raw = 0.8): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: text,
    status: 'active',
    confidence: raw,
    confidenceRaw: raw,
    confidenceFactors: factorsBlob(),
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
  })
  const { sourceId } = await addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

async function countVerifications(): Promise<number> {
  const rows = await db.select({ id: claimVerification.id }).from(claimVerification)
  return rows.length
}

describe('S4 report_usage — append-only usage_truth events (A.2)', () => {
  it('appends exactly one usage_truth row with outcome / by_role / taskId / note; all four outcomes round-trip', async () => {
    for (const outcome of USAGE_OUTCOMES) {
      const id = await seedActiveClaim(`claim ${outcome}`)
      const { verificationId } = await reportUsage(db, id, outcome, {
        byRole: 'agent:bidder-7',
        taskId: 'task-42',
        note: `used as ${outcome}`,
      })
      const events = await getUsageEvents(db, id)
      expect(events).toHaveLength(1)
      const e = events[0]!
      expect(e.id).toBe(verificationId)
      expect(e.outcome).toBe(outcome) // round-trips through verdict JSONB
      expect(e.byRole).toBe('agent:bidder-7')
      expect(e.taskId).toBe('task-42')
      expect(e.note).toBe(`used as ${outcome}`)
    }
  })

  it('persists kind=usage_truth and a verdict carrying the outcome', async () => {
    const id = await seedActiveClaim('verdict shape')
    const { verificationId } = await reportUsage(db, id, 'corrected', { byRole: 'agent:x' })
    const [row] = await db
      .select()
      .from(claimVerification)
      .where(eq(claimVerification.id, verificationId))
    expect(row!.kind).toBe('usage_truth')
    expect(row!.verdict).toMatchObject({ outcome: 'corrected', taskId: null, note: null })
  })

  it('rejects a nonexistent claimId with no partial write', async () => {
    await expect(reportUsage(db, randomUUID(), 'adopted')).rejects.toThrow(/not found/i)
    expect(await countVerifications()).toBe(0)
  })

  it('rejects an invalid outcome with no write', async () => {
    const id = await seedActiveClaim('bad outcome')
    // @ts-expect-error — exercising the runtime guard against an off-contract outcome
    await expect(reportUsage(db, id, 'bogus')).rejects.toThrow(/invalid outcome/i)
    expect(await countVerifications()).toBe(0)
  })

  it('records by_role per report and is append-only — repeated reports never overwrite prior rows', async () => {
    const id = await seedActiveClaim('append only')
    await reportUsage(db, id, 'adopted', { byRole: 'agent:athlete' })
    await reportUsage(db, id, 'refuted', { byRole: 'human:judge' }) // judge ≠ athlete attribution preserved

    const events = await getUsageEvents(db, id)
    expect(events).toHaveLength(2) // both retained, nothing updated/deleted
    expect(events.map((e) => e.byRole).sort()).toEqual(['agent:athlete', 'human:judge'])
    expect(events.map((e) => e.outcome).sort()).toEqual(['adopted', 'refuted'])
  })

  it('does not mutate claim.confidence (升降信 decoupled from reporting)', async () => {
    const id = await seedActiveClaim('immutable confidence')
    const before = (await db.select().from(claim).where(eq(claim.id, id)))[0]!

    await reportUsage(db, id, 'corrected', { byRole: 'agent:x', note: 'wrong value' })

    const after = (await db.select().from(claim).where(eq(claim.id, id)))[0]!
    expect(after.confidence).toBe(before.confidence)
    expect(after.confidenceRaw).toBe(before.confidenceRaw)
    expect(after.confidenceFactors).toEqual(before.confidenceFactors)
  })

  it('failure pool enumerates only corrected/refuted across claims (adopted/partial excluded)', async () => {
    const a = await seedActiveClaim('pool corrected')
    const b = await seedActiveClaim('pool refuted')
    const c = await seedActiveClaim('pool adopted')
    const d = await seedActiveClaim('pool partial')
    await reportUsage(db, a, 'corrected', { byRole: 'r' })
    await reportUsage(db, b, 'refuted', { byRole: 'r' })
    await reportUsage(db, c, 'adopted', { byRole: 'r' })
    await reportUsage(db, d, 'partial', { byRole: 'r' })

    const pool = await getFailurePool(db)
    expect(pool.map((e) => e.outcome).sort()).toEqual(['corrected', 'refuted'])
    expect(new Set(pool.map((e) => e.claimId))).toEqual(new Set([a, b]))
    for (const e of pool) expect(FAILURE_OUTCOMES).toContain(e.outcome)
  })

  it('a claim with no usage history enumerates empty and recalls with f4 at its neutral value (no crash)', async () => {
    const id = await seedActiveClaim('no usage yet')
    expect(await getUsageEvents(db, id)).toEqual([])

    const [r] = await recallClaims(db, 'no usage yet')
    expect(r!.confidence.factors.usageCorrect).toBe(0) // f4 neutral; Harvester (S19) is the only feeder
  })

  it('end-to-end: recall → report corrected → event is queryable (failure pool) and confidence is unchanged', async () => {
    const id = await seedActiveClaim('engram usage seam')
    const [recalled] = await recallClaims(db, 'engram usage seam')
    expect(recalled!.claim.id).toBe(id)
    const confBefore = recalled!.confidence.value

    await reportUsage(db, id, 'corrected', { byRole: 'agent:consumer-1', taskId: 'bid-99' })

    const events = await getUsageEvents(db, id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ outcome: 'corrected', taskId: 'bid-99' })
    expect((await getFailurePool(db)).map((e) => e.claimId)).toContain(id)

    const [recalledAfter] = await recallClaims(db, 'engram usage seam')
    expect(recalledAfter!.confidence.value).toBe(confBefore) // report_usage left confidence untouched
    expect(recalledAfter!.confidence.factors.usageCorrect).toBe(0) // f4 still neutral (not fed until S19)
  })
})
