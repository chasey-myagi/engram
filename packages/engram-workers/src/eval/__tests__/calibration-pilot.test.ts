/**
 * M2 校准 pilot 的 CI 守门(fake 端口、真测试 DB、不联网)——守 g-校准映射拟合闭环的逻辑:接地语料 seed →
 * 真 recall 产 usage(读回真 usage_truth 燃料)→ isotonic 拟合 g → **按 fact 切分**(留出事实 g 未见)上 g 把 ECE 压下。
 * 真 Qwen 嵌入版见 calibration-pilot/run.ts(env-gated,不进 CI)。
 *
 * **射程**:验命门的**校准映射(g)半边**(usage→拟合→压 ECE)在真 recall+真 usage 上闭环;raw 七因子计算半边在 seed
 * 时被直接设值绕过(它本身在 core 的 confidence 单测里验),M2 不测它。
 *
 * 四测:①闭环 + 真泛化(留出事实零跨边 + g 在未见事实上压 ECE);②语料前提不变量(过自信被真注入);③负对照(良校准输入 ⇒ g 不无中生有压 ECE);④强制 recall miss ⇒ pilot fail-loud(不在幸存子集上证明闭环)。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  appendClaim,
  createDb,
  makeFakeEmbedder,
  schema,
  transitionClaim,
  type DB,
  type Embedder,
} from '@engram/core'

import { buildCorpus, NUM_LEVELS } from '../calibration-pilot/corpus.js'
import {
  assertCalibrationPilotPass,
  checkCalibrationPilotPass,
  measureFromSamples,
  PILOT_MIN_HELDOUT,
  PILOT_MIN_SAMPLES,
  runCalibrationPilot,
  SEED_CREATED_BY,
  seedCorpus,
  type CalibrationMeasurement,
  type FactSample,
  type SeedSpi,
  type UsageStats,
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

// 由 ① 端到端跑出、供 R4(健康闭环不误伤)复用的真实健康输出。
let healthyUsage: UsageStats | undefined
let healthyMeasurement: CalibrationMeasurement | undefined

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

    // R4 复用:把端到端健康输出存给纯判据测试(见 describe「pilot 通过门」)。
    healthyUsage = usage
    healthyMeasurement = measurement

    expect(seed.promoted).toBeGreaterThan(0)
    expect(usage.recallHits).toBeGreaterThan(0)
    expect(measurement.heldoutCount).toBeGreaterThan(0)

    // 覆盖完整性 tie 回「丢弃之前」:零 miss、usage 写入无缺口、每 fact 一条 usage ⇒ usageRows === promoted。
    expect(usage.recallMisses).toBe(0) // 全命中:零 miss
    expect(usage.usageRows).toBe(usage.recallHits) // usage 写入无缺口
    expect(usage.usageRows).toBe(seed.promoted) // tie 回「丢弃之前」的 promoted facts
    // 生产取样器(按 (byRole,taskId) 去重)读回 = usageRows:本语料每条 usage 身份唯一 ⇒ 去重不缩水。
    expect(persistedSamples).toBe(usage.usageRows)
    // totalSamples(collectFactSamples 原始行读回、不去重)≥ persisted(去重后);**不**断言两者恒等——
    // 口径不同(EGR-CR-030 后 corrected/partial 会让 persisted 折叠缩水),钉死等式会在语义变动时误伤。
    expect(measurement.totalSamples).toBeGreaterThanOrEqual(persistedSamples)

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

  it('④ 强制 recall miss ⇒ pilot fail-loud:整条 throw,绝不静默在幸存子集上证明闭环', async () => {
    // 构造「必 miss」的真实场景:包装 fake embedder,让 corpus 中**某一个** fact 的 query 嵌入指向
    // 与全部 document 无公共三元组的"垃圾"向量(cosine=0 < minSimilarity 0.1 ⇒ 该 claim 必召不回)。
    // document 嵌入与其余 query 全透传 ⇒ 仅这一个 fact recall miss,其余全命中。这正是真 DashScope 嵌入下
    // 「一批事实召回不到」的最小复现:miss 的 fact 不进 usage_truth、不进测量集 ⇒ pilot 必须 fail-loud,
    // 不能在剩下的幸存命中子集上拟合 g 并"证明" ECE 下降。
    const base = makeFakeEmbedder()
    const missQuery = buildCorpus()[0]!.query // 取确定性语料的第一个 fact 的 query 作为被强制 miss 的目标
    const embedderWithForcedMiss: Embedder = {
      version: base.version,
      dim: base.dim,
      embed: (text, kind) =>
        // 只拦截那一个 query 的 query-嵌入,映射到与任何真实 statement 都无公共三元组的文本 ⇒ 召回 cosine=0、必 miss。
        kind === 'query' && text === missQuery
          ? base.embed('zzzqqqxxx_no_such_trigram_anywhere_zzz', 'query')
          : base.embed(text, kind),
    }

    // red(未修前):runCalibrationPilot 无 fail-loud 校验,有 miss 也只 recallMisses+=1 后静默 continue,
    //              在幸存子集上照常拟合 g、正常 return ⇒ "期望 throw" 失败。
    // green(修后):recallMisses !== 0(或覆盖不一致)让整条 pilot throw。
    await expect(
      runCalibrationPilot(db, embedderWithForcedMiss, { heldoutEvery: 3 }),
    ).rejects.toThrow(/recall 未覆盖|recallMisses|覆盖不一致|recall 命中/)
  }, 120_000)

  // ────────────────────────────────────────────────────────────────────────────
  // EGR-CR-041(#116)回归:seed 真走正式写 SPI + 晋升门、不冒充 distiller、provenance 失败不留 active orphan。
  // 选方案 1(证明真闭环)⇒ T1+T2+T3+T4。
  // ────────────────────────────────────────────────────────────────────────────

  it('T1 · seed 真走正式写 SPI(appendClaim×total + transitionClaim 过晋升门、非冒充 distiller)', async () => {
    // spy 适配器:包真 appendClaim/transitionClaim,断言 seed 真经它们(而非裸 db.insert)。
    const appendSpy = vi.fn(appendClaim)
    const transitionSpy = vi.fn(transitionClaim)
    const spi: SeedSpi = { appendClaim: appendSpy, transitionClaim: transitionSpy }

    const facts = buildCorpus()
    const seed = await seedCorpus(db, embedder, facts, spi)

    // appendClaim 每条 fact 调一次(经 D1 + 单事务写半边)。
    expect(appendSpy).toHaveBeenCalledTimes(seed.total)
    // transitionClaim 每条 fact 调一次,翻 active、蓝边(agent:*,非 human)、entailmentPass:true(过晋升门)。
    expect(transitionSpy).toHaveBeenCalledTimes(seed.total)
    for (const call of transitionSpy.mock.calls) {
      const [, , toStatus, opts] = call
      expect(toStatus).toBe('active')
      expect(opts.entailmentPass).toBe(true)
      expect(typeof opts.actor.role).toBe('string')
      expect(opts.actor.isHuman).toBe(false) // 蓝边晋升,绝非人 Approve 旁路门（授权认 isHuman 布尔）
    }

    // 不再冒用 distiller 身份:seed 出的 claim 一律 createdBy=SEED_CREATED_BY、无一为 'agent:distiller'。
    const claimIds = [...seed.claimIdByFact.values()]
    const rows = await db
      .select({ createdBy: schema.claim.createdBy, status: schema.claim.status })
      .from(schema.claim)
    const seeded = rows.filter((r) => r.status === 'active')
    expect(seeded.length).toBeGreaterThanOrEqual(claimIds.length)
    expect(rows.every((r) => r.createdBy !== 'agent:distiller')).toBe(true)
    expect(seeded.every((r) => r.createdBy === SEED_CREATED_BY)).toBe(true)
  }, 120_000)

  it('T2 · 故障注入:provenance 写失败整事务回滚,不留 active orphan claim', async () => {
    // 让 transitionClaim 透传,但 appendClaim 注入「provenance 指向不存在的 source」⇒ NOT NULL FK 违例 ⇒
    // appendClaim 的单事务整体回滚(claim + provenance 一起没写)。
    // **用一个本测专属、不与确定性语料撞车的 subject**,使本测的「故障 seed」是该 subject 上**唯一**的写入——
    // 这样「故障后该 subject 无 active claim」就精确等价于「故障没留下 orphan」,不受本文件其它测试共享 DB 的污染。
    const corpus0 = buildCorpus()[0]!
    const uniqueSubject = `T2-orphan-probe-${randomUUID()}`
    const fact = { ...corpus0, id: `t2-${randomUUID()}`, subject: uniqueSubject }

    // 用真 appendClaim,但把出处的 sourceId 换成一个不存在的 UUID ⇒ FK 违例、事务回滚。
    const ghostSource = randomUUID()
    const failingSpi: SeedSpi = {
      appendClaim: (database, emb, draft, _provs) =>
        appendClaim(database, emb, draft, [
          { sourceId: ghostSource, locator: 'cal:ghost', relevance: 'exact' },
        ]),
      transitionClaim,
    }

    // red(未修前):seedCorpus 裸两次独立 insert、无事务 ⇒ claim 已 active 后 provenance 失败 ⇒ 留 1 条 active orphan。
    // green(修后):经 appendClaim 单事务 ⇒ provenance(FK 违例)失败连 claim 一起回滚 ⇒ 0 orphan。
    await expect(seedCorpus(db, embedder, [fact], failingSpi)).rejects.toThrow()

    const after = await db
      .select({ id: schema.claim.id, status: schema.claim.status })
      .from(schema.claim)
      .where(eq(schema.claim.subject, uniqueSubject))
    // 关键断言:故障后该 subject **不存在** active claim(事务回滚 ⇒ 0 orphan)。
    expect(after.filter((r) => r.status === 'active').length).toBe(0)
    // 更强:连 draft 也没留下(整事务回滚,claim 行根本没落)——该 subject 行数为 0。
    expect(after.length).toBe(0)
  }, 120_000)

  it('T3 · seed 出的 active claim 都经晋升门(status=active ∧ T1 spy 证明经 transitionClaim),非裸写', async () => {
    // 经 transitionClaim spy 真过门 + 终态 active 联合证明:claim 是「过晋升门」翻 active,不是裸 insert status:'active'。
    const transitionSpy = vi.fn(transitionClaim)
    const spi: SeedSpi = { appendClaim, transitionClaim: transitionSpy }
    const facts = buildCorpus()
    const seed = await seedCorpus(db, embedder, facts, spi)

    const claimIds = [...seed.claimIdByFact.values()]
    const rows = await db
      .select({ id: schema.claim.id, status: schema.claim.status })
      .from(schema.claim)
    const byId = new Map(rows.map((r) => [r.id, r.status]))
    // 每条 seed claim:终态 active。
    for (const id of claimIds) expect(byId.get(id)).toBe('active')
    // 每条 active claim 都有一次对应的 promote 调用(过门记录),而非裸写。
    const promotedIds = new Set(
      transitionSpy.mock.calls
        .filter((c) => c[2] === 'active' && c[3]?.entailmentPass === true)
        .map((c) => c[1]),
    )
    for (const id of claimIds) expect(promotedIds.has(id)).toBe(true)
  }, 120_000)
})

/**
 * #117(EGR-CR-042)的核心回归:pilot 的 pass-gate(checkCalibrationPilotPass / assertCalibrationPilotPass)。
 * 纯判据、零 DB ⇒ 不依赖上面的 beforeAll 建库,直接喂构造数据。守三种退化必拒(样本不足 / heldout 空 / ECE 未改善)
 * + 健康闭环不误伤 + fail-loud 包装在失败时 throw。这是把 run.ts「无条件打印跑通 ✓ + 退出 0」堵成可拦截的诊断门。
 */
describe('#117 · pilot 通过门(纯判据:样本不足 / heldout 空 / ECE 未改善 ⇒ 拒;健康闭环 ⇒ 过)', () => {
  // recall 全命中、无东西可校时的占位 usage(R1/R2/R3 不经真 recall,只测纯判据)。
  const usageOk: UsageStats = { recallHits: 100, recallMisses: 0, usageRows: 100 }

  it('R1 · 空样本 ⇒ 判据不通过(样本不足 + heldout 空)', () => {
    const m = measureFromSamples([], { heldoutEvery: 3 })
    expect(m.totalSamples).toBe(0)
    expect(m.heldoutCount).toBe(0)
    // recall 全漏:无 usage 燃料。
    const noUsage: UsageStats = { recallHits: 0, recallMisses: 0, usageRows: 0 }
    const r = checkCalibrationPilotPass(noUsage, m)
    expect(r.passed).toBe(false)
    // 含样本不足与 heldout 空两项。
    expect(r.failures.some((f) => f.includes('样本不足'))).toBe(true)
    expect(r.failures.some((f) => f.includes('heldout'))).toBe(true)
  })

  it('R2 · heldout 过小(低于下限)⇒ 判据不通过', () => {
    // splitByFact 的 index-0 恒落 heldout ⇒ 单 fact 时 heldout 非空、严格"=0"不可达;
    // 用「多 fact + 大 heldoutEvery」让只有 1 个 fact 落 heldout(heldoutCount=1 < PILOT_MIN_HELDOUT)——
    // 这正是判据 m.heldoutCount >= PILOT_MIN_HELDOUT 实际守的「heldout 空/过小」语义。
    const samples: FactSample[] = []
    for (let i = 0; i < 6; i++)
      samples.push({ factId: `r2-${i}`, rawPredicted: 0.7, correct: i % 2 === 0 })
    const m = measureFromSamples(samples, { heldoutEvery: 100 })
    expect(m.heldoutCount).toBeLessThan(PILOT_MIN_HELDOUT)
    const r = checkCalibrationPilotPass(usageOk, m)
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.includes('heldout'))).toBe(true)
  })

  it('R3 · ECE 未改善(良校准输入,g 不压 ECE)⇒ 判据不通过', () => {
    // 复用测试 ③ 的「良校准输入」构造:5 档 × 20,每档 k=round(raw·20) 正确 ⇒ eceDrop≈0。
    const samples: FactSample[] = []
    let fid = 0
    for (const raw of [0.5, 0.6, 0.7, 0.8, 0.9]) {
      const n = 20
      const k = Math.round(raw * n)
      for (let i = 0; i < n; i++)
        samples.push({ factId: `r3-${fid++}`, rawPredicted: raw, correct: i < k })
    }
    const m = measureFromSamples(samples, { heldoutEvery: 3 })
    // 样本/heldout 都够(只让 ECE 项触发,证明判据精确指向「g 未改善」而非被别的项盖过)。
    expect(m.totalSamples).toBeGreaterThanOrEqual(PILOT_MIN_SAMPLES)
    expect(m.heldoutCount).toBeGreaterThanOrEqual(PILOT_MIN_HELDOUT)
    expect(m.eceDrop).toBeLessThanOrEqual(0) // g 没把 ECE 压下(良校准输入)
    const r = checkCalibrationPilotPass(usageOk, m)
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.includes('未改善'))).toBe(true)
  })

  it('R4 · 健康闭环 ⇒ 判据通过(不误伤)', () => {
    // 复用 ① 端到端跑出的真实健康输出(真 recall + 真泛化 + eceDrop>0)。
    expect(healthyUsage, 'R4 依赖测试 ① 先跑出健康输出').toBeDefined()
    expect(healthyMeasurement).toBeDefined()
    const r = checkCalibrationPilotPass(healthyUsage!, healthyMeasurement!)
    expect(r.failures).toEqual([])
    expect(r.passed).toBe(true)
  })

  it('R5 · assertCalibrationPilotPass:失败即 throw、健康不 throw', () => {
    const empty = measureFromSamples([], { heldoutEvery: 3 })
    const noUsage: UsageStats = { recallHits: 0, recallMisses: 0, usageRows: 0 }
    expect(() => assertCalibrationPilotPass(noUsage, empty)).toThrow(/未通过|未改善|样本/)
    // 健康数据不该 throw(对应 run.ts:assert 后才打印「跑通 ✓」的链路)。
    expect(healthyMeasurement, 'R5 依赖测试 ① 先跑出健康输出').toBeDefined()
    expect(() => assertCalibrationPilotPass(healthyUsage!, healthyMeasurement!)).not.toThrow()
  })
})

/**
 * EGR-CR-041(#116)· T4 · 不冒充真闭环 / 主张与证据对齐(纯单元,零 DB)。
 * 选方案 1:保留"全是真的"措辞**当且仅当** seed 真走 SPI 已被 T1/T3 证明(本 PR 已成立);
 * 且 seed 身份不得冒用 distiller(诚实标注)。这是防"文案再次脱离实现"的回归。
 */
describe('#116 · T4 · 不冒充真闭环(身份诚实 + 文案与实现对齐)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const pilotSrc = readFileSync(join(here, '..', 'calibration-pilot', 'pilot.ts'), 'utf8')
  const corpusSrc = readFileSync(join(here, '..', 'calibration-pilot', 'corpus.ts'), 'utf8')

  it('seed 身份诚实:SEED_CREATED_BY 非 distiller、且源码不再裸 insert 出 distiller 产物', () => {
    // 身份常量不冒充 distiller。
    expect(SEED_CREATED_BY).not.toBe('agent:distiller')
    // seedCorpus 不再把 createdBy 写成 'agent:distiller'(防回退到裸 insert 冒充)。
    expect(pilotSrc).not.toContain("createdBy: 'agent:distiller'")
  })

  it('seed 真走正式写 SPI:pilot.ts 真 import 并使用 appendClaim + transitionClaim', () => {
    // 对照 red-blue-round / redteam-immunity:这两个 SPI 必须真被 seed 使用(不再旁路)。
    expect(pilotSrc).toContain('appendClaim')
    expect(pilotSrc).toContain('transitionClaim')
    // 不再有裸 db.insert(schema.claim) 把 status 直接写 active(晋升门旁路的形态)。
    expect(pilotSrc).not.toMatch(/db\.insert\(schema\.claim\)/)
  })

  it('成熟度覆写命名诚实:有显式命名的 synthetic 成熟度 fixture,且文案标注它是 fixture 注入', () => {
    // 方案 1b 的诚实点:成熟度是一个显式命名的 test-only 步骤,而非藏在 seed 里。
    expect(pilotSrc).toContain('applySyntheticMaturity')
    // corpus 文档承认"成熟度"那一步是 fixture 注入、发生在过门之后(主张与证据对齐)。
    expect(corpusSrc).toMatch(/fixture/)
  })
})
