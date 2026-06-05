/**
 * M2 校准 pilot 的 CI 守门(fake 端口、真测试 DB、不联网)——守 g-校准映射拟合闭环的逻辑:接地语料 seed →
 * 真 recall 产 usage(读回真 usage_truth 燃料)→ isotonic 拟合 g → **按 fact 切分**(留出事实 g 未见)上 g 把 ECE 压下。
 * 真 Qwen 嵌入版见 calibration-pilot/run.ts(env-gated,不进 CI)。
 *
 * **射程**:验命门的**校准映射(g)半边**(usage→拟合→压 ECE)在真 recall+真 usage 上闭环;raw 七因子计算半边在 seed
 * 时被直接设值绕过(它本身在 core 的 confidence 单测里验),M2 不测它。
 *
 * 三测:①闭环 + 真泛化(留出事实零跨边 + g 在未见事实上压 ECE);②语料前提不变量(过自信被真注入);③负对照(良校准输入 ⇒ g 不无中生有压 ECE)。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDb, makeFakeEmbedder, type DB, type Embedder } from '@engram/core'

import { buildCorpus, NUM_LEVELS } from '../calibration-pilot/corpus.js'
import {
  measureFromSamples,
  runCalibrationPilot,
  type FactSample,
} from '../calibration-pilot/pilot.js'

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

describe('M2 · 校准 pilot(g 拟合闭环:接地语料 → 真 recall+usage → 按 fact 切分、留出事实上压 ECE)', () => {
  it('① 闭环 + 真泛化:留出事实零跨边,g 非平凡,且在未见事实上把 ECE 压下', async () => {
    const { seed, usage, measurement, persistedSamples } = await runCalibrationPilot(db, embedder, {
      heldoutEvery: 3,
    })

    expect(seed.promoted).toBeGreaterThan(0)
    expect(usage.recallHits).toBeGreaterThan(0)
    expect(measurement.heldoutCount).toBeGreaterThan(0)
    // 读回口径一致:本地读回样本数 = 生产校准取样器(collectUsageCalibrationSamples)所见。
    expect(persistedSamples).toBe(measurement.totalSamples)

    // 结构性 sanity(本语料一 fact 一 usage ⇒ 恒 0,非硬泛化证据);真泛化的实证是下面 ECE 在**同档不同事实**上下降。
    expect(measurement.factsInBothSides).toBe(0)

    // 语料确实注入了可观的过自信(否则无东西可校)。
    expect(measurement.identity.ece).toBeGreaterThan(0.03)
    // g 非平凡:学到一条有跨度的单调映射(y 跨度 > 0.05),不是常值/identity。
    const ys = measurement.fittedG.knots.map((k) => k.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.05)
    // 关键(真泛化):g 在**未见事实**(同档不同事实,g 没见过它们的标签)上把 ECE 压下 ⇒ 学到的是档级正确率的泛化修正。
    expect(measurement.calibrated.ece).toBeLessThan(measurement.identity.ece)
    expect(measurement.eceDrop).toBeGreaterThan(0)
  }, 120_000)

  it('② 语料前提不变量:各档实测真值率单调升、且每档严格低于该档 rawTarget(过自信真被注入)', () => {
    const facts = buildCorpus()
    const rates: number[] = []
    for (let level = 0; level < NUM_LEVELS; level++) {
      const fs = facts.filter((f) => f.level === level)
      expect(fs.length).toBeGreaterThan(0)
      const trueRate = fs.filter((f) => f.isTrue).length / fs.length
      // 过自信:每档真值率严格低于该档 rawTarget(raw 高估正确率)。
      expect(trueRate).toBeLessThan(fs[0]!.rawTarget)
      rates.push(trueRate)
    }
    // 单调:档号越高(rawTarget 越大)真值率越高 ⇒ raw 有信息量(g 该学单调、非翻转)。
    for (let i = 1; i < rates.length; i++) expect(rates[i]!).toBeGreaterThan(rates[i - 1]!)
    // 客观真值:每个事实都有非空 object(altAt 保证 false 事实 object ≠ 真值)。
    for (const f of facts) expect(f.object.length).toBeGreaterThan(0)
  })

  it('③ 负对照:良校准输入(各档正确率≈rawTarget)⇒ g 不无中生有压 ECE(eceDrop≈0)', () => {
    // 5 档 × 20 事实,每档 k=round(raw·20) 条正确 ⇒ 观测正确率≈raw(本就良校准)。每事实唯一 factId、按 fact 切分。
    const samples: FactSample[] = []
    let fid = 0
    for (const raw of [0.5, 0.6, 0.7, 0.8, 0.9]) {
      const n = 20
      const k = Math.round(raw * n)
      for (let i = 0; i < n; i++)
        samples.push({ factId: `nc-${fid++}`, rawPredicted: raw, correct: i < k })
    }
    const m = measureFromSamples(samples, { heldoutEvery: 3 })
    expect(m.factsInBothSides).toBe(0)
    // 输入本就良校准:identity ECE 低(阈值留宽:量化 round(raw·20)+按 fact 子采样会让留出子集略偏离档基率,
    // 实测~0.047;放到 0.08 避免无关采样噪声假红——本测要证的是 g 的**克制**,不是子集的精确校准)。
    expect(m.identity.ece).toBeLessThan(0.08)
    // g 不该在已良校准的输入上无中生有"改善"(防"总把 ECE 压向基率"的 bug)。
    expect(Math.abs(m.eceDrop)).toBeLessThan(0.05)
  })
})
