import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  getEditorConflictQueue,
  getRefusedRulings,
  getResolvedConflicts,
  makeFakeEmbedder,
  recallClaims,
  schema,
  type DB,
} from '@engram/core'
import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { arbitrateConflicts, runArbiter } from '../arbiter.js'
import type { AgentRuntime } from '../runtime/port.js'
import { makeHarnessPiRuntime } from '../runtime/harness-pi.js'

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
const ARBITER_ROLE = 'agent:arbiter'

const WEIGHTS = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}
// HIGH profile clears the recall floor (0.4) even under one active contradiction (conflictDecay 0.667).
const HIGH = {
  authority: 0.8,
  humanReview: 0.8,
  entailment: 0.8,
  indepSupport: 0.8,
  usageCorrect: 0.8,
}

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
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

/** Seed one ACTIVE, recallable S/P/O claim (HIGH profile) + one provenance from a chosen-authority source. */
async function seedClaim(opts: {
  query: string
  object: string
  asOf: Date
  authority: number
  /** 出处相关度档（默认 exact，保持既有用例语义不变）。S21 用 supporting 喂弱反向证据。 */
  relevance?: schema.ProvRelevance
}): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: `src-${randomUUID()}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: opts.authority,
  })
  const id = randomUUID()
  await db.insert(schema.claim).values({
    id,
    claimText: opts.query,
    subject: 'k',
    predicate: 'p',
    object: opts.object,
    status: 'active',
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: { ...HIGH, ageDays: 0, activeContradicts: 0, staleDecay: 1, conflictDecay: 1 },
      weights: WEIGHTS,
      calibrationVersion: 'identity',
    },
    lineageId: randomUUID(),
    asOf: opts.asOf,
    createdBy: 'agent:distiller',
    embedding: await embedder.embed(opts.query),
    embeddingVersion: embedder.version,
  })
  await db.insert(schema.claimProvenance).values({
    id: randomUUID(),
    claimId: id,
    sourceId,
    locator: 'L1',
    relevance: opts.relevance ?? 'exact',
  })
  return id
}

/** Seed a contradicting active pair (same query text → recall returns both) + a contradicts edge. */
async function seedPair(opts: {
  query: string
  aAsOf: Date
  bAsOf: Date
  aAuthority: number
  bAuthority: number
  /** 出处相关度档（默认两侧 exact）。S21 用于让胜者只有弱反向证据。 */
  aRelevance?: schema.ProvRelevance
  bRelevance?: schema.ProvRelevance
}): Promise<{ a: string; b: string }> {
  const a = await seedClaim({
    query: opts.query,
    object: 'A',
    asOf: opts.aAsOf,
    authority: opts.aAuthority,
    ...(opts.aRelevance !== undefined ? { relevance: opts.aRelevance } : {}),
  })
  const b = await seedClaim({
    query: opts.query,
    object: 'B',
    asOf: opts.bAsOf,
    authority: opts.bAuthority,
    ...(opts.bRelevance !== undefined ? { relevance: opts.bRelevance } : {}),
  })
  await db
    .insert(schema.relation)
    .values({ id: randomUUID(), fromClaim: a, toClaim: b, type: 'contradicts' })
  return { a, b }
}

async function statusOf(id: string): Promise<schema.ClaimStatus> {
  const [row] = await db
    .select({ s: schema.claim.status })
    .from(schema.claim)
    .where(eq(schema.claim.id, id))
  return row!.s
}

let seq = 0
function adjudicateTurn(a: string, b: string): FakeAssistantResponse {
  return {
    content: [
      {
        type: 'toolCall',
        id: `tc${++seq}`,
        name: 'adjudicate_conflict',
        arguments: { claimA: a, claimB: b },
      },
    ],
    stopReason: 'toolUse',
  }
}
const finishTurn: () => FakeAssistantResponse = () => ({
  content: [{ type: 'toolCall', id: `tc${++seq}`, name: 'finish', arguments: {} }],
  stopReason: 'toolUse',
})
const stopTurn: FakeAssistantResponse = {
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'stop',
}
function runtimeOf(script: FakeAssistantResponse[]): AgentRuntime {
  return makeHarnessPiRuntime(createFakeModel(script))
}
// A runtime that, if its loop is ever entered, hard-fails — proves a code path short-circuits before the loop.
const throwingRuntime: AgentRuntime = {
  run() {
    throw new Error('arbiter loop must not run')
  },
}

describe('S20 Arbiter worker (bounded loop on harness-pi) — A.5 deterministic conflict convergence', () => {
  it('unique winner (③ recency): the strictly-newer claim is self-adjudicated trusted — contradicts edge + believed marker, no escalation, no status change', async () => {
    const { a, b } = await seedPair({
      query: 'k p A',
      aAsOf: new Date('2025-06-01T00:00:00.000Z'), // newer
      bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      aAuthority: 0.5,
      bAuthority: 0.5,
    })
    const res = await arbitrateConflicts(
      { db, runtime: runtimeOf([adjudicateTurn(a, b), finishTurn(), stopTurn]) },
      [[a, b]],
    )

    expect(res.loopReason).toBe('done')
    expect(res.resolved).toBe(1)
    expect(res.escalated).toBe(0)
    const outcome = res.outcomes.find((o) => o.outcome === 'resolved')!
    expect(outcome.winnerId).toBe(a) // newer wins at ③ recency
    expect(outcome.rung).toBe('recency')

    // believed/trust marker recorded; nothing in the editor queue
    const resolved = await getResolvedConflicts(db)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.payload.winnerId).toBe(a)
    expect(resolved[0]!.payload.byRole).toBe(ARBITER_ROLE)
    expect(await getEditorConflictQueue(db)).toHaveLength(0)

    // RED LINE #2: Arbiter never relaxes/quarantines/revives — both stay active
    expect(await statusOf(a)).toBe('active')
    expect(await statusOf(b)).toBe('active')

    // recall still dual-returns BOTH with the contradicts pointer + each side's as_of (no auto-pick at recall)
    const hits = await recallClaims(db, embedder, 'k p A')
    const byId = new Map(hits.map((h) => [h.claim.id, h]))
    expect(byId.get(a)!.contradicts).toContain(b)
    expect(byId.get(b)!.contradicts).toContain(a)
    expect(byId.get(a)!.claim.asOf.getTime()).toBe(new Date('2025-06-01T00:00:00.000Z').getTime())
  })

  it('tie (equal recency AND authority AND indepSupport, no supersede): escalates to the editor-in-chief queue, NOT auto-picked; both stay recallable', async () => {
    const t = new Date('2025-01-01T00:00:00.000Z')
    const { a, b } = await seedPair({
      query: 'k p A',
      aAsOf: t,
      bAsOf: t,
      aAuthority: 0.5,
      bAuthority: 0.5,
    })
    const res = await arbitrateConflicts(
      { db, runtime: runtimeOf([adjudicateTurn(a, b), finishTurn(), stopTurn]) },
      [[a, b]],
    )

    expect(res.resolved).toBe(0)
    expect(res.escalated).toBe(1)
    expect(await getResolvedConflicts(db)).toHaveLength(0)
    const queue = await getEditorConflictQueue(db)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.payload.rung).toBe('human') // awaits the human's ① ruling
    expect(new Set([queue[0]!.payload.claimA, queue[0]!.payload.claimB])).toEqual(new Set([a, b]))

    // not auto-picked: both still active and both still recallable
    expect(await statusOf(a)).toBe('active')
    expect(await statusOf(b)).toBe('active')
    expect((await recallClaims(db, embedder, 'k p A')).map((h) => h.claim.id).sort()).toEqual(
      [a, b].sort(),
    )
  })

  it('replayable: same conflict pair + same library state ⇒ same winner (deterministic, independent of who drives the loop)', async () => {
    const seed = () =>
      seedPair({
        query: 'k p A',
        aAsOf: new Date('2025-01-01T00:00:00.000Z'),
        bAsOf: new Date('2025-01-01T00:00:00.000Z'),
        aAuthority: 0.9, // a wins at ④ authority
        bAuthority: 0.2,
      })

    const first = await seed()
    const r1 = await arbitrateConflicts(
      { db, runtime: runtimeOf([adjudicateTurn(first.a, first.b), finishTurn(), stopTurn]) },
      [[first.a, first.b]],
    )
    const w1 = r1.outcomes.find((o) => o.outcome === 'resolved')!

    // wipe + reseed an identical-shape conflict and re-run with the OPPOSITE argument order in the loop.
    await pool.query('TRUNCATE source, claim, claim_provenance, relation, metrics_events CASCADE')
    const second = await seed()
    const r2 = await arbitrateConflicts(
      { db, runtime: runtimeOf([adjudicateTurn(second.b, second.a), finishTurn(), stopTurn]) },
      [[second.b, second.a]],
    )
    const w2 = r2.outcomes.find((o) => o.outcome === 'resolved')!

    // identical winning side (the higher-authority object 'A') + identical rung, regardless of argument order.
    expect(w1.rung).toBe('authority')
    expect(w2.rung).toBe('authority')
    expect(w1.winnerId).toBe(first.a)
    expect(w2.winnerId).toBe(second.a)
  })

  it('bounded loop: budget (maxTurns) exhaustion escalates the un-adjudicated pair to the human — never infinite retry', async () => {
    const { a, b } = await seedPair({
      query: 'k p A',
      aAsOf: new Date('2025-06-01T00:00:00.000Z'),
      bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      aAuthority: 0.5,
      bAuthority: 0.5,
    })
    // a loop that keeps calling adjudicate on a bogus (non-pending) pair and NEVER finishes; with maxTurns=2 the
    // loop is cut off → reason max_turns, while the real pair [a,b] is left un-adjudicated (still pending).
    const bogus1 = randomUUID()
    const bogus2 = randomUUID()
    const stallScript: FakeAssistantResponse[] = [
      adjudicateTurn(bogus1, bogus2),
      adjudicateTurn(bogus1, bogus2),
      adjudicateTurn(bogus1, bogus2),
      adjudicateTurn(bogus1, bogus2),
    ]
    const res = await arbitrateConflicts({ db, runtime: runtimeOf(stallScript) }, [[a, b]], {
      maxTurns: 2,
    })

    expect(res.loopReason).toBe('max_turns') // budget cut off
    // degrades to the human queue (not auto-resolved): bounded → human, no infinite retry
    expect(res.resolved).toBe(0)
    expect(res.escalated).toBe(1)
    expect(await getResolvedConflicts(db)).toHaveLength(0)
    const queue = await getEditorConflictQueue(db)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.payload.reason).toMatch(/budget exhaustion|un-adjudicated/)
    expect(await statusOf(a)).toBe('active') // status untouched
    expect(await statusOf(b)).toBe('active')
  })

  it('supersede (②) outranks recency/authority below it: the superseding head wins even when older/weaker', async () => {
    // old head: newer-ish + stronger authority; new head supersedes it but is older + weaker. ② still wins.
    const old = await seedClaim({
      query: 'k p A',
      object: 'A',
      asOf: new Date('2025-06-01T00:00:00.000Z'),
      authority: 0.9,
    })
    const neo = await seedClaim({
      query: 'k p A',
      object: 'B',
      asOf: new Date('2025-01-01T00:00:00.000Z'),
      authority: 0.2,
    })
    // a supersedes edge from neo → old, plus the contradicts edge.
    await db
      .insert(schema.relation)
      .values({ id: randomUUID(), fromClaim: neo, toClaim: old, type: 'supersedes' })
    await db
      .insert(schema.relation)
      .values({ id: randomUUID(), fromClaim: old, toClaim: neo, type: 'contradicts' })

    const res = await arbitrateConflicts(
      { db, runtime: runtimeOf([adjudicateTurn(old, neo), finishTurn(), stopTurn]) },
      [[old, neo]],
    )
    const w = res.outcomes.find((o) => o.outcome === 'resolved')!
    expect(w.rung).toBe('supersede')
    expect(w.winnerId).toBe(neo) // the superseding head wins despite being older + weaker
  })

  it('a non-active conflict (one side flagged) is skipped — only active↔active is a live conflict needing machine adjudication', async () => {
    const { a, b } = await seedPair({
      query: 'k p A',
      aAsOf: new Date('2025-06-01T00:00:00.000Z'),
      bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      aAuthority: 0.5,
      bAuthority: 0.5,
    })
    await db.update(schema.claim).set({ status: 'flagged' }).where(eq(schema.claim.id, b))
    // throwingRuntime proves the loop is NOT entered (no active↔active pair to adjudicate).
    const res = await runArbiter({ db, runtime: throwingRuntime }, { pairs: [[a, b]] })
    expect(res.resolved).toBe(0)
    expect(res.escalated).toBe(0)
    expect(res.skipped).toBe(0)
    expect(res.outcomes).toHaveLength(0)
    expect(await getResolvedConflicts(db)).toHaveLength(0)
    expect(await getEditorConflictQueue(db)).toHaveLength(0)
  })

  it('cron mode (no pairs given): scans all active↔active contradicts edges and converges them', async () => {
    const { a, b } = await seedPair({
      query: 'k p A',
      aAsOf: new Date('2025-06-01T00:00:00.000Z'),
      bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      aAuthority: 0.5,
      bAuthority: 0.5,
    })
    // no `pairs` → selectPairs scans the contradicts edges itself
    const res = await runArbiter(
      { db, runtime: runtimeOf([adjudicateTurn(a, b), finishTurn(), stopTurn]) },
      {},
    )
    expect(res.resolved).toBe(1)
    expect(res.outcomes.find((o) => o.outcome === 'resolved')!.winnerId).toBe(a)
  })

  it('idempotent cron: a resolved conflict is NOT re-adjudicated next run — no duplicate believed marker, loop not even entered', async () => {
    const { a, b } = await seedPair({
      query: 'idem res A',
      aAsOf: new Date('2025-06-01T00:00:00.000Z'), // a strictly newer ⇒ unique winner (③ recency)
      bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      aAuthority: 0.5,
      bAuthority: 0.5,
    })
    const r1 = await runArbiter(
      { db, runtime: runtimeOf([adjudicateTurn(a, b), finishTurn(), stopTurn]) },
      {},
    )
    expect(r1.resolved).toBe(1)
    expect(await getResolvedConflicts(db)).toHaveLength(1) // one believed marker written
    // 2nd cron run: pair already adjudicated → selectPairs skips it → loop NOT entered (throwingRuntime proves it)
    const r2 = await runArbiter({ db, runtime: throwingRuntime }, {})
    expect(r2.resolved).toBe(0)
    expect(await getResolvedConflicts(db)).toHaveLength(1) // STILL 1 — re-run does not stack a duplicate marker
  })

  it('idempotent cron: an escalated conflict is NOT re-escalated next run — the editor queue does not stack duplicates', async () => {
    const { a, b } = await seedPair({
      query: 'idem esc A',
      aAsOf: new Date('2025-01-01T00:00:00.000Z'), // equal recency + authority + indep, no supersede ⇒ tie ⇒ escalate
      bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      aAuthority: 0.5,
      bAuthority: 0.5,
    })
    const r1 = await runArbiter(
      { db, runtime: runtimeOf([adjudicateTurn(a, b), finishTurn(), stopTurn]) },
      {},
    )
    expect(r1.escalated).toBe(1)
    expect(await getEditorConflictQueue(db)).toHaveLength(1)
    const r2 = await runArbiter({ db, runtime: throwingRuntime }, {})
    expect(r2.escalated).toBe(0)
    expect(await getEditorConflictQueue(db)).toHaveLength(1) // STILL 1 — no duplicate editor-queue entry
  })

  // S21 · NC-exact 红线（红线#3 / A.6）在 Arbiter 路：机判自裁 = 把**败者**判为负（refuted）。
  // 落采信标记前须经同一统一闸门：**胜者**须有 ≥1 条 relevance='exact' 反向命题；无则拒判 + 升级主编（不落采信）。
  it('NC-exact red line: a unique ladder winner whose evidence is only SUPPORTING (no exact reverse proposition) is REFUSED — no believed marker, escalated to the editor-in-chief instead', async () => {
    // a is strictly newer ⇒ ③ recency picks a as the unique winner; but a's only provenance is 'supporting'.
    const { a, b } = await seedPair({
      query: 'nc p A',
      aAsOf: new Date('2025-06-01T00:00:00.000Z'), // newer → winner
      bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      aAuthority: 0.5,
      bAuthority: 0.5,
      aRelevance: 'supporting', // winner lacks an EXACT reverse proposition
      bRelevance: 'supporting',
    })
    const res = await arbitrateConflicts(
      { db, runtime: runtimeOf([adjudicateTurn(a, b), finishTurn(), stopTurn]) },
      [[a, b]],
    )

    // refused: NO believed/trust marker recorded; the pair is escalated to the human queue instead.
    expect(res.resolved).toBe(0)
    expect(res.escalated).toBe(1)
    expect(await getResolvedConflicts(db)).toHaveLength(0)
    const queue = await getEditorConflictQueue(db)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.payload.rung).toBe('human')
    expect(queue[0]!.payload.reason).toMatch(/NC-exact/)

    // the refusal is recorded on the shared ruling_refused queue (same gate as the Verifier path)
    const refused = await getRefusedRulings(db)
    expect(refused).toHaveLength(1)
    expect(refused[0]!.payload.ruledAgainstClaimId).toBe(b) // loser ruled-against
    expect(refused[0]!.payload.reverseEvidenceClaimId).toBe(a) // exact looked for on the WINNER
    expect(refused[0]!.payload.rulingKind).toBe('refuted')
    expect(refused[0]!.payload.path).toBe('arbiter')

    // red line #2: nothing relaxed/quarantined — both stay active and recallable
    expect(await statusOf(a)).toBe('active')
    expect(await statusOf(b)).toBe('active')
  })

  it('NC-exact red line: the same ladder winner WITH an exact reverse proposition self-adjudicates normally (believed marker, no refusal)', async () => {
    const { a, b } = await seedPair({
      query: 'nc p A',
      aAsOf: new Date('2025-06-01T00:00:00.000Z'), // newer → winner
      bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      aAuthority: 0.5,
      bAuthority: 0.5,
      aRelevance: 'exact', // winner carries the EXACT reverse proposition
      bRelevance: 'supporting',
    })
    const res = await arbitrateConflicts(
      { db, runtime: runtimeOf([adjudicateTurn(a, b), finishTurn(), stopTurn]) },
      [[a, b]],
    )

    expect(res.resolved).toBe(1)
    expect(res.escalated).toBe(0)
    const resolved = await getResolvedConflicts(db)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.payload.winnerId).toBe(a)
    expect(await getRefusedRulings(db)).toHaveLength(0) // exact present → no refusal
  })
})
