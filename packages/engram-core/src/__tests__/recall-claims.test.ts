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
import { claim, claimProvenance, relation, type ClaimStatus } from '../db/schema.js'
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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, page_claims, standards CASCADE',
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

/**
 * confidence_factors blob 摆到「召回(用 DEFAULT_WEIGHTS, Σw=1)重算后 value == raw」：5 个加性因子都置 raw，
 * 衰减置 1 ⇒ base = Σwᵢ·raw = raw·1 = raw。S7 起召回用活动权重重算 raw（不再读存档 confidence_raw），
 * 故因子必须与目标 value 自洽（不能像早先那样塞个无关的 confidence_raw）。
 */
function factorsBlob(
  raw: number,
  calibrationVersion: string = CALIBRATION_IDENTITY,
): StoredConfidence {
  return {
    factors: {
      authority: raw,
      humanReview: raw,
      entailment: raw,
      indepSupport: raw,
      usageCorrect: raw,
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
    confidenceFactors: factorsBlob(opts.raw, opts.calibrationVersion),
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
    // key by claimText (recomputed value carries tiny FP error → exact-value map keys are fragile)
    const byText = new Map(results.map((r) => [r.claim.claimText, r]))

    expect(byText.has('widget below floor')).toBe(false) // 0.2 < 0.4 never surfaces
    expect(byText.get('widget mid band')!.mustVerify).toBe(true) // mid band: usable but verify
    expect(byText.get('widget high band')!.mustVerify).toBe(false) // high band: directly usable
    expect(results).toHaveLength(2)
  })

  it('gates near both band edges: just below 0.4 excluded; just-above-floor + just-below-0.6 ⇒ mustVerify; ≥0.6 ⇒ usable', async () => {
    // recomputed confidence carries FP error, so probe with safe margins (≫ FP) around the thresholds
    await seedClaim({ raw: 0.39, text: 'edge below floor' }) // < 0.4 → excluded
    await seedClaim({ raw: 0.41, text: 'edge just above floor' }) // [0.4,0.6) → mustVerify
    await seedClaim({ raw: 0.59, text: 'edge just below verify' }) // [0.4,0.6) → mustVerify
    await seedClaim({ raw: 0.61, text: 'edge above verify' }) // ≥0.6 → usable

    const results = await recallClaims(db, 'edge')
    const byText = new Map(results.map((r) => [r.claim.claimText, r]))
    expect(byText.has('edge below floor')).toBe(false) // floor excludes < 0.4
    expect(byText.get('edge just above floor')!.mustVerify).toBe(true)
    expect(byText.get('edge just below verify')!.mustVerify).toBe(true)
    expect(byText.get('edge above verify')!.mustVerify).toBe(false)
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
    expect(snap.factors.entailment).toBe(0.8) // factor breakdown carried through (blob sets all factors = raw)
    expect(snap.takenAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(snap.takenAt.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('an already-returned snapshot is frozen — later mutation of the claim does not change it', async () => {
    const id = await seedClaim({ raw: 0.8, text: 'mutate me' })
    const [r] = await recallClaims(db, 'mutate')
    expect(r!.confidence.value).toBe(0.8)

    // mutate the underlying claim's factors after recall returned (recall recomputes from factors now)
    await db
      .update(claim)
      .set({ confidenceFactors: factorsBlob(0.05), confidence: 0.05, confidenceRaw: 0.05 })
      .where(eq(claim.id, id))

    expect(r!.confidence.value).toBe(0.8) // held snapshot unchanged (value copy, not a live view)
    expect(r!.confidence.raw).toBe(0.8) // nested fields detached too, not just the value primitive
    expect(r!.confidence.factors.entailment).toBe(0.8)
    const again = await recallClaims(db, 'mutate')
    expect(again).toHaveLength(0) // a fresh recall recomputes from the new factors (0.05 < floor)
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
      confidenceFactors: factorsBlob(0.8),
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

describe('S8 contradicts — dual-return + real-time conflictDecay (A.3/A.5)', () => {
  const contradict = (from: string, to: string) =>
    db
      .insert(relation)
      .values({ id: randomUUID(), fromClaim: from, toClaim: to, type: 'contradicts' })

  it('returns BOTH contradicting claims, each annotated with the contradicts edge — neither dropped nor auto-picked', async () => {
    const a = await seedClaim({ raw: 0.8, text: 'sky color blue' })
    const b = await seedClaim({ raw: 0.8, text: 'sky color green' })
    await contradict(a, b)

    const results = await recallClaims(db, 'sky color')
    expect(results).toHaveLength(2)
    const byId = new Map(results.map((r) => [r.claim.id, r]))
    expect(byId.get(a)!.contradicts).toEqual([b]) // each tagged with its contradicts edge
    expect(byId.get(b)!.contradicts).toEqual([a])
  })

  it('an active contradicts edge drives conflictDecay so BOTH sides drop vs no-conflict (real time)', async () => {
    const a = await seedClaim({ raw: 0.8, text: 'engram conflict a' })
    const b = await seedClaim({ raw: 0.8, text: 'engram conflict b' })

    // before the edge: full confidence, conflictDecay = 1
    const before = new Map((await recallClaims(db, 'engram conflict')).map((r) => [r.claim.id, r]))
    expect(before.get(a)!.confidence.value).toBeCloseTo(0.8, 6)
    expect(before.get(a)!.confidence.factors.conflictDecay).toBe(1)

    await contradict(a, b) // one active contradiction each → conflictDecay(1) = 1/1.5

    const after = new Map((await recallClaims(db, 'engram conflict')).map((r) => [r.claim.id, r]))
    for (const id of [a, b]) {
      expect(after.get(id)!.confidence.value).toBeCloseTo(0.8 / 1.5, 6) // measurably reduced, both sides
      expect(after.get(id)!.confidence.factors.activeContradicts).toBe(1)
      expect(after.get(id)!.confidence.factors.conflictDecay).toBeCloseTo(1 / 1.5, 6)
    }
  })

  it('a claim with no contradictions is unaffected (conflictDecay = 1, contradicts = [])', async () => {
    await seedClaim({ raw: 0.8, text: 'lonely fact' })
    const [r] = await recallClaims(db, 'lonely fact')
    expect(r!.confidence.value).toBeCloseTo(0.8, 6)
    expect(r!.confidence.factors.conflictDecay).toBe(1)
    expect(r!.confidence.factors.activeContradicts).toBe(0)
    expect(r!.contradicts).toEqual([])
  })

  it.each(['draft', 'flagged', 'quarantined', 'superseded'] as const)(
    'a contradiction whose opponent is %s is not an active conflict (only active opponents count)',
    async (status) => {
      const a = await seedClaim({ raw: 0.8, text: `nonactive opp ${status} head` })
      const b = await seedClaim({ raw: 0.8, text: `opp ${status} other`, status })
      await contradict(a, b)
      const [r] = await recallClaims(db, `nonactive opp ${status} head`)
      expect(r!.confidence.value).toBeCloseTo(0.8, 6) // opponent not active → no live conflict
      expect(r!.confidence.factors.conflictDecay).toBe(1)
      expect(r!.contradicts).toEqual([])
    },
  )

  it('conflict can GATE, not just down-rank: enough active contradictions push value below the floor → absent', async () => {
    const a = await seedClaim({ raw: 0.5, text: 'gated by conflict target' })
    const b = await seedClaim({ raw: 0.5, text: 'gated rival one' })
    const c = await seedClaim({ raw: 0.5, text: 'gated rival two' })
    await contradict(b, a)
    await contradict(c, a) // 2 active contradictions → conflictDecay(2) = 0.5
    // 0.5 × 0.5 = 0.25 < 0.4 floor → the target disappears entirely (conflict gates, not merely annotates)
    expect(await recallClaims(db, 'gated by conflict target')).toHaveLength(0)
  })

  it('append→recall seam: a contradiction recorded by append surfaces in recall.contradicts (one real edge, read both ways)', async () => {
    // recordContradictions writes ONE real edge (from new → existing); recall is direction-agnostic
    const s1 = await seedSource(0.9)
    const s2 = await seedSource(0.9)
    const prov = [
      { sourceId: s1.sourceId, locator: 'l1' },
      { sourceId: s2.sourceId, locator: 'l2' },
    ]
    const { claimId: a } = await appendClaim(
      db,
      { claimText: 'seam sku maxres 4k', subject: 'sku', predicate: 'maxres', object: '4k' },
      prov,
    )
    const { claimId: b } = await appendClaim(
      db,
      { claimText: 'seam sku maxres 1080p', subject: 'sku', predicate: 'maxres', object: '1080p' },
      prov,
    )
    // promote to active + lift factors above the floor (S8 append base is too low to clear floor under the penalty)
    for (const id of [a, b]) {
      await db
        .update(claim)
        .set({ status: 'active', confidenceFactors: factorsBlob(0.9) })
        .where(eq(claim.id, id))
    }
    const byId = new Map((await recallClaims(db, 'seam sku maxres')).map((r) => [r.claim.id, r]))
    expect(byId.get(a)!.contradicts).toEqual([b]) // the single append-written edge is read from both sides
    expect(byId.get(b)!.contradicts).toEqual([a])
    expect(byId.get(a)!.confidence.factors.activeContradicts).toBe(1)
  })

  it('multiple active contradictions stack: conflictDecay(2) = 1/(1+0.5·2) = 0.5', async () => {
    const a = await seedClaim({ raw: 0.9, text: 'multi target' })
    const b = await seedClaim({ raw: 0.9, text: 'multi rival one' })
    const c = await seedClaim({ raw: 0.9, text: 'multi rival two' })
    await contradict(b, a)
    await contradict(c, a)
    const [r] = await recallClaims(db, 'multi target')
    expect(r!.confidence.factors.activeContradicts).toBe(2)
    expect(r!.confidence.value).toBeCloseTo(0.9 * 0.5, 6) // conflictDecay(2) = 0.5
    expect(new Set(r!.contradicts)).toEqual(new Set([b, c]))
  })

  it('a self-referential contradicts edge does not make a claim conflict with itself (defensive)', async () => {
    const a = await seedClaim({ raw: 0.8, text: 'self edge claim' })
    await contradict(a, a) // from == to (write path blocks this; direct insert bottoms it out)
    const [r] = await recallClaims(db, 'self edge claim')
    expect(r!.contradicts).toEqual([])
    expect(r!.confidence.factors.conflictDecay).toBe(1)
  })

  it('all five relation types persist with correct from/to references', async () => {
    const a = await seedClaim({ raw: 0.8, text: 'rel from' })
    const b = await seedClaim({ raw: 0.8, text: 'rel to' })
    for (const type of [
      'supports',
      'contradicts',
      'refines',
      'derived_from',
      'supersedes',
    ] as const) {
      await db.insert(relation).values({ id: randomUUID(), fromClaim: a, toClaim: b, type })
    }
    const rows = await db.select().from(relation).where(eq(relation.fromClaim, a))
    expect(rows.map((r) => r.type).sort()).toEqual([
      'contradicts',
      'derived_from',
      'refines',
      'supersedes',
      'supports',
    ])
    expect(rows.every((r) => r.toClaim === b)).toBe(true)
  })
})
