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
  applyG,
  type StoredConfidence,
} from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { addSource, appendClaim } from '../spi/append-claim.js'
import { claim, claimProvenance, type ClaimStatus } from '../db/schema.js'
import {
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
  recallClaims,
} from '../spi/recall-claims.js'

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

async function seedSource(authorityScore = 0.5) {
  return addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore,
  })
}

/** confidence_factors 的合法占位 blob —— 召回只读 raw 并现算 g，因子只随快照透传，无需与 raw 对账。 */
function factorsBlob(calibrationVersion: string = CALIBRATION_IDENTITY): StoredConfidence {
  return {
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
    weights: DEFAULT_WEIGHTS,
    calibrationVersion,
  }
}

/**
 * 直接落一条已知 raw 的 claim（绕过写路径公式）—— 召回测的是消费门，须能精确摆出任意 band，
 * 包括 appendClaim 当前还够不到的 ≥0.6「可直接用」band（humanReview/usage/entailment 生产者在 S17/S19/S22）。
 */
async function seedClaim(opts: {
  raw: number
  text: string
  subject?: string | null
  status?: ClaimStatus
  provenance?: boolean
  calibrationVersion?: string
}): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: opts.text,
    subject: opts.subject ?? null,
    status: opts.status ?? 'active',
    confidence: opts.raw,
    confidenceRaw: opts.raw,
    confidenceFactors: factorsBlob(opts.calibrationVersion),
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
  })
  if (opts.provenance !== false) {
    const { sourceId } = await seedSource()
    await db
      .insert(claimProvenance)
      .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  }
  return id
}

describe('S3 recall_claims — consumption gate (A.2)', () => {
  it('gates by band: <0.4 absent, [0.4,0.6) mustVerify=true, ≥0.6 mustVerify=false (black-box SPI)', async () => {
    await seedClaim({ raw: 0.2, text: 'widget below floor' })
    await seedClaim({ raw: 0.5, text: 'widget mid band' })
    await seedClaim({ raw: 0.8, text: 'widget high band' })

    const results = await recallClaims(db, 'widget')
    const byValue = new Map(results.map((r) => [r.confidence.value, r]))

    expect(byValue.has(0.2)).toBe(false) // below 0.4 never surfaces
    expect(byValue.get(0.5)?.mustVerify).toBe(true) // mid band: usable but verify
    expect(byValue.get(0.8)?.mustVerify).toBe(false) // high band: directly usable
    expect(results).toHaveLength(2)
  })

  it('band edges are inclusive at 0.4 and 0.6, exclusive just below', async () => {
    await seedClaim({ raw: 0.399, text: 'edge a' })
    await seedClaim({ raw: KERNEL_CONFIDENCE_FLOOR, text: 'edge b' }) // exactly 0.4
    await seedClaim({ raw: MUST_VERIFY_THRESHOLD, text: 'edge c' }) // exactly 0.6

    const results = await recallClaims(db, 'edge')
    const vals = results.map((r) => r.confidence.value).sort((a, b) => a - b)
    expect(vals).toEqual([0.4, 0.6]) // 0.399 excluded; 0.4 and 0.6 included
    expect(results.find((r) => r.confidence.value === 0.4)?.mustVerify).toBe(true) // 0.4 ⇒ verify
    expect(results.find((r) => r.confidence.value === 0.6)?.mustVerify).toBe(false) // 0.6 ⇒ usable
  })

  it('every result carries ≥1 provenance; a claim with no provenance never surfaces', async () => {
    await seedClaim({ raw: 0.8, text: 'orphan no-prov', provenance: false })
    await seedClaim({ raw: 0.8, text: 'grounded with-prov', provenance: true })

    const results = await recallClaims(db, 'prov')
    expect(results).toHaveLength(1)
    expect(results[0]!.claim.claimText).toBe('grounded with-prov')
    for (const r of results) {
      expect(r.provenances.length).toBeGreaterThanOrEqual(1)
      const p = r.provenances[0]!
      expect(p.sourceId).toBeTruthy()
      expect(p.locator).toBe('p1')
      expect(p.relevance).toBe('exact')
    }
  })

  it('takes the ConfidenceSnapshot at recall instant (takenAt) with value=g(raw), raw, factors, weights, calibrationVersion', async () => {
    await seedClaim({ raw: 0.8, text: 'snapshot claim' })
    const before = new Date()
    const [r] = await recallClaims(db, 'snapshot')
    const after = new Date()

    const snap = r!.confidence
    expect(snap.value).toBe(0.8) // identity ⇒ value === raw
    expect(snap.raw).toBe(0.8)
    expect(snap.calibrationVersion).toBe(CALIBRATION_IDENTITY)
    expect(snap.weights).toEqual(DEFAULT_WEIGHTS)
    expect(snap.factors.entailment).toBe(0.5) // factor breakdown carried through for explainability
    expect(snap.takenAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(snap.takenAt.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('an already-returned snapshot is frozen — later mutation of the claim does not change it', async () => {
    const id = await seedClaim({ raw: 0.8, text: 'mutate me' })
    const [r] = await recallClaims(db, 'mutate')
    expect(r!.confidence.value).toBe(0.8)

    // mutate the underlying claim after recall returned
    await db.update(claim).set({ confidenceRaw: 0.05, confidence: 0.05 }).where(eq(claim.id, id))

    expect(r!.confidence.value).toBe(0.8) // held snapshot unchanged (value copy, not a live view)
    expect(r!.confidence.raw).toBe(0.8) // nested fields detached too, not just the value primitive
    expect(r!.confidence.factors.entailment).toBe(0.5)
    const again = await recallClaims(db, 'mutate')
    expect(again).toHaveLength(0) // a fresh recall reflects the mutation (now below floor)
  })

  it('ctx.confidenceFloor below the kernel floor is clamped up to 0.4 — consumers cannot relax the gate', async () => {
    await seedClaim({ raw: 0.2, text: 'floor below' })
    await seedClaim({ raw: 0.5, text: 'floor mid' })

    const results = await recallClaims(db, 'floor', { confidenceFloor: 0.1 })
    expect(results).toHaveLength(1) // 0.2 still excluded — floor clamped to 0.4, not lowered to 0.1
    expect(results[0]!.confidence.value).toBe(0.5)
  })

  it('ctx.confidenceFloor above 0.4 further filters results', async () => {
    await seedClaim({ raw: 0.5, text: 'raise mid' })
    await seedClaim({ raw: 0.8, text: 'raise high' })

    const results = await recallClaims(db, 'raise', { confidenceFloor: 0.7 })
    expect(results).toHaveLength(1)
    expect(results[0]!.confidence.value).toBe(0.8)
  })

  it('mustVerify follows the kernel 0.6 bar, not the consumer floor', async () => {
    await seedClaim({ raw: 0.55, text: 'kernel-relative verify' })
    const [r] = await recallClaims(db, 'kernel-relative', { confidenceFloor: 0.5 })
    expect(r!.confidence.value).toBe(0.55)
    expect(r!.mustVerify).toBe(true) // 0.55 < 0.6 kernel bar even though it cleared the 0.5 floor
  })

  it('never surfaces superseded versions (single head)', async () => {
    await seedClaim({ raw: 0.8, text: 'sku spec', status: 'active' })
    await seedClaim({ raw: 0.8, text: 'sku spec', status: 'superseded' })

    const results = await recallClaims(db, 'sku spec')
    expect(results).toHaveLength(1)
    expect(results[0]!.claim.status).toBe('active')
  })

  it('orders by confidence descending and honors ctx.limit', async () => {
    await seedClaim({ raw: 0.5, text: 'rank claim a' })
    await seedClaim({ raw: 0.9, text: 'rank claim b' })
    await seedClaim({ raw: 0.7, text: 'rank claim c' })

    const all = await recallClaims(db, 'rank claim')
    expect(all.map((r) => r.confidence.value)).toEqual([0.9, 0.7, 0.5])

    const top2 = await recallClaims(db, 'rank claim', { limit: 2 })
    expect(top2.map((r) => r.confidence.value)).toEqual([0.9, 0.7])
  })

  it('matches subject as well as claim_text, with deterministic literal substring (LIKE metachars escaped)', async () => {
    await seedClaim({ raw: 0.8, text: 'discount a%b literal', subject: null })
    await seedClaim({ raw: 0.8, text: 'discount axxb wildcard', subject: null })
    await seedClaim({ raw: 0.8, text: 'unrelated body', subject: 'SKU-42' })

    const literal = await recallClaims(db, 'a%b')
    expect(literal).toHaveLength(1) // % is literal, not a wildcard matching axxb
    expect(literal[0]!.claim.claimText).toBe('discount a%b literal')

    await seedClaim({ raw: 0.8, text: 'code a_b underscore', subject: null })
    await seedClaim({ raw: 0.8, text: 'code axb underscore', subject: null })
    const underscore = await recallClaims(db, 'a_b')
    expect(underscore).toHaveLength(1) // _ is literal, not a single-char wildcard matching axb
    expect(underscore[0]!.claim.claimText).toBe('code a_b underscore')

    const bySubject = await recallClaims(db, 'SKU-42')
    expect(bySubject).toHaveLength(1)
    expect(bySubject[0]!.claim.subject).toBe('SKU-42')
  })

  it('returns [] for an empty query or no match', async () => {
    await seedClaim({ raw: 0.8, text: 'present' })
    expect(await recallClaims(db, '')).toEqual([])
    expect(await recallClaims(db, 'absent-token')).toEqual([])
  })

  it('never surfaces non-active claims — draft (shadow zone), quarantined, or flagged (status gate, layer ①)', async () => {
    // High confidence is not enough: the consumption gate also requires a consumable status.
    await seedClaim({ raw: 0.8, text: 'gate active', status: 'active' })
    await seedClaim({ raw: 0.8, text: 'gate draft', status: 'draft' })
    await seedClaim({ raw: 0.8, text: 'gate quarantined', status: 'quarantined' })
    await seedClaim({ raw: 0.8, text: 'gate flagged', status: 'flagged' })

    const results = await recallClaims(db, 'gate')
    expect(results).toHaveLength(1)
    expect(results[0]!.claim.status).toBe('active')
    expect(results[0]!.claim.claimText).toBe('gate active')
  })

  it('matches case-insensitively (ilike)', async () => {
    await seedClaim({ raw: 0.8, text: 'widget high band' })
    const results = await recallClaims(db, 'WIDGET')
    expect(results).toHaveLength(1)
    expect(results[0]!.claim.claimText).toBe('widget high band')
  })

  it('treats a non-finite confidenceFloor (NaN / ±Infinity) as the kernel floor, not vacuously', async () => {
    await seedClaim({ raw: 0.2, text: 'nf below' })
    await seedClaim({ raw: 0.5, text: 'nf mid' })

    for (const bad of [NaN, Infinity, -Infinity]) {
      const results = await recallClaims(db, 'nf', { confidenceFloor: bad })
      expect(results.map((r) => r.confidence.value)).toEqual([0.5]) // kernel floor 0.4: 0.2 out, 0.5 in
    }
  })

  it('breaks ties deterministically by claim id ascending at equal confidence', async () => {
    const a = await seedClaim({ raw: 0.8, text: 'tie one' })
    const b = await seedClaim({ raw: 0.8, text: 'tie two' })
    const results = await recallClaims(db, 'tie')
    expect(results.map((r) => r.claim.id)).toEqual([a, b].sort()) // id-ascending, not insertion order
  })

  it('echoes every claim passthrough column (id/subject/predicate/object/status/lineageId/asOf)', async () => {
    // guard the pure-passthrough columns — a wrong-column typo in the mapping would slip past
    // the band/snapshot tests, which only check id/subject/status.
    const id = randomUUID()
    const lineageId = randomUUID()
    const asOf = new Date('2025-01-02T03:04:05.000Z')
    await db.insert(claim).values({
      id,
      claimText: 'passthrough body',
      subject: 'subj-x',
      predicate: 'pred-y',
      object: 'obj-z',
      status: 'active',
      confidence: 0.8,
      confidenceRaw: 0.8,
      confidenceFactors: factorsBlob(),
      lineageId,
      asOf,
      createdBy: 'test',
    })
    const { sourceId } = await seedSource()
    await db
      .insert(claimProvenance)
      .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })

    const [r] = await recallClaims(db, 'passthrough')
    expect(r!.claim).toMatchObject({
      id,
      subject: 'subj-x',
      predicate: 'pred-y',
      object: 'obj-z',
      status: 'active',
      lineageId,
    })
    expect(r!.claim.asOf.toISOString()).toBe(asOf.toISOString())
  })

  it('returns ALL provenances for a multi-provenance claim (exercises the grouping push branch)', async () => {
    const id = await seedClaim({ raw: 0.8, text: 'multi prov', provenance: false })
    const s1 = await seedSource()
    const s2 = await seedSource()
    await db.insert(claimProvenance).values([
      {
        id: randomUUID(),
        claimId: id,
        sourceId: s1.sourceId,
        locator: 'loc-1',
        relevance: 'exact',
      },
      {
        id: randomUUID(),
        claimId: id,
        sourceId: s2.sourceId,
        locator: 'loc-2',
        relevance: 'supporting',
      },
    ])
    const [r] = await recallClaims(db, 'multi prov')
    expect(r!.provenances).toHaveLength(2)
    expect(r!.provenances.map((p) => p.locator).sort()).toEqual(['loc-1', 'loc-2'])
    expect(new Set(r!.provenances.map((p) => p.sourceId))).toEqual(
      new Set([s1.sourceId, s2.sourceId]),
    )
  })

  it('isolates provenance per claim — each result carries only its own sources', async () => {
    const idA = await seedClaim({ raw: 0.8, text: 'iso alpha', provenance: false })
    const idB = await seedClaim({ raw: 0.7, text: 'iso beta', provenance: false })
    const sa = await seedSource()
    const sb = await seedSource()
    await db.insert(claimProvenance).values([
      {
        id: randomUUID(),
        claimId: idA,
        sourceId: sa.sourceId,
        locator: 'a-loc',
        relevance: 'exact',
      },
      {
        id: randomUUID(),
        claimId: idB,
        sourceId: sb.sourceId,
        locator: 'b-loc',
        relevance: 'exact',
      },
    ])
    const byId = new Map((await recallClaims(db, 'iso')).map((r) => [r.claim.id, r]))
    expect(byId.get(idA)!.provenances.map((p) => p.sourceId)).toEqual([sa.sourceId]) // no B leakage
    expect(byId.get(idB)!.provenances.map((p) => p.sourceId)).toEqual([sb.sourceId]) // no A leakage
  })

  it('end-to-end through the real append→recall seam: appended claims are draft (shadow zone) and are NOT recalled until promoted (S13)', async () => {
    // appendClaim writes status=draft and no draft→active promotion path exists yet (S13).
    // Even a well-corroborated claim sits in the shadow zone and must not be consumable.
    const s1 = await seedSource(0.9)
    const s2 = await seedSource(0.9)
    await appendClaim(db, { claimText: 'engram corroborated fact' }, [
      { sourceId: s1.sourceId, locator: 'l1' },
      { sourceId: s2.sourceId, locator: 'l2' },
    ])
    const lone = await seedSource(0.9)
    await appendClaim(db, { claimText: 'engram lone-source fact' }, [
      { sourceId: lone.sourceId, locator: 'l' },
    ])

    expect(await recallClaims(db, 'engram')).toHaveLength(0) // both draft → shadow zone, not recalled
  })
})

describe('S3 g mapping at recall (criterion 5)', () => {
  it('g is pure and identity ⇒ value === raw across a sweep', () => {
    for (let i = 0; i <= 10; i++) {
      const raw = i / 10
      expect(applyG(raw, CALIBRATION_IDENTITY)).toBe(raw)
      expect(applyG(raw, CALIBRATION_IDENTITY)).toBe(applyG(raw, CALIBRATION_IDENTITY)) // pure
    }
  })

  it('g is monotonic non-decreasing: raw up ⇒ value not down', () => {
    let prev = -Infinity
    for (let i = 0; i <= 20; i++) {
      const v = applyG(i / 20, CALIBRATION_IDENTITY)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})
