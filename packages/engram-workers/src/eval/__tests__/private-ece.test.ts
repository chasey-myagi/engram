/**
 * M3-B 的 CI 守门(fake 端口、真测试 DB、不联网)——守**私域语料 + 注入式自定义 corpus 走 runCorroboratedEce 全程闭环**。
 *
 * M3-B 与 Option C 同一管线、只换语料(判官无法世界核查的虚构事实 + 注入错源)。**真区别只在真 Qwen 判官**:它对私域
 * 事实无先验、查不出假 claim ⇒ 假货进消费门 ⇒ 真带过自信(见 run-private.ts 真跑)。CI 用 pass-everything 判官替身,
 * 故两语料行为一致;这里只验:① 私域语料不变量(虚构实体、注入错源、单调过自信、窄带);② runCorroboratedEce 接受
 * **注入 corpus** 仍端到端闭环(抽取→印证→晋升→召回→usage→g 在留出事实上压低 ECE)。零额度、确定性。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createDb,
  makeFakeEmbedder,
  makeFakeEntailmentJudge,
  makeFakeSameFactJudge,
  type DB,
  type Embedder,
} from '@engram/core'

import { makeFakeSourceReader } from '../../read/fake-source-reader.js'
import { buildPrivateCorpus } from '../realworld-ece/corpus.js'
import {
  makeExtractingFakeRuntime,
  runCorroboratedEce,
  type CorroboratedDeps,
} from '../realworld-ece/harness.js'

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

function deps(): CorroboratedDeps {
  return {
    db,
    embedder,
    judge: makeFakeSameFactJudge(),
    runtime: makeExtractingFakeRuntime(),
    reader: makeFakeSourceReader(),
    entailmentJudge: makeFakeEntailmentJudge(), // 替身:一律 pass(真 run 才用真判官,见 run-private.ts)
  }
}

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  pool.on('error', () => {})
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
}, 60_000)

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

describe('M3-B · 私域事实(判官无法核查)真过自信 ECE', () => {
  it('① 私域语料不变量:48 条虚构事实、注入错源、3 tier 单调过自信、窄带', () => {
    const facts = buildPrivateCorpus()
    expect(facts.length).toBe(48)
    expect(new Set(facts.map((f) => f.id)).size).toBe(48)
    expect(new Set(facts.map((f) => f.docText)).size).toBe(48)

    // 虚构实体:subject 带族代号(VX-/KX-/MRLN-/QP-),LLM 无先验 ⇒ 判官无法世界核查。
    const codeRe = /(VX|KX|MRLN|QP)-\d+/
    for (const f of facts) expect(f.subject).toMatch(codeRe)

    // 注入错源:false fact 的 docText 用错记值(= 真值+17);true 用真值。oracle 据 isTrue 判 adopted/refuted。
    // 这里只校 false 确实存在且 docText 与 query 配套(query 不含具体值)。
    expect(facts.some((f) => !f.isTrue)).toBe(true)
    for (const f of facts) {
      expect(f.docText).toContain(f.subject)
      expect(f.query.endsWith('what')).toBe(true)
    }

    // 3 tier × 16、tier 内真值率命中注入率、单调过自信、置信落 [0.5,0.6) 窄带(同 Option C 铺法)。
    const tiers = [...new Set(facts.map((f) => f.tier))].sort((a, b) => a - b)
    expect(tiers).toEqual([0, 1, 2])
    const conf: number[] = []
    const rate: number[] = []
    for (const t of tiers) {
      const fs = facts.filter((f) => f.tier === t)
      expect(fs.length).toBe(16)
      const trueRate = fs.filter((f) => f.isTrue).length / fs.length
      expect(trueRate).toBeCloseTo(fs[0]!.tierTrueRate, 5)
      expect(trueRate).toBeLessThan(fs[0]!.expectedConfidence) // 过自信
      expect(fs[0]!.expectedConfidence).toBeGreaterThanOrEqual(0.5)
      expect(fs[0]!.expectedConfidence).toBeLessThan(0.6)
      conf.push(fs[0]!.expectedConfidence)
      rate.push(trueRate)
    }
    for (let i = 1; i < tiers.length; i++) {
      expect(conf[i]!).toBeGreaterThan(conf[i - 1]!)
      expect(rate[i]!).toBeGreaterThan(rate[i - 1]!)
    }
  })

  it('② 注入 corpus 走全程闭环:抽取→印证→晋升→召回→usage→g 在留出事实上压低 ECE', async () => {
    const facts = buildPrivateCorpus()
    const r = await runCorroboratedEce(deps(), { facts, binCount: 20, heldoutEvery: 3 })

    // runCorroboratedEce 接受注入 corpus(facts 参数),全 48 条经管线晋升+召回。
    expect(r.distillDone).toBe(facts.length)
    expect(r.promoted).toBe(facts.length) // pass-everything 替身 ⇒ 真假都进(真 run 才见真判官筛选)
    expect(r.usage.usageRows).toBe(facts.length)
    expect(r.sampleCount).toBe(facts.length)

    // 召回置信真实集合 = 语料 expectedConfidence(钉到真因子流水线,权重漂移即大声失败)。
    const distinctReal = [...new Set(r.confSorted.map((c) => Number(c.toFixed(3))))].sort(
      (a, b) => a - b,
    )
    const distinctExpected = [...new Set(facts.map((f) => f.expectedConfidence))].sort(
      (a, b) => a - b,
    )
    expect(distinctReal).toEqual(distinctExpected)

    // 注入过自信被 g 在留出事实上压下(测量机器对私域 corpus 同样工作)。
    expect(r.measurement).not.toBeNull()
    const m = r.measurement!
    expect(m.heldoutCount).toBeGreaterThan(0)
    expect(m.factsInBothSides).toBe(0)
    expect(m.identity.ece).toBeGreaterThan(0.03)
    expect(m.calibrated.ece).toBeLessThan(m.identity.ece)
    expect(m.eceDrop).toBeGreaterThan(0)
    // g 非平凡:学到一条有跨度的单调映射(knot y 跨度 > 0.05),不是塌成常值/identity 仍靠 trivial drop 蒙混。
    const ys = m.fittedG.knots.map((k) => k.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.05)
  }, 120_000)
})
