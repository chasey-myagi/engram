import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
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

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool // connected to the base db; creates/drops the per-run db
let pool: pg.Pool // connected to this run's throwaway db
let db: DB
let testDbName: string

// 每次测试运行用一个独立的一次性数据库做隔离：并发的多个测试进程（含 review-gate 的多 agent 同跑）
// 各自有库，TRUNCATE 不会跨进程互踩、不再死锁/FK 违例。run 结束 DROP 掉。
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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, page_claims CASCADE',
  )
})

async function seedSource(meta: Record<string, unknown> = {}) {
  return addSource(db, {
    content: 'datasheet body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    meta,
  })
}

describe('S1 walking skeleton: append_claim + D1 hard gate', () => {
  it('persists a draft claim plus exactly its provenance in one atomic transaction', async () => {
    const { sourceId } = await seedSource()
    const { claimId } = await appendClaim(db, { claimText: 'SKU-123 supports 4K@120' }, [
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
    await expect(appendClaim(db, { claimText: 'orphan' }, [])).rejects.toThrow(/D1|provenance/i)
    expect(await db.select().from(claim)).toHaveLength(0)
    expect(await db.select().from(claimProvenance)).toHaveLength(0)
  })

  it('rolls back the whole append when a provenance points at a nonexistent source (NOT NULL FK)', async () => {
    await expect(
      appendClaim(db, { claimText: 'bad-prov' }, [{ sourceId: randomUUID(), locator: 'x' }]),
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
    const { claimId: oldId } = await appendClaim(db, { claimText: 'v1' }, [
      { sourceId, locator: 'l' },
    ])
    const oldBefore = (await db.select().from(claim).where(eq(claim.id, oldId)))[0]!

    const { claimId: newId } = await supersedeClaim(db, oldId, { claimText: 'v2' }, [
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
    const { claimId } = await appendClaim(db, { claimText: 'multi-src fact' }, [
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
      appendClaim(db, { claimText: 'partial' }, [
        { sourceId, locator: 'good' },
        { sourceId: randomUUID(), locator: 'bad' }, // nonexistent source → FK fails after prov #1 inserted
      ]),
    ).rejects.toThrow()
    expect(await db.select().from(claim)).toHaveLength(0)
    expect(await db.select().from(claimProvenance)).toHaveLength(0)
  })

  it('defaults provenance relevance to "supporting" when omitted', async () => {
    const { sourceId } = await seedSource()
    const { claimId } = await appendClaim(db, { claimText: 'def' }, [{ sourceId, locator: 'l' }])
    const provs = await db
      .select()
      .from(claimProvenance)
      .where(eq(claimProvenance.claimId, claimId))
    expect(provs[0]!.relevance).toBe('supporting')
  })

  it('append() stamps the S1 placeholder confidence triple + default createdBy (locks the S2 contract)', async () => {
    const { sourceId } = await seedSource()
    const { claimId } = await appendClaim(db, { claimText: 'c' }, [{ sourceId, locator: 'l' }])
    const row = (await db.select().from(claim).where(eq(claim.id, claimId)))[0]!
    expect(row.confidence).toBe(0)
    expect(row.confidenceRaw).toBe(0)
    expect(row.confidenceFactors).toEqual({})
    expect(row.createdBy).toBe('agent:unknown')
  })

  it('keeps one stable lineage across a supersede chain (v1 -> v2 -> v3), append-only', async () => {
    const { sourceId } = await seedSource()
    const v1 = await appendClaim(db, { claimText: 'v1' }, [{ sourceId, locator: 'l' }])
    const v2 = await supersedeClaim(db, v1.claimId, { claimText: 'v2' }, [
      { sourceId, locator: 'l' },
    ])
    const v3 = await supersedeClaim(db, v2.claimId, { claimText: 'v3' }, [
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
    const { claimId: v1 } = await appendClaim(db, { claimText: 'v1' }, [{ sourceId, locator: 'l' }])
    await expect(supersedeClaim(db, v1, { claimText: 'v2' }, [])).rejects.toThrow(/D1|provenance/i)
    expect(await db.select().from(claim)).toHaveLength(1) // only v1; no v2 written
    expect(await db.select().from(relation)).toHaveLength(0) // no supersedes edge
  })

  it('supersedeClaim throws and writes nothing when the target claim does not exist', async () => {
    const { sourceId } = await seedSource()
    await expect(
      supersedeClaim(db, randomUUID(), { claimText: 'v2' }, [{ sourceId, locator: 'l' }]),
    ).rejects.toThrow(/not found/i)
    expect(await db.select().from(claim)).toHaveLength(0)
    expect(await db.select().from(relation)).toHaveLength(0)
  })

  it('supersedeClaim refuses to supersede an already-superseded claim (sequential no-fork)', async () => {
    const { sourceId } = await seedSource()
    const { claimId: v1 } = await appendClaim(db, { claimText: 'v1' }, [{ sourceId, locator: 'l' }])
    await supersedeClaim(db, v1, { claimText: 'v2' }, [{ sourceId, locator: 'l' }]) // v1 -> superseded
    await expect(
      supersedeClaim(db, v1, { claimText: 'v2-fork' }, [{ sourceId, locator: 'l' }]),
    ).rejects.toThrow(/already superseded/i)
    expect(await db.select().from(claim)).toHaveLength(2) // v1, v2 only — no forked head
  })

  it('serializes concurrent supersedes of the same head — single-head invariant (SELECT FOR UPDATE)', async () => {
    const { sourceId } = await seedSource()
    const { claimId: v1 } = await appendClaim(db, { claimText: 'v1' }, [{ sourceId, locator: 'l' }])
    const results = await Promise.allSettled([
      supersedeClaim(db, v1, { claimText: 'A' }, [{ sourceId, locator: 'l' }]),
      supersedeClaim(db, v1, { claimText: 'B' }, [{ sourceId, locator: 'l' }]),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1) // exactly one wins
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1) // the other is rejected
    const claims = await db.select().from(claim)
    expect(claims).toHaveLength(2) // v1 + the single winning version — no fork
    expect(claims.filter((c) => c.status === 'draft')).toHaveLength(1) // single head under the lineage
  })

  it('D1 DB-layer backstop: a provenance with NULL source_id is physically rejected (NOT NULL)', async () => {
    const { sourceId } = await seedSource()
    const { claimId } = await appendClaim(db, { claimText: 'real' }, [{ sourceId, locator: 'l' }])
    // bypass the SPI guard, hit the table directly: a NULL source_id must be rejected by the DB (Story 36)
    await expect(
      pool.query(
        'INSERT INTO claim_provenance (id, claim_id, source_id, locator) VALUES ($1, $2, NULL, $3)',
        [randomUUID(), claimId, 'x'],
      ),
    ).rejects.toThrow()
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
