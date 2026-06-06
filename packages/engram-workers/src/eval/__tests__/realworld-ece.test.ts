/**
 * M3-A(lean)真实世界 ECE 骨架的 CI 守门(fake 端口、真测试 DB、不联网)。真 Qwen 版见 realworld-ece/run.ts(env-gated)。
 *
 * **核心实证(测②)**:extraction-only(每事实单源)抽出的 claim 物理上**进不了可消费态**——单源 raw 封顶
 *   0.3·auth+0.075(≤0.375),晋升门 conf≥0.5 全拦死 ⇒ 0 晋升、0 usage 样本、measurement=null。这正是内核
 *   「置信靠挣不靠声称」红线的实证:光抽取的 emergent 置信测的是空集,要真 ECE 曲线必须上多源印证 + Verifier。
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
  makeFakeSameFactJudge,
  type DB,
  type Embedder,
} from '@engram/core'

import { makeFakeSourceReader } from '../../read/fake-source-reader.js'
import { buildRealWorldCorpus } from '../realworld-ece/corpus.js'
import {
  makeExtractingFakeRuntime,
  runRealWorldEce,
  type RealWorldDeps,
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

function deps(): RealWorldDeps {
  return {
    db,
    embedder,
    judge: makeFakeSameFactJudge(),
    runtime: makeExtractingFakeRuntime(),
    reader: makeFakeSourceReader(),
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

describe('M3-A · lean 真实世界 ECE 骨架', () => {
  it('① 语料前提不变量:真值~50/50、authority∈[0.6,1] 且与真假解耦、id/docText/query 齐备', () => {
    const facts = buildRealWorldCorpus()
    expect(facts.length).toBeGreaterThanOrEqual(30)

    const trueRate = facts.filter((f) => f.isTrue).length / facts.length
    expect(trueRate).toBeGreaterThan(0.4)
    expect(trueRate).toBeLessThan(0.6)

    for (const f of facts) {
      expect(f.sourceAuthority).toBeGreaterThanOrEqual(0.6)
      expect(f.sourceAuthority).toBeLessThanOrEqual(1.0)
      expect(f.id.length).toBeGreaterThan(0)
      expect(f.docText.length).toBeGreaterThan(0)
      expect(f.query.length).toBeGreaterThan(0)
    }
    expect(new Set(facts.map((f) => f.id)).size).toBe(facts.length)
    expect(new Set(facts.map((f) => f.docText)).size).toBe(facts.length)

    // authority 与真假解耦:真组 / 假组的平均 authority 接近(差 < 0.1,排除"高权威=真"的混淆)。
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const tAuth = mean(facts.filter((f) => f.isTrue).map((f) => f.sourceAuthority))
    const fAuth = mean(facts.filter((f) => !f.isTrue).map((f) => f.sourceAuthority))
    expect(Math.abs(tAuth - fAuth)).toBeLessThan(0.1)
  })

  it('② 实证:extraction-only(单源)→ 每事实恰一条 draft、晋升门全拦、measurement=空集', async () => {
    const facts = buildRealWorldCorpus()
    // 单次 ingest(此 DB 仅本测写入,无跨测污染);entailmentPass=true 也拦得住 ⇒ 拦在 conf<0.5 而非 entailment。
    const result = await runRealWorldEce(deps(), { sourcesPerFact: 1, entailmentPass: true })

    // 忠实抽取:每事实都 distill 成功,且经 provenance 反查恰好一条 claim(单源、无跨事实误并)。
    expect(result.ingest.distillDone).toBe(facts.length)
    expect(result.ingest.claimsByFact.size).toBe(facts.length)
    for (const f of facts) expect(result.ingest.claimsByFact.get(f.id)?.length).toBe(1)
    expect(result.promotion.outcomes.length).toBe(facts.length)
    expect(result.promotion.noClaim).toBe(0)

    // 核心:0 晋升,全部被门拦,且拦的原因是 conf<0.5(不是别的偶发错误)。
    expect(result.promotion.promoted).toBe(0)
    expect(result.promotion.blocked).toBe(facts.length)
    for (const o of result.promotion.outcomes) {
      expect(o.reason).toContain('< 0.5')
    }

    // emergent raw 实测符合公式 base=0.3·auth+0.075(单源 indep=0、entail 中性 0.5),且全 < 0.4 ≪ 0.5 门。
    const byFact = new Map(facts.map((f) => [f.id, f]))
    for (const o of result.promotion.outcomes) {
      const f = byFact.get(o.factId)!
      expect(o.raw).not.toBeNull()
      expect(o.raw!).toBeCloseTo(0.3 * f.sourceAuthority + 0.075, 2)
    }
    expect(result.promotion.rawSorted.at(-1)!).toBeLessThan(0.4)

    // ⇒ 无 active ⇒ recall 全空 ⇒ 0 usage 样本 ⇒ 无校准曲线(extraction-only 测空集)。
    expect(result.usage.usageRows).toBe(0)
    expect(result.sampleCount).toBe(0)
    expect(result.measurement).toBeNull()
  }, 120_000)
})
