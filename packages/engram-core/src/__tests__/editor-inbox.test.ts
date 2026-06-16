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
  NEUTRAL_FACTORS,
  type ConfidenceFactorBreakdown,
  type StoredConfidence,
} from '../confidence/confidence.js'
import { trustedHumanActor, agentActor } from '../spi/actor.js'
import { createDb, type DB } from '../db/client.js'
import { claim, claimProvenance, pageClaims, relation, type ClaimStatus } from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource, appendClaim, supersedeClaim } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { approveClaim, rejectClaim } from '../editor/editor-action.js'
import { getEditorInbox, getClaimLineage, EDITOR_INBOX_STATUSES } from '../editor/editor-inbox.js'
import {
  humanAdjudicateConflict,
  loadConflictSide,
  resolveConflict,
  escalateConflict,
  getEditorConflictQueue,
  getResolvedConflicts,
  getClaimStatus,
} from '../spi/conflict-arbiter.js'
import { adjudicateConflict } from '../spi/conflict-ladder.js'
import { readConflictQueueDepth } from '../governance/metric-readers.js'

// S23 · 主编工作台（inbox 升序 + claim 谱系 + 人工裁定①）+ 末端用户访问边界。
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder = makeFakeEmbedder()
const EDITOR = 'human:editor'

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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, page_claims, standards CASCADE',
  )
})

async function aSource(authorityScore = 0.9) {
  return addSource(db, {
    content: `body-${randomUUID()}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore,
  })
}

/**
 * Seed a claim at a chosen status + factor profile, embedding=query (so it is recallable as `active`),
 * with one exact provenance. Factors default to a neutral profile; tweak via `factors`.
 */
async function seedClaim(opts: {
  query: string
  status: ClaimStatus
  factors?: Partial<ConfidenceFactorBreakdown>
  text?: string
  subject?: string
  predicate?: string
  object?: string
  asOf?: Date
  createdBy?: string
  provCount?: number
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
    claimText: opts.text ?? `claim for ${opts.query}`,
    subject: opts.subject ?? null,
    predicate: opts.predicate ?? null,
    object: opts.object ?? null,
    status: opts.status,
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: stored,
    lineageId: randomUUID(),
    asOf: opts.asOf ?? new Date(),
    createdBy: opts.createdBy ?? 'agent:distiller',
    embedding: await embedder.embed(opts.query),
    embeddingVersion: embedder.version,
  })
  const n = opts.provCount ?? 1
  for (let i = 0; i < n; i++) {
    const { sourceId } = await aSource()
    await db
      .insert(claimProvenance)
      .values({ id: randomUUID(), claimId: id, sourceId, locator: `p${i}`, relevance: 'exact' })
  }
  return id
}

describe('S23 getEditorInbox — review queue sorted by LIVE-recomputed confidence ASCENDING (most suspicious first)', () => {
  it('orders by recomputed confidence ascending; ties broken by claimId (deterministic, pageable)', async () => {
    // three active claims with different authority → different live value
    const low = await seedClaim({ query: 'q-low', status: 'active', factors: { authority: 0.5 } })
    const mid = await seedClaim({ query: 'q-mid', status: 'active', factors: { authority: 0.7 } })
    const high = await seedClaim({
      query: 'q-high',
      status: 'active',
      factors: { authority: 0.95 },
    })

    const inbox = await getEditorInbox(db)
    const ids = inbox.map((r) => r.claimId)
    // ascending: lowest confidence first
    expect(ids).toEqual([low, mid, high])
    // strictly non-decreasing values
    for (let i = 1; i < inbox.length; i++) {
      expect(inbox[i]!.confidence.value).toBeGreaterThanOrEqual(inbox[i - 1]!.confidence.value)
    }
  })

  it('uses the LIVE recompute口径 (same as recall), NOT the stored claim.confidence column', async () => {
    // stored confidence column is garbage (set high) but live recompute (authority only) is low.
    const id = await seedClaim({
      query: 'live vs stored',
      status: 'active',
      factors: { authority: 0.5 },
    })
    await db.update(claim).set({ confidence: 0.99, confidenceRaw: 0.99 }).where(eq(claim.id, id))
    const inbox = await getEditorInbox(db)
    const row = inbox.find((r) => r.claimId === id)!
    // base = 0.3·0.5(auth) + 0.15·0.5(entail neutral) = 0.225 — NOT the stored 0.99
    expect(row.confidence.value).toBeCloseTo(0.225, 5)
    expect(row.confidence.value).not.toBeCloseTo(0.99, 2)
  })

  it('PROVES re-sort on recompute: a Reject (drops f1) lowers a claim and resurfaces it toward the top', async () => {
    // A has LOWER intrinsic authority than B; only its human endorsement lifts it above B.
    // base(A,f1=1) = 0.3·0.6 + 0.3·1 + 0.15·0.5 = 0.555 ; base(B,f1=0) = 0.3·0.7 + 0.15·0.5 = 0.285
    const a = await seedClaim({
      query: 'a-endorsed',
      status: 'active',
      factors: { authority: 0.6 },
    })
    const b = await seedClaim({ query: 'b-plain', status: 'active', factors: { authority: 0.7 } })
    // endorse A (f1→1) so it sits clearly ABOVE B
    await approveClaim(db, a, { actor: trustedHumanActor(EDITOR) })
    const before = (await getEditorInbox(db)).map((r) => r.claimId)
    expect(before).toEqual([b, a]) // ascending: b first (0.285), a last (0.555)

    // now the editor Rejects A (f1→0, status active→quarantined). A leaves the active band but
    // is STILL in the inbox (quarantined is reviewable) and its live confidence collapsed → it bubbles up.
    // base(A,f1=0) = 0.3·0.6 + 0.15·0.5 = 0.255 < base(B) 0.285 → A re-sorts BEFORE B.
    await rejectClaim(db, a, { actor: trustedHumanActor(EDITOR) })
    const after = await getEditorInbox(db)
    const aRow = after.find((r) => r.claimId === a)!
    expect(aRow.status).toBe('quarantined')
    // A's f1 dropped to 0 → its live value fell below B's → A now sorts before B (resurfaced to the top)
    const order = after.map((r) => r.claimId)
    expect(order.indexOf(a)).toBeLessThan(order.indexOf(b))
  })

  it('PROVES re-sort on recompute: a new active contradicts edge lowers a claim via live conflictDecay', async () => {
    const a = await seedClaim({
      query: 'contra-a',
      status: 'active',
      subject: 's',
      predicate: 'p',
      object: 'x',
      factors: { authority: 0.9 },
    })
    const b = await seedClaim({ query: 'b-plain', status: 'active', factors: { authority: 0.7 } })
    const beforeA = (await getEditorInbox(db)).find((r) => r.claimId === a)!.confidence.value

    // add an active contradicting peer for A
    const peer = await seedClaim({
      query: 'contra-peer',
      status: 'active',
      subject: 's',
      predicate: 'p',
      object: 'y',
      factors: { authority: 0.9 },
    })
    await db
      .insert(relation)
      .values({ id: randomUUID(), fromClaim: a, toClaim: peer, type: 'contradicts' })

    const after = await getEditorInbox(db)
    const aRow = after.find((r) => r.claimId === a)!
    expect(aRow.confidence.activeContradicts).toBe(1) // live conflict count
    expect(aRow.contradicts).toEqual([peer]) // explicit double-return of the active peer
    expect(aRow.confidence.value).toBeLessThan(beforeA) // conflictDecay lowered it
    void b
  })

  // REGRESSION (gate#1 linus): a contradicts edge to a NON-active peer must NOT count as an active conflict.
  // The inbox loads draft/active/flagged/quarantined as candidates; peer-activeness must be REAL status, never
  // "in the candidate set" — else an active claim contradicting a quarantined peer gets a spurious conflictDecay
  // and falsely bubbles to the top. The peer here is in the inbox candidate set (quarantined) yet must be ignored.
  it('a contradicts edge to a NON-active (quarantined) peer is NOT counted (activeContradicts=0, no decay, peer not double-returned)', async () => {
    const a = await seedClaim({
      query: 'contra-a2',
      status: 'active',
      subject: 's2',
      predicate: 'p2',
      object: 'x',
      factors: { authority: 0.9 },
    })
    const beforeA = (await getEditorInbox(db)).find((r) => r.claimId === a)!.confidence.value

    // a quarantined peer (IS in the inbox candidate set, but NOT active) — must be ignored as a conflict
    const deadPeer = await seedClaim({
      query: 'contra-dead-peer',
      status: 'quarantined',
      subject: 's2',
      predicate: 'p2',
      object: 'y',
      factors: { authority: 0.9 },
    })
    await db
      .insert(relation)
      .values({ id: randomUUID(), fromClaim: a, toClaim: deadPeer, type: 'contradicts' })

    const aRow = (await getEditorInbox(db)).find((r) => r.claimId === a)!
    expect(aRow.confidence.activeContradicts).toBe(0) // quarantined peer is NOT an active conflict
    expect(aRow.contradicts).toEqual([]) // not double-returned (A.5: only active peers)
    expect(aRow.confidence.value).toBeCloseTo(beforeA, 10) // confidence unchanged → no conflictDecay, no spurious bubble-up
  })

  it('includes draft / active / flagged / quarantined; EXCLUDES superseded (lineage-only)', async () => {
    const d = await seedClaim({ query: 'draft', status: 'draft', factors: { authority: 0.9 } })
    const a = await seedClaim({ query: 'active', status: 'active', factors: { authority: 0.9 } })
    const f = await seedClaim({ query: 'flagged', status: 'flagged', factors: { authority: 0.9 } })
    const qd = await seedClaim({
      query: 'quar',
      status: 'quarantined',
      factors: { authority: 0.9 },
    })
    const sup = await seedClaim({ query: 'sup', status: 'superseded', factors: { authority: 0.9 } })

    const ids = (await getEditorInbox(db)).map((r) => r.claimId)
    expect(ids).toContain(d)
    expect(ids).toContain(a)
    expect(ids).toContain(f)
    expect(ids).toContain(qd)
    expect(ids).not.toContain(sup) // superseded never in the review queue
    expect(EDITOR_INBOX_STATUSES).not.toContain('superseded')
  })

  it('statuses filter intersects with the review set (cannot smuggle superseded in)', async () => {
    const a = await seedClaim({ query: 'active', status: 'active', factors: { authority: 0.9 } })
    const qd = await seedClaim({
      query: 'quar',
      status: 'quarantined',
      factors: { authority: 0.9 },
    })
    const sup = await seedClaim({ query: 'sup', status: 'superseded', factors: { authority: 0.9 } })

    const only = await getEditorInbox(db, { statuses: ['quarantined'] })
    expect(only.map((r) => r.claimId)).toEqual([qd])
    void a
    // asking for superseded yields nothing (intersection with review set = empty)
    expect(await getEditorInbox(db, { statuses: ['superseded'] })).toHaveLength(0)
    void sup
  })

  it('limit + offset paginate the ascending list', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedClaim({
          query: `q${i}`,
          status: 'active',
          factors: { authority: 0.5 + i * 0.1 },
        }),
      )
    }
    const all = (await getEditorInbox(db)).map((r) => r.claimId)
    const page1 = (await getEditorInbox(db, { limit: 2, offset: 0 })).map((r) => r.claimId)
    const page2 = (await getEditorInbox(db, { limit: 2, offset: 2 })).map((r) => r.claimId)
    expect(page1).toEqual(all.slice(0, 2))
    expect(page2).toEqual(all.slice(2, 4))
  })

  it('maps the j/k + a/e/r surface: claim body + live conf + provenance count + status + contradicts', async () => {
    const id = await seedClaim({
      query: 'rich row',
      status: 'flagged',
      text: 'the relay is rated 16A',
      subject: 'relay',
      predicate: 'rated',
      object: '16A',
      factors: { authority: 0.8 },
      provCount: 2,
    })
    const [row] = await getEditorInbox(db)
    expect(row!.claimId).toBe(id)
    expect(row!.claimText).toBe('the relay is rated 16A')
    expect(row!.subject).toBe('relay')
    expect(row!.predicate).toBe('rated')
    expect(row!.object).toBe('16A')
    expect(row!.status).toBe('flagged')
    expect(row!.provenanceCount).toBe(2)
    expect(typeof row!.confidence.value).toBe('number')
    expect(row!.contradicts).toEqual([])
    expect(typeof row!.createdBy).toBe('string')
  })

  it('empty store → empty inbox', async () => {
    expect(await getEditorInbox(db)).toEqual([])
  })
})

describe('S23 getClaimLineage — full genealogy (provenances / citing pages / version history)', () => {
  it('returns provenances with drill-back locators (source id + locator + excerpt + relevance)', async () => {
    const { sourceId } = await aSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'lineage claim' }, [
      { sourceId, locator: 'page 7, line 3', excerpt: 'measured 42Nm', relevance: 'exact' },
    ])
    const lin = await getClaimLineage(db, claimId)
    expect(lin.claimId).toBe(claimId)
    expect(lin.provenances).toHaveLength(1)
    const p = lin.provenances[0]!
    expect(p.sourceId).toBe(sourceId)
    expect(p.locator).toBe('page 7, line 3')
    expect(p.excerpt).toBe('measured 42Nm')
    expect(p.relevance).toBe('exact')
    expect(typeof p.provenanceId).toBe('string')
  })

  it('returns citing pages via page_claims M:N (which pages cite this claim, with ord)', async () => {
    const { sourceId } = await aSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'cited claim' }, [
      { sourceId, locator: 'l1' },
    ])
    const pageA = randomUUID()
    const pageB = randomUUID()
    await db.insert(pageClaims).values({ pageId: pageA, claimId, ord: 0 })
    await db.insert(pageClaims).values({ pageId: pageB, claimId, ord: 5 })

    const lin = await getClaimLineage(db, claimId)
    expect(lin.citingPages).toHaveLength(2)
    const byPage = new Map(lin.citingPages.map((c) => [c.pageId, c.ord]))
    expect(byPage.get(pageA)).toBe(0)
    expect(byPage.get(pageB)).toBe(5)
  })

  it('walks supersede chain over shared lineage_id: superseded versions VISIBLE, ordered oldest→newest', async () => {
    const { sourceId } = await aSource()
    // v1 → v2 → v3 (each supersedes the prior; same lineage_id; old versions preserved)
    const { claimId: v1 } = await appendClaim(db, embedder, { claimText: 'v1 text' }, [
      { sourceId, locator: 'l1' },
    ])
    const { claimId: v2 } = await supersedeClaim(db, embedder, v1, { claimText: 'v2 text' }, [
      { sourceId, locator: 'l2' },
    ])
    const { claimId: v3 } = await supersedeClaim(db, embedder, v2, { claimText: 'v3 text' }, [
      { sourceId, locator: 'l3' },
    ])

    // querying lineage from ANY version returns the full chain
    const linFromV1 = await getClaimLineage(db, v1)
    expect(linFromV1.versions.map((v) => v.claimId)).toEqual([v1, v2, v3]) // oldest → newest
    expect(linFromV1.versions.map((v) => v.claimText)).toEqual(['v1 text', 'v2 text', 'v3 text'])
    // old versions are VISIBLE (not deleted) and marked superseded; the head is not
    expect(linFromV1.versions.map((v) => v.superseded)).toEqual([true, true, false])
    expect(linFromV1.versions.map((v) => v.status)).toEqual(['superseded', 'superseded', 'draft'])
    // same lineage_id throughout
    const lineageIds = new Set(linFromV1.versions.map((v) => v.claimId))
    expect(lineageIds.size).toBe(3)
    expect(linFromV1.lineageId).toBe((await getClaimLineage(db, v3)).lineageId)
  })

  it('single-version claim: one version, not superseded', async () => {
    const { sourceId } = await aSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'solo' }, [
      { sourceId, locator: 'l1' },
    ])
    const lin = await getClaimLineage(db, claimId)
    expect(lin.versions).toHaveLength(1)
    expect(lin.versions[0]!.superseded).toBe(false)
    expect(lin.citingPages).toEqual([])
  })

  it('missing claim throws not-found', async () => {
    await expect(getClaimLineage(db, randomUUID())).rejects.toThrow(/not found/)
  })
})

describe('S23 humanAdjudicateConflict — rung ① human ruling ON TOP of the machine ladder (A.5)', () => {
  // helper: build a real conflicting pair (same s/p, different object) recorded via append
  async function aConflictPair(opts?: {
    aAsOf?: Date
    bAsOf?: Date
    aAuth?: number
    bAuth?: number
  }): Promise<{ a: string; b: string }> {
    const sa = await addSource(db, {
      content: `sa-${randomUUID()}`,
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: opts?.aAuth ?? 0.9,
    })
    const sb = await addSource(db, {
      content: `sb-${randomUUID()}`,
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: opts?.bAuth ?? 0.9,
    })
    const { claimId: a } = await appendClaim(
      db,
      embedder,
      {
        claimText: 'fact A',
        subject: 's',
        predicate: 'p',
        object: 'x',
        ...(opts?.aAsOf !== undefined ? { asOf: opts.aAsOf } : {}),
      },
      [{ sourceId: sa.sourceId, locator: 'la', relevance: 'exact' }],
    )
    const { claimId: b } = await appendClaim(
      db,
      embedder,
      {
        claimText: 'fact B',
        subject: 's',
        predicate: 'p',
        object: 'y',
        ...(opts?.bAsOf !== undefined ? { asOf: opts.bAsOf } : {}),
      },
      [{ sourceId: sb.sourceId, locator: 'lb', relevance: 'exact' }],
    )
    return { a, b }
  }

  it('ENFORCED human-exclusivity: an agent caller is REJECTED by code before any side effect', async () => {
    const { a, b } = await aConflictPair()
    await expect(
      humanAdjudicateConflict(db, { a, b, winnerId: a, actor: agentActor('agent:arbiter') }),
    ).rejects.toThrow(/human-exclusive|not human/)
    // not just documented: nothing was written (no contradicts edge, no resolved marker)
    expect(await getResolvedConflicts(db)).toHaveLength(0)
    const edges = await db.select().from(relation).where(eq(relation.type, 'contradicts'))
    // the append-time S8 detector already records ONE contradicts edge for the pair; assert no NEW one was added
    expect(edges.length).toBe(1)
  })

  it('rung ① can pick EITHER side regardless of the machine ladder (human overrides the machine result)', async () => {
    // construct a pair where the MACHINE ladder would pick B (newer as_of wins by recency ③)
    const older = new Date('2020-01-01T00:00:00Z')
    const newer = new Date('2024-01-01T00:00:00Z')
    const { a, b } = await aConflictPair({ aAsOf: older, bAsOf: newer })
    const sideA = await loadConflictSide(db, a)
    const sideB = await loadConflictSide(db, b)
    const machine = adjudicateConflict(sideA, sideB)
    expect(machine.outcome).toBe('winner')
    expect(machine.winnerId).toBe(b) // machine would pick the newer one (recency)

    // the human OVERRIDES and picks the OLDER A — that is what rung ① means
    const res = await humanAdjudicateConflict(db, {
      a,
      b,
      winnerId: a,
      actor: trustedHumanActor(EDITOR),
      reason: 'A is the authoritative spec',
    })
    expect(res.outcome).toBe('resolved')
    expect(res.winnerId).toBe(a)
    expect(res.loserId).toBe(b)
    expect(res.rung).toBe('human')

    const resolved = await getResolvedConflicts(db)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.payload.winnerId).toBe(a) // human-chosen, against the machine
    expect(resolved[0]!.payload.rung).toBe('human')
    expect(resolved[0]!.payload.byRole).toBe(EDITOR)
    expect(resolved[0]!.payload.reason).toBe('A is the authoritative spec')
  })

  it('resolves a claim escalated to the editor queue (S20 getEditorConflictQueue) via rung ①', async () => {
    // make a perfect tie (same as_of, authority, indep) → machine escalates to the editor
    const sameAsOf = new Date('2023-06-01T00:00:00Z')
    const { a, b } = await aConflictPair({
      aAsOf: sameAsOf,
      bAsOf: sameAsOf,
      aAuth: 0.8,
      bAuth: 0.8,
    })
    const adj = adjudicateConflict(await loadConflictSide(db, a), await loadConflictSide(db, b))
    expect(adj.outcome).toBe('escalate')
    await escalateConflict(db, {
      a,
      b,
      rung: adj.rung,
      reason: adj.reason,
      byRole: 'agent:arbiter',
    })
    const queue = await getEditorConflictQueue(db)
    expect(queue).toHaveLength(1)

    // editor takes it from the queue and rules with rung ①
    const res = await humanAdjudicateConflict(db, {
      a,
      b,
      winnerId: b,
      actor: trustedHumanActor(EDITOR),
    })
    expect(res.winnerId).toBe(b)
    expect(res.rung).toBe('human')
    expect(await getResolvedConflicts(db)).toHaveLength(1)

    // EGR-CR-015 回归：human resolve 同一 pair 后，editor queue 不再返回旧 escalated 事件
    expect(await getEditorConflictQueue(db)).toHaveLength(0)
    // 但 escalated 历史事件本身仍在 event log（append-only 不撤回，审计可查）
    expect(await getResolvedConflicts(db)).toHaveLength(1)
  })

  it('EGR-CR-015: human-resolved pair no longer inflates conflictQueueDepth governance signal', async () => {
    const sameAsOf = new Date('2023-06-01T00:00:00Z')
    const { a, b } = await aConflictPair({
      aAsOf: sameAsOf,
      bAsOf: sameAsOf,
      aAuth: 0.8,
      bAuth: 0.8,
    })
    const adj = adjudicateConflict(await loadConflictSide(db, a), await loadConflictSide(db, b))
    expect(adj.outcome).toBe('escalate')
    await escalateConflict(db, {
      a,
      b,
      rung: adj.rung,
      reason: adj.reason,
      byRole: 'agent:arbiter',
    })
    expect((await readConflictQueueDepth(db)).value).toBe(1) // 升级后压力 = 1

    await humanAdjudicateConflict(db, { a, b, winnerId: a, actor: trustedHumanActor(EDITOR) })
    expect((await readConflictQueueDepth(db)).value).toBe(0) // 人裁后压力归零，治理信号不再虚高
  })

  it('EGR-CR-015: resolving one pair does not drop other still-escalated pairs from the queue', async () => {
    const sameAsOf = new Date('2023-06-01T00:00:00Z')
    const p1 = await aConflictPair({ aAsOf: sameAsOf, bAsOf: sameAsOf, aAuth: 0.8, bAuth: 0.8 })
    const p2 = await aConflictPair({ aAsOf: sameAsOf, bAsOf: sameAsOf, aAuth: 0.8, bAuth: 0.8 })
    for (const p of [p1, p2]) {
      const adj = adjudicateConflict(
        await loadConflictSide(db, p.a),
        await loadConflictSide(db, p.b),
      )
      await escalateConflict(db, {
        a: p.a,
        b: p.b,
        rung: adj.rung,
        reason: adj.reason,
        byRole: 'agent:arbiter',
      })
    }
    expect(await getEditorConflictQueue(db)).toHaveLength(2)

    await humanAdjudicateConflict(db, {
      a: p1.a,
      b: p1.b,
      winnerId: p1.a,
      actor: trustedHumanActor(EDITOR),
    })
    const queue = await getEditorConflictQueue(db)
    expect(queue).toHaveLength(1) // 只关 p1，p2 仍在
    const remaining = queue[0]!.payload
    const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`)
    expect(key(remaining.claimA, remaining.claimB)).toBe(key(p2.a, p2.b))
  })

  it('AFTER a human ruling, recall reflects the believed marker (loser eats live conflictDecay)', async () => {
    // both claims recallable on the same query; the conflict edge makes them each eat conflictDecay live
    const sa = await addSource(db, {
      content: `sa-${randomUUID()}`,
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.95,
    })
    const sb = await addSource(db, {
      content: `sb-${randomUUID()}`,
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.95,
    })
    const q = 'relay rating dispute'
    const { claimId: a } = await appendClaim(
      db,
      embedder,
      { claimText: q, subject: 's', predicate: 'p', object: 'x' },
      [{ sourceId: sa.sourceId, locator: 'la', relevance: 'exact' }],
    )
    const { claimId: b } = await appendClaim(
      db,
      embedder,
      { claimText: q, subject: 's', predicate: 'p', object: 'y' },
      [{ sourceId: sb.sourceId, locator: 'lb', relevance: 'exact' }],
    )
    // promote both to active so they are recallable
    await approveClaim(db, a, { actor: trustedHumanActor(EDITOR) })
    await approveClaim(db, b, { actor: trustedHumanActor(EDITOR) })

    const before = await recallClaims(db, embedder, q)
    const bothBefore = before.filter((r) => r.claim.id === a || r.claim.id === b)
    expect(bothBefore).toHaveLength(2)
    // each sees the other as an active contradiction (explicit double-return, A.5)
    for (const r of bothBefore) {
      expect(r.contradicts.length).toBe(1)
      expect(r.confidence.factors.activeContradicts).toBe(1)
    }

    // human rules A the winner. resolveConflict records the believed marker; status of neither claim changes (red line #2)
    await humanAdjudicateConflict(db, { a, b, winnerId: a, actor: trustedHumanActor(EDITOR) })
    expect(await getClaimStatus(db, a)).toBe('active') // ruling does not relax/quarantine
    expect(await getClaimStatus(db, b)).toBe('active')

    // recall still double-returns the conflict; the believed marker is auditable via getResolvedConflicts
    const after = await recallClaims(db, embedder, q)
    expect(after.filter((r) => r.claim.id === a || r.claim.id === b)).toHaveLength(2)
    const resolved = await getResolvedConflicts(db)
    expect(resolved[0]!.payload.winnerId).toBe(a)
    expect(resolved[0]!.payload.rung).toBe('human')
  })

  it('rejects winnerId not in the pair, and self-conflict', async () => {
    const { a, b } = await aConflictPair()
    await expect(
      humanAdjudicateConflict(db, {
        a,
        b,
        winnerId: randomUUID(),
        actor: trustedHumanActor(EDITOR),
      }),
    ).rejects.toThrow(/must be one of the conflicting pair/)
    await expect(
      humanAdjudicateConflict(db, { a, b: a, winnerId: a, actor: trustedHumanActor(EDITOR) }),
    ).rejects.toThrow(/cannot conflict with itself/)
  })

  it('rejects a missing claim (both ends must exist)', async () => {
    const { a } = await aConflictPair()
    await expect(
      humanAdjudicateConflict(db, {
        a,
        b: randomUUID(),
        winnerId: a,
        actor: trustedHumanActor(EDITOR),
      }),
    ).rejects.toThrow(/not found/)
  })

  it('reuses resolveConflict marker semantics (does not duplicate the ladder): contradicts edge is idempotent', async () => {
    const { a, b } = await aConflictPair()
    // a machine resolve already ran (e.g. an earlier Arbiter pass) — edge exists
    const adj = adjudicateConflict(await loadConflictSide(db, a), await loadConflictSide(db, b))
    if (adj.outcome === 'winner') {
      await resolveConflict(db, { a, b, adjudication: adj, byRole: 'agent:arbiter' })
    }
    const edgesBefore = (await db.select().from(relation).where(eq(relation.type, 'contradicts')))
      .length
    // human re-rules: no duplicate contradicts edge (ensureContradictsEdge is idempotent)
    await humanAdjudicateConflict(db, { a, b, winnerId: a, actor: trustedHumanActor(EDITOR) })
    const edgesAfter = (await db.select().from(relation).where(eq(relation.type, 'contradicts')))
      .length
    expect(edgesAfter).toBe(edgesBefore)
  })
})

describe('S23 end-user access boundary — editor surface is distinct from the consumer recall path', () => {
  it('consumer recall returns ONLY cited claims (claim + conf + provenances), never inbox/adjudication data', async () => {
    // seed an active recallable claim + a quarantined one (editor sees the quarantined; consumer never does)
    const q = 'boundary fact'
    const active = await seedClaim({
      query: q,
      status: 'active',
      factors: { authority: 0.95, indepSupport: 0.9 },
    })
    const quarantined = await seedClaim({
      query: q,
      status: 'quarantined',
      factors: { authority: 0.95 },
    })

    // consumer path (recall): only the active, cited claim; shape carries NO editor-only fields
    const hits = await recallClaims(db, embedder, q)
    expect(hits.map((h) => h.claim.id)).toContain(active)
    expect(hits.map((h) => h.claim.id)).not.toContain(quarantined) // gated-out status never surfaces to consumer
    for (const h of hits) {
      expect(h.provenances.length).toBeGreaterThanOrEqual(1) // cited
      // recall result shape: claim / confidence / provenances / mustVerify / contradicts / embeddingVersion
      expect(h).not.toHaveProperty('provenanceCount') // inbox-only field
      expect(h).not.toHaveProperty('citingPages') // lineage-only field
      expect(h.confidence).not.toHaveProperty('activeContradicts')
    }

    // editor path (inbox): SEES the quarantined claim that the consumer cannot
    const inboxIds = (await getEditorInbox(db)).map((r) => r.claimId)
    expect(inboxIds).toContain(quarantined)
  })

  it('the adjudication queue / resolved markers are editor-only — recall does not expose them', async () => {
    const q = 'queue boundary'
    const a = await seedClaim({
      query: q,
      status: 'active',
      subject: 's',
      predicate: 'p',
      object: 'x',
      factors: { authority: 0.95, indepSupport: 0.9 },
    })
    const b = await seedClaim({
      query: q,
      status: 'active',
      subject: 's',
      predicate: 'p',
      object: 'y',
      factors: { authority: 0.95, indepSupport: 0.9 },
    })
    await db
      .insert(relation)
      .values({ id: randomUUID(), fromClaim: a, toClaim: b, type: 'contradicts' })
    await escalateConflict(db, { a, b, rung: 'human', reason: 'tie', byRole: 'agent:arbiter' })

    // recall double-returns the conflicting peer id (A.5 explicit), but exposes NO queue/event payload
    const hits = await recallClaims(db, embedder, q)
    for (const h of hits) {
      expect(Array.isArray(h.contradicts)).toBe(true) // peer ids only (for the UI to fetch via editor SPI)
      expect(h).not.toHaveProperty('escalated')
      expect(h).not.toHaveProperty('queue')
      expect(h).not.toHaveProperty('adjudication')
    }
    // the editor-only queue is reachable solely via the editor SPI
    expect(await getEditorConflictQueue(db)).toHaveLength(1)
  })
})
