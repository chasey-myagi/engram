import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  applyAdapter,
  createDb,
  recallClaims,
  schema,
  type DB,
  type RecallResult,
} from '@engram/core'

import { OFFICIAL_DATASHEET, biddingAdapter, biddingTighten, readSourceTypes } from './index.js'

// ---- pure unit tests (no DB) ----

function makeResult(id: string, value: number, sourceId: string): RecallResult {
  return {
    claim: {
      id,
      claimText: `claim ${id}`,
      subject: null,
      predicate: null,
      object: null,
      status: 'active',
      lineageId: `lin-${id}`,
      asOf: new Date('2025-01-01T00:00:00Z'),
    },
    confidence: {
      value,
      raw: value,
      factors: {
        authority: 0.5,
        humanReview: 0,
        entailment: 0.5,
        indepSupport: 0,
        usageCorrect: 0,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: {
        authority: 0.3,
        humanReview: 0.3,
        entailment: 0.15,
        indepSupport: 0.15,
        usageCorrect: 0.1,
      },
      calibrationVersion: 'identity',
      takenAt: new Date('2025-01-01T00:00:00Z'),
    },
    provenances: [{ sourceId, locator: 'p1', relevance: 'exact' }],
    mustVerify: value < 0.6,
  }
}

describe('biddingAdapter — meta-driven tightening (pure)', () => {
  it('official_datasheet keeps conf (factor 1); other source_type is discounted; both ≤ gConf', () => {
    const types = new Map<string, string | undefined>([
      ['s-off', OFFICIAL_DATASHEET],
      ['s-forum', 'community_forum'],
      ['s-unknown', undefined],
    ])
    const out = biddingAdapter(types, { discount: 0.5 })([
      makeResult('o', 0.9, 's-off'),
      makeResult('f', 0.9, 's-forum'),
      makeResult('u', 0.9, 's-unknown'),
    ])
    expect(out[0]!.confidence.value).toBeCloseTo(0.9) // official → unchanged
    expect(out[1]!.confidence.value).toBeCloseTo(0.45) // forum → discounted
    expect(out[2]!.confidence.value).toBeCloseTo(0.45) // unknown type → discounted like non-official
  })

  it('recomputes mustVerify when the discount drops conf below the kernel trust bar', () => {
    const types = new Map<string, string | undefined>([['s-forum', 'community_forum']])
    const out = biddingAdapter(types, { discount: 0.5 })([makeResult('f', 0.9, 's-forum')])
    expect(out[0]!.confidence.value).toBeCloseTo(0.45)
    expect(out[0]!.mustVerify).toBe(true) // 0.45 < 0.6
  })

  it('composes with the kernel applyAdapter operator — a legitimate tightening passes the invariant', () => {
    const kernel = [makeResult('o', 0.9, 's-off'), makeResult('f', 0.8, 's-forum')]
    const types = new Map<string, string | undefined>([
      ['s-off', OFFICIAL_DATASHEET],
      ['s-forum', 'community_forum'],
    ])
    const out = applyAdapter(kernel, biddingAdapter(types))
    expect(out).toHaveLength(2)
    expect(out[0]!.confidence.value).toBeCloseTo(0.9)
    expect(out[1]!.confidence.value).toBeCloseTo(0.64) // 0.8 * 0.8 default discount, ≤ gConf
  })
})

// ---- DB integration: read real source.meta, recall, tighten through the SPI ----

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'engram-core',
  'drizzle',
)

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

async function seedActiveClaim(text: string, sourceId: string, raw = 0.9): Promise<string> {
  const id = randomUUID()
  await db.insert(schema.claim).values({
    id,
    claimText: text,
    status: 'active',
    confidence: raw,
    confidenceRaw: raw,
    confidenceFactors: {
      factors: {
        authority: 0.5,
        humanReview: 0,
        entailment: 0.5,
        indepSupport: 0,
        usageCorrect: 0,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: {
        authority: 0.3,
        humanReview: 0.3,
        entailment: 0.15,
        indepSupport: 0.15,
        usageCorrect: 0.1,
      },
      calibrationVersion: 'identity',
    },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
  })
  await db
    .insert(schema.claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

describe('bidding-adapter DB integration — business identity via source.meta (adapter → SPI, no reverse dep)', () => {
  it('readSourceTypes pulls source_type out of source.meta (kernel stores meta opaque)', async () => {
    const off = await addSource(db, {
      content: 'datasheet',
      contentHash: randomUUID(),
      kind: 'formal_document',
      meta: { source_type: OFFICIAL_DATASHEET, vendor: 'acme' },
    })
    const forum = await addSource(db, {
      content: 'thread',
      contentHash: randomUUID(),
      kind: 'conversation_log',
      meta: { source_type: 'community_forum' },
    })
    const bare = await addSource(db, {
      content: 'x',
      contentHash: randomUUID(),
      kind: 'external_feed',
    }) // no source_type in meta

    const types = await readSourceTypes(db, [off.sourceId, forum.sourceId, bare.sourceId])
    expect(types.get(off.sourceId)).toBe(OFFICIAL_DATASHEET)
    expect(types.get(forum.sourceId)).toBe('community_forum')
    expect(types.get(bare.sourceId)).toBeUndefined()
  })

  it('end-to-end: recall → biddingTighten holds an official_datasheet-backed claim at g, discounts a forum-backed one, all ≤ kernel g', async () => {
    const off = await addSource(db, {
      content: 'datasheet',
      contentHash: randomUUID(),
      kind: 'formal_document',
      meta: { source_type: OFFICIAL_DATASHEET },
    })
    const forum = await addSource(db, {
      content: 'thread',
      contentHash: randomUUID(),
      kind: 'conversation_log',
      meta: { source_type: 'community_forum' },
    })
    const idOff = await seedActiveClaim('bidding spec official', off.sourceId, 0.9)
    const idForum = await seedActiveClaim('bidding spec forum', forum.sourceId, 0.9)

    const kernel = await recallClaims(db, 'bidding spec')
    const gConf = new Map(kernel.map((r) => [r.claim.id, r.confidence.value]))
    expect(gConf.get(idOff)).toBeCloseTo(0.9)
    expect(gConf.get(idForum)).toBeCloseTo(0.9)

    const tightened = await biddingTighten(db, kernel)
    const byId = new Map(tightened.map((r) => [r.claim.id, r]))
    expect(byId.get(idOff)!.confidence.value).toBeCloseTo(0.9) // official: held at kernel g
    expect(byId.get(idForum)!.confidence.value).toBeCloseTo(0.72) // forum: 0.9 * 0.8 discount
    for (const r of tightened) {
      expect(r.confidence.value).toBeLessThanOrEqual(gConf.get(r.claim.id)! + 1e-9) // tightening upheld
    }
  })

  it('request-tier confidenceFloor can only tighten — below the kernel 0.4 floor it is clamped, not lowered', async () => {
    const off = await addSource(db, {
      content: 'd',
      contentHash: randomUUID(),
      kind: 'formal_document',
      meta: { source_type: OFFICIAL_DATASHEET },
    })
    await seedActiveClaim('floor probe low', off.sourceId, 0.45) // above kernel 0.4, below 0.6

    // floor 0.1 is clamped up to 0.4 ⇒ the 0.45 claim still surfaces (consumers cannot lower the gate)
    expect(await recallClaims(db, 'floor probe', { confidenceFloor: 0.1 })).toHaveLength(1)
    // a stricter floor above 0.45 filters it out
    expect(await recallClaims(db, 'floor probe', { confidenceFloor: 0.7 })).toHaveLength(0)
  })
})
