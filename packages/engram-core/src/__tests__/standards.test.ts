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
import { applyAdapter } from '../spi/adapter.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { createDb, type DB } from '../db/client.js'
import { addSource } from '../spi/append-claim.js'
import { claim, claimProvenance, standards } from '../db/schema.js'
import { recallClaims } from '../spi/recall-claims.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const embedder = makeFakeEmbedder()

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string

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
    embedding: await embedder.embed(text),
    embeddingVersion: embedder.version,
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
  })
  const { sourceId } = await addSource(db, {
    content: 'body',
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

  it('setStandards rejects threshold violations: consumeFloor < 0.4, must_verify < kernel 0.6 (relaxation!), must_verify < floor, must_verify > 1', async () => {
    await expect(setStandards(db, { factorWeights: FULL, consumeFloor: 0.3 })).rejects.toThrow(
      /consumeFloor|0\.4/i,
    )
    // the dangerous direction: lowering the trust bar below kernel 0.6 would flatten the must-verify band
    await expect(
      setStandards(db, { factorWeights: FULL, consumeFloor: 0.4, mustVerifyThreshold: 0.5 }),
    ).rejects.toThrow(/trust bar|mustVerify|0\.6/i)
    await expect(
      setStandards(db, { factorWeights: FULL, consumeFloor: 0.7, mustVerifyThreshold: 0.65 }), // < floor
    ).rejects.toThrow(/mustVerify/i)
    await expect(
      setStandards(db, { factorWeights: FULL, mustVerifyThreshold: 1.2 }),
    ).rejects.toThrow(/mustVerify/i)
    expect(await db.select().from(standards)).toHaveLength(0)
  })

  it('accepts and persists the inclusive threshold boundaries exactly (0.4 floor, 0.6 / 1.0 / =floor verify)', async () => {
    const a = await setStandards(db, {
      factorWeights: FULL,
      consumeFloor: 0.4,
      mustVerifyThreshold: 0.6,
    })
    expect(a.consumeFloor).toBe(0.4) // kernel floor edge accepted
    expect(a.mustVerifyThreshold).toBe(0.6) // kernel trust-bar edge accepted
    const b = await setStandards(db, { factorWeights: FULL, mustVerifyThreshold: 1 })
    expect(b.mustVerifyThreshold).toBe(1) // upper edge accepted
    const c = await setStandards(db, {
      factorWeights: FULL,
      consumeFloor: 0.6,
      mustVerifyThreshold: 0.6,
    })
    expect(c.consumeFloor).toBe(0.6) // mustVerify === consumeFloor (lower ≤ edge) accepted
  })

  it('defaults consumeFloor=0.4 / mustVerify=0.6 / createdBy=editor:unknown and returns a populated row', async () => {
    const row = await setStandards(db, { factorWeights: FULL })
    expect(row.consumeFloor).toBe(0.4)
    expect(row.mustVerifyThreshold).toBe(0.6)
    expect(row.createdBy).toBe('editor:unknown')
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  it('effective consume floor = max(config consumeFloor, request ctx.confidenceFloor) — the stricter wins', async () => {
    await seedClaimWithFactors(
      factors({ authority: 0.5, humanReview: 0.5, indepSupport: 0.5, usageCorrect: 0.5 }), // recomputes to 0.5
      'engram floor combo',
    )
    // baseline: default config floor 0.4, ctx floor 0.4 → 0.5 surfaces
    expect(
      await recallClaims(db, embedder, 'engram floor combo', { confidenceFloor: 0.4 }),
    ).toHaveLength(1)
    // request wins: config 0.4 (default), ctx 0.7 → effective 0.7 → 0.5 dropped
    expect(
      await recallClaims(db, embedder, 'engram floor combo', { confidenceFloor: 0.7 }),
    ).toHaveLength(0)
    // config wins: config 0.6, ctx 0.4 → effective 0.6 → 0.5 dropped
    await setStandards(db, { factorWeights: FULL, consumeFloor: 0.6 })
    expect(
      await recallClaims(db, embedder, 'engram floor combo', { confidenceFloor: 0.4 }),
    ).toHaveLength(0)
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
    const [r1] = await recallClaims(db, embedder, 'engram weight demo')
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

    const [r2] = await recallClaims(db, embedder, 'engram weight demo')
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
    expect(await recallClaims(db, embedder, 'engram floor demo')).toHaveLength(1) // default floor 0.4

    await setStandards(db, { factorWeights: FULL, consumeFloor: 0.6 }) // raise the consume floor above 0.525
    expect(await recallClaims(db, embedder, 'engram floor demo')).toHaveLength(0) // now below the active floor
  })

  it('a mustVerifyThreshold change flips mustVerify on the next recall', async () => {
    // DEFAULT: 0.3·1 + 0.3·1 + 0.15·0.5 = 0.675
    await seedClaimWithFactors(
      factors({ authority: 1, humanReview: 1, entailment: 0.5 }),
      'engram verify demo',
    )
    const [before] = await recallClaims(db, embedder, 'engram verify demo')
    expect(before!.confidence.value).toBeCloseTo(0.675, 6)
    expect(before!.mustVerify).toBe(false) // 0.675 ≥ default 0.6

    await setStandards(db, { factorWeights: FULL, mustVerifyThreshold: 0.8 }) // raise the trust bar above 0.675
    const [after] = await recallClaims(db, embedder, 'engram verify demo')
    expect(after!.mustVerify).toBe(true) // 0.675 < 0.8 now ⇒ must verify
  })

  it('a config-raised mustVerify bar stays consistent with the adapter operator (no false adapter-relaxed)', async () => {
    // config can only RAISE the trust bar (≥ kernel 0.6); a [0.6, bar) claim is flagged mustVerify=true,
    // and since its value ≥ kernel 0.6, applyAdapter (hardcoded 0.6) requires nothing ⇒ no contradiction.
    await setStandards(db, { factorWeights: FULL, mustVerifyThreshold: 0.8 })
    await seedClaimWithFactors(
      factors({
        authority: 0.7,
        humanReview: 0.7,
        entailment: 0.7,
        indepSupport: 0.7,
        usageCorrect: 0.7,
      }), // base = 0.7
      'engram adapter seam',
    )
    const results = await recallClaims(db, embedder, 'engram adapter seam')
    expect(results[0]!.confidence.value).toBeCloseTo(0.7, 6)
    expect(results[0]!.mustVerify).toBe(true) // 0.7 < config 0.8

    const out = applyAdapter(results, (rs) => rs.map((r) => ({ ...r }))) // identity adapter
    expect(out).toHaveLength(1) // not rejected as 'adapter relaxed' (0.7 ≥ kernel 0.6)
    expect(out[0]!.mustVerify).toBe(true)
  })
})
