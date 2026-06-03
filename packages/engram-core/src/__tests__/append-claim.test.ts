import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb, createPool, type DB } from '../db/client.js'
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

let pool: pg.Pool
let db: DB

beforeAll(() => {
  pool = createPool()
  db = createDb(pool)
})
afterAll(async () => {
  await pool.end()
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

  it('dedupes sources by content_hash (UNIQUE) and round-trips arbitrary meta JSON the kernel never reads', async () => {
    const hash = randomUUID()
    const meta = {
      domain: 'bidding',
      source_type: 'official_datasheet',
      product_id: 'SKU-123',
      nested: { axes: [1, 2, 3], ok: true },
    }
    const a = await addSource(db, {
      content: 'same bytes',
      contentHash: hash,
      kind: 'formal_document',
      meta,
    })
    const b = await addSource(db, {
      content: 'same bytes',
      contentHash: hash,
      kind: 'formal_document',
      meta: { totally: 'different' },
    })
    expect(b.sourceId).toBe(a.sourceId) // second insert deduped to the same row
    const rows = await db.select().from(source).where(eq(source.contentHash, hash))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.meta).toEqual(meta) // first write's meta round-trips faithfully
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
