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
  getReconcileEscalations,
  makeFakeEmbedder,
  makeFakeEntailmentJudge,
  schema,
  type DB,
  type EntailmentJudge,
  type EntailmentQuery,
  type EntailmentVerdict,
} from '@engram/core'

import { reconcileBatch, runReconciler } from '../reconciler.js'

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
const RECONCILER_ROLE = 'agent:reconciler'
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

/**
 * Faithful ≥-bound entailment oracle (NOT a hardcoded verdict): pass ⟺ evidence ⊢ claim ⟺ evidence's
 * lower bound ≥ claim's (stricter implies looser). Because it actually computes entailment, it would FAIL
 * if the Reconciler's A/B (suspected/anchor) judge direction were inverted — pinning the near-dup-poison direction.
 */
function boundOracle() {
  let calls = 0
  const lower = (str: string): number => {
    const m = str.match(/(\d+(?:\.\d+)?)/)
    return m ? parseFloat(m[1]!) : NaN
  }
  const j: EntailmentJudge & { callCount: () => number } = {
    version: 'fake:bound-oracle',
    async judge(q: EntailmentQuery): Promise<EntailmentVerdict> {
      calls += 1
      const claimBound = lower(q.claimText)
      const evidBound = lower(q.evidence[0]?.sourceContent ?? '')
      if (Number.isNaN(claimBound) || Number.isNaN(evidBound)) return 'fail'
      return evidBound >= claimBound ? 'pass' : 'fail'
    },
    callCount: () => calls,
  }
  return j
}

interface MkOpts {
  claimText: string
  subject: string | null
  predicate?: string | null
  object: string | null
  status?: schema.ClaimStatus
  createdBy?: string
  /** extra supports sources beyond the default one (for the indep-inflation audit). */
  extraSources?: { contentHash?: string; derivedFromSourceId?: string; kind?: schema.SourceKind }[]
}

/** Seed a claim with a real (fake-embedder) embedding + ≥1 exact provenance; precise subject/object/status. */
async function mkClaim(opts: MkOpts): Promise<{ claimId: string; sourceId: string }> {
  const { sourceId } = await addSource(db, {
    content: `src for ${opts.claimText}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  const claimId = randomUUID()
  await db.insert(schema.claim).values({
    id: claimId,
    claimText: opts.claimText,
    subject: opts.subject,
    predicate: opts.predicate ?? null,
    object: opts.object,
    status: opts.status ?? 'active',
    confidence: 0.6,
    confidenceRaw: 0.6,
    confidenceFactors: { factors: {}, weights: WEIGHTS, calibrationVersion: 'identity' },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: opts.createdBy ?? 'agent:distiller',
    embedding: await embedder.embed(opts.claimText),
    embeddingVersion: embedder.version,
  })
  await db.insert(schema.claimProvenance).values({
    id: randomUUID(),
    claimId,
    sourceId,
    locator: 'L1',
    relevance: 'exact',
  })
  for (const ex of opts.extraSources ?? []) {
    const extra = await addSource(db, {
      content: `extra for ${opts.claimText} ${randomUUID()}`,
      contentHash: ex.contentHash ?? randomUUID(),
      kind: ex.kind ?? 'formal_document',
      authorityScore: 0.7,
      ...(ex.derivedFromSourceId != null ? { derivedFromSourceId: ex.derivedFromSourceId } : {}),
    })
    await db.insert(schema.claimProvenance).values({
      id: randomUUID(),
      claimId,
      sourceId: extra.sourceId,
      locator: 'L2',
      relevance: 'supporting',
    })
  }
  return { claimId, sourceId }
}

async function statusOf(claimId: string): Promise<schema.ClaimStatus> {
  const [row] = await db
    .select({ s: schema.claim.status })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  return row!.s
}

async function refinesEdges(fromId: string) {
  return db
    .select()
    .from(schema.relation)
    .where(and(eq(schema.relation.type, 'refines'), eq(schema.relation.fromClaim, fromId)))
}

// Two claim texts sharing subject+predicate prefix are trigram-near (≥0.75).
const ANCHOR_TEXT = 'skuA battery capacity is at least 4000 mah'
const POISON_TEXT = 'skuA battery capacity is at least 800 mah' // silently shrunk object
const REFINE_TEXT = 'skuA battery capacity is at least 4500 mah' // narrower, still within anchor

describe('S18 Reconciler worker (batch_appended: 函数 + 灰区一次 LLM) — A.6/A.7', () => {
  it('near-dup-poison: a silently shrunk object is flagged (active→flagged) + escalated with the peer id, NOT merged', async () => {
    const anchor = await mkClaim({
      claimText: ANCHOR_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 4000',
    })
    const poison = await mkClaim({
      claimText: POISON_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 800', // shrunk away from the anchor's 4000 → A ⊄ B
    })
    // faithful oracle: A(=poison ≥800) does NOT entail B(=anchor ≥4000) → fail ⇒ poison (direction pinned)
    const judge = boundOracle()
    const res = await reconcileBatch({ db, judge }, [poison.claimId])

    expect(res.escalations).toBe(1)
    expect(res.flagged).toBe(1)
    expect(judge.callCount()).toBe(1) // 灰区点状一次 LLM
    expect(await statusOf(poison.claimId)).toBe('flagged') // tightened (blue)
    expect(await statusOf(anchor.claimId)).toBe('active') // anchor untouched — NOT merged/destroyed

    // escalation carries the peer claim id (the S17 conflict signal home)
    const esc = await getReconcileEscalations(db, poison.claimId)
    expect(esc).toHaveLength(1)
    expect(esc[0]!.conflictsWith).toBe(anchor.claimId)
    expect(esc[0]!.byRole).toBe(RECONCILER_ROLE)
    // both claims still exist (no destructive merge)
    const all = await db.select({ id: schema.claim.id }).from(schema.claim)
    expect(all.map((c) => c.id).sort()).toEqual([anchor.claimId, poison.claimId].sort())
  })

  it('genuine refinement: A.object ⊆ B.object is linked as refines, NOT flagged or escalated', async () => {
    const anchor = await mkClaim({
      claimText: ANCHOR_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 4000',
    })
    const refine = await mkClaim({
      claimText: REFINE_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 4500', // narrower but still satisfies ≥4000
    })
    const judge = boundOracle() // faithful: A(≥4500) ⊢ B(≥4000) → pass ⇒ refines (direction pinned)
    const res = await reconcileBatch({ db, judge }, [refine.claimId])

    expect(res.refinesLinked).toBe(1)
    expect(res.flagged).toBe(0)
    expect(res.escalations).toBe(0)
    expect(await statusOf(refine.claimId)).toBe('active') // not flagged
    const edges = await refinesEdges(refine.claimId)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.toClaim).toBe(anchor.claimId)
    expect(await getReconcileEscalations(db, refine.claimId)).toHaveLength(0)
  })

  it('anti same-source inflation: a claim whose supports include a same-hash / derived-from copy is surfaced (indepSupport must not grow by source count)', async () => {
    const sharedHash = `dup-${randomUUID()}`
    // claim with two same-contentHash sources (same-source copy) → non-independent pair
    const dup = await mkClaim({
      claimText: 'skuB weight is 250 g',
      subject: 'skuB',
      predicate: 'weight',
      object: '250g',
      extraSources: [{ contentHash: sharedHash }, { contentHash: sharedHash }],
    })
    // a clean claim with two genuinely distinct sources
    const clean = await mkClaim({
      claimText: 'skuC weight is 300 g',
      subject: 'skuC',
      predicate: 'weight',
      object: '300g',
      extraSources: [{}, {}],
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
    const res = await runReconciler({ db, judge }, { claimIds: [dup.claimId, clean.claimId] })

    const dupAudit = res.indepAudits.find((a) => a.claimId === dup.claimId)
    const cleanAudit = res.indepAudits.find((a) => a.claimId === clean.claimId)
    expect(dupAudit?.hasNonIndependentPair).toBe(true) // same-hash copies cannot each count as indep support
    expect(cleanAudit?.hasNonIndependentPair).toBe(false)
  })

  it('conservative on uncertainty: a gray-zone pair the judge cannot place keeps BOTH claims (no merge, no flag)', async () => {
    const anchor = await mkClaim({
      claimText: ANCHOR_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 4000',
    })
    const other = await mkClaim({
      claimText: POISON_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 800',
    })
    // judge throws → reconcilePair degrades to inconclusive ⇒ keep both
    const judge: EntailmentJudge = {
      version: 'boom',
      async judge(): Promise<EntailmentVerdict> {
        throw new Error('judge boom')
      },
    }
    const res = await reconcileBatch({ db, judge }, [other.claimId])

    expect(res.flagged).toBe(0)
    expect(res.escalations).toBe(0)
    expect(res.refinesLinked).toBe(0)
    expect(await statusOf(anchor.claimId)).toBe('active')
    expect(await statusOf(other.claimId)).toBe('active') // not flagged
    expect(await refinesEdges(other.claimId)).toHaveLength(0)
    expect(await getReconcileEscalations(db, other.claimId)).toHaveLength(0)
  })

  it('judge≠athlete: the Reconciler never reviews/judges a claim it itself authored (skipped, LLM never called)', async () => {
    await mkClaim({
      claimText: ANCHOR_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 4000',
    })
    const self = await mkClaim({
      claimText: POISON_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 800',
      createdBy: RECONCILER_ROLE,
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' }) // would flag if it were judged
    const res = await reconcileBatch({ db, judge }, [self.claimId])

    expect(res.skipped).toBeGreaterThanOrEqual(1)
    expect(res.escalations).toBe(0)
    expect(judge.callCount()).toBe(0) // never judged its own claim
    expect(await statusOf(self.claimId)).toBe('active')
  })

  it('draft poison: a draft A judged poison is NOT flagged (draft→flagged is illegal) but the escalation is still recorded with the peer id', async () => {
    const anchor = await mkClaim({
      claimText: ANCHOR_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 4000',
    })
    const draftPoison = await mkClaim({
      claimText: POISON_TEXT,
      subject: 'skuA',
      predicate: 'capacity',
      object: 'at least 800',
      status: 'draft',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'not_co_true' })
    const res = await reconcileBatch({ db, judge }, [draftPoison.claimId])

    expect(res.escalations).toBe(1) // signal still recorded (don't drop the conflict)
    expect(res.flagged).toBe(0) // draft→flagged illegal → no transition (conservative, no crash)
    expect(await statusOf(draftPoison.claimId)).toBe('draft') // unchanged
    const esc = await getReconcileEscalations(db, draftPoison.claimId)
    expect(esc).toHaveLength(1)
    expect(esc[0]!.conflictsWith).toBe(anchor.claimId)
  })

  it('empty batch / no anchors: does nothing, no crash, one LLM call budget respected', async () => {
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    const res = await reconcileBatch({ db, judge }, [])
    expect(res.reviewed).toBe(0)
    expect(res.escalations).toBe(0)
    expect(judge.callCount()).toBe(0)

    // a lone claim with no same-subject anchor → no pair, no LLM
    const lone = await mkClaim({
      claimText: 'unique solo claim with no peer',
      subject: 'solo',
      predicate: 'p',
      object: 'v',
    })
    const res2 = await reconcileBatch({ db, judge }, [lone.claimId])
    expect(res2.reviewed).toBe(0)
    expect(judge.callCount()).toBe(0)
  })
})
