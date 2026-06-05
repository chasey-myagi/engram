/**
 * M2 校准 pilot 的 CI 守门(fake 端口、真测试 DB、不联网)——守 pilot **逻辑**:接地语料 seed → 真 recall 产 usage →
 * isotonic 拟合 g → 留出集上 g 把 ECE 压下。真 Qwen 嵌入版见 calibration-pilot/run.ts(env-gated,不进 CI)。
 *
 * 不是 smoke:断言(1)语料确实注入了可观的 identity 校准误差(有东西可校);(2)g 在**留出集**上把 ECE 压下
 * (不只训练集——证明学到的是泛化的单调修正、非过拟合);(3)g 非平凡(≥2 结点)。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDb, makeFakeEmbedder, type DB, type Embedder } from '@engram/core'

import { runCalibrationPilot } from '../calibration-pilot/pilot.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
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
const embedder: Embedder = makeFakeEmbedder()

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
}, 60_000)

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

describe('M2 · 校准 pilot(接地语料 → 真 recall+usage → isotonic g 在留出集压低 ECE)', () => {
  it('校准闭环闭合:语料有可观 identity 校准误差,g 在**留出集**上把 ECE 压下、且 g 非平凡', async () => {
    const { seed, usage, measurement } = await runCalibrationPilot(db, embedder, {
      consumers: 6,
      heldoutEvery: 3,
    })

    // seed:至少 mid+strong 档晋升 active 并可召回(全 fact 都过 D2 晋升门设计)。
    expect(seed.promoted).toBeGreaterThan(0)
    expect(usage.recallHits).toBeGreaterThan(0)
    // 样本量够拟合(独立 (by_role,taskId) 去重后)。
    expect(measurement.totalSamples).toBeGreaterThanOrEqual(60)
    expect(measurement.heldoutCount).toBeGreaterThan(0)

    // ① 语料确实注入了可观的过自信(否则无东西可校,测试就没意义)。
    expect(measurement.identity.ece).toBeGreaterThan(0.03)
    // ② g 非平凡(学到了一条单调映射,不是 identity)。
    expect(measurement.fittedG.knots.length).toBeGreaterThanOrEqual(2)
    // ③ 关键:g 在**留出集**上把 ECE 压下(泛化的单调修正,不是过拟合训练集)。
    expect(measurement.calibrated.ece).toBeLessThan(measurement.identity.ece)
    expect(measurement.eceDrop).toBeGreaterThan(0)
  }, 120_000)
})
