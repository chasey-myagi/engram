import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  CALIBRATION_IDENTITY,
  DEFAULT_WEIGHTS,
  NEUTRAL_FACTORS,
  type ConfidenceFactorBreakdown,
  type StoredConfidence,
} from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import {
  claim,
  claimProvenance,
  claimVerification,
  relation,
  type ClaimStatus,
} from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { writePatrolVerdict, computeEntailmentFactor } from '../verifier/patrol-verdict.js'
import { approveClaim, editApproveClaim, rejectClaim } from '../editor/editor-action.js'
import { agentActor, trustedHumanActor } from '../spi/actor.js'
import {
  writeHumanReview,
  latestHumanReview,
  computeHumanReviewFactor,
  latestHumanReviewFactors,
  HUMAN_REVIEW_APPROVE,
  HUMAN_REVIEW_REJECT,
} from '../editor/human-review.js'
import { getHumanOverturns } from '../editor/human-overturn.js'

// S22 · 主编三动作（Approve / Edit-Approve / Reject）= 因子-only(f1 humanReview) + append-only + 翻案事件。
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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events CASCADE',
  )
})

const EDITOR = 'human:editor'

async function aSource(authorityScore = 0.9) {
  return addSource(db, {
    content: `body-${randomUUID()}`,
    kind: 'structured_spec',
    authorityScore,
  })
}

/**
 * Seed a claim at a chosen status + factor profile, recallable (embedding=query), with one exact provenance.
 * f1 (humanReview) defaults to neutral 0 so we can prove Approve raises it / Reject keeps it floored.
 */
async function seedClaim(opts: {
  query: string
  status: ClaimStatus
  factors?: Partial<ConfidenceFactorBreakdown>
  createdBy?: string
}): Promise<string> {
  const id = randomUUID()
  const factors: ConfidenceFactorBreakdown = {
    authority: 0,
    humanReview: 0,
    entailment: NEUTRAL_FACTORS.entailment,
    indepSupport: 0,
    usageCorrect: 0,
    ageDays: 0,
    activeContradicts: 0,
    staleDecay: 1,
    conflictDecay: 1,
    ...opts.factors,
  }
  const stored: StoredConfidence = {
    factors,
    weights: DEFAULT_WEIGHTS,
    calibrationVersion: CALIBRATION_IDENTITY,
  }
  await db.insert(claim).values({
    id,
    claimText: `claim for ${opts.query}`,
    status: opts.status,
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: stored,
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: opts.createdBy ?? 'agent:distiller',
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

describe('S22 f1 humanReview producer — human review → f1 (命门 A.3, last dormant factor)', () => {
  it('constants + neutral: Approve=1, Reject=0, NEUTRAL_FACTORS.humanReview=0 (single source of truth)', () => {
    expect(HUMAN_REVIEW_APPROVE).toBe(1)
    expect(HUMAN_REVIEW_REJECT).toBe(0)
    expect(NEUTRAL_FACTORS.humanReview).toBe(0) // "人审未发生"中性
  })

  it('writeHumanReview + latestHumanReview: append-only, latest wins; no review → null (→ neutral 0)', async () => {
    const id = await seedClaim({
      query: 'review me',
      status: 'active',
      factors: { authority: 0.9 },
    })
    expect(await latestHumanReview(db, id)).toBeNull()
    expect(await computeHumanReviewFactor(db, id)).toBe(NEUTRAL_FACTORS.humanReview) // 0

    await writeHumanReview(db, {
      claimId: id,
      actor: trustedHumanActor(EDITOR),
      verdict: { humanReview: 0 },
    })
    await writeHumanReview(db, {
      claimId: id,
      actor: trustedHumanActor(EDITOR),
      verdict: { humanReview: 1 },
    })
    expect(await latestHumanReview(db, id)).toBe(1) // latest of two reviews
    expect(await computeHumanReviewFactor(db, id)).toBe(1)
    // append-only: both rows persisted, both kind=patrol & human
    const rows = await db.select().from(claimVerification).where(eq(claimVerification.claimId, id))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === 'patrol' && r.byRole === EDITOR)).toBe(true)
  })

  it('writeHumanReview rejects a non-human caller — f1 is a human-only factor (red line #2)', async () => {
    const id = await seedClaim({ query: 'agent cannot endorse', status: 'draft' })
    await expect(
      writeHumanReview(db, {
        claimId: id,
        actor: agentActor('agent:distiller'),
        verdict: { humanReview: 1 },
      }),
    ).rejects.toThrow(/is not human/)
    // nothing written, factor stays neutral
    expect(await latestHumanReview(db, id)).toBeNull()
    expect(await computeHumanReviewFactor(db, id)).toBe(0)
  })

  // EGR-CR-002 对抗回归（gate human-review.ts:71 writeHumanReview 写入门）：授权读 actor.isHuman，伪装 role 越不过。
  // agentActor('human:fake') ⇒ isHuman:false ⇒ 拒；旧门 isHumanRole('human:fake') 会误判成人、放行伪造人审。
  it('EGR-CR-002: writeHumanReview REJECTS agentActor("human:fake") — a forged human role cannot cast a human review (authz reads isHuman, not the role string)', async () => {
    const id = await seedClaim({ query: 'forged human review', status: 'draft' })
    await expect(
      writeHumanReview(db, {
        claimId: id,
        actor: agentActor('human:fake'),
        verdict: { humanReview: 1 },
      }),
    ).rejects.toThrow(/is not human/)
    expect(await latestHumanReview(db, id)).toBeNull() // no f1 written
    expect(await computeHumanReviewFactor(db, id)).toBe(0)
  })

  it('latestHumanReviewFactors: batch read, latest per claim, claims with no review absent from the map', async () => {
    const a = await seedClaim({ query: 'a', status: 'active' })
    const b = await seedClaim({ query: 'b', status: 'active' })
    const c = await seedClaim({ query: 'c', status: 'active' }) // never reviewed
    await writeHumanReview(db, {
      claimId: a,
      actor: trustedHumanActor(EDITOR),
      verdict: { humanReview: 1 },
    })
    await writeHumanReview(db, {
      claimId: b,
      actor: trustedHumanActor(EDITOR),
      verdict: { humanReview: 1 },
    })
    await writeHumanReview(db, {
      claimId: b,
      actor: trustedHumanActor(EDITOR),
      verdict: { humanReview: 0 },
    }) // newer
    const m = await latestHumanReviewFactors(db, [a, b, c])
    expect(m.get(a)).toBe(1)
    expect(m.get(b)).toBe(0) // latest = reject
    expect(m.has(c)).toBe(false) // no review → not in map (caller keeps stored/neutral)
  })

  it('f1 and f2 share kind=patrol but never cross-read: a human Approve does not clobber an existing entailment pass, and vice versa', async () => {
    const id = await seedClaim({ query: 'shared patrol channel', status: 'active' })
    // verifier writes entailment pass → f2=1
    await writePatrolVerdict(db, {
      claimId: id,
      byRole: 'agent:verifier',
      verdict: { entailment: 'pass' },
    })
    expect(await computeEntailmentFactor(db, id)).toBe(1)
    expect(await latestHumanReview(db, id)).toBeNull() // no human-review row yet

    // a NEWER human Approve row (no entailment field) must NOT drop f2 back to neutral
    await writeHumanReview(db, {
      claimId: id,
      actor: trustedHumanActor(EDITOR),
      verdict: { humanReview: 1 },
    })
    expect(await computeEntailmentFactor(db, id)).toBe(1) // still reads the latest entailment-bearing row
    expect(await latestHumanReview(db, id)).toBe(1) // f1 reads the human-review row

    // a NEWER verifier fail row (no humanReview field) must NOT drop f1 — f1 keeps the latest human row
    await writePatrolVerdict(db, {
      claimId: id,
      byRole: 'agent:verifier',
      verdict: { entailment: 'fail' },
    })
    expect(await computeEntailmentFactor(db, id)).toBe(0) // f2 now fail
    expect(await latestHumanReview(db, id)).toBe(1) // f1 unchanged by the verifier row
  })
})

describe('S22 Approve — endorse f1 (=1), promote/relax via the state machine (factor-only, not direct status write)', () => {
  it('end-to-end demo: editor Approves a sub-gate draft → f1 maxes, claim crosses the gate to active and becomes recallable', async () => {
    const q = 'sub-gate draft about the relay rating'
    // base with neutral f1=0: 0.3·0.9(auth) + 0.3·0(f1) + 0.15·0.5(entail) + 0.15·0 + 0.1·0 = 0.345 < 0.4 floor
    const id = await seedClaim({ query: q, status: 'draft', factors: { authority: 0.9 } })
    expect(await recallClaims(db, embedder, q)).toHaveLength(0) // draft shadow zone: not recalled

    const res = await approveClaim(db, id, {
      actor: trustedHumanActor(EDITOR),
      note: 'verified against datasheet',
    })
    expect(res.status).toBe('active')
    expect(res.overturnEventId).toBeUndefined() // draft promote is not an overturn
    expect(await statusOf(id)).toBe('active')

    // LOAD-BEARING EFFECT: f1 rose to 1 at recall-time AND the value crossed the floor → recallable
    const hits = await recallClaims(db, embedder, q)
    expect(hits.map((h) => h.claim.id)).toContain(id)
    const hit = hits.find((h) => h.claim.id === id)!
    expect(hit.confidence.factors.humanReview).toBe(1) // f1 maxed at recall-time
    // raw with f1=1: 0.345 (neutral) + 0.3·1 = 0.645 ≥ floor 0.4
    expect(hit.confidence.value).toBeGreaterThan(0.4)
  })

  it('Approve RAISES f1 vs a neutral baseline at recall-time (a sign flip would fail this)', async () => {
    const q = 'high-auth active claim awaiting endorsement'
    // already-active, recallable without f1: 0.3·0.95 + 0.15·0.5 = 0.36 ... bump indep so it clears floor pre-approve
    const id = await seedClaim({
      query: q,
      status: 'active',
      factors: { authority: 0.95, indepSupport: 0.5 },
    })
    const before = await recallClaims(db, embedder, q)
    expect(before).toHaveLength(1)
    expect(before[0]!.confidence.factors.humanReview).toBe(0) // neutral pre-approve
    const vBefore = before[0]!.confidence.value

    await approveClaim(db, id, { actor: trustedHumanActor(EDITOR) })
    const after = await recallClaims(db, embedder, q)
    expect(after[0]!.confidence.factors.humanReview).toBe(1)
    expect(after[0]!.confidence.value).toBeGreaterThan(vBefore) // f1 raised the value
  })

  it('Approve also persists f1 at COMMIT-time: the stored snapshot reflects f1 after a recompute (commit ∧ recall)', async () => {
    // prove f1 is wired at the single factor seam (computeConfidenceFromProvenances opts.claimId), not only at recall.
    const q = 'commit-time f1 seam'
    const id = await seedClaim({ query: q, status: 'active', factors: { authority: 0.9 } })
    await approveClaim(db, id, { actor: trustedHumanActor(EDITOR) })
    // Assert the single factor seam directly: a commit-time recompute for this claimId reads f1 live (=1 after Approve).
    const { computeConfidenceFromProvenances } = await import('../spi/append-claim.js')
    const provs = await db
      .select({ sourceId: claimProvenance.sourceId, relevance: claimProvenance.relevance })
      .from(claimProvenance)
      .where(eq(claimProvenance.claimId, id))
    const conf = await db.transaction((tx) =>
      computeConfidenceFromProvenances(
        tx,
        provs.map((p) => ({ sourceId: p.sourceId, relevance: p.relevance })),
        new Date(),
        { claimId: id },
      ),
    )
    expect(conf.factors.humanReview).toBe(1) // f1 read live at the commit-time seam
  })

  it('Approve relaxing a quarantined claim records a human_overturn (un_quarantine) — the falseQuarantineRate producer for S26', async () => {
    const q = 'mis-quarantined claim'
    const id = await seedClaim({ query: q, status: 'quarantined', factors: { authority: 0.9 } })
    expect(await recallClaims(db, embedder, q)).toHaveLength(0) // quarantined: not recalled

    const res = await approveClaim(db, id, {
      actor: trustedHumanActor(EDITOR),
      note: 'patrol was too aggressive',
    })
    expect(res.status).toBe('active')
    expect(res.overturnEventId).toBeDefined()
    expect(await statusOf(id)).toBe('active') // relaxed via the red edge

    const overturns = await getHumanOverturns(db, id)
    expect(overturns).toHaveLength(1)
    expect(overturns[0]!.payload.overturn).toBe('un_quarantine')
    expect(overturns[0]!.payload.fromStatus).toBe('quarantined')
    expect(overturns[0]!.payload.toStatus).toBe('active')
    expect(overturns[0]!.payload.byRole).toBe(EDITOR)
    expect(overturns[0]!.eventId).toBe(res.overturnEventId)
    // and it is recallable again with f1=1
    const hits = await recallClaims(db, embedder, q)
    expect(hits.find((h) => h.claim.id === id)?.confidence.factors.humanReview).toBe(1)
  })

  it('Approve relaxing flagged → pardon overturn; superseded → rollback overturn', async () => {
    const f = await seedClaim({
      query: 'flagged claim',
      status: 'flagged',
      factors: { authority: 0.9 },
    })
    await approveClaim(db, f, { actor: trustedHumanActor(EDITOR) })
    expect((await getHumanOverturns(db, f))[0]!.payload.overturn).toBe('pardon')
    expect(await statusOf(f)).toBe('active')

    const s = await seedClaim({
      query: 'superseded claim',
      status: 'superseded',
      factors: { authority: 0.9 },
    })
    await approveClaim(db, s, { actor: trustedHumanActor(EDITOR) })
    expect((await getHumanOverturns(db, s))[0]!.payload.overturn).toBe('rollback')
    expect(await statusOf(s)).toBe('active')
  })

  it('Approve on an already-active claim only endorses (no transition, no overturn)', async () => {
    const id = await seedClaim({
      query: 'already active',
      status: 'active',
      factors: { authority: 0.9 },
    })
    const res = await approveClaim(db, id, { actor: trustedHumanActor(EDITOR) })
    expect(res.status).toBe('active')
    expect(res.overturnEventId).toBeUndefined()
    expect(await getHumanOverturns(db, id)).toHaveLength(0)
    expect(await latestHumanReview(db, id)).toBe(1)
  })

  it('Approve is human-only: an agent caller is rejected before any side effect', async () => {
    const id = await seedClaim({
      query: 'agent approve',
      status: 'quarantined',
      factors: { authority: 0.9 },
    })
    await expect(approveClaim(db, id, { actor: agentActor('agent:rogue') })).rejects.toThrow(
      /only a human/,
    )
    expect(await statusOf(id)).toBe('quarantined') // unchanged
    expect(await latestHumanReview(db, id)).toBeNull() // no f1 written
    expect(await getHumanOverturns(db, id)).toHaveLength(0)
  })

  // EGR-CR-002 对抗回归（gate editor-action.ts:50 requireHuman）：授权读 actor.isHuman，伪装的 role 串越不过。
  // agentActor('human:fake') ⇒ isHuman:false ⇒ Approve 在任何副作用前即被拒（不放松、不写 f1、不记翻案）。
  it('EGR-CR-002: agentActor("human:fake") is REJECTED by Approve — a forged human role cannot relax (authz reads isHuman, not the role string)', async () => {
    const id = await seedClaim({
      query: 'forged editor approve',
      status: 'quarantined',
      factors: { authority: 0.9 },
    })
    await expect(approveClaim(db, id, { actor: agentActor('human:fake') })).rejects.toThrow(
      /only a human/,
    )
    expect(await statusOf(id)).toBe('quarantined') // unchanged
    expect(await latestHumanReview(db, id)).toBeNull() // no f1 written
    expect(await getHumanOverturns(db, id)).toHaveLength(0)
  })
})

describe('S22 Edit-Approve — append-only NEW version, then endorse the new one (never destructive)', () => {
  it('creates a new same-lineage version (old preserved + superseded + recallable lineage), endorses & promotes the new', async () => {
    const q = 'editable fact about the torque spec'
    const oldId = await seedClaim({ query: q, status: 'active', factors: { authority: 0.9 } })
    const [oldRow] = await db
      .select({ lineageId: claim.lineageId })
      .from(claim)
      .where(eq(claim.id, oldId))
    const oldLineage = oldRow!.lineageId

    const { sourceId } = await aSource()
    const res = await editApproveClaim(
      db,
      embedder,
      oldId,
      { claimText: `claim for ${q} (corrected to 42Nm)` },
      [{ sourceId, locator: 'rev-2', excerpt: 'measured 42Nm' }],
      { actor: trustedHumanActor(EDITOR), note: 'corrected torque' },
    )
    expect(res.claimId).not.toBe(oldId) // a NEW version id
    expect(res.status).toBe('active')

    // new version reuses the lineage_id, old is superseded but NOT deleted (lineage preserved, still queryable)
    const [newRow] = await db
      .select({ lineageId: claim.lineageId, status: claim.status })
      .from(claim)
      .where(eq(claim.id, res.claimId))
    expect(newRow!.lineageId).toBe(oldLineage)
    expect(newRow!.status).toBe('active')
    expect(await statusOf(oldId)).toBe('superseded')
    const [stillThere] = await db.select({ id: claim.id }).from(claim).where(eq(claim.id, oldId))
    expect(stillThere!.id).toBe(oldId) // old version physically retained

    // a supersedes relation new→old exists (lineage edge)
    const sup = await db
      .select()
      .from(relation)
      .where(
        and(
          eq(relation.fromClaim, res.claimId),
          eq(relation.toClaim, oldId),
          eq(relation.type, 'supersedes'),
        ),
      )
    expect(sup).toHaveLength(1)

    // the new version carries f1=1 and is the one recalled (old superseded → not recalled)
    const hits = await recallClaims(db, embedder, q)
    expect(hits.map((h) => h.claim.id)).toEqual([res.claimId])
    expect(hits[0]!.confidence.factors.humanReview).toBe(1)
    expect(hits[0]!.claim.lineageId).toBe(oldLineage)
  })

  it('Edit-Approve never mutates the old version text in place (append-only): old text is byte-preserved', async () => {
    const q = 'immutable old text'
    const oldId = await seedClaim({ query: q, status: 'active', factors: { authority: 0.9 } })
    const [before] = await db.select({ t: claim.claimText }).from(claim).where(eq(claim.id, oldId))
    const oldText = before!.t

    const { sourceId } = await aSource()
    await editApproveClaim(
      db,
      embedder,
      oldId,
      { claimText: 'a totally new revised text' },
      [{ sourceId, locator: 'r2' }],
      { actor: trustedHumanActor(EDITOR) },
    )
    const [after] = await db.select({ t: claim.claimText }).from(claim).where(eq(claim.id, oldId))
    expect(after!.t).toBe(oldText) // old row text unchanged — never destructive
  })

  it('Edit-Approve is human-only and forces provenance (D1) on the new version', async () => {
    const oldId = await seedClaim({
      query: 'edit guards',
      status: 'active',
      factors: { authority: 0.9 },
    })
    await expect(
      editApproveClaim(
        db,
        embedder,
        oldId,
        { claimText: 'x' },
        [{ sourceId: (await aSource()).sourceId, locator: 'r' }],
        { actor: agentActor('agent:x') },
      ),
    ).rejects.toThrow(/only a human/)
    // D1: no provenance → physically refused (no new version, old stays the head)
    await expect(
      editApproveClaim(db, embedder, oldId, { claimText: 'x' }, [], {
        actor: trustedHumanActor(EDITOR),
      }),
    ).rejects.toThrow(/forced provenance|>=1 provenance/)
    expect(await statusOf(oldId)).toBe('active') // old still the active head, untouched
  })
})

describe('S22 Reject — tighten to quarantined (f1=0), audit-preserved, never destructive', () => {
  it('Reject an agent-promoted (active) claim → quarantined, gone from recall but auditable, + a reject_agent_promoted overturn', async () => {
    const q = 'agent-promoted claim the editor distrusts'
    const id = await seedClaim({
      query: q,
      status: 'active',
      factors: { authority: 0.95, indepSupport: 0.5 },
    })
    expect((await recallClaims(db, embedder, q)).map((h) => h.claim.id)).toContain(id) // recallable while active

    const res = await rejectClaim(db, id, {
      actor: trustedHumanActor(EDITOR),
      note: 'contradicts the spec',
    })
    expect(res.status).toBe('quarantined')
    expect(res.overturnEventId).toBeDefined()
    expect(await statusOf(id)).toBe('quarantined')

    // gone from recall, but physically retained (auditable)
    expect((await recallClaims(db, embedder, q)).find((h) => h.claim.id === id)).toBeUndefined()
    const [stillThere] = await db.select({ id: claim.id }).from(claim).where(eq(claim.id, id))
    expect(stillThere!.id).toBe(id)

    // f1 dropped to 0 (a tightening review) — LOAD-BEARING: latest human review is the reject
    expect(await latestHumanReview(db, id)).toBe(0)

    // overturn recorded (the editor overturned the agent's promotion)
    const ov = await getHumanOverturns(db, id)
    expect(ov).toHaveLength(1)
    expect(ov[0]!.payload.overturn).toBe('reject_agent_promoted')
    expect(ov[0]!.payload.fromStatus).toBe('active')
    expect(ov[0]!.payload.toStatus).toBe('quarantined')
  })

  it('Reject DROPS f1 to 0 (mirror of Approve): a sign flip would fail this', async () => {
    const id = await seedClaim({
      query: 'reject drops f1',
      status: 'active',
      factors: { authority: 0.9 },
    })
    await approveClaim(db, id, { actor: trustedHumanActor(EDITOR) })
    expect(await computeHumanReviewFactor(db, id)).toBe(1) // approved first
    await rejectClaim(db, id, { actor: trustedHumanActor(EDITOR) })
    expect(await computeHumanReviewFactor(db, id)).toBe(0) // reject floors f1
  })

  it('Reject a flagged claim → quarantined (single blue step); no overturn (flagged is not an agent-promoted active)', async () => {
    const id = await seedClaim({
      query: 'flagged then rejected',
      status: 'flagged',
      factors: { authority: 0.9 },
    })
    const res = await rejectClaim(db, id, { actor: trustedHumanActor(EDITOR) })
    expect(res.status).toBe('quarantined')
    expect(res.overturnEventId).toBeUndefined()
    expect(await getHumanOverturns(db, id)).toHaveLength(0)
    expect(await latestHumanReview(db, id)).toBe(0)
  })

  it('Reject a draft keeps it in the shadow zone (no illegal draft→quarantined) with f1=0 — never recalled, auditable', async () => {
    const q = 'rejected draft'
    const id = await seedClaim({
      query: q,
      status: 'draft',
      factors: { authority: 0.95, indepSupport: 0.9 },
    })
    const res = await rejectClaim(db, id, { actor: trustedHumanActor(EDITOR) })
    expect(res.status).toBe('draft') // A.4 has no legal draft→quarantined edge
    expect(await latestHumanReview(db, id)).toBe(0) // f1=0 ⇒ can never cross the promote gate
    expect(await recallClaims(db, embedder, q)).toHaveLength(0) // shadow zone
  })

  it('Reject is human-only and is append-only (a prior Approve row is preserved alongside the Reject row)', async () => {
    const id = await seedClaim({
      query: 'reject guards',
      status: 'active',
      factors: { authority: 0.9 },
    })
    await expect(rejectClaim(db, id, { actor: agentActor('agent:x') })).rejects.toThrow(
      /only a human/,
    )

    await approveClaim(db, id, { actor: trustedHumanActor(EDITOR) }) // first an approve
    await rejectClaim(db, id, { actor: trustedHumanActor(EDITOR) }) // then a reject
    const rows = await db.select().from(claimVerification).where(eq(claimVerification.claimId, id))
    expect(rows.length).toBeGreaterThanOrEqual(2) // both reviews retained (append-only)
    expect(await latestHumanReview(db, id)).toBe(0) // latest wins
  })

  it('idempotent-ish: Reject a quarantined claim only re-records the f1=0 review (no extra transition, no new overturn)', async () => {
    const id = await seedClaim({
      query: 'already quarantined',
      status: 'quarantined',
      factors: { authority: 0.9 },
    })
    const res = await rejectClaim(db, id, { actor: trustedHumanActor(EDITOR) })
    expect(res.status).toBe('quarantined')
    expect(res.overturnEventId).toBeUndefined()
    expect(await getHumanOverturns(db, id)).toHaveLength(0)
    expect(await latestHumanReview(db, id)).toBe(0)
  })
})

/**
 * 把 db 包成「事务内首个 .update() 抛错」的代理：模拟状态翻转那一步的 DB 故障。其余方法（select/insert、
 * 以及事务外的 getActiveStandards）原样透传（绑定到真实 db/tx，避免 this 丢失）。用于证明动作的单事务原子性。
 */
function dbThatThrowsOnUpdate(realDb: DB): DB {
  const wrapTx = (tx: object): object =>
    new Proxy(tx, {
      get(t, p, r) {
        if (p === 'update') {
          return () => {
            throw new Error('injected: DB fault during status update')
          }
        }
        const v = Reflect.get(t, p, r)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          (target as DB).transaction((tx) => fn(wrapTx(tx as object)), ...(rest as []))
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as DB
}

describe('S22 atomicity + concurrency — HITL editor actions are single-transaction (must-fix from gate#1)', () => {
  it('concurrency: two concurrent Approves on ONE quarantined claim record EXACTLY ONE un_quarantine overturn (not two) — the FOR UPDATE lock serializes; the loser sees active and only re-endorses', async () => {
    const id = await seedClaim({
      query: 'concurrent un-quarantine',
      status: 'quarantined',
      factors: { authority: 0.9 },
    })
    // race two editors un-quarantining the same claim
    const [r1, r2] = await Promise.all([
      approveClaim(db, id, { actor: trustedHumanActor('human:editor-a') }),
      approveClaim(db, id, { actor: trustedHumanActor('human:editor-b') }),
    ])
    expect(r1.status).toBe('active')
    expect(r2.status).toBe('active')
    expect(await statusOf(id)).toBe('active')
    // EXACTLY ONE un_quarantine overturn — the S26 falseQuarantineRate signal is not double-counted
    const ov = await getHumanOverturns(db, id)
    expect(ov.filter((o) => o.payload.overturn === 'un_quarantine')).toHaveLength(1)
    // exactly one of the two carries the overturn id; the other is a plain re-endorsement
    expect([r1.overturnEventId, r2.overturnEventId].filter(Boolean)).toHaveLength(1)
  })

  it('concurrency: two concurrent Rejects on ONE active claim record EXACTLY ONE reject_agent_promoted overturn', async () => {
    const id = await seedClaim({
      query: 'concurrent reject',
      status: 'active',
      factors: { authority: 0.9 },
    })
    const [r1, r2] = await Promise.all([
      rejectClaim(db, id, { actor: trustedHumanActor('human:editor-a') }),
      rejectClaim(db, id, { actor: trustedHumanActor('human:editor-b') }),
    ])
    expect(r1.status).toBe('quarantined')
    expect(r2.status).toBe('quarantined')
    const ov = await getHumanOverturns(db, id)
    expect(ov.filter((o) => o.payload.overturn === 'reject_agent_promoted')).toHaveLength(1)
    expect([r1.overturnEventId, r2.overturnEventId].filter(Boolean)).toHaveLength(1)
  })

  it('atomicity: a fault during the status transition rolls back the WHOLE action — no orphan f1 row, no overturn event, status untouched', async () => {
    const id = await seedClaim({
      query: 'atomic rollback',
      status: 'quarantined',
      factors: { authority: 0.9 },
    })
    const faultyDb = dbThatThrowsOnUpdate(db)
    // writeHumanReview (insert) runs first, THEN the transition's update throws → whole tx must roll back.
    await expect(approveClaim(faultyDb, id, { actor: trustedHumanActor(EDITOR) })).rejects.toThrow(
      /injected/,
    )
    expect(await statusOf(id)).toBe('quarantined') // status never moved
    expect(await latestHumanReview(db, id)).toBeNull() // the f1 row was rolled back (no orphan endorsement)
    expect(await getHumanOverturns(db, id)).toHaveLength(0) // no overturn ever recorded (reached after the throw)
  })

  it('atomicity: a fault during Reject rolls back the f1=0 row and any partial tighten — no orphan overturn claiming quarantined', async () => {
    const id = await seedClaim({
      query: 'atomic reject rollback',
      status: 'active',
      factors: { authority: 0.9 },
    })
    const faultyDb = dbThatThrowsOnUpdate(db)
    await expect(rejectClaim(faultyDb, id, { actor: trustedHumanActor(EDITOR) })).rejects.toThrow(
      /injected/,
    )
    expect(await statusOf(id)).toBe('active') // never reached flagged/quarantined
    expect(await latestHumanReview(db, id)).toBeNull()
    expect(await getHumanOverturns(db, id)).toHaveLength(0)
  })

  it('Edit-Approve records NO human_overturn (a corrected/superseded edit is not a relaxation of an agent ruling)', async () => {
    const q = 'edit approve no overturn'
    const oldId = await seedClaim({ query: q, status: 'active', factors: { authority: 0.9 } })
    const { sourceId } = await aSource()
    const res = await editApproveClaim(
      db,
      embedder,
      oldId,
      { claimText: `claim for ${q} (revised)` },
      [{ sourceId, locator: 'r2' }],
      { actor: trustedHumanActor(EDITOR) },
    )
    expect(res.overturnEventId).toBeUndefined()
    expect(await getHumanOverturns(db, res.claimId)).toHaveLength(0)
    expect(await getHumanOverturns(db, oldId)).toHaveLength(0)
  })

  it('writeHumanReview clamps an out-of-range humanReview into [0,1] (a removed clamp would fail this)', async () => {
    const id = await seedClaim({ query: 'clamp', status: 'active', factors: { authority: 0.9 } })
    await writeHumanReview(db, {
      claimId: id,
      actor: trustedHumanActor(EDITOR),
      verdict: { humanReview: 2 },
    })
    expect(await latestHumanReview(db, id)).toBe(1) // clamped down to the [0,1] ceiling
    expect(await computeHumanReviewFactor(db, id)).toBe(1)
  })

  it('editor actions on a missing claim throw not-found and write nothing', async () => {
    const ghost = randomUUID()
    await expect(approveClaim(db, ghost, { actor: trustedHumanActor(EDITOR) })).rejects.toThrow(
      /not found/,
    )
    await expect(rejectClaim(db, ghost, { actor: trustedHumanActor(EDITOR) })).rejects.toThrow(
      /not found/,
    )
    expect(await getHumanOverturns(db, ghost)).toHaveLength(0)
  })
})
