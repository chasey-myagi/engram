import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { claim, claimProvenance } from '../db/schema.js'
import { addSource } from '../spi/append-claim.js'
import { reportUsage } from '../spi/report-usage.js'
import { recallClaims } from '../spi/recall-claims.js'
import {
  getL5Candidates,
  getRegressionPool,
  isHumanRole,
  refluxFailures,
  replayRegressionItem,
  replayRegressionPool,
} from '../spi/reflux.js'

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
    'TRUNCATE source, claim, claim_provenance, claim_verification, metrics_events, regression_pool, l5_candidates CASCADE',
  )
})

const ABOVE_FLOOR = {
  authority: 0.8,
  humanReview: 0.8,
  entailment: 0.8,
  indepSupport: 0.8,
  usageCorrect: 0.8,
}

async function aSource() {
  return addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
}

/** Seed a recallable active claim addressable by `query` (embedding = query vector) + one exact provenance. */
async function seedActiveAnswering(text: string, query: string): Promise<string> {
  const id = randomUUID()
  const vector = await embedder.embed(query, 'query')
  await db.insert(claim).values({
    id,
    claimText: text,
    status: 'active',
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
    embedding: vector,
    embeddingVersion: embedder.version,
  })
  const { sourceId } = await aSource()
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

describe('S11 production-failure reflux → live regression set (A.2/A.9)', () => {
  it('only refuted/corrected events surface into the pool keyed by claim + query/task; adopted/partial never pollute it', async () => {
    const a = await seedActiveAnswering('claim a answer', 'query about a')
    const b = await seedActiveAnswering('claim b answer', 'query about b')

    await reportUsage(db, a, 'refuted', {
      byRole: 'agent:x',
      query: 'query about a',
      taskId: 'task-a',
    })
    await reportUsage(db, b, 'corrected', {
      byRole: 'agent:x',
      query: 'query about b',
      taskId: 'task-b',
    })
    await reportUsage(db, a, 'adopted', { byRole: 'agent:x', query: 'query about a' }) // must NOT pool
    await reportUsage(db, a, 'partial', { byRole: 'agent:x', query: 'query about a' }) // must NOT pool

    const { pooled } = await refluxFailures(db)
    expect(pooled).toBe(2) // exactly the refuted + corrected

    const items = await getRegressionPool(db)
    expect(items.map((i) => i.outcome).sort()).toEqual(['corrected', 'refuted'])
    const aItem = items.find((i) => i.claimId === a)!
    expect(aItem.outcome).toBe('refuted')
    expect(aItem.query).toBe('query about a')
    expect(aItem.taskId).toBe('task-a')
    // both failure outcomes carry their key fields symmetrically
    const bItem = items.find((i) => i.claimId === b)!
    expect(bItem.outcome).toBe('corrected')
    expect(bItem.query).toBe('query about b')
    expect(bItem.taskId).toBe('task-b')
  })

  it('a pooled failure carries its query + recall-time confSnapshot and replays through recall_claims to a pass/fail verdict', async () => {
    const q = 'what is the failing answer'
    const c = await seedActiveAnswering('the originally-served wrong answer', q)
    await reportUsage(db, c, 'refuted', {
      byRole: 'agent:x',
      query: q,
      confidenceAtRecall: 0.8,
      calibrationVersion: CALIBRATION_IDENTITY,
    })

    await refluxFailures(db)
    const [item] = await getRegressionPool(db)
    expect(item!.query).toBe(q)
    expect(item!.predictedConfidence).toBe(0.8) // recall-time snapshot preserved
    expect(item!.calibrationVersion).toBe(CALIBRATION_IDENTITY)

    // claim still active+recallable ⇒ the failure still reproduces ⇒ FAIL
    const before = await replayRegressionItem(db, embedder, item!)
    expect(before.replayable).toBe(true)
    expect(before.stillRecalled).toBe(true)
    expect(before.pass).toBe(false)

    // "fix" it (quarantine the bad claim) ⇒ no longer recalled ⇒ PASS against current behavior
    await db.update(claim).set({ status: 'quarantined' }).where(eq(claim.id, c))
    const after = await replayRegressionItem(db, embedder, item!)
    expect(after.stillRecalled).toBe(false)
    expect(after.pass).toBe(true)
  })

  it('reflux preserves provenance lineage: the pooled failure is attributable to a specific claim whose provenance is reachable', async () => {
    const q = 'attribution query'
    const c = await seedActiveAnswering('attributable claim', q)
    await reportUsage(db, c, 'refuted', { byRole: 'agent:x', query: q })

    await refluxFailures(db)
    const [item] = await getRegressionPool(db)
    expect(item!.claimId).toBe(c) // attributable to the exact failing claim

    // the claim_id FK ⇒ the claim's provenance chain is reachable (D1: ≥1 provenance)
    const prov = await db
      .select({ sourceId: claimProvenance.sourceId })
      .from(claimProvenance)
      .where(eq(claimProvenance.claimId, item!.claimId))
    expect(prov.length).toBeGreaterThanOrEqual(1)
  })

  it("human-confirmed 'KB truly lacks it' is queued as an L5 candidate; an agent's same flag is NOT (human-confirmed only)", async () => {
    const cH = await seedActiveAnswering('wrong answer humans flagged', 'human-flagged gap query')
    const cA = await seedActiveAnswering('wrong answer agent flagged', 'agent-flagged gap query')

    await reportUsage(db, cH, 'refuted', {
      byRole: 'human:judge',
      query: 'human-flagged gap query',
      kbLacksAnswer: true,
    })
    await reportUsage(db, cA, 'refuted', {
      byRole: 'agent:x',
      query: 'agent-flagged gap query',
      kbLacksAnswer: true, // an agent cannot self-confirm a knowledge gap
    })

    const { pooled, l5Queued } = await refluxFailures(db)
    expect(pooled).toBe(2) // both are real failures → both pooled
    expect(l5Queued).toBe(1) // only the human-confirmed one queues an L5 candidate

    const candidates = await getL5Candidates(db, 'queued')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.query).toBe('human-flagged gap query')
    expect(candidates[0]!.confirmedBy).toBe('human:judge')
    expect(candidates[0]!.status).toBe('queued') // promotion to the frozen L5 suite is the S12 QA gate
    expect(candidates[0]!.claimId).toBe(cH)
  })

  it('a human kbLacksAnswer with no query cannot form a question and is not queued (still pooled as a failure)', async () => {
    const c = await seedActiveAnswering('wrong answer no query', 'some query')
    await reportUsage(db, c, 'refuted', { byRole: 'human:judge', kbLacksAnswer: true }) // no query

    const { pooled, l5Queued } = await refluxFailures(db)
    expect(pooled).toBe(1)
    expect(l5Queued).toBe(0)
    expect(await getL5Candidates(db)).toHaveLength(0)
  })

  it('the pool is re-runnable without duplicating already-captured failures (idempotent reflux)', async () => {
    const c = await seedActiveAnswering('first failure', 'first query')
    await reportUsage(db, c, 'refuted', { byRole: 'agent:x', query: 'first query' })

    expect((await refluxFailures(db)).pooled).toBe(1)
    expect((await refluxFailures(db)).pooled).toBe(0) // second run captures nothing new
    expect(await getRegressionPool(db)).toHaveLength(1) // no duplicate row

    // a genuinely new failure is captured on the next run, and only that one
    const c2 = await seedActiveAnswering('second failure', 'second query')
    await reportUsage(db, c2, 'refuted', { byRole: 'agent:x', query: 'second query' })
    expect((await refluxFailures(db)).pooled).toBe(1)
    expect(await getRegressionPool(db)).toHaveLength(2)
  })

  it('the L5 candidate queue is idempotent across reflux runs too', async () => {
    const c = await seedActiveAnswering('flagged claim', 'idempotent gap query')
    await reportUsage(db, c, 'refuted', {
      byRole: 'human:judge',
      query: 'idempotent gap query',
      kbLacksAnswer: true,
    })
    expect((await refluxFailures(db)).l5Queued).toBe(1)
    expect((await refluxFailures(db)).l5Queued).toBe(0)
    expect(await getL5Candidates(db)).toHaveLength(1)
  })

  it('replayRegressionPool aggregates pass/fail/unreplayable; events without a query are unreplayable', async () => {
    // (1) a still-reproducing failure (fail)
    const q1 = 'reproducing failure query'
    const c1 = await seedActiveAnswering('still-served wrong answer', q1)
    await reportUsage(db, c1, 'refuted', { byRole: 'agent:x', query: q1 })
    // (2) a fixed failure (pass): report, then quarantine
    const q2 = 'fixed failure query'
    const c2 = await seedActiveAnswering('once-wrong now-gone answer', q2)
    await reportUsage(db, c2, 'corrected', { byRole: 'agent:x', query: q2 })
    // (3) a legacy failure with NO query (unreplayable)
    const c3 = await seedActiveAnswering('legacy failure', 'legacy query')
    await reportUsage(db, c3, 'refuted', { byRole: 'agent:x' }) // query omitted

    await refluxFailures(db)
    await db.update(claim).set({ status: 'quarantined' }).where(eq(claim.id, c2)) // fix #2

    const report = await replayRegressionPool(db, embedder)
    expect(report.total).toBe(3)
    expect(report.failed).toBe(1) // #1 still recalled
    expect(report.passed).toBe(1) // #2 quarantined
    expect(report.unreplayable).toBe(1) // #3 has no query
  })

  it('empty inputs degrade cleanly: reflux over no failures returns zeros; replay over an empty pool returns an all-zero report', async () => {
    expect(await refluxFailures(db)).toEqual({ pooled: 0, l5Queued: 0 })
    expect(await replayRegressionPool(db, embedder)).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      unreplayable: 0,
      results: [],
    })
  })

  it('a failure reported without a confSnapshot pools with null predictedConfidence/calibrationVersion (legacy/optional path)', async () => {
    const c = await seedActiveAnswering('snapshotless failure', 'snapshotless query')
    await reportUsage(db, c, 'refuted', { byRole: 'agent:x', query: 'snapshotless query' }) // no confidenceAtRecall / calibrationVersion

    await refluxFailures(db)
    const [item] = await getRegressionPool(db)
    expect(item!.predictedConfidence).toBeNull()
    expect(item!.calibrationVersion).toBeNull()
    expect(item!.query).toBe('snapshotless query') // still replayable
  })

  it('keyed by claim+query/task is NOT a dedup key: two independent failures of the same claim+query pool as two rows (production distribution, frequency = signal)', async () => {
    const q = 'recurring failure query'
    const c = await seedActiveAnswering('recurring failing claim', q)
    await reportUsage(db, c, 'refuted', { byRole: 'agent:x', query: q }) // first production failure
    await reportUsage(db, c, 'refuted', { byRole: 'agent:x', query: q }) // a second, independent failure

    const { pooled } = await refluxFailures(db)
    expect(pooled).toBe(2) // two distinct usage_truth events ⇒ two pool rows (dedup is per source_event_id only)
    const items = await getRegressionPool(db)
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.claimId === c && i.query === q)).toBe(true)
    expect(new Set(items.map((i) => i.sourceEventId)).size).toBe(2) // each anchored to its own event
  })

  it('replay pass is a NARROW criterion: quarantining the failing claim yields pass even though the KB still lacks the right answer (deliberate, not a bug)', async () => {
    const q = 'narrow-pass-semantics query'
    const c = await seedActiveAnswering('the wrong claim that gets quarantined', q)
    await reportUsage(db, c, 'refuted', { byRole: 'agent:x', query: q })
    await refluxFailures(db)
    const [item] = await getRegressionPool(db)

    // Quarantine the bad claim. The KB now has NO answer for q (recall returns [] → an L5-style gap),
    // yet the regression replay reports pass: its only question is "does the SPECIFIC bad claim still
    // surface?" — and it no longer does. The orthogonal "KB still lacks the right answer" is tracked
    // elsewhere (L5 candidate queue + recall's gap signal), deliberately NOT folded into this verdict.
    await db.update(claim).set({ status: 'quarantined' }).where(eq(claim.id, c))
    const verdict = await replayRegressionItem(db, embedder, item!)
    expect(verdict.stillRecalled).toBe(false)
    expect(verdict.pass).toBe(true) // narrow pass: the failing claim is gone, regardless of whether a correct answer exists
    const stillEmpty = await recallClaims(db, embedder, q)
    expect(stillEmpty).toHaveLength(0) // …and indeed the KB now answers nothing for q
  })

  it('a corrected failure whose claim is still recalled replays to fail (symmetry with refuted)', async () => {
    const q = 'corrected-still-live query'
    const c = await seedActiveAnswering('a corrected-but-still-served claim', q)
    await reportUsage(db, c, 'corrected', { byRole: 'agent:x', query: q })
    await refluxFailures(db)
    const [item] = await getRegressionPool(db)
    expect(item!.outcome).toBe('corrected')
    const verdict = await replayRegressionItem(db, embedder, item!)
    expect(verdict.stillRecalled).toBe(true)
    expect(verdict.pass).toBe(false) // the claim is still live ⇒ the failure still reproduces
  })

  it('isHumanRole: only a human-prefixed role counts as a confirmation', () => {
    expect(isHumanRole('human:judge')).toBe(true)
    expect(isHumanRole('human')).toBe(true)
    expect(isHumanRole('agent:x')).toBe(false)
    expect(isHumanRole('consumer:unknown')).toBe(false)
    expect(isHumanRole('verifier')).toBe(false)
    expect(isHumanRole('humanoid-agent')).toBe(false) // tightened: not every 'human…' prefix is a human
  })
})
