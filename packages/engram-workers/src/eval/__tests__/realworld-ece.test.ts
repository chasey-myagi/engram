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

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addSource,
  appendClaim,
  createDb,
  makeFakeEmbedder,
  makeFakeEntailmentJudge,
  makeFakeSameFactJudge,
  reportUsage,
  schema,
  type DB,
  type Embedder,
} from '@engram/core'

import { makeFakeSourceReader } from '../../read/fake-source-reader.js'
import {
  buildCorroboratedCorpus,
  buildRealWorldCorpus,
  type RealWorldFact,
} from '../realworld-ece/corpus.js'
import {
  ingestCorpus,
  makeExtractingFakeRuntime,
  promoteEligible,
  runCorroboratedEce,
  runRealWorldEce,
  type CorroboratedDeps,
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

function corroboratedDeps(): CorroboratedDeps {
  return { ...deps(), entailmentJudge: makeFakeEntailmentJudge() }
}

/**
 * 预置一条**与本次评测无关**的、能被旧 `collectFactSamples` 误收的 usage_truth 行(EGR-CR-060)。
 * 走真写路径:addSource + appendClaim 落一条真 claim,再 reportUsage 记一条满足 shape 过滤
 * (predictedConfidence 为数、outcome='adopted')的样本。它**没有**本次 run 的 evalRunId,
 * 故修复后(读端按 evalRunId 过滤)不得被本次测量收进来。
 */
async function seedUnrelatedUsageTruth(marker: string): Promise<void> {
  const src = await addSource(db, {
    content: `unrelated historical artifact ${marker}`,
    kind: 'historical_artifact',
    authorityScore: 0.9,
  })
  const { claimId } = await appendClaim(
    db,
    embedder,
    {
      claimText: `Unrelated-${marker} is a stray usage_truth sample`,
      subject: `Unrelated-${marker}`,
      predicate: 'is',
      object: 'a stray usage_truth sample',
      asOf: new Date(),
      createdBy: 'agent:eval-seed',
    },
    [{ sourceId: src.sourceId, locator: `unrel:${marker}`, relevance: 'exact' }],
  )
  await reportUsage(db, claimId, 'adopted', {
    taskId: `unrelated-${marker}`,
    byRole: 'agent:eval-consumer',
    confidenceAtRecall: 0.9,
  })
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

    // 核心:0 晋升,全部归**预期**门拦截(conf<0.5),无非门错误(接线故障)。
    expect(result.promotion.promoted).toBe(0)
    expect(result.promotion.expectedBlocked).toBe(facts.length)
    expect(result.promotion.unexpectedError).toBe(0)
    for (const o of result.promotion.outcomes) {
      expect(o.kind).toBe('expected_blocked')
      expect(o.detail).toContain('< 0.5')
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

  it('③ 回归(EGR-CR-061):非门 transition error(claim 被删)→ fail-loud,不计入 expectedBlocked', async () => {
    // 落实台账 Regression Test Map 第 1472 行:非 confidence-gate 的 transition error 不得静默吞成正常 blocked。
    // 直接调 promoteEligible(绕开 runRealWorldEce)以便注入异常前置态;单 fact、与 corpus 其他事实隔离。
    const marker = randomUUID()
    const fact: RealWorldFact = {
      id: `egr-cr-061-${marker}`,
      subject: `RegressionSentinel-${marker}`,
      predicate: 'is',
      docText: `RegressionSentinel-${marker} is a sentinel fact`,
      query: `RegressionSentinel-${marker}`,
      isTrue: true,
      sourceAuthority: 0.9,
    }
    const facts = [fact]
    const ingest = await ingestCorpus(deps(), facts, { sourcesPerFact: 1 })
    const claimId = ingest.claimsByFact.get(fact.id)?.[0]
    expect(claimId).toBeTruthy()

    // 预置非门错误:删掉 claim ⇒ transitionClaim 抛 `transition: claim <id> not found`(transition.ts:104,非门)。
    // 先清掉指向它的 provenance(FK 约束),再删 claim 本体。
    await db.delete(schema.claimProvenance).where(eq(schema.claimProvenance.claimId, claimId!))
    await db.delete(schema.claim).where(eq(schema.claim.id, claimId!))

    // 方案 A(rethrow):非门错误必须 fail-loud,而非被吞成 expected_blocked。
    await expect(promoteEligible(deps(), facts, ingest.claimsByFact)).rejects.toThrow(
      /unexpected transition failure/,
    )
    // 错误链路保留被删 claimId / not found,定位用。
    await expect(promoteEligible(deps(), facts, ingest.claimsByFact)).rejects.toThrow(
      new RegExp(`${claimId}.*not found`),
    )
  }, 120_000)

  it('④ 回归(EGR-CR-061):entailment 门(entailmentPass=false)归 expected_blocked,不误判为非门错误', async () => {
    // 证明白名单覆盖 transition.ts:148 那条门文案(`entailment did not pass`),不被当成接线故障 rethrow。
    const marker = randomUUID()
    const fact: RealWorldFact = {
      id: `egr-cr-061-entail-${marker}`,
      subject: `EntailSentinel-${marker}`,
      predicate: 'is',
      docText: `EntailSentinel-${marker} is a sentinel fact`,
      query: `EntailSentinel-${marker}`,
      isTrue: true,
      sourceAuthority: 0.9,
    }
    const facts = [fact]
    const ingest = await ingestCorpus(deps(), facts, { sourcesPerFact: 1 })
    const claimId = ingest.claimsByFact.get(fact.id)?.[0]
    expect(claimId).toBeTruthy()

    // 人为把 conf 抬过 0.5 门(直接写 stored factors,让 raw 重算结果 ≥0.5),使晋升只可能卡在 entailment 门。
    // f0=indepSupport 给满 → base 抬高;identity 校准 ⇒ conf=raw。这样 conf<0.5 门不再触发,改由 entailmentPass=false 拦。
    const [before] = await db
      .select({ factors: schema.claim.confidenceFactors })
      .from(schema.claim)
      .where(eq(schema.claim.id, claimId!))
    const stored = before!.factors as {
      factors: Record<string, number>
      weights: Record<string, number>
      calibrationVersion: string
    }
    const bumped = { ...stored, factors: { ...stored.factors, indepSupport: 1, authority: 1 } }
    await db
      .update(schema.claim)
      .set({ confidenceFactors: bumped })
      .where(eq(schema.claim.id, claimId!))

    const stats = await promoteEligible(deps(), facts, ingest.claimsByFact, {
      entailmentPass: false,
    })
    // 若 conf 仍未过门则拦在 conf<0.5;两条门文案都属 expected_blocked,核心断言是:不 rethrow、不计 unexpectedError。
    expect(stats.unexpectedError).toBe(0)
    expect(stats.promoted).toBe(0)
    expect(stats.expectedBlocked).toBe(1)
    expect(stats.outcomes[0]!.kind).toBe('expected_blocked')
  }, 120_000)

  it('⑤ 回归(EGR-CR-060):预置无关 usage_truth 后,extraction-only 仍测空集(本次 run 隔离)', async () => {
    // 台账 Regression Test Map 第 1471 行的硬性回归:runRealWorldEce 的 measurement 必须只含本次 run 产出的样本,
    // 不得把库里已有的历史 usage_truth(M2 pilot / 旧 M3-A / reflux 回放等)混进来。
    // red(未修前必失败):旧 collectFactSamples(deps.db) 无差别读整库 ⇒ 收到 N 条预置样本 ⇒ sampleCount=N>0、measurement 非 null。
    const marker = randomUUID()
    // 预置 3 条与本次 corpus 无关、但满足 collectFactSamples shape 过滤(能被旧实现误收)的历史样本。
    await seedUnrelatedUsageTruth(`${marker}-a`)
    await seedUnrelatedUsageTruth(`${marker}-b`)
    await seedUnrelatedUsageTruth(`${marker}-c`)

    const result = await runRealWorldEce(deps(), { sourcesPerFact: 1, entailmentPass: true })

    // 本次 extraction-only 确实 0 晋升、0 usage(与测② 一致)。
    expect(result.usage.usageRows).toBe(0)
    // 关键:尽管库里有 3 条预置样本,本次测量集仍只含本 run 样本(=0)。
    expect(result.sampleCount).toBe(0)
    // 空集 ⇒ 无曲线,不得因历史样本返回非 null。
    expect(result.measurement).toBeNull()
  }, 120_000)

  it('⑥ 回归(EGR-CR-060):有真实样本时 sampleCount 严格等于本次 usageRows(护栏不变量)', async () => {
    // 用 runCorroboratedEce(多源印证路径,会真产出 active claim 与 usage 样本)跑一次;调用前同样预置无关 usage_truth。
    // red:旧实现 sampleCount = usageRows + N(混入预置)⇒ 断言失败。green:按 evalRunId 过滤后精确相等。
    const marker = randomUUID()
    await seedUnrelatedUsageTruth(`co-${marker}-a`)
    await seedUnrelatedUsageTruth(`co-${marker}-b`)

    const facts = buildCorroboratedCorpus()
    const result = await runCorroboratedEce(corroboratedDeps(), { binCount: 20, heldoutEvery: 3 })

    // 本次写入 usage 行数 = 本次读回样本数,预置历史样本一条都不混入。
    expect(result.usage.usageRows).toBe(facts.length)
    expect(result.sampleCount).toBe(result.usage.usageRows)
    // ECE 完全基于本 run 数据。
    expect(result.measurement).not.toBeNull()
    expect(result.measurement!.totalSamples).toBe(result.usage.usageRows)
  }, 120_000)

  it('⑦ 单元(EGR-CR-060):evalRunId 不匹配且 taskId 缺失的样本不被本次过滤收入', async () => {
    // 守 pilot.ts 的 taskId 缺失退化空串隐患:即便 taskId 缺失,只要 evalRunId 不属于本次 run,过滤后就不该返回它。
    const runId = randomUUID()
    const otherClaimMarker = randomUUID()
    // 落一条真 claim,reportUsage 时**故意不带 taskId**(退化空串),且不带本次 runId 的 evalRunId。
    const src = await addSource(db, {
      content: `unrelated no-taskid artifact ${otherClaimMarker}`,
      kind: 'historical_artifact',
      authorityScore: 0.9,
    })
    const { claimId } = await appendClaim(
      db,
      embedder,
      {
        claimText: `NoTaskId-${otherClaimMarker} is a stray sample`,
        subject: `NoTaskId-${otherClaimMarker}`,
        predicate: 'is',
        object: 'a stray sample',
        asOf: new Date(),
        createdBy: 'agent:eval-seed',
      },
      [{ sourceId: src.sourceId, locator: `notaskid:${otherClaimMarker}`, relevance: 'exact' }],
    )
    await reportUsage(db, claimId, 'adopted', {
      byRole: 'agent:eval-consumer',
      confidenceAtRecall: 0.7,
    })

    const { collectFactSamples } = await import('../calibration-pilot/pilot.js')
    // 按本次(空)run 过滤:不应收到那条 evalRunId 不匹配、taskId 缺失的样本。
    const scoped = await collectFactSamples(db, { evalRunId: runId })
    expect(scoped.some((s) => s.factId === '')).toBe(false)
    expect(scoped.length).toBe(0)
  }, 120_000)
})
