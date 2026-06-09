/**
 * S8 · Plan A 学习闭环 + 轮次隔离 + decision_eval 持久化 + A3 污染防护守门。
 *
 * 纯函数(零 DB):① 轮次隔离负对照(R1∩R2≠∅ → 抛 RoundOverlapError);
 *   ② **泛化**:g1 拟在 R1、迁到**不同样本**的 R2(漂移相位 + 略不同档准确率)仍守约(held-out lift>0、CI 下界>0);g1 冻结(不在 R2 重拟)、roundDelta 小;
 *   ②b **判别力对照**:R2 校准结构与 R1 **冲突** ⇒ g1 迁不动 ⇒ r2 lift 塌、fitted 反而更差、|roundDelta| 大(证明 ② 的小 roundDelta 不是恒真)。
 * DB(真 pgvector):③ recordDecisionEval/getDecisionEval 有符号读数往返;④ fail-loud(空字段 → 归因『非空』、NaN/∞ → 归因『有限』);
 *   ⑤ persistLoopResult 落齐行(行数从结构推导、非魔法数)+ variant value 对账;⑥ **A3 铁证**:取样器对**真 usage_truth** 返回 >0,
 *   但落一批 decision_eval 后计数**不变** ⇒ 决策结局没渗进 g 燃料(decision_eval 与 usage_truth 物理隔离;且取样器非恒零)。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addSource,
  collectUsageCalibrationSamples,
  createDb,
  getDecisionEval,
  makeFakeEmbedder,
  recordDecisionEval,
  reportUsage,
  schema,
  type DB,
} from '@engram/core'

import {
  assertRoundsDisjoint,
  persistLoopResult,
  RoundOverlapError,
  runLearningLoop,
} from '../decision-value/learning-loop.js'
import type { LabeledSample } from '../decision-value/split-and-tune.js'

const PHI = 0.6180339887498949

interface RoundTier {
  raw: number
  acc: number
  n: number
}

/** 造一轮:tiers×n、golden-ratio 指派 correctness(phase 错相位 ⇒ 不同轮**非逐位克隆**);factId 带 prefix(轮间不相交)。 */
function makeRound(prefix: string, tiers: RoundTier[], phase = 0): LabeledSample[] {
  const out: LabeledSample[] = []
  let idx = 0
  const maxN = Math.max(...tiers.map((t) => t.n))
  for (let k = 0; k < maxN; k++) {
    for (const t of tiers) {
      if (k >= t.n) continue
      out.push({
        factId: `${prefix}-${String(idx).padStart(4, '0')}`,
        rawPredicted: t.raw,
        correct: ((k + phase) * PHI) % 1 < t.acc,
      })
      idx++
    }
  }
  return out
}

/** ①/⑤/⑥ 复用的过自信一轮(不测泛化处,克隆同分布即可)。 */
function overconfidentRound(prefix: string, nPerTier = 60): LabeledSample[] {
  return makeRound(
    prefix,
    [
      { raw: 0.9, acc: 0.85, n: nPerTier },
      { raw: 0.82, acc: 0.3, n: nPerTier },
      { raw: 0.5, acc: 0.4, n: nPerTier },
    ],
    0,
  )
}

const TAU = 0.8

/** 在 DB 里 seed 一条 active claim + 一条真 usage_truth(adopted),让 collectUsageCalibrationSamples 取得到 1 条样本。 */
async function seedOneUsage(db: DB, taskId: string): Promise<void> {
  const embedder = makeFakeEmbedder()
  const src = await addSource(db, {
    content: `source-${taskId}`,
    contentHash: randomUUID(),
    kind: 'formal_document',
    authorityScore: 0.8,
  })
  const claimId = randomUUID()
  await db.insert(schema.claim).values({
    id: claimId,
    claimText: `claim-${taskId}`,
    subject: 's',
    predicate: 'p',
    object: 'o',
    status: 'active',
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: {
        authority: 0.8,
        humanReview: 0.8,
        entailment: 0.8,
        indepSupport: 0.8,
        usageCorrect: 0.8,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: {
        authority: 0.3,
        humanReview: 0.3,
        entailment: 0.15,
        indepSupport: 0.15,
        usageCorrect: 0.1,
      },
      calibrationVersion: 'identity',
    },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'agent:distiller',
    embedding: await embedder.embed('claim', 'document'),
    embeddingVersion: embedder.version,
  })
  await db.insert(schema.claimProvenance).values({
    id: randomUUID(),
    claimId,
    sourceId: src.sourceId,
    locator: `loc:${taskId}`,
    relevance: 'exact',
  })
  await reportUsage(db, claimId, 'adopted', {
    taskId,
    byRole: 'agent:eval-consumer',
    confidenceAtRecall: 0.8,
  })
}

describe('S8 · 学习闭环 + 轮次隔离(纯函数)', () => {
  it('① 轮次隔离负对照:R1∩R2 有重叠事实 → 抛 RoundOverlapError', () => {
    expect(() => assertRoundsDisjoint(['a', 'b', 'c'], ['c', 'd'])).toThrow(RoundOverlapError)
    expect(() => assertRoundsDisjoint(['a', 'b'], ['c', 'd'])).not.toThrow()
    // runLearningLoop 也必须在重叠时 fail-loud(held-out 前提被破坏)。
    const r1 = overconfidentRound('dup', 30)
    const r2 = [...overconfidentRound('dup2', 30), r1[0]!] // 注入一个 R1 的事实
    expect(() => runLearningLoop({ r1, r2, tau: TAU })).toThrow(RoundOverlapError)
  })

  it('② 泛化:g1 拟在 R1、迁到**不同样本**的 R2(漂移相位+略不同档准确率)仍守约;g1 冻结(不在 R2 重拟);roundDelta 小', () => {
    const r1 = makeRound(
      'g1r1',
      [
        { raw: 0.9, acc: 0.85, n: 60 },
        { raw: 0.82, acc: 0.3, n: 60 },
        { raw: 0.5, acc: 0.4, n: 60 },
      ],
      0,
    )
    // R2:同**过自信结构**(高 raw 真准、中 raw 严重高估)但各档准确率略不同 + 错相位 ⇒ 真·未见样本(correct 序列与 R1 不逐位相同)。
    const r2 = makeRound(
      'g1r2',
      [
        { raw: 0.9, acc: 0.82, n: 60 },
        { raw: 0.82, acc: 0.33, n: 60 },
        { raw: 0.5, acc: 0.45, n: 60 },
      ],
      17,
    )
    const loop = runLearningLoop({ r1, r2, tau: TAU, seed: 1, bootstrapIterations: 1000 })
    // R1 学到的 g1(把 overstated 压到 τ 下)迁到**不同的** R2 facts 仍守约 ⇒ 决策价值真泛化(非查表)。
    expect(loop.r2.decisionLift).toBeGreaterThan(0.05)
    expect(loop.r2.ci.lo).toBeGreaterThan(0)
    expect(loop.r2.fitted.promiseError).toBeLessThan(loop.r2.identity.promiseError)
    // g1 冻结:held-out 评测用的仍是 R1 拟的 g(若被误改成在 R2 eval 集上重拟,knots 会变)——这是接线守卫,不替代泛化证明。
    expect(loop.r2.gMap.knots).toEqual(loop.r1.gMap.knots)
    // 同结构 ⇒ 迁移近乎无损,泛化差小(判别力由 ②b 的反例守:此断言**能**失败)。
    expect(Math.abs(loop.roundDelta)).toBeLessThan(0.1)
  })

  it('②b 判别力对照:R2 校准结构与 R1 **冲突**(高 raw 在 R2 反而最不准)⇒ g1 迁不动 ⇒ r2 lift 塌、fitted 反更差、|roundDelta| 大', () => {
    const r1 = makeRound(
      'xr1',
      [
        { raw: 0.9, acc: 0.85, n: 60 }, // R1:高 raw 真准 ⇒ g1(0.9) 学高、≥τ 留
        { raw: 0.82, acc: 0.3, n: 60 },
        { raw: 0.5, acc: 0.4, n: 60 },
      ],
      0,
    )
    const r2 = makeRound(
      'xr2',
      [
        { raw: 0.9, acc: 0.2, n: 60 }, // R2:高 raw **最不准** —— g1(0.9)≥τ 仍答 ⇒ fitted 把最差档当 ≥τ 把握答进去
        { raw: 0.82, acc: 0.5, n: 60 }, // 而中 raw 在 R2 其实不错,却被 g1(0.82)<τ 弃掉
        { raw: 0.5, acc: 0.4, n: 60 },
      ],
      17,
    )
    const loop = runLearningLoop({ r1, r2, tau: TAU, seed: 1, bootstrapIterations: 1000 })
    expect(loop.r1.decisionLift).toBeGreaterThan(0.05) // 样本内仍有正 lift
    // g1 对 R2 的结构是错的:fitted 答了 R2 最差档(0.9→0.20)、弃了较好档(0.82→0.50)⇒ fitted **比 identity 还差**。
    expect(loop.r2.fitted.promiseError).toBeGreaterThan(loop.r2.identity.promiseError)
    expect(loop.r2.decisionLift).toBeLessThan(0.05) // 价值塌(实为负)
    // ⇒ |roundDelta| 大:这正是 ② 的 `roundDelta<0.1` **会失败**的情形,证明那条断言有判别力、不是恒真。
    expect(Math.abs(loop.roundDelta)).toBeGreaterThan(0.1)
  })
})

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

describe('S8 · decision_eval 持久化 + A3 污染防护(真 DB)', () => {
  let admin: pg.Pool
  let pool: pg.Pool
  let db: DB
  let testDbName: string

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

  it('③ recordDecisionEval / getDecisionEval:有符号读数往返(含负值 + CI + sampleN)', async () => {
    await recordDecisionEval(db, {
      runLabel: 'T:R2',
      variant: 'loop',
      metric: 'decisionLift',
      value: 0.2375,
      ciLow: 0.094,
      ciHigh: 0.353,
      sampleN: 72,
    })
    await recordDecisionEval(db, {
      runLabel: 'T:R2',
      variant: 'loop',
      metric: 'roundDelta',
      value: -0.012, // 有符号:可负
    })
    const rows = await getDecisionEval(db, { runLabel: 'T:R2' })
    expect(rows.length).toBe(2)
    const lift = rows.find((r) => r.metric === 'decisionLift')!
    expect(lift.value).toBeCloseTo(0.2375, 10)
    expect(lift.ciLow).toBeCloseTo(0.094, 10)
    expect(lift.sampleN).toBe(72)
    const delta = rows.find((r) => r.metric === 'roundDelta')!
    expect(delta.value).toBeCloseTo(-0.012, 10) // 负号保住(不被 clamp)
    expect(delta.ciLow).toBeNull()
    // 按 metric 过滤。
    expect((await getDecisionEval(db, { runLabel: 'T:R2', metric: 'roundDelta' })).length).toBe(1)
  })

  it('④ fail-loud:空字段 → 归因『非空』、NaN/∞ → 归因『有限』(两类校验不互相吞)', async () => {
    await expect(
      recordDecisionEval(db, { runLabel: '', variant: 'loop', metric: 'x', value: 1 }),
    ).rejects.toThrow(/非空/)
    await expect(
      recordDecisionEval(db, { runLabel: 'a', variant: 'loop', metric: '  ', value: 1 }),
    ).rejects.toThrow(/非空/)
    await expect(
      recordDecisionEval(db, { runLabel: 'a', variant: 'loop', metric: 'x', value: Number.NaN }),
    ).rejects.toThrow(/有限/)
    await expect(
      recordDecisionEval(db, {
        runLabel: 'a',
        variant: 'loop',
        metric: 'x',
        value: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow(/有限/)
  })

  it('⑤ persistLoopResult:把一轮闭环落齐 decision_eval 行(R2 lift+CI+sampleN / roundDelta / 各 variant 指标)', async () => {
    const loop = runLearningLoop({
      r1: overconfidentRound('p1'),
      r2: overconfidentRound('p2'),
      tau: TAU,
      seed: 2,
      bootstrapIterations: 500,
    })
    const written = await persistLoopResult(db, 'A', loop)
    // 行数从结构推导(非魔法数):3 条 loop 行(R2 lift + R2 roundDelta + R1 lift)+ 2 轮 × 3 variant × 3 恒有限指标。
    const ROUNDS = 2
    const VARIANTS = 3 // identity / fitted / oracle
    const PER_VARIANT_METRICS = 3 // coverage / regret / promiseError
    const LOOP_ROWS = 3
    expect(written).toBe(LOOP_ROWS + ROUNDS * VARIANTS * PER_VARIANT_METRICS)
    const r2Lift = await getDecisionEval(db, {
      runLabel: 'A:R2',
      variant: 'loop',
      metric: 'decisionLift',
    })
    expect(r2Lift.length).toBe(1)
    expect(r2Lift[0]!.value).toBeCloseTo(loop.r2.decisionLift, 10)
    expect(r2Lift[0]!.ciLow).toBeCloseTo(loop.r2.ci.lo, 10)
    expect(r2Lift[0]!.sampleN).toBe(loop.r2.identity.total)
    // roundDelta 落在 R2 标签下。
    expect(
      (await getDecisionEval(db, { runLabel: 'A:R2', variant: 'loop', metric: 'roundDelta' }))
        .length,
    ).toBe(1)
    // 每 variant 的 promiseError 不仅存在,且 **value 与结果对账**(防 persist 把 coverage/regret/promiseError 写串列)。
    for (const [variant, profile] of [
      ['identity', loop.r2.identity],
      ['fitted', loop.r2.fitted],
      ['oracle', loop.r2.oracle],
    ] as const) {
      const rows = await getDecisionEval(db, { runLabel: 'A:R2', variant, metric: 'promiseError' })
      expect(rows.length).toBe(1)
      expect(rows[0]!.value).toBeCloseTo(profile.promiseError, 10)
    }
  })

  it('⑥ A3 铁证:取样器对真 usage **会**返回>0,但 decision_eval 写入**不**改它(决策没渗进 g 燃料、且取样器非恒零)', async () => {
    // 干净库:g 燃料为 0。
    expect((await collectUsageCalibrationSamples(db)).length).toBe(0)
    // 正控:落一条**真 usage_truth** ⇒ 取样器返回 1(证明它不是恒零——否则下面的"不变"会假绿)。
    await seedOneUsage(db, 'real-consumer-1')
    expect((await collectUsageCalibrationSamples(db)).length).toBe(1)
    // 落一整轮闭环的决策读数到 decision_eval。
    await persistLoopResult(
      db,
      'B',
      runLearningLoop({
        r1: overconfidentRound('b1'),
        r2: overconfidentRound('b2'),
        tau: TAU,
        bootstrapIterations: 200,
      }),
    )
    // 关键:写了一堆 decision_eval 后,生产校准取样器(只读 usage_truth)计数**仍是 1**(那条真 usage)、**未被决策抬高**
    // ⇒ 决策结局物理上没进 g 燃料(decision_eval 与 usage_truth 隔离;A3 红线兑现)。
    expect((await collectUsageCalibrationSamples(db)).length).toBe(1)
    // 而 decision_eval 里确实有这一轮的行(决策结局有被记下,只是没去喂 g)。
    expect((await getDecisionEval(db, { runLabel: 'B:R2' })).length).toBeGreaterThan(0)
  })
})
