import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  makeFakeEmbedder,
  makeFakeEntailmentJudge,
  recallClaims,
  schema,
  type DB,
  type EntailmentJudge,
  type EntailmentQuery,
  type EntailmentVerdict,
} from '@engram/core'

import { runVerifier, verifyEnqueued } from '../verifier.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'engram-core',
  'drizzle',
)

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder = makeFakeEmbedder()
const MS_PER_DAY = 86_400_000
const VERIFIER_ROLE = 'agent:verifier'
// 内核未导出 DEFAULT_WEIGHTS/CALIBRATION_IDENTITY；测试内联起步基线（与 A.3 一致）。
const WEIGHTS = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}

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

/** 一个一律按 verdict 判定、抛错可控、记调用次数的 fake EntailmentJudge。 */
function judgeOf(verdict: EntailmentVerdict | 'throw') {
  if (verdict === 'throw') {
    let calls = 0
    const j: EntailmentJudge & { callCount: () => number } = {
      version: 'fake:throw',
      async judge(_q: EntailmentQuery): Promise<EntailmentVerdict> {
        calls += 1
        throw new Error('entailment judge boom')
      },
      callCount: () => calls,
    }
    return j
  }
  return makeFakeEntailmentJudge({ verdictOf: () => verdict })
}

type Factors = {
  authority: number
  humanReview: number
  entailment: number
  indepSupport: number
  usageCorrect: number
  ageDays: number
  activeContradicts: number
  staleDecay: number
  conflictDecay: number
}

/** 直接 seed source + claim(+exact 出处)，精确控制 status / createdBy / asOf / 因子 / 是否可召回。 */
async function mkClaim(opts: {
  status: schema.ClaimStatus
  createdBy?: string
  claimText?: string
  asOf?: Date
  authorityScore?: number
  factors?: Partial<Factors>
  recallable?: boolean
}): Promise<{ claimId: string; sourceId: string }> {
  const claimText = opts.claimText ?? `claim-${randomUUID()}`
  const { sourceId } = await addSource(db, {
    content: `src for ${claimText}`,
    contentHash: randomUUID(),
    kind: 'structured_spec', // half-life 730d
    authorityScore: opts.authorityScore ?? 0.9,
  })
  const factors: Factors = {
    authority: opts.authorityScore ?? 0.9,
    humanReview: 0,
    entailment: 0.5,
    indepSupport: 0,
    usageCorrect: 0,
    ageDays: 0,
    activeContradicts: 0,
    staleDecay: 1,
    conflictDecay: 1,
    ...opts.factors,
  }
  const claimId = randomUUID()
  const recallable = opts.recallable ?? false
  await db.insert(schema.claim).values({
    id: claimId,
    claimText,
    status: opts.status,
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: { factors, weights: WEIGHTS, calibrationVersion: 'identity' },
    lineageId: randomUUID(),
    asOf: opts.asOf ?? new Date(),
    createdBy: opts.createdBy ?? 'agent:distiller',
    embedding: recallable ? await embedder.embed(claimText) : null,
    embeddingVersion: recallable ? embedder.version : null,
  })
  await db.insert(schema.claimProvenance).values({
    id: randomUUID(),
    claimId,
    sourceId,
    locator: 'L1',
    relevance: 'exact',
  })
  return { claimId, sourceId }
}

async function statusOf(claimId: string): Promise<schema.ClaimStatus> {
  const [row] = await db
    .select({ s: schema.claim.status })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  return row!.s
}
async function patrolRows(claimId: string) {
  return db
    .select()
    .from(schema.claimVerification)
    .where(
      and(
        eq(schema.claimVerification.kind, 'patrol'),
        eq(schema.claimVerification.claimId, claimId),
      ),
    )
}

describe('S17 Verifier worker (D3 patrol: 函数/统计 + 点状一次 LLM) — A.4/A.6/A.7', () => {
  it('hallucination: an unentailed active claim moves active→flagged with a {entailment:fail} patrol (by_role=verifier), and drops out of recall; exactly one LLM call', async () => {
    const { claimId } = await mkClaim({
      status: 'active',
      recallable: true,
      claimText: 'sku-h spec 7',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    const res = await runVerifier({ db, judge })

    expect(res.patrolled).toBe(1)
    expect(res.transitions).toBe(1)
    expect(await statusOf(claimId)).toBe('flagged') // active→flagged (blue tighten)
    expect(judge.callCount()).toBe(1) // 点状一次 LLM/claim

    const rows = await patrolRows(claimId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.byRole).toBe(VERIFIER_ROLE) // judge≠athlete: verifier role, not the athlete created_by
    expect((rows[0]!.verdict as { entailment: string }).entailment).toBe('fail')

    expect(await recallClaims(db, embedder, 'sku-h spec 7')).toHaveLength(0) // flagged ⇒ not recallable
  })

  it('staleness: a fresh-entailment but past-half-life claim is flagged by the staleness patrol', async () => {
    const old = new Date(Date.now() - 800 * MS_PER_DAY) // > structured_spec half-life (730d)
    const { claimId } = await mkClaim({ status: 'active', asOf: old })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' }) // not a hallucination — only stale
    const res = await runVerifier({ db, judge })

    expect(res.outcomes[0]!.stale).toBe(true)
    expect(await statusOf(claimId)).toBe('flagged')
  })

  it('draft→active: a passing real entailment + live-f2 conf≥0.5 auto-promotes a draft and makes it recallable', async () => {
    // stored base(entail0.5)=0.4875<0.5; with patrol pass live-f2=1 → 0.5625≥0.5 (see transition gate)
    const { claimId } = await mkClaim({
      status: 'draft',
      recallable: true,
      claimText: 'sku-p spec 9',
      factors: { authority: 1, indepSupport: 0.75, entailment: 0.5 },
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
    const res = await runVerifier({ db, judge })

    expect(res.outcomes[0]!.entailment).toBe('pass')
    expect(await statusOf(claimId)).toBe('active') // promoted via real entailment producer (closes S13 stub)
    const hits = await recallClaims(db, embedder, 'sku-p spec 9')
    expect(hits.map((h) => h.claim.id)).toContain(claimId) // recallable after promotion
    expect(hits.find((h) => h.claim.id === claimId)!.confidence.factors.entailment).toBe(1)
  })

  it('judge≠athlete: the Verifier never patrols/endorses a claim it itself authored (skipped, no verdict, status unchanged, LLM never called)', async () => {
    const { claimId } = await mkClaim({ status: 'active', createdBy: VERIFIER_ROLE })
    const judge = judgeOf('throw') // would throw if ever called — proves it isn't
    const res = await runVerifier({ db, judge })

    expect(res.skipped).toBe(1)
    expect(res.patrolled).toBe(0)
    expect(judge.callCount()).toBe(0)
    expect(await patrolRows(claimId)).toHaveLength(0) // no self-written patrol row
    expect(await statusOf(claimId)).toBe('active') // untouched
  })

  it('flagged→quarantined: a still-unsupported flagged claim is tightened further (fail patrol)', async () => {
    const { claimId } = await mkClaim({ status: 'flagged' })
    const res = await runVerifier({
      db,
      judge: makeFakeEntailmentJudge({ verdictOf: () => 'fail' }),
    })
    expect(res.transitions).toBe(1)
    expect(await statusOf(claimId)).toBe('quarantined')
  })

  it('failure degrades safely: a claim whose judge throws is skipped (no crash, no transition, no verdict) and can be retried next round', async () => {
    const { claimId } = await mkClaim({ status: 'active' })
    const judge = judgeOf('throw')
    const res = await runVerifier({ db, judge }) // must not reject
    expect(res.skipped).toBe(1)
    expect(res.patrolled).toBe(0)
    expect(res.transitions).toBe(0)
    expect(judge.callCount()).toBe(1) // it was called and threw
    expect(await patrolRows(claimId)).toHaveLength(0) // nothing written on failure
    expect(await statusOf(claimId)).toBe('active') // unchanged → next cron retries
  })

  it('one point-LLM call per patrolled claim; superseded/quarantined are never patrolled', async () => {
    await mkClaim({ status: 'active', claimText: 'a' })
    await mkClaim({ status: 'draft', claimText: 'b' })
    await mkClaim({ status: 'flagged', claimText: 'c' })
    await mkClaim({ status: 'quarantined', claimText: 'd' }) // 仅人能放松 → 不巡
    await mkClaim({ status: 'superseded', claimText: 'e' }) // 终态 → 不巡
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
    const res = await runVerifier({ db, judge })
    expect(res.patrolled).toBe(3) // only draft/active/flagged
    expect(judge.callCount()).toBe(3) // exactly one call per patrolled claim
  })

  it('enqueue trigger: verifyEnqueued patrols only the given claim ids', async () => {
    const target = await mkClaim({ status: 'active', claimText: 'enq-target' })
    await mkClaim({ status: 'active', claimText: 'other' }) // must be left alone
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    const res = await verifyEnqueued({ db, judge }, [target.claimId])
    expect(res.patrolled).toBe(1)
    expect(judge.callCount()).toBe(1)
    expect(await statusOf(target.claimId)).toBe('flagged')
  })

  // S20 routed follow-up: S17 deferred the conflict signal's peer id (conflictsWith). The Verifier now populates it
  // on a not_co_true verdict, finding the contradicting peer via the contradicts edge — handing the pairwise
  // conflict to the Arbiter (the owner of pairwise resolution).
  it('not_co_true populates the patrol verdict with the contradicting peer id (conflictsWith) — the routed conflict signal for the Arbiter', async () => {
    const target = await mkClaim({ status: 'active', claimText: 'k p A' })
    const peer = await mkClaim({ status: 'active', claimText: 'k p B' })
    await db.insert(schema.relation).values({
      id: randomUUID(),
      fromClaim: target.claimId,
      toClaim: peer.claimId,
      type: 'contradicts',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'not_co_true' })
    // patrol only the target so we assert its verdict precisely (peer would also be patrolled in a full round).
    const res = await verifyEnqueued({ db, judge }, [target.claimId])
    expect(res.patrolled).toBe(1)

    const rows = await patrolRows(target.claimId)
    expect(rows).toHaveLength(1)
    const verdict = rows[0]!.verdict as { entailment: string; conflictsWith?: string }
    expect(verdict.entailment).toBe('not_co_true')
    expect(verdict.conflictsWith).toBe(peer.claimId) // the deferred-from-S17 peer id is now filled
    // not_co_true is also a tighten signal: active→flagged (blue), unchanged red-line behavior.
    expect(await statusOf(target.claimId)).toBe('flagged')
  })

  it('a non-conflict verdict (fail) leaves conflictsWith unset even when a contradicts edge exists (only not_co_true routes the pairwise signal)', async () => {
    const target = await mkClaim({ status: 'active', claimText: 'k p A' })
    const peer = await mkClaim({ status: 'active', claimText: 'k p B' })
    await db.insert(schema.relation).values({
      id: randomUUID(),
      fromClaim: target.claimId,
      toClaim: peer.claimId,
      type: 'contradicts',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    await verifyEnqueued({ db, judge }, [target.claimId])
    const rows = await patrolRows(target.claimId)
    const verdict = rows[0]!.verdict as { entailment: string; conflictsWith?: string }
    expect(verdict.entailment).toBe('fail')
    expect(verdict.conflictsWith).toBeUndefined()
  })
})
