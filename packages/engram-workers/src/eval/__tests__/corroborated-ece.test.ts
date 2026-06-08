/**
 * Option C 的 CI 守门(fake 端口、真测试 DB、不联网)——守**校准测量机器**全程在 fake 下闭环:
 *   Distiller 形抽取(makeExtractingFakeRuntime)→ 多源印证(n=4,直接挂出处+重算 indep)→ Verifier
 *   (judge=makeFakeEntailmentJudge **默认一律 pass**)→ 内核晋升过 0.5 门的 → 真 recall(fake 三元组袋嵌入足以
 *   语义命中共享前缀)→ oracle usage → measureFromSamples。真 Qwen 版见 realworld-ece/run-corroborated.ts(env-gated)。
 *
 * ⚠️ **射程界定(诚实)**:这里 entailment 判官是「一律 pass」的测试替身,刻意让真假 claim 都晋升,从而构造一个
 *   **被注入过自信的可消费集**,验证「g 在留出事实上把 ECE 压下」这条**测量机器**确实工作。它**不**代表真 Engram 行为:
 *   真 Qwen entailment 判官会对可世界核验的事实**事实核查**、把假 claim 挡在 active 之外(见 run-corroborated.ts 真跑结果)。
 *   即真系统里「过自信的可消费 claim」对可核验事实基本不存在;真过自信梯度需不可核验的私域事实(M3-B)。
 *
 * 与 lean 空集实证(realworld-ece.test.ts)互补:那里证「光抽取进不了可消费态」,这里证「多源印证+核验后能进、
 * 且(在 pass-everything 判官下)注入的过自信被 g 在留出事实上压下」。fake 嵌入=bag-of-trigrams,共享长前缀 ⇒ recall 命中。
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
import { buildCorroboratedCorpus } from '../realworld-ece/corpus.js'
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
    judge: makeFakeSameFactJudge(), // 不同事实不并(distinct subject ⇒ unrelated);与真 run 同口径
    runtime: makeExtractingFakeRuntime(),
    reader: makeFakeSourceReader(),
    entailmentJudge: makeFakeEntailmentJudge(), // 默认 pass ⇒ Verifier 抬 f2、晋升过门的
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

describe('Option C · 多源印证 + 真 Verifier → 真 ECE 曲线', () => {
  it('① 语料不变量:48 条、3 tier 单调过自信、tier 内真值率命中、置信落 [0.5,0.6) 窄带', () => {
    const facts = buildCorroboratedCorpus()
    expect(facts.length).toBe(48)
    const tiers = [...new Set(facts.map((f) => f.tier))].sort((a, b) => a - b)
    expect(tiers).toEqual([0, 1, 2])
    const confByTier: number[] = []
    const rateByTier: number[] = []
    for (const t of tiers) {
      const fs = facts.filter((f) => f.tier === t)
      expect(fs.length).toBe(16)
      const trueRate = fs.filter((f) => f.isTrue).length / fs.length
      // tier 内实测真值率 = 注入率(Bresenham 均匀铺开,精确)。
      expect(trueRate).toBeCloseTo(fs[0]!.tierTrueRate, 5)
      // 过自信:每 tier 真值率严格低于其预期置信。
      expect(trueRate).toBeLessThan(fs[0]!.expectedConfidence)
      // 落在可消费窄带(且 ≥0.5 门,配 Verifier entail pass 后能晋升)。
      expect(fs[0]!.expectedConfidence).toBeGreaterThanOrEqual(0.5)
      expect(fs[0]!.expectedConfidence).toBeLessThan(0.6)
      confByTier.push(fs[0]!.expectedConfidence)
      rateByTier.push(trueRate)
    }
    // 单调:tier 越高,置信更高、真值率也更高(g 该学正斜率而非翻转)。
    for (let i = 1; i < tiers.length; i++) {
      expect(confByTier[i]!).toBeGreaterThan(confByTier[i - 1]!)
      expect(rateByTier[i]!).toBeGreaterThan(rateByTier[i - 1]!)
    }
  })

  it('② 全程闭环:抽取→印证→真 Verifier 晋升→召回→usage→g 在留出事实上压低 ECE', async () => {
    const facts = buildCorroboratedCorpus()
    const r = await runCorroboratedEce(deps(), { binCount: 20, heldoutEvery: 3 })

    // 抽取忠实 + 多源印证后过门晋升(与 lean 空集对照:这里 promoted 远 > 0)。
    expect(r.distillDone).toBe(facts.length)
    expect(r.committedTotal).toBe(facts.length)
    expect(r.verifierPatrolled).toBe(facts.length)
    expect(r.promoted).toBe(facts.length) // n=4 + entail pass ⇒ 两 tier 都过 0.5 门

    // 真 recall + usage:经 SPI 落 usage_truth、读回非空。
    expect(r.usage.recallHits).toBe(facts.length)
    expect(r.usage.usageRows).toBe(facts.length)
    expect(r.sampleCount).toBe(facts.length)

    // 召回置信落 [0.5,0.6) 窄带(emergent,经真因子流水线 + g=identity)。
    expect(r.confSorted[0]!).toBeGreaterThanOrEqual(0.5)
    expect(r.confSorted.at(-1)!).toBeLessThan(0.6)
    // 真实 recall 置信的 distinct 集合 = 语料 expectedConfidence —— 把「文档预测值」钉到**真因子流水线产出**上:
    // 内核 DEFAULT_WEIGHTS / indepSupport 公式一旦漂移,真值偏离 expectedConfidence ⇒ 本断言大声失败(防静默失真)。
    const distinctReal = [...new Set(r.confSorted.map((c) => Number(c.toFixed(3))))].sort(
      (a, b) => a - b,
    )
    const distinctExpected = [...new Set(facts.map((f) => f.expectedConfidence))].sort(
      (a, b) => a - b,
    )
    expect(distinctReal).toEqual(distinctExpected)

    // 测量非空 + 真泛化:注入了可观过自信(identity ECE 高),g 在**留出事实**上把 ECE 压下。
    expect(r.measurement).not.toBeNull()
    const m = r.measurement!
    expect(m.heldoutCount).toBeGreaterThan(0)
    expect(m.factsInBothSides).toBe(0)
    expect(m.identity.ece).toBeGreaterThan(0.03)
    expect(m.calibrated.ece).toBeLessThan(m.identity.ece)
    expect(m.eceDrop).toBeGreaterThan(0)
  }, 120_000)
})
