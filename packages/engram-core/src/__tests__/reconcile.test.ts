import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { claim } from '../db/schema.js'
import { makeFakeEntailmentJudge } from '../verifier/fake-entailment-judge.js'
import type {
  EntailmentJudge,
  EntailmentQuery,
  EntailmentVerdict,
} from '../verifier/entailment-judge.js'
import {
  hasNonIndependentPair,
  isReconcileCandidate,
  objectSubsetViaEntailment,
  reconcilePair,
  RECONCILE_PAIR_SIMILARITY,
} from '../same-fact/reconcile.js'
import type { ClaimShape } from '../same-fact/same-fact.js'
import type { SourceIndep } from '../same-fact/independent.js'
import {
  getReconcileEscalations,
  recordReconcileEscalation,
  RECONCILE_POISON_REASON,
} from '../spi/reconcile-signal.js'

const shape = (
  subject: string | null,
  predicate: string | null,
  object: string | null,
  claimText = 't',
): ClaimShape => ({ subject, predicate, object, claimText })

const src = (over: Partial<SourceIndep>): SourceIndep => ({
  id: over.id ?? randomUUID(),
  contentHash: over.contentHash ?? randomUUID(),
  kind: over.kind ?? 'formal_document',
  derivedFromSourceId: over.derivedFromSourceId ?? null,
})

// ---------- pure functions (no DB) ----------

describe('S18 Reconciler pure functions (A.6 near-dup-poison)', () => {
  it('isReconcileCandidate: same subject + non-equivalent object + similarity≥0.75 qualifies', () => {
    const a = shape('skuA', 'capacity', 'at least 4000')
    const b = shape('skuA', 'capacity', 'at least 8000')
    expect(isReconcileCandidate(a, b, 0.9)).toBe(true)
  })

  it('isReconcileCandidate: rejects below-threshold similarity', () => {
    const a = shape('skuA', 'capacity', '4000')
    const b = shape('skuA', 'capacity', '8000')
    expect(isReconcileCandidate(a, b, RECONCILE_PAIR_SIMILARITY - 0.01)).toBe(false)
  })

  it('isReconcileCandidate: rejects different subjects (not the same fact lineage)', () => {
    expect(isReconcileCandidate(shape('skuA', 'p', '4000'), shape('skuB', 'p', '8000'), 0.99)).toBe(
      false,
    )
  })

  it('isReconcileCandidate: rejects equivalent objects (that is a same-fact merge, not poison)', () => {
    // 1m≡100cm: equivalent ⇒ commit 的 same 合并管，不是 object 被改小/反
    expect(isReconcileCandidate(shape('s', 'len', '1m'), shape('s', 'len', '100cm'), 0.99)).toBe(
      false,
    )
  })

  it('isReconcileCandidate: rejects free-text claims without structured object', () => {
    expect(isReconcileCandidate(shape('s', 'p', null), shape('s', 'p', '8000'), 0.99)).toBe(false)
    expect(isReconcileCandidate(shape(null, null, null, 'x'), shape('s', 'p', '8000'), 0.99)).toBe(
      false,
    )
  })

  it('objectSubsetViaEntailment: pass⇒refines, fail⇒poison, not_co_true⇒poison; exactly one LLM call', async () => {
    const a = shape('skuA', 'capacity', 'at least 8000', 'skuA capacity at least 8000')
    const b = shape('skuA', 'capacity', 'at least 4000', 'skuA capacity at least 4000')

    const jPass = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
    expect(await objectSubsetViaEntailment(jPass, a, b)).toBe('refines')
    expect(jPass.callCount()).toBe(1)

    const jFail = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    expect(await objectSubsetViaEntailment(jFail, a, b)).toBe('poison')
    expect(jFail.callCount()).toBe(1)

    const jNct = makeFakeEntailmentJudge({ verdictOf: () => 'not_co_true' })
    expect(await objectSubsetViaEntailment(jNct, a, b)).toBe('poison')
    expect(jNct.callCount()).toBe(1)
  })

  it('objectSubsetViaEntailment: feeds the peer claim text as the (exact) evidence source', async () => {
    let seen: EntailmentQuery | null = null
    const judge: EntailmentJudge = {
      version: 'spy',
      async judge(q: EntailmentQuery): Promise<EntailmentVerdict> {
        seen = q
        return 'pass'
      },
    }
    const a = shape('skuA', 'capacity', '8000', 'A says 8000')
    const b = shape('skuA', 'capacity', '4000', 'B says 4000')
    await objectSubsetViaEntailment(judge, a, b)
    expect(seen).not.toBeNull()
    expect(seen!.claimText).toBe('A says 8000') // A is the proposition under test
    expect(seen!.evidence).toHaveLength(1)
    expect(seen!.evidence[0]!.sourceContent).toBe('B says 4000') // B is the (wider) anchor source
    expect(seen!.evidence[0]!.relevance).toBe('exact') // NC-exact 口径 → 反向可被判出
  })

  it('reconcilePair: unqualified pair (low similarity) never calls the judge ⇒ inconclusive', async () => {
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    const v = await reconcilePair(judge, shape('s', 'p', '4'), shape('s', 'p', '8'), 0.5)
    expect(v).toBe('inconclusive')
    expect(judge.callCount()).toBe(0) // 不够格不烧 LLM
  })

  it('reconcilePair: a throwing judge degrades to inconclusive (conservative: keep both)', async () => {
    const judge: EntailmentJudge = {
      version: 'boom',
      async judge(): Promise<EntailmentVerdict> {
        throw new Error('judge boom')
      },
    }
    const v = await reconcilePair(judge, shape('s', 'p', '8000'), shape('s', 'p', '4000'), 0.95)
    expect(v).toBe('inconclusive') // 失败 → 不合并、不判 refines、不误 flag
  })

  it('hasNonIndependentPair: same contentHash (same-source copy) is non-independent', () => {
    const h = 'shared-hash'
    expect(hasNonIndependentPair([src({ contentHash: h }), src({ contentHash: h })])).toBe(true)
  })

  it('hasNonIndependentPair: direct derived_from lineage is non-independent', () => {
    const root = src({})
    const derived = src({ derivedFromSourceId: root.id })
    expect(hasNonIndependentPair([root, derived])).toBe(true)
  })

  it('hasNonIndependentPair: genuinely distinct sources are independent', () => {
    expect(hasNonIndependentPair([src({}), src({}), src({})])).toBe(false)
  })

  it('hasNonIndependentPair: empty / singleton has no non-independent pair', () => {
    expect(hasNonIndependentPair([])).toBe(false)
    expect(hasNonIndependentPair([src({})])).toBe(false)
  })
})

// ---------- escalation signal SPI (DB-backed) ----------

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
  await pool.query('TRUNCATE source, claim, claim_provenance, relation, claim_verification CASCADE')
})

async function mkBareClaim(): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: `c-${id}`,
    status: 'active',
    confidence: 0.5,
    confidenceRaw: 0.5,
    confidenceFactors: { factors: {}, weights: DEFAULT_WEIGHTS, calibrationVersion: 'identity' },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'agent:distiller',
  })
  return id
}

describe('S18 Reconciler escalation signal (records the peer claim id — closes S17 gap) — A.6/A.7', () => {
  it('records a patrol verdict carrying conflictsWith=peer id, reason=near_dup_poison, by_role=reconciler', async () => {
    const a = await mkBareClaim() // suspected poison
    const b = await mkBareClaim() // the anchor it shrank/reversed
    const { verificationId } = await recordReconcileEscalation(db, {
      claimId: a,
      conflictsWith: b,
      byRole: 'agent:reconciler',
      judgeVersion: 'fake:entailment-v1',
    })
    expect(verificationId).toBeTruthy()

    const escalations = await getReconcileEscalations(db, a)
    expect(escalations).toHaveLength(1)
    const e = escalations[0]!
    expect(e.claimId).toBe(a)
    expect(e.conflictsWith).toBe(b) // peer id recorded — the relational conflict signal S17 left empty
    expect(e.byRole).toBe('agent:reconciler') // judge≠athlete: reconciler's own role
  })

  it('getReconcileEscalations: only returns rows tagged near_dup_poison with a non-empty conflictsWith', async () => {
    const a = await mkBareClaim()
    const b = await mkBareClaim()
    await recordReconcileEscalation(db, {
      claimId: a,
      conflictsWith: b,
      byRole: 'agent:reconciler',
    })
    // a plain patrol row (no reconcile reason) must NOT be surfaced as an escalation
    const { writePatrolVerdict } = await import('../verifier/patrol-verdict.js')
    await writePatrolVerdict(db, {
      claimId: a,
      byRole: 'agent:verifier',
      verdict: { entailment: 'fail', reason: 'flagged' },
    })
    const escalations = await getReconcileEscalations(db, a)
    expect(escalations).toHaveLength(1)
    expect(escalations[0]!.conflictsWith).toBe(b)
    expect(RECONCILE_POISON_REASON).toBe('near_dup_poison')
  })
})
