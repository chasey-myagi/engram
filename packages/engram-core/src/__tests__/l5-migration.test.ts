import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource, appendClaim } from '../spi/append-claim.js'
import { writeHumanReview } from '../editor/human-review.js'
import { transitionClaim } from '../spi/transition.js'
import { recallClaims } from '../spi/recall-claims.js'
import { L5_GAP_QUESTIONS } from '../eval/l5-gap.js'
import {
  getKnowledgeGrewEvents,
  isMigratedOutOfL5,
  liveL5Questions,
  migrateL5IfGrew,
} from '../eval/l5-migration.js'

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
    'TRUNCATE source, claim, claim_provenance, claim_verification, knowledge_grew_events CASCADE',
  )
})

/** Make the L5 gap question answerable by self-authoring a claim addressable by its query (real write SPI). */
async function answerL5(query: string): Promise<string> {
  const src = await addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.95,
  })
  const { claimId } = await appendClaim(
    db,
    embedder,
    { claimText: query, createdBy: 'agent:self' },
    [{ sourceId: src.sourceId, locator: 'p1', relevance: 'exact' }],
  )
  await writeHumanReview(db, {
    claimId,
    byRole: 'human:editor',
    verdict: { humanReview: 1, action: 'approve' },
  })
  await transitionClaim(db, claimId, 'active', { by: 'human:test', entailmentPass: true })
  return claimId
}

const Q0 = L5_GAP_QUESTIONS[0]!

describe('S31 L5 → spine migration ("knowledge grew")', () => {
  it('a zero-recall L5 question that becomes answerable (recall≥1 + human-confirmed) is migrated OUT of L5 and recorded as "knowledge grew"', async () => {
    // before: the L5 question is a blind spot (empty KB ⇒ zero recall)
    expect(await recallClaims(db, embedder, Q0.query)).toHaveLength(0)
    expect(await isMigratedOutOfL5(db, Q0.id)).toBe(false)

    // the KB grows its own answer ⇒ the question becomes answerable
    await answerL5(Q0.query)
    expect((await recallClaims(db, embedder, Q0.query)).length).toBeGreaterThanOrEqual(1)

    // migrate: recall≥1 AND human-confirmed ⇒ migrated out, recorded as knowledge-grew (append-only)
    const res = await migrateL5IfGrew(db, embedder, Q0.id, {
      confirmedBy: 'human:editor',
      releaseSnapshot: 'rel-2',
    })
    expect(res.migrated).toBe(true)
    expect(res.recalledCount).toBeGreaterThanOrEqual(1)
    expect(await isMigratedOutOfL5(db, Q0.id)).toBe(true)

    const grew = await getKnowledgeGrewEvents(db)
    expect(grew).toHaveLength(1)
    expect(grew[0]!.l5QuestionId).toBe(Q0.id)
    expect(grew[0]!.query).toBe(Q0.query)
    expect(grew[0]!.releaseSnapshot).toBe('rel-2')
  })

  it('a STILL zero-recall L5 question is NOT migrated (it remains a blind spot)', async () => {
    const res = await migrateL5IfGrew(db, embedder, Q0.id, {
      confirmedBy: 'human:editor',
      releaseSnapshot: 'rel-1',
    })
    expect(res.migrated).toBe(false)
    expect(res.reasons.some((r) => /zero-recall/.test(r))).toBe(true)
    expect(await isMigratedOutOfL5(db, Q0.id)).toBe(false)
    expect(await getKnowledgeGrewEvents(db)).toHaveLength(0)
  })

  it('HITL gate: an answerable L5 question is NOT migrated without a HUMAN confirmation (agent cannot self-report growth)', async () => {
    await answerL5(Q0.query)
    const res = await migrateL5IfGrew(db, embedder, Q0.id, {
      confirmedBy: 'agent:self', // not human
      releaseSnapshot: 'rel-1',
    })
    expect(res.migrated).toBe(false)
    expect(res.reasons.some((r) => /not human-confirmed/.test(r))).toBe(true)
    expect(await isMigratedOutOfL5(db, Q0.id)).toBe(false)
  })

  it('append-only & idempotent: migrating the same grown question twice does not stack a second row', async () => {
    await answerL5(Q0.query)
    const first = await migrateL5IfGrew(db, embedder, Q0.id, {
      confirmedBy: 'human:editor',
      releaseSnapshot: 'rel-1',
    })
    expect(first.migrated).toBe(true)
    const second = await migrateL5IfGrew(db, embedder, Q0.id, {
      confirmedBy: 'human:editor',
      releaseSnapshot: 'rel-1',
    })
    expect(second.migrated).toBe(false)
    expect(second.reasons.some((r) => /already migrated/.test(r))).toBe(true)
    expect(await getKnowledgeGrewEvents(db)).toHaveLength(1) // exactly one row, no stacking
  })

  it('liveL5Questions drops the migrated question from the active blind-spot set (frozen fixture is NOT physically deleted)', async () => {
    await answerL5(Q0.query)
    await migrateL5IfGrew(db, embedder, Q0.id, {
      confirmedBy: 'human:editor',
      releaseSnapshot: 'r',
    })
    const live = await liveL5Questions(db)
    expect(live.some((q) => q.id === Q0.id)).toBe(false) // dropped from the live set
    expect(live.length).toBe(L5_GAP_QUESTIONS.length - 1)
    // but the frozen fixture itself is untouched (append-only migration = logical, not destructive)
    expect(L5_GAP_QUESTIONS.some((q) => q.id === Q0.id)).toBe(true)
  })

  it('only a frozen L5 question id can be migrated (a random id is rejected)', async () => {
    await expect(
      migrateL5IfGrew(db, embedder, 'not-an-l5-id', {
        confirmedBy: 'human:editor',
        releaseSnapshot: 'r',
      }),
    ).rejects.toThrow(/not a frozen L5 gap question/)
  })
})
