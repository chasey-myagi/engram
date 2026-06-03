import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  CALIBRATION_IDENTITY,
  DEFAULT_WEIGHTS,
  type AdditiveFactors,
  type FactorWeights,
} from '../confidence/confidence.js'
import { DEFAULT_STANDARDS, getActiveStandards, setStandards } from '../config/standards.js'
import { createDb, type DB } from '../db/client.js'
import { addSource } from '../spi/append-claim.js'
import { claim, claimProvenance, standards } from '../db/schema.js'
import { recallClaims } from '../spi/recall-claims.js'

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
  await pool.query('TRUNCATE source, claim, claim_provenance, standards CASCADE')
})

const FULL: FactorWeights = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}

/** Seed a recallable active claim whose stored factors are exactly `factors` (recall recomputes from them). */
async function seedClaimWithFactors(factors: AdditiveFactors, text: string): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: text,
    status: 'active',
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: {
      factors: { ...factors, ageDays: 0, activeContradicts: 0, staleDecay: 1, conflictDecay: 1 },
      weights: DEFAULT_WEIGHTS,
      calibrationVersion: CALIBRATION_IDENTITY,
    },
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

const factors = (over: Partial<AdditiveFactors> = {}): AdditiveFactors => ({
  authority: 0,
  humanReview: 0,
  entailment: 0.5,
  indepSupport: 0,
  usageCorrect: 0,
  ...over,
})

describe('S7 config-state Standards (A.2/A.3)', () => {
  it('getActiveStandards returns the kernel default when the table is empty', async () => {
    expect(await getActiveStandards(db)).toEqual(DEFAULT_STANDARDS)
  })

  it('setStandards rejects weight violations: authority=0, Σw>1, and a negative weight (no row written)', async () => {
    await expect(setStandards(db, { factorWeights: { ...FULL, authority: 0 } })).rejects.toThrow(
      /authority|D1/i,
    )
    await expect(
      setStandards(db, { factorWeights: { ...FULL, authority: 0.5 } }), // Σ = 1.2
    ).rejects.toThrow(/Σw|≤ 1/i)
    await expect(
      setStandards(db, { factorWeights: { ...FULL, humanReview: -0.1 } }),
    ).rejects.toThrow(/≥ 0|must be/i)
    expect(await db.select().from(standards)).toHaveLength(0) // nothing written
  })

  it('setStandards rejects threshold violations: consumeFloor below kernel 0.4, and must_verify out of [floor,1]', async () => {
    await expect(setStandards(db, { factorWeights: FULL, consumeFloor: 0.3 })).rejects.toThrow(
      /consumeFloor|0\.4/i,
    )
    await expect(
      setStandards(db, { factorWeights: FULL, consumeFloor: 0.5, mustVerifyThreshold: 0.45 }),
    ).rejects.toThrow(/mustVerify/i)
    await expect(
      setStandards(db, { factorWeights: FULL, mustVerifyThreshold: 1.2 }),
    ).rejects.toThrow(/mustVerify/i)
    expect(await db.select().from(standards)).toHaveLength(0)
  })

  it('is append-only: each setStandards adds a row; getActiveStandards returns the latest', async () => {
    await setStandards(db, { factorWeights: FULL, createdBy: 'editor:a' })
    const second = await setStandards(db, {
      factorWeights: { ...FULL, authority: 0.4, humanReview: 0.2 }, // Σ = 1.0
      consumeFloor: 0.5,
      createdBy: 'editor:b',
    })
    expect(await db.select().from(standards)).toHaveLength(2) // both retained (auditable)
    const active = await getActiveStandards(db)
    expect(active.factorWeights.authority).toBe(0.4)
    expect(active.consumeFloor).toBe(0.5)
    expect(second.createdBy).toBe('editor:b')
  })

  it('a weight change recomputes confidence for NEW recalls while the prior snapshot stays frozen', async () => {
    // factors fixed on the claim; the recalled value depends on the ACTIVE weights
    const id = await seedClaimWithFactors(
      factors({ authority: 1, entailment: 0.5, indepSupport: 1 }),
      'engram weight demo',
    )
    const [r1] = await recallClaims(db, 'engram weight demo')
    // DEFAULT: 0.3·1 + 0.15·0.5 + 0.15·1 = 0.525
    expect(r1!.confidence.value).toBeCloseTo(0.525, 6)
    expect(r1!.confidence.weights).toEqual(DEFAULT_WEIGHTS)

    await setStandards(db, {
      factorWeights: {
        authority: 0.6,
        humanReview: 0.1,
        entailment: 0.1,
        indepSupport: 0.1,
        usageCorrect: 0.1,
      },
      createdBy: 'editor:test',
    })

    const [r2] = await recallClaims(db, 'engram weight demo')
    // heavy-authority: 0.6·1 + 0.1·0.5 + 0.1·1 = 0.75 — recomputed for the new request
    expect(r2!.confidence.value).toBeCloseTo(0.75, 6)
    expect(r2!.claim.id).toBe(id)
    expect(r2!.confidence.weights.authority).toBe(0.6) // active weights ride into the snapshot

    // the earlier snapshot object is a frozen value copy — the standards change did not touch it
    expect(r1!.confidence.value).toBeCloseTo(0.525, 6)
    expect(r1!.confidence.weights).toEqual(DEFAULT_WEIGHTS)
  })

  it('a threshold change takes effect on the next recall: raising consumeFloor drops a now-too-low claim', async () => {
    // recomputes to 0.525 under DEFAULT weights
    await seedClaimWithFactors(
      factors({ authority: 1, entailment: 0.5, indepSupport: 1 }),
      'engram floor demo',
    )
    expect(await recallClaims(db, 'engram floor demo')).toHaveLength(1) // default floor 0.4

    await setStandards(db, { factorWeights: FULL, consumeFloor: 0.6 }) // raise the consume floor above 0.525
    expect(await recallClaims(db, 'engram floor demo')).toHaveLength(0) // now below the active floor
  })

  it('a mustVerifyThreshold change flips mustVerify on the next recall', async () => {
    // DEFAULT: 0.3·1 + 0.3·1 + 0.15·0.5 = 0.675
    await seedClaimWithFactors(
      factors({ authority: 1, humanReview: 1, entailment: 0.5 }),
      'engram verify demo',
    )
    const [before] = await recallClaims(db, 'engram verify demo')
    expect(before!.confidence.value).toBeCloseTo(0.675, 6)
    expect(before!.mustVerify).toBe(false) // 0.675 ≥ default 0.6

    await setStandards(db, { factorWeights: FULL, mustVerifyThreshold: 0.8 }) // raise the trust bar above 0.675
    const [after] = await recallClaims(db, 'engram verify demo')
    expect(after!.mustVerify).toBe(true) // 0.675 < 0.8 now ⇒ must verify
  })
})
