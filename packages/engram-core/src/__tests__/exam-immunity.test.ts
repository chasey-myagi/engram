import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import {
  claim,
  claimProvenance,
  claimVerification,
  l5Candidates,
  type ClaimStatus,
} from '../db/schema.js'
import { addSource } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { runL5Suite } from '../eval/l5-gap.js'
import { getGoldenQuestions, getPromotionAudit, promoteCandidate } from '../spi/exam-immunity.js'

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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, regression_pool, l5_candidates, golden_questions, promotion_audit CASCADE',
  )
})

const ABOVE_FLOOR = {
  authority: 0.8,
  humanReview: 0.8,
  entailment: 0.8,
  indepSupport: 0.8,
  usageCorrect: 0.8,
}

/** Seed a claim with an explicit embed-query + status + optional S/P/O, plus one exact provenance (D1). */
async function seedClaim(opts: {
  claimText: string
  embedQuery: string
  status: ClaimStatus
  subject?: string
  predicate?: string
  object?: string
}): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: opts.claimText,
    subject: opts.subject,
    predicate: opts.predicate,
    object: opts.object,
    status: opts.status,
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: {
        ...ABOVE_FLOOR,
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
    embedding: await embedder.embed(opts.embedQuery),
    embeddingVersion: embedder.version,
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

/** Insert a queued L5 candidate directly (the candidate namespace). */
async function seedCandidate(
  query: string,
  claimId: string | null,
  confirmedBy = 'human:judge',
): Promise<string> {
  const id = randomUUID()
  await db.insert(l5Candidates).values({
    id,
    sourceEventId: randomUUID(),
    query,
    claimId,
    confirmedBy,
    status: 'queued',
  })
  return id
}

describe('S12 A1 exam-immunity pipeline before golden promotion (A.9 red line)', () => {
  it('queued candidates live in the candidate namespace and do not participate in scoring until promoted', async () => {
    const origin = await seedClaim({ claimText: 'origin', embedQuery: 'q', status: 'quarantined' })
    await seedCandidate('a queued but unpromoted gap question', origin)
    expect(await getGoldenQuestions(db)).toHaveLength(0) // nothing scored yet
    // scoring runs over the golden namespace; with nothing promoted, the scored set is empty
    const report = await runL5Suite(db, embedder, [])
    expect(report.total).toBe(0)
  })

  it('a clean candidate passes the immunity pipeline and is frozen into golden (reusing real append + patrol), scored but never recalled', async () => {
    const q = 'what is the documented purge interval for the staging cache'
    // originating claim is quarantined ⇒ recall(q) is empty ⇒ KB truly lacks the answer; still provenance-traceable
    const origin = await seedClaim({
      claimText: 'a once-wrong answer',
      embedQuery: q,
      status: 'quarantined',
    })
    const candidateId = await seedCandidate(q, origin)

    const res = await promoteCandidate(db, embedder, candidateId, { confirmedBy: 'human:judge' })
    expect(res.promoted).toBe(true)
    expect(res.result).toMatchObject({
      humanConfirmed: true,
      kbTrulyLacks: true,
      noSelfContradiction: true,
      locatorsTraceable: true,
      passed: true,
    })

    // frozen into the golden namespace; candidate transitions to promoted
    const golden = await getGoldenQuestions(db)
    expect(golden).toHaveLength(1)
    expect(golden[0]!.query).toBe(q)
    expect(golden[0]!.candidateId).toBe(candidateId)
    expect(golden[0]!.poisonClaimId).toBe(res.poisonClaimId) // the frozen row links the authored poison claim
    expect(golden[0]!.promotedBy).toBe('human:judge') // the human authority is recorded on the golden row (provenance)
    expect(golden[0]!.basis).toMatchObject({
      humanConfirmed: true,
      kbTrulyLacks: true,
      noSelfContradiction: true,
      locatorsTraceable: true,
      passed: true,
    }) // the full immunity snapshot is frozen alongside the question
    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('promoted')

    // reused the real append/patrol path: a poison claim was authored + a patrol verdict recorded on it
    expect(res.poisonClaimId).toBeDefined()
    const patrol = await db
      .select()
      .from(claimVerification)
      .where(
        and(
          eq(claimVerification.claimId, res.poisonClaimId!),
          eq(claimVerification.kind, 'patrol'),
        ),
      )
    expect(patrol).toHaveLength(1)
    expect((patrol[0]!.verdict as { check: string }).check).toBe('exam_immunity')

    // never recalled: golden lives outside `claim`, and the poison claim is draft ⇒ recall(q) stays empty
    expect(await recallClaims(db, embedder, q)).toHaveLength(0)

    // scored through the REAL L5 suite (eval == consumption, zero bespoke path): a frozen gap scores 1.0
    const report = await runL5Suite(
      db,
      embedder,
      golden.map((g) => ({ id: g.id, query: g.query })),
    )
    expect(report.total).toBe(1)
    expect(report.blindSpotScore).toBe(1)
  })

  it('a structured poison (S/P/O present) that does NOT contradict the KB passes the contradiction scan and promotes', async () => {
    const q = 'which lubricant grade is specified for the idler bearing'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    // S/P/O present (so recordContradictions actually runs the scan, unlike free-text) but nothing in the
    // KB shares this subject+predicate ⇒ no contradicts edge ⇒ the contra.length===0 TRUE branch is taken
    const res = await promoteCandidate(db, embedder, candidateId, {
      confirmedBy: 'human:judge',
      poison: { subject: 'idler-bearing', predicate: 'lubricant-grade', object: 'iso-vg-46' },
    })
    expect(res.result.noSelfContradiction).toBe(true) // the scan ran on a structured poison and found nothing
    expect(res.promoted).toBe(true)
    expect(await getGoldenQuestions(db)).toHaveLength(1)
  })

  it('A1 red line: a deliberately-poisoned candidate (the KB actually CAN answer it) is rejected and never enters golden', async () => {
    const q = 'what is the supported maximum batch size for the ingest endpoint'
    // an ACTIVE claim answers q ⇒ recall(q) is non-empty ⇒ this gap question is poison (would mis-score the KB)
    const answer = await seedClaim({
      claimText: 'the ingest endpoint supports batches of 512',
      embedQuery: q,
      status: 'active',
    })
    const candidateId = await seedCandidate(q, answer)

    const res = await promoteCandidate(db, embedder, candidateId, { confirmedBy: 'human:judge' })
    expect(res.promoted).toBe(false)
    expect(res.result.kbTrulyLacks).toBe(false) // the poison: the KB has an answer
    expect(res.result.passed).toBe(false)
    expect(res.result.reasons).toContain(
      'KB already answers the question (recall returned a claim)',
    )
    expect(res.poisonClaimId).toBeUndefined() // doomed candidate ⇒ authoring skipped (no wasted draft poison)
    expect(await getGoldenQuestions(db)).toHaveLength(0) // never enters the golden set

    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('rejected') // poisoned candidate burned, terminal
    // the auditable "凭何": the rejection reason is persisted in the audit basis, not just returned
    const audit = await getPromotionAudit(db, candidateId)
    expect(audit[0]!.basis.reasons).toContain(
      'KB already answers the question (recall returned a claim)',
    )
  })

  it('A1 red line: a self-contradicting candidate (its poison claim contradicts the active KB) is rejected even though the KB lacks the answer', async () => {
    const q = 'which torque spec applies to the rotor mount'
    // active claim S+P+O1 with an UNRELATED embedding ⇒ recall(q) stays empty (kbTrulyLacks holds) …
    await seedClaim({
      claimText: 'rotor mount torque is 40 nm',
      embedQuery: 'totally unrelated banana split dessert',
      status: 'active',
      subject: 'rotor-mount',
      predicate: 'torque',
      object: '40nm',
    })
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    // … but the human frames the poison claim with the same S+P, a different O ⇒ authoring creates a contradicts edge
    const res = await promoteCandidate(db, embedder, candidateId, {
      confirmedBy: 'human:judge',
      poison: { subject: 'rotor-mount', predicate: 'torque', object: '55nm' },
    })
    expect(res.result.kbTrulyLacks).toBe(true) // the KB indeed lacks an answer to q
    expect(res.result.noSelfContradiction).toBe(false) // …but the question self-contradicts the KB
    expect(res.result.reasons).toContain(
      'question self-contradicts the KB (a contradicts edge was created on authoring)',
    )
    expect(res.promoted).toBe(false)
    expect(await getGoldenQuestions(db)).toHaveLength(0)
    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('rejected')

    // "fail ⇒ logged": the poison-authoring rejection path STILL records an auditable rejection
    const audit = await getPromotionAudit(db, candidateId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('rejected')
    expect(audit[0]!.decidedBy).toBe('human:judge')
    expect(audit[0]!.basis.passed).toBe(false)

    // the rejected poison claim persists as the immune-system artifact, with its patrol verdict explaining why
    expect(res.poisonClaimId).toBeDefined()
    const patrol = await db
      .select()
      .from(claimVerification)
      .where(
        and(
          eq(claimVerification.claimId, res.poisonClaimId!),
          eq(claimVerification.kind, 'patrol'),
        ),
      )
    expect(patrol).toHaveLength(1)
    expect((patrol[0]!.verdict as { noSelfContradiction: boolean }).noSelfContradiction).toBe(false)
  })

  it('only a human can promote: an agent-confirmed attempt is rejected, audited, and does NOT burn the candidate (stays queued)', async () => {
    const q = 'agent-confirmed attempt query'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    const res = await promoteCandidate(db, embedder, candidateId, { confirmedBy: 'agent:rogue' })
    expect(res.promoted).toBe(false)
    expect(res.result.humanConfirmed).toBe(false)
    expect(res.result.reasons).toContain("not human-confirmed (by_role 'agent:rogue')")
    expect(res.poisonClaimId).toBeUndefined() // no poison authored on an unauthorized attempt
    expect(await getGoldenQuestions(db)).toHaveLength(0)

    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('queued') // unauthorized attempt must not burn the candidate

    const audit = await getPromotionAudit(db, candidateId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('rejected')
    expect(audit[0]!.decidedBy).toBe('agent:rogue')
    expect(audit[0]!.basis.reasons).toContain("not human-confirmed (by_role 'agent:rogue')")
  })

  it('locator traceability: a candidate with no originating claim is not traceable and is rejected (no poison authored)', async () => {
    const candidateId = await seedCandidate('untraceable gap question', null) // claimId null ⇒ no origin to trace

    const res = await promoteCandidate(db, embedder, candidateId, { confirmedBy: 'human:judge' })
    expect(res.result.locatorsTraceable).toBe(false)
    expect(res.result.reasons).toContain('candidate has no traceable originating claim')
    expect(res.promoted).toBe(false)
    expect(res.poisonClaimId).toBeUndefined()
    expect(await getGoldenQuestions(db)).toHaveLength(0)
  })

  it('locator traceability: an originating claim that exists but has NO provenance hits the !prov branch — rejected, no poison authored', async () => {
    const q = 'gap whose origin claim carries no provenance'
    // directly insert an origin claim with ZERO provenance rows (bypassing appendClaim's D1 guard);
    // quarantined ⇒ recall(q) stays empty so kbTrulyLacks holds and the traceability failure is isolated
    const originId = randomUUID()
    await db.insert(claim).values({
      id: originId,
      claimText: 'origin without any provenance',
      status: 'quarantined',
      confidence: 0.8,
      confidenceRaw: 0.8,
      confidenceFactors: {
        factors: {
          ...ABOVE_FLOOR,
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
      embedding: await embedder.embed(q),
      embeddingVersion: embedder.version,
    })
    const candidateId = await seedCandidate(q, originId)

    const res = await promoteCandidate(db, embedder, candidateId, { confirmedBy: 'human:judge' })
    expect(res.result.kbTrulyLacks).toBe(true) // origin is quarantined ⇒ recall(q) empty
    expect(res.result.locatorsTraceable).toBe(false) // …but the origin claim has no provenance to trace
    expect(res.result.reasons).toContain('originating claim lacks provenance (not traceable)')
    expect(res.promoted).toBe(false)
    expect(res.poisonClaimId).toBeUndefined() // authoring skipped on the !prov branch
    expect(await getGoldenQuestions(db)).toHaveLength(0)
  })

  it('promotion is append-only and auditable (who / when / on-what-basis) for both pass and fail', async () => {
    const q = 'auditable promotion query'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    const t0 = (await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId)))[0]!
      .createdAt
    await promoteCandidate(db, embedder, candidateId, { confirmedBy: 'human:architect' })

    const audit = await getPromotionAudit(db, candidateId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('promoted') // who
    expect(audit[0]!.decidedBy).toBe('human:architect') // who
    expect(audit[0]!.basis.passed).toBe(true) // on-what-basis (the immunity result snapshot)
    expect(audit[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(t0.getTime()) // when
  })

  it('promotion is single-shot: re-promoting a non-queued (already promoted) candidate throws; unknown candidate throws', async () => {
    const q = 'single-shot query'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)
    await promoteCandidate(db, embedder, candidateId, { confirmedBy: 'human:judge' }) // → promoted

    await expect(
      promoteCandidate(db, embedder, candidateId, { confirmedBy: 'human:judge' }),
    ).rejects.toThrow(/only queued candidates/)
    await expect(
      promoteCandidate(db, embedder, randomUUID(), { confirmedBy: 'human:judge' }),
    ).rejects.toThrow(/not found/)
  })

  it('rejection is terminal: a rejected candidate cannot be re-promoted (a burned poison can never sneak back)', async () => {
    const q = 'rejected-then-retried query'
    const answer = await seedClaim({
      claimText: 'kb can answer this',
      embedQuery: q,
      status: 'active',
    })
    const candidateId = await seedCandidate(q, answer)
    await promoteCandidate(db, embedder, candidateId, { confirmedBy: 'human:judge' }) // → rejected (KB answers)

    await expect(
      promoteCandidate(db, embedder, candidateId, { confirmedBy: 'human:judge' }),
    ).rejects.toThrow(/only queued candidates/)
  })

  it('getGoldenQuestions and the unfiltered getPromotionAudit return rows in created_at-ascending order across multiple candidates', async () => {
    const mk = async (n: number) => {
      const q = `gap question number ${n}`
      const origin = await seedClaim({
        claimText: `origin ${n}`,
        embedQuery: q,
        status: 'quarantined',
      })
      const cid = await seedCandidate(q, origin)
      await promoteCandidate(db, embedder, cid, { confirmedBy: 'human:judge' })
      return q
    }
    const q1 = await mk(1)
    const q2 = await mk(2)
    const q3 = await mk(3)

    const golden = await getGoldenQuestions(db)
    expect(golden.map((g) => g.query)).toEqual([q1, q2, q3]) // promotion order preserved (feeds runL5Suite stably)

    const audit = await getPromotionAudit(db) // unfiltered (no candidateId) branch
    expect(audit).toHaveLength(3)
    expect(audit.every((a) => a.decision === 'promoted')).toBe(true)
    for (let i = 1; i < audit.length; i++) {
      expect(audit[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        audit[i - 1]!.createdAt.getTime(),
      )
    }
  })
})
