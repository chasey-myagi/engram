/**
 * EGR-CR-037 · EngramRunner public SPI 空 batch 守卫（integration/DB）。
 *
 * 钉死：public SPI `harvestUsage([])` 是 no-op —— 不 publish 空 `report_usage`、不把空 batch 派进 Harvester 工种、
 * 不对全库 usage_truth claim 重算 confidence。修前空数组会被 dispatcher 派给 harvester handler，handler 内的
 * harvestBatch([]) 再退化成 cron 全库重算；修后在 SPI 源头短路（A+B 双层里的 B），firedByWorker['harvester'] 干净。
 *
 * 按现有 per-file DB 约定搭壳（临时 Postgres、migrate、beforeEach TRUNCATE），注入 fake 端口 + 真 db。
 */
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
  makeFakeEmbedder,
  makeFakeEntailmentJudge,
  makeFakeSameFactJudge,
  reportUsage,
  schema,
  type DB,
} from '@engram/core'
import { createFakeModel } from '@harness-pi/core/testing'

import { EngramRunner, type EngramRunnerDeps } from '../runner/engram-runner.js'
import { makeFakeSourceReader } from '../read/fake-source-reader.js'
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
const WEIGHTS = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  pool.on('error', () => {}) // 吞 teardown 期 DROP ... WITH(FORCE) 终止连接的 57P01
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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, worker_failure CASCADE',
  )
})

/** 组装一个全注入 fake 端口的 EngramRunner（loop 工种的运行时注 harness-pi + 空 fake model 脚本；本套件不驱动 loop）。 */
function makeRunner(): EngramRunner {
  const idleRuntime = makeHarnessPiRuntime(createFakeModel([]))
  const deps: EngramRunnerDeps = {
    db,
    embedder,
    distiller: {
      db,
      embedder,
      judge: makeFakeSameFactJudge(),
      runtime: idleRuntime,
      reader: makeFakeSourceReader(),
    },
    verifier: { db, judge: makeFakeEntailmentJudge({ verdictOf: () => 'fail' }) },
    reconciler: { db, judge: makeFakeEntailmentJudge({ verdictOf: () => 'pass' }) },
    harvester: { db },
    arbiterRuntimeFor: () => idleRuntime,
  }
  return new EngramRunner(deps)
}

/** seed 一条有 usage_truth（adopted）的 claim —— 即「cron 全库扫描会重算」的那种。返回 id。 */
async function mkUsageClaim(claimText: string): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: `src for ${claimText}`,
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  const factors = {
    authority: 0.9,
    humanReview: 0,
    entailment: 0.5,
    indepSupport: 0.75,
    usageCorrect: 0,
    ageDays: 0,
    activeContradicts: 0,
    staleDecay: 1,
    conflictDecay: 1,
  }
  const id = randomUUID()
  await db.insert(schema.claim).values({
    id,
    claimText,
    status: 'active',
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: { factors, weights: WEIGHTS, calibrationVersion: 'identity' },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'agent:distiller',
    embedding: await embedder.embed(claimText),
    embeddingVersion: embedder.version,
  })
  await db.insert(schema.claimProvenance).values({
    id: randomUUID(),
    claimId: id,
    sourceId,
    locator: 'L1',
    relevance: 'exact',
  })
  // 3 个独立 consumer adopted → cron 重算会把 f4 从 0→1（给空 batch 一个清晰可反证的副作用）。
  for (const u of ['a', 'b', 'c']) {
    await reportUsage(db, id, 'adopted', { byRole: `consumer:${u}`, taskId: `t-${u}` })
  }
  return id
}

async function storedOf(claimId: string): Promise<{ usageCorrect: number; raw: number }> {
  const [row] = await db
    .select({ f: schema.claim.confidenceFactors, raw: schema.claim.confidenceRaw })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  const stored = row!.f as { factors: { usageCorrect: number } }
  return { usageCorrect: stored.factors.usageCorrect, raw: row!.raw }
}

describe('EngramRunner public SPI — EGR-CR-037 empty-batch guard', () => {
  it('harvestUsage([]) is a no-op: Harvester is NOT dispatched and no claim is recomputed (no full-table write)', async () => {
    const runner = makeRunner()
    const id = await mkUsageClaim('sku runner empty-batch')
    const before = await storedOf(id)
    expect(before.usageCorrect).toBe(0) // pre-harvest neutral

    // 空 batch：修前空 report_usage 被派发 → harvester handler 跑全库重算（f4 0→1）；修后 SPI 短路，不派发、不写。
    const res = await runner.harvestUsage([])

    // A+B 双层方案：harvester 一次都没被派发。
    expect(res.firedByWorker['harvester'] ?? 0).toBe(0)
    expect(res.dispatched).toBe(0)
    expect(res.traces).toEqual([])

    const after = await storedOf(id)
    expect(after.usageCorrect).toBe(before.usageCorrect) // 未被全库重算
    expect(after.raw).toBe(before.raw)
  })

  it('a NON-empty harvestUsage still recomputes (guards the empty-batch case only, not all batches)', async () => {
    const runner = makeRunner()
    const id = await mkUsageClaim('sku runner non-empty')
    expect((await storedOf(id)).usageCorrect).toBe(0)

    const res = await runner.harvestUsage([id])

    expect(res.firedByWorker['harvester']).toBe(1) // dispatched exactly once
    expect((await storedOf(id)).usageCorrect).toBe(1) // recomputed (f4 0→1)
  })
})
