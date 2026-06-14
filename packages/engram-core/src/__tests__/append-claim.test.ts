import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type DB } from '../db/client.js'
import {
  claim,
  claimProvenance,
  claimStatus,
  provRelevance,
  relation,
  relationType,
  source,
  sourceKind,
  verificationKind,
} from '../db/schema.js'
import { addSource, appendClaim, supersedeClaim } from '../spi/append-claim.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { DEFAULT_WEIGHTS } from '../confidence/confidence.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const embedder = makeFakeEmbedder() // deterministic, offline — same instance produces/queries vectors

let admin: pg.Pool // connected to the base db; creates/drops the per-run db
let pool: pg.Pool // connected to this run's throwaway db
let db: DB
let testDbName: string

// 每次测试运行用一个独立的一次性数据库做隔离：并发的多个测试进程（含 review-gate 的多 agent 同跑）
// 各自有库，TRUNCATE 不会跨进程互踩、不再死锁/FK 违例。run 结束 DROP 掉。
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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, page_claims CASCADE',
  )
})

async function seedSource(meta: Record<string, unknown> = {}) {
  return addSource(db, {
    content: 'datasheet body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5, // explicit so confidence-factor assertions don't ride the schema default
    meta,
  })
}

describe('S1 walking skeleton: append_claim + D1 hard gate', () => {
  it('persists a draft claim plus exactly its provenance in one atomic transaction', async () => {
    const { sourceId } = await seedSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'SKU-123 supports 4K@120' }, [
      { sourceId, locator: 'page 4, table 2', relevance: 'exact' },
    ])
    const claims = await db.select().from(claim).where(eq(claim.id, claimId))
    expect(claims).toHaveLength(1)
    expect(claims[0]!.status).toBe('draft')
    expect(claims[0]!.lineageId).toBeTruthy() // fresh, non-null lineage

    const provs = await db
      .select()
      .from(claimProvenance)
      .where(eq(claimProvenance.claimId, claimId))
    expect(provs).toHaveLength(1)
    expect(provs[0]!.sourceId).toBe(sourceId)
    expect(provs[0]!.relevance).toBe('exact')
  })

  it('throws and writes NOTHING when provenance is empty (D1 hard gate)', async () => {
    await expect(appendClaim(db, embedder, { claimText: 'orphan' }, [])).rejects.toThrow(
      /D1|provenance/i,
    )
    expect(await db.select().from(claim)).toHaveLength(0)
    expect(await db.select().from(claimProvenance)).toHaveLength(0)
  })

  // EGR-CR-023: locator 必须能钻回原文锚点。空/全空白 locator = 不可点击的幽灵出处，core guard 连事务都不开就拒。
  it.each([
    ['empty string', ''],
    ['all whitespace', '   '],
  ])(
    'appendClaim rejects a blank locator (%s) before opening a tx and writes NOTHING (EGR-CR-023 core guard)',
    async (_label, locator) => {
      const { sourceId } = await seedSource() // a real source so the FK passes — isolates the locator guard
      await expect(
        appendClaim(db, embedder, { claimText: 'ghost' }, [{ sourceId, locator }]),
      ).rejects.toThrow(/locator/i)
      expect(await db.select().from(claim)).toHaveLength(0)
      expect(await db.select().from(claimProvenance)).toHaveLength(0)
    },
  )

  it.each([
    ['empty string', ''],
    ['all whitespace', '   '],
  ])(
    'supersedeClaim rejects a blank locator (%s) — old head stays, no new version, no supersedes edge (EGR-CR-023)',
    async (_label, locator) => {
      const { sourceId } = await seedSource()
      const { claimId: headId } = await appendClaim(db, embedder, { claimText: 'v1' }, [
        { sourceId, locator: 'page 1' },
      ])
      await expect(
        supersedeClaim(db, embedder, headId, { claimText: 'v2' }, [{ sourceId, locator }]),
      ).rejects.toThrow(/locator/i)
      const head = (await db.select().from(claim).where(eq(claim.id, headId)))[0]!
      expect(head.status).toBe('draft') // old head untouched, NOT marked superseded
      expect(await db.select().from(claim)).toHaveLength(1) // no v2 written
      expect(await db.select().from(relation)).toHaveLength(0) // no supersedes edge
    },
  )

  it('rolls back the whole append when a provenance points at a nonexistent source (NOT NULL FK)', async () => {
    await expect(
      appendClaim(db, embedder, { claimText: 'bad-prov' }, [
        { sourceId: randomUUID(), locator: 'x' },
      ]),
    ).rejects.toThrow()
    // atomic: neither the claim nor any provenance survived
    expect(await db.select().from(claim)).toHaveLength(0)
    expect(await db.select().from(claimProvenance)).toHaveLength(0)
  })

  it('dedupes sources by content_hash (UNIQUE), preserving the first row, round-tripping arbitrary meta JSON', async () => {
    const hash = randomUUID()
    const meta = {
      domain: 'bidding',
      source_type: 'official_datasheet',
      product_id: 'SKU-123',
      nested: { axes: [1, 2, 3], ok: true },
    }
    const a = await addSource(db, {
      content: 'first bytes',
      contentHash: hash,
      kind: 'formal_document',
      authorityScore: 0.9,
      meta,
    })
    const b = await addSource(db, {
      content: 'SECOND bytes',
      contentHash: hash,
      kind: 'human_qa',
      authorityScore: 0.1,
      meta: { totally: 'different' },
    })
    expect(b.sourceId).toBe(a.sourceId) // second insert deduped to the same row
    const rows = await db.select().from(source).where(eq(source.contentHash, hash))
    expect(rows).toHaveLength(1)
    // the conflicting second write must NOT overwrite the existing row's fields
    expect(rows[0]!.content).toBe('first bytes')
    expect(rows[0]!.kind).toBe('formal_document')
    expect(rows[0]!.authorityScore).toBe(0.9)
    expect(rows[0]!.meta).toEqual(meta)
  })

  it('two distinct content_hashes create two distinct sources (the negative of dedupe)', async () => {
    const a = await addSource(db, { content: 'x', contentHash: randomUUID(), kind: 'human_qa' })
    const b = await addSource(db, { content: 'y', contentHash: randomUUID(), kind: 'human_qa' })
    expect(b.sourceId).not.toBe(a.sourceId)
    expect(await db.select().from(source)).toHaveLength(2)
  })

  it('supersede appends a new claim under the SAME lineage_id, marks old superseded, no physical delete', async () => {
    const { sourceId } = await seedSource()
    const { claimId: oldId } = await appendClaim(db, embedder, { claimText: 'v1' }, [
      { sourceId, locator: 'l' },
    ])
    const oldBefore = (await db.select().from(claim).where(eq(claim.id, oldId)))[0]!

    const { claimId: newId } = await supersedeClaim(db, embedder, oldId, { claimText: 'v2' }, [
      { sourceId, locator: 'l' },
    ])
    const newRow = (await db.select().from(claim).where(eq(claim.id, newId)))[0]!
    expect(newRow.lineageId).toBe(oldBefore.lineageId) // same lineage across versions

    const oldAfter = (await db.select().from(claim).where(eq(claim.id, oldId)))[0]
    expect(oldAfter).toBeDefined() // still queryable — no physical delete
    expect(oldAfter!.status).toBe('superseded')

    const rels = await db.select().from(relation).where(eq(relation.fromClaim, newId))
    expect(rels.some((r) => r.type === 'supersedes' && r.toClaim === oldId)).toBe(true)
  })

  it('persists multiple provenances for one claim in a single transaction', async () => {
    const s1 = await seedSource()
    const s2 = await seedSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'multi-src fact' }, [
      { sourceId: s1.sourceId, locator: 'a', relevance: 'exact' },
      { sourceId: s2.sourceId, locator: 'b', relevance: 'supporting' },
    ])
    const provs = await db
      .select()
      .from(claimProvenance)
      .where(eq(claimProvenance.claimId, claimId))
    expect(provs).toHaveLength(2)
    expect(new Set(provs.map((p) => p.sourceId))).toEqual(new Set([s1.sourceId, s2.sourceId]))
    expect(new Set(provs.map((p) => p.relevance))).toEqual(new Set(['exact', 'supporting']))
  })

  it('rolls back the WHOLE append when one of several provenances has a bad source (atomic across rows)', async () => {
    const { sourceId } = await seedSource()
    await expect(
      appendClaim(db, embedder, { claimText: 'partial' }, [
        { sourceId, locator: 'good' },
        { sourceId: randomUUID(), locator: 'bad' }, // nonexistent source → FK fails after prov #1 inserted
      ]),
    ).rejects.toThrow()
    expect(await db.select().from(claim)).toHaveLength(0)
    expect(await db.select().from(claimProvenance)).toHaveLength(0)
  })

  it('defaults provenance relevance to "supporting" when omitted', async () => {
    const { sourceId } = await seedSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'def' }, [
      { sourceId, locator: 'l' },
    ])
    const provs = await db
      .select()
      .from(claimProvenance)
      .where(eq(claimProvenance.claimId, claimId))
    expect(provs[0]!.relevance).toBe('supporting')
  })

  it('append() stamps a continuous computed confidence + factor snapshot (命门 — replaces the 0/0/{} placeholder)', async () => {
    const { sourceId } = await seedSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'c' }, [
      { sourceId, locator: 'l' },
    ])
    const row = (await db.select().from(claim).where(eq(claim.id, claimId)))[0]!
    expect(row.confidence).toBeGreaterThan(0) // no longer the 0 placeholder
    expect(row.confidence).toBeLessThanOrEqual(1)
    expect(row.confidence).toBe(row.confidenceRaw) // g = identity
    const cf = row.confidenceFactors as {
      calibrationVersion: string
      weights: typeof DEFAULT_WEIGHTS
      factors: Record<string, number>
    }
    expect(cf.calibrationVersion).toBe('identity')
    expect(cf.weights).toEqual(DEFAULT_WEIGHTS)
    expect(cf.factors.authority).toBe(0.5) // seedSource default authority_score
    expect(row.createdBy).toBe('agent:unknown')
  })

  it('keeps one stable lineage across a supersede chain (v1 -> v2 -> v3), append-only', async () => {
    const { sourceId } = await seedSource()
    const v1 = await appendClaim(db, embedder, { claimText: 'v1' }, [{ sourceId, locator: 'l' }])
    const v2 = await supersedeClaim(db, embedder, v1.claimId, { claimText: 'v2' }, [
      { sourceId, locator: 'l' },
    ])
    const v3 = await supersedeClaim(db, embedder, v2.claimId, { claimText: 'v3' }, [
      { sourceId, locator: 'l' },
    ])

    const rows = await db.select().from(claim)
    const byId = new Map(rows.map((r) => [r.id, r]))
    const lineage = byId.get(v1.claimId)!.lineageId
    expect(byId.get(v2.claimId)!.lineageId).toBe(lineage)
    expect(byId.get(v3.claimId)!.lineageId).toBe(lineage) // one stable lineage across all three
    expect(byId.get(v1.claimId)!.status).toBe('superseded')
    expect(byId.get(v2.claimId)!.status).toBe('superseded')
    expect(byId.get(v3.claimId)!.status).toBe('draft') // head
    expect(rows).toHaveLength(3) // append-only: nothing deleted
  })

  it('supersedeClaim enforces D1 — empty provenance throws and writes no new version', async () => {
    const { sourceId } = await seedSource()
    const { claimId: v1 } = await appendClaim(db, embedder, { claimText: 'v1' }, [
      { sourceId, locator: 'l' },
    ])
    await expect(supersedeClaim(db, embedder, v1, { claimText: 'v2' }, [])).rejects.toThrow(
      /D1|provenance/i,
    )
    expect(await db.select().from(claim)).toHaveLength(1) // only v1; no v2 written
    expect(await db.select().from(relation)).toHaveLength(0) // no supersedes edge
  })

  it('supersedeClaim throws and writes nothing when the target claim does not exist', async () => {
    const { sourceId } = await seedSource()
    await expect(
      supersedeClaim(db, embedder, randomUUID(), { claimText: 'v2' }, [{ sourceId, locator: 'l' }]),
    ).rejects.toThrow(/not found/i)
    expect(await db.select().from(claim)).toHaveLength(0)
    expect(await db.select().from(relation)).toHaveLength(0)
  })

  it('supersedeClaim refuses to supersede an already-superseded claim (sequential no-fork)', async () => {
    const { sourceId } = await seedSource()
    const { claimId: v1 } = await appendClaim(db, embedder, { claimText: 'v1' }, [
      { sourceId, locator: 'l' },
    ])
    await supersedeClaim(db, embedder, v1, { claimText: 'v2' }, [{ sourceId, locator: 'l' }]) // v1 -> superseded
    await expect(
      supersedeClaim(db, embedder, v1, { claimText: 'v2-fork' }, [{ sourceId, locator: 'l' }]),
    ).rejects.toThrow(/already superseded/i)
    expect(await db.select().from(claim)).toHaveLength(2) // v1, v2 only — no forked head
  })

  it('serializes concurrent supersedes of the same head — single-head invariant (SELECT FOR UPDATE)', async () => {
    const { sourceId } = await seedSource()
    const { claimId: v1 } = await appendClaim(db, embedder, { claimText: 'v1' }, [
      { sourceId, locator: 'l' },
    ])
    const results = await Promise.allSettled([
      supersedeClaim(db, embedder, v1, { claimText: 'A' }, [{ sourceId, locator: 'l' }]),
      supersedeClaim(db, embedder, v1, { claimText: 'B' }, [{ sourceId, locator: 'l' }]),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1) // exactly one wins
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1) // the other is rejected
    const claims = await db.select().from(claim)
    expect(claims).toHaveLength(2) // v1 + the single winning version — no fork
    expect(claims.filter((c) => c.status === 'draft')).toHaveLength(1) // single head under the lineage
  })

  it('D1 DB-layer backstop: a provenance with NULL source_id is physically rejected (NOT NULL)', async () => {
    const { sourceId } = await seedSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'real' }, [
      { sourceId, locator: 'l' },
    ])
    // bypass the SPI guard, hit the table directly: a NULL source_id must be rejected by the DB (Story 36)
    await expect(
      pool.query(
        'INSERT INTO claim_provenance (id, claim_id, source_id, locator) VALUES ($1, $2, NULL, $3)',
        [randomUUID(), claimId, 'x'],
      ),
    ).rejects.toThrow()
  })

  it.each([
    ['empty string', ''],
    ['all whitespace', '   '],
  ])(
    'EGR-CR-023 DB-layer backstop: a blank locator (%s) is physically rejected even when bypassing the SPI guard (CHECK constraint)',
    async (_label, locator) => {
      const { sourceId } = await seedSource()
      const { claimId } = await appendClaim(db, embedder, { claimText: 'real' }, [
        { sourceId, locator: 'page 1' },
      ])
      // bypass the SPI guard, hit the table directly via drizzle: the DB CHECK must reject a blank locator
      await expect(
        db.insert(claimProvenance).values({
          id: randomUUID(),
          claimId,
          sourceId,
          locator,
          relevance: 'supporting',
        }),
      ).rejects.toThrow()
    },
  )

  it('命门 end-to-end: 1 source vs 3 independent sources vs a stale source → three distinct continuous confidences', async () => {
    const s1 = await seedSource()
    const single = await appendClaim(db, embedder, { claimText: 'fact' }, [
      { sourceId: s1.sourceId, locator: 'l' },
    ])

    const a = await seedSource()
    const b = await seedSource()
    const c = await seedSource()
    const triple = await appendClaim(db, embedder, { claimText: 'fact' }, [
      { sourceId: a.sourceId, locator: 'l' },
      { sourceId: b.sourceId, locator: 'l' },
      { sourceId: c.sourceId, locator: 'l' },
    ])

    const sStale = await seedSource()
    const twoYearsAgo = new Date(Date.now() - 730 * 86_400_000) // one half-life for structured_spec
    const stale = await appendClaim(db, embedder, { claimText: 'fact', asOf: twoYearsAgo }, [
      { sourceId: sStale.sourceId, locator: 'l' },
    ])

    const confOf = async (id: string) =>
      (await db.select().from(claim).where(eq(claim.id, id)))[0]!.confidence
    const cSingle = await confOf(single.claimId)
    const cTriple = await confOf(triple.claimId)
    const cStale = await confOf(stale.claimId)

    expect(cTriple).toBeGreaterThan(cSingle) // more independent corroboration → higher
    expect(cStale).toBeLessThan(cSingle) // staleness decays it
    for (const v of [cSingle, cTriple, cStale]) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThan(1)
    }
    expect(new Set([cSingle, cTriple, cStale]).size).toBe(3) // three distinct, non-bucketed values
  })

  it('supersede recomputes confidence from the NEW version provenances (v1 single < v2 three independent)', async () => {
    const s1 = await seedSource()
    const v1 = await appendClaim(db, embedder, { claimText: 'fact' }, [
      { sourceId: s1.sourceId, locator: 'l' },
    ])
    const a = await seedSource()
    const b = await seedSource()
    const c = await seedSource()
    const v2 = await supersedeClaim(db, embedder, v1.claimId, { claimText: 'fact' }, [
      { sourceId: a.sourceId, locator: 'l' },
      { sourceId: b.sourceId, locator: 'l' },
      { sourceId: c.sourceId, locator: 'l' },
    ])
    const rowOf = async (id: string) => (await db.select().from(claim).where(eq(claim.id, id)))[0]!
    const r1 = await rowOf(v1.claimId)
    const r2 = await rowOf(v2.claimId)
    expect(r2.confidence).toBeGreaterThan(r1.confidence) // recomputed from 3 independent sources
    const cf2 = r2.confidenceFactors as { factors: { indepSupport: number } }
    expect(cf2.factors.indepSupport).toBeCloseTo(0.75, 10) // 3 sources → 1 - 0.5^2
  })

  it('confidence uses the dominant (highest-authority) source for f0 and its kind for half-life', async () => {
    // strong formal_document (authority 0.9, half-life 730) + weak human_qa (authority 0.2, half-life 90)
    const strong = await addSource(db, {
      content: 's',
      contentHash: randomUUID(),
      kind: 'formal_document',
      authorityScore: 0.9,
    })
    const weak = await addSource(db, {
      content: 'w',
      contentHash: randomUUID(),
      kind: 'human_qa',
      authorityScore: 0.2,
    })
    const oneYearAgo = new Date(Date.now() - 365 * 86_400_000)
    const { claimId } = await appendClaim(db, embedder, { claimText: 'mixed', asOf: oneYearAgo }, [
      { sourceId: strong.sourceId, locator: 'l' },
      { sourceId: weak.sourceId, locator: 'l' },
    ])
    const row = (await db.select().from(claim).where(eq(claim.id, claimId)))[0]!
    const cf = row.confidenceFactors as { factors: { authority: number; staleDecay: number } }
    expect(cf.factors.authority).toBe(0.9) // the strongest source, not the first / weakest
    // dominant kind = formal_document (730) → 0.5^(365/730), NOT human_qa (90) → 0.5^(365/90)
    expect(cf.factors.staleDecay).toBeCloseTo(Math.pow(0.5, 365 / 730), 6)
  })

  it('indepSupport counts DISTINCT sources — citing one source twice does not inflate corroboration (命门 red line)', async () => {
    const { sourceId } = await seedSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'dup' }, [
      { sourceId, locator: 'p1' },
      { sourceId, locator: 'p2' }, // same source, different locator
    ])
    const row = (await db.select().from(claim).where(eq(claim.id, claimId)))[0]!
    const cf = row.confidenceFactors as { factors: { indepSupport: number } }
    expect(cf.factors.indepSupport).toBe(0) // 1 distinct source → no independent corroboration, not 2
  })

  // EGR-CR-024 (#102): two derived siblings (B, C) sharing an un-cited ancestor R must NOT inflate f3.
  // The claim cites only B and C; the fix recursively loads R via derived_from so the two collapse to the
  // single root lineage → 1 independent support → independentSupportScore(1) = 0, NOT 0.5.
  it('indepSupport collapses sibling derived sources sharing an un-cited ancestor (shared ancestor f3 — EGR-CR-024)', async () => {
    const R = await addSource(db, {
      content: 'datasheet',
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.5,
    })
    const B = await addSource(db, {
      content: 'derivedB',
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.5,
      derivedFromSourceId: R.sourceId,
    })
    const C = await addSource(db, {
      content: 'derivedC',
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.5,
      derivedFromSourceId: R.sourceId,
    })
    const { claimId } = await appendClaim(db, embedder, { claimText: 'sibling f3' }, [
      { sourceId: B.sourceId, locator: 'l1' },
      { sourceId: C.sourceId, locator: 'l2' }, // cites only B, C — never R
    ])
    const cf = (await db.select().from(claim).where(eq(claim.id, claimId)))[0]!
      .confidenceFactors as {
      factors: { indepSupport: number }
    }
    expect(cf.factors.indepSupport).toBe(0) // collapse to root R ⇒ 1 independent support ⇒ score 0, not 0.5
  })

  it('all five enums match Appendix A.1 exactly', () => {
    expect(sourceKind.enumValues).toEqual([
      'formal_document',
      'structured_spec',
      'human_qa',
      'conversation_log',
      'historical_artifact',
      'agent_synthesis',
      'external_feed',
    ])
    expect(claimStatus.enumValues).toEqual([
      'draft',
      'active',
      'flagged',
      'quarantined',
      'superseded',
    ])
    expect(relationType.enumValues).toEqual([
      'supports',
      'contradicts',
      'refines',
      'derived_from',
      'supersedes',
    ])
    expect(provRelevance.enumValues).toEqual(['exact', 'supporting', 'tangential', 'irrelevant'])
    expect(verificationKind.enumValues).toEqual(['patrol', 'usage_truth', 'reembed_marker'])
  })
})

describe('S8 contradiction detection (append, optimistic — record both, never block)', () => {
  async function appendStructured(
    subject: string,
    predicate: string,
    object: string,
    text: string,
  ) {
    const { sourceId } = await seedSource()
    return appendClaim(db, embedder, { claimText: text, subject, predicate, object }, [
      { sourceId, locator: 'l', relevance: 'exact' },
    ])
  }
  const contradictsEdges = () => db.select().from(relation).where(eq(relation.type, 'contradicts'))

  it('records a contradicts edge for a reversed-object fact and keeps BOTH claims (append not blocked)', async () => {
    const { claimId: a } = await appendStructured('sku-1', 'supports', '4k@120', 'A')
    const { claimId: b } = await appendStructured('sku-1', 'supports', '1080p@60', "A'")
    expect(
      await db
        .select()
        .from(claim)
        .where(inArray(claim.id, [a, b])),
    ).toHaveLength(2) // both kept
    const edges = await contradictsEdges()
    expect(edges).toHaveLength(1)
    expect(edges[0]!.fromClaim).toBe(b) // new → existing
    expect(edges[0]!.toClaim).toBe(a)
  })

  it('records no contradiction for the SAME object (same fact, not reversed)', async () => {
    await appendStructured('sku-1', 'supports', '4k@120', 'first')
    await appendStructured('sku-1', 'supports', '4k@120', 'second')
    expect(await contradictsEdges()).toHaveLength(0)
  })

  it('records no contradiction across a different subject or predicate', async () => {
    await appendStructured('sku-1', 'supports', '4k@120', 'base')
    await appendStructured('sku-2', 'supports', '1080p', 'diff subject')
    await appendStructured('sku-1', 'requires', '1080p', 'diff predicate')
    expect(await contradictsEdges()).toHaveLength(0)
  })

  it('does not detect contradictions for unstructured claims (no subject/predicate/object)', async () => {
    const { sourceId } = await seedSource()
    await appendClaim(db, embedder, { claimText: 'unstructured one' }, [{ sourceId, locator: 'l' }])
    await appendClaim(db, embedder, { claimText: 'unstructured two' }, [{ sourceId, locator: 'l' }])
    expect(await contradictsEdges()).toHaveLength(0)
  })

  it('records no contradiction when the new claim lacks an object, or when the existing object is null', async () => {
    const s = await seedSource()
    // new claim partially structured (object null) → recordContradictions early-returns, no detection
    await appendClaim(db, embedder, { claimText: 'partial', subject: 'sku-x', predicate: 'p' }, [
      { sourceId: s.sourceId, locator: 'l' },
    ])
    // now a fully-structured claim on the same subject+predicate: the existing null-object row is NOT a contradiction
    await appendStructured('sku-x', 'p', '4k', 'full now')
    expect(await contradictsEdges()).toHaveLength(0)
  })

  it('does not contradict a SUPERSEDED existing claim (only live versions participate)', async () => {
    const { claimId: old } = await appendStructured('sku-z', 'res', '4k', 'old')
    await db.update(claim).set({ status: 'superseded' }).where(eq(claim.id, old))
    await appendStructured('sku-z', 'res', '1080p', 'new reversed') // old superseded → excluded
    expect(await contradictsEdges()).toHaveLength(0)
  })

  it('a third reversed-object fact contradicts BOTH prior versions (two edges)', async () => {
    await appendStructured('sku-9', 'maxres', '720p', 'v1')
    await appendStructured('sku-9', 'maxres', '1080p', 'v2')
    const { claimId: c } = await appendStructured('sku-9', 'maxres', '4k', 'v3')
    const edges = await contradictsEdges()
    // v2 contradicts v1 (1), v3 contradicts v1 and v2 (2) → 3 total
    expect(edges).toHaveLength(3)
    expect(edges.filter((e) => e.fromClaim === c)).toHaveLength(2) // v3 → v1, v3 → v2
  })
})
