/**
 * EGR-CR-043 · 受控 source metadata 缝（T3）的 CI 守门（真测试 DB）。
 *
 * 验：recall result 顺 provenance 扇出带回**受控、只读、白名单过滤**的 `sourceMeta`——
 *   - 白名单内的 key（source_type）随出处带回；
 *   - 白名单外的 key（vendor）即便存在 source.meta 也不外泄（证明「受控」而非整条透传）；
 *   - sourceMeta 被 Object.freeze（只读，consumer 不可改写 core 内部存储投影）；
 *   - source 无任何白名单 key → sourceMeta 为 {}，recall 不报错。
 *
 * 这条缝是为让领域 adapter 拿到自己注入的业务身份而开——adapter 据此收紧，不再穿透 schema 旁路查 source.meta。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { claim, claimProvenance } from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource } from './append-claim.js'
import { RECALL_SOURCE_META_KEYS, recallClaims } from './recall-claims.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const embedder = makeFakeEmbedder()

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL })
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
  pool.on('error', () => {})
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
}, 60_000)

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

beforeEach(async () => {
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, page_claims, standards CASCADE',
  )
})

// 直落一条已知 raw 的 active claim + 出处（seed 路径）。5 因子全置 raw、衰减置 1 ⇒ recalled value == raw。
async function seedActiveClaim(text: string, sourceId: string, raw = 0.9): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: text,
    status: 'active',
    confidence: raw,
    confidenceRaw: raw,
    confidenceFactors: {
      factors: {
        authority: raw,
        humanReview: raw,
        entailment: raw,
        indepSupport: raw,
        usageCorrect: raw,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: DEFAULT_WEIGHTS,
      calibrationVersion: CALIBRATION_IDENTITY,
    },
    embedding: await embedder.embed(text),
    embeddingVersion: embedder.version,
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
  })
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

describe('EGR-CR-043 · recall result carries controlled, read-only, whitelisted sourceMeta', () => {
  it('exposes whitelisted source_type, drops non-whitelisted vendor, and freezes the summary', async () => {
    const src = await addSource(db, {
      content: 'datasheet',
      kind: 'formal_document',
      meta: { source_type: 'official_datasheet', vendor: 'acme' }, // vendor is NOT whitelisted
    })
    const id = await seedActiveClaim('metadata seam claim', src.sourceId, 0.9)

    const results = await recallClaims(db, embedder, 'metadata seam')
    const r = results.find((x) => x.claim.id === id)!
    expect(r).toBeDefined()
    const sm = r.provenances[0]!.sourceMeta

    // 白名单内：source_type 随出处带回。
    expect(sm.source_type).toBe('official_datasheet')
    // 白名单外：vendor 即便在 source.meta 也不外泄（受控暴露，非整条透传）。
    expect('vendor' in sm).toBe(false)
    expect(sm.vendor).toBeUndefined()
    expect(RECALL_SOURCE_META_KEYS).not.toContain('vendor')
    // 只读：sourceMeta 被冻结，consumer 不可改写 core 内部存储投影。
    expect(Object.isFrozen(sm)).toBe(true)
  })

  it('a source without any whitelisted key yields an empty (frozen) sourceMeta — recall does not error', async () => {
    const src = await addSource(db, {
      content: 'feed item',
      kind: 'external_feed', // no source_type in meta
    })
    const id = await seedActiveClaim('bare source claim', src.sourceId, 0.9)

    const results = await recallClaims(db, embedder, 'bare source')
    const r = results.find((x) => x.claim.id === id)!
    expect(r).toBeDefined()
    const sm = r.provenances[0]!.sourceMeta
    expect(sm.source_type).toBeUndefined()
    expect(Object.keys(sm)).toEqual([])
    expect(Object.isFrozen(sm)).toBe(true)
  })
})
