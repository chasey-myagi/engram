/**
 * S28 DB 集成测试 —— 命门闭环最后一块：confidence 从 identity 毕业成**拟合、可校准**的概率。
 *
 * 覆盖（每条都被对抗式门禁盯着）：
 *   1) ≥200 门：<200 不拟合（g 维持 identity）；≥200 才拟合 g'。
 *   2) usage_truth 取样（独立用户/不同 task 门控，A.6 反刷单）：同身份刷单只算一票。
 *   3) 经 S27 验收门原子换：全项通过才换、calibration_version 翻版；**换后 golden 上 ECE < identity 基线**（ECE 下降证明）。
 *   4) 老快照冻结：换 g 前拍的快照保留旧版本/旧 conf；只有钉新版本的 claim 用 g'。
 *   5) w/g 分离：改权重不重拟 g；重拟 g 不改权重。
 *   6) g=identity 回退：真换上 g' 后回退仍退回裸 raw。
 *   7) code_version 锚：换 g 的 evidence 落 codeVersion（历史不可比断点标记）。
 *   FIX 1（承重）：活动 g 非 identity 时，新建 draft 钉到活动版本、draft→active 晋升**不抛**、conf 在 g' 下算。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  CALIBRATION_CODE_VERSION,
  CALIBRATION_IDENTITY,
  applyGMap,
  computeReliability,
} from '../index.js'
import { trustedHumanActor, agentActor } from '../spi/actor.js'
import { DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import {
  collectUsageCalibrationSamples,
  fitAndMaybeRecalibrate,
  MIN_FIT_SAMPLES,
} from '../calibration/fit-from-usage.js'
import { fitIsotonic } from '../calibration/isotonic.js'
import {
  getActiveCalibrationVersion,
  getCalibrationHistory,
  rollbackToIdentity,
} from '../calibration/calibration-store.js'
import { createDb, type DB } from '../db/client.js'
import { claim, claimProvenance, type ClaimStatus } from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource, appendClaim } from '../spi/append-claim.js'
import { reportUsage } from '../spi/report-usage.js'
import { recallClaims } from '../spi/recall-claims.js'
import { transitionClaim } from '../spi/transition.js'
import { setStandards } from '../config/standards.js'

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
  pool.on('error', () => {}) // 吞 teardown 期 DROP ... WITH(FORCE) 终止连接的 57P01（测试已结束、连接被服务端杀属预期）
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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, standards, governance_state, calibration_map CASCADE',
  )
})

/** 从召回结果里按 claimText 取唯一目标（fake embedder 子串近邻可能带出别的 active claim，按文本精确定位）。 */
function pick(
  results: Awaited<ReturnType<typeof recallClaims>>,
  text: string,
): Awaited<ReturnType<typeof recallClaims>>[number] {
  const hit = results.find((r) => r.claim.claimText === text)
  if (!hit)
    throw new Error(`pick: recall returned no claim with text "${text}" (got ${results.length})`)
  return hit
}

/** 直插一条 active claim（带出处），返回 id —— 给它挂 usage_truth 用（reportUsage 要求 claim 存在）。 */
async function seedClaim(text: string): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: text,
    status: 'active' as ClaimStatus,
    confidence: 0.6,
    confidenceRaw: 0.6,
    confidenceFactors: {
      factors: {
        authority: 1,
        humanReview: 1,
        entailment: 0,
        indepSupport: 0,
        usageCorrect: 0,
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
  const { sourceId } = await addSource(db, {
    content: `body-${id}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

/**
 * 落一批 usage_truth：每条用**不同身份** (by_role + taskId) ⇒ 独立门控下每条算一票。
 * raw=该次召回快照预测值（identity 下 == raw）；correct→outcome。错校准：低 raw 反而更常对、高 raw 反而更常错。
 */
async function seedMiscalibratedUsage(claimId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const raw = ((i % 10) + 0.5) / 10 // 0.05..0.95 轮转
    // 目标 observed 随 raw 单调上升但偏离 raw（错校准）：低段被低估、高段被高估。
    const target = 0.3 + 0.36 * (raw - 0.05) // raw 0.05→0.3, raw 0.95→0.624
    const correct = (i * 7919) % 1000 < Math.round(target * 1000) // 确定性伪随机阈值
    await reportUsage(db, claimId, correct ? 'adopted' : 'refuted', {
      byRole: `consumer:${i}`, // 每条独立身份 ⇒ 独立门控不折叠
      taskId: `task-${i}`,
      confidenceAtRecall: raw,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
  }
}

/**
 * 落一批**全 adopted** 的 usage_truth（每条独立身份）：各 raw 的 observed 恒=1 ⇒ isotonic 拟出常量 g′
 * （零分辨力）⇒ 验收门必拒（output_spread/翻转率）。用于证明「拟合成功但门拒 → HOLD」这条 A.7 失效静音路径。
 */
async function seedFlatUsage(claimId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const raw = ((i % 10) + 0.5) / 10 // raw 仍铺开 0.05..0.95，但 outcome 恒为 adopted
    await reportUsage(db, claimId, 'adopted', {
      byRole: `flat:${i}`,
      taskId: `flat-task-${i}`,
      confidenceAtRecall: raw,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
  }
}

describe('S28 ≥200 门 + usage_truth 取样（独立门控）', () => {
  it('<200 条独立 usage_truth → 不拟合，g 维持 identity', async () => {
    const cid = await seedClaim('threshold claim')
    await seedMiscalibratedUsage(cid, MIN_FIT_SAMPLES - 1) // 199 条
    const res = await fitAndMaybeRecalibrate(db)
    expect(res.fitted).toBe(false)
    if (res.fitted === false) {
      expect(res.reason).toBe('below_threshold')
      expect(res.sampleCount).toBe(MIN_FIT_SAMPLES - 1)
    }
    // g 仍 identity、表里没有任何拟合行。
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
    expect(await getCalibrationHistory(db)).toHaveLength(0)
  })

  it('≥200 条独立 usage_truth → 拟合 g′', async () => {
    const cid = await seedClaim('threshold claim 2')
    await seedMiscalibratedUsage(cid, MIN_FIT_SAMPLES + 40) // 240 条
    const res = await fitAndMaybeRecalibrate(db, { version: 'iso-fit-1' })
    expect(res.fitted).toBe(true)
  })

  it('恰好 200 条独立 usage_truth → 拟合（门是 ≥ 而非 >，钉死 off-by-one）', async () => {
    const cid = await seedClaim('threshold exact claim')
    await seedMiscalibratedUsage(cid, MIN_FIT_SAMPLES) // 恰 200
    const samples = await collectUsageCalibrationSamples(db)
    expect(samples).toHaveLength(MIN_FIT_SAMPLES) // 确认正好 200 distinct
    const res = await fitAndMaybeRecalibrate(db, { version: 'iso-200' })
    expect(res.fitted).toBe(true) // 200 == 门 → 拟合（不是 <200 的 below_threshold）
  })

  it('独立门控：同一身份刷单 1000 次只算一票 → 不足 200、不拟合（防 Goodhart）', async () => {
    const cid = await seedClaim('spam claim')
    for (let i = 0; i < 1000; i++) {
      // 同一 (by_role, taskId) 身份反复上报 ⇒ 折叠成一票。
      await reportUsage(db, cid, i % 2 === 0 ? 'adopted' : 'refuted', {
        byRole: 'consumer:spammer',
        taskId: 'task-spam',
        confidenceAtRecall: 0.5,
        calibrationVersion: CALIBRATION_IDENTITY,
      })
    }
    const samples = await collectUsageCalibrationSamples(db)
    expect(samples).toHaveLength(1) // 1000 次刷单只剩一票
    const res = await fitAndMaybeRecalibrate(db)
    expect(res.fitted).toBe(false)
  })
})

describe('S28 latest-by-identity 取样：最新 corrected/partial 覆盖旧 adopted（与 f4 同口径，EGR-CR-030）', () => {
  it('同一身份先 adopted 后 corrected → corrected 覆盖旧 adopted，该身份不进校准样本（与 f4 同口径）', async () => {
    const cid = await seedClaim('correct-overrides claim')
    // 同一 (by_role, taskId)：先 adopted（旧票），后 corrected（最新表态）。
    await reportUsage(db, cid, 'adopted', {
      byRole: 'consumer:c1',
      taskId: 'task-c1',
      confidenceAtRecall: 0.9,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    await reportUsage(db, cid, 'corrected', {
      byRole: 'consumer:c1',
      taskId: 'task-c1',
      confidenceAtRecall: 0.9,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    const samples = await collectUsageCalibrationSamples(db)
    expect(samples).toHaveLength(0) // 最新结局是 corrected ⇒ 该身份不成样本（红：修前会是 1）
  })

  it('同一身份先 adopted 后 partial → partial 同样覆盖旧 adopted，该身份不进校准样本', async () => {
    const cid = await seedClaim('partial-overrides claim')
    await reportUsage(db, cid, 'adopted', {
      byRole: 'consumer:p1',
      taskId: 'task-p1',
      confidenceAtRecall: 0.9,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    await reportUsage(db, cid, 'partial', {
      byRole: 'consumer:p1',
      taskId: 'task-p1',
      confidenceAtRecall: 0.9,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    const samples = await collectUsageCalibrationSamples(db)
    expect(samples).toHaveLength(0)
  })

  it('199 个有效独立样本 + 1 个最新为 corrected 的身份 → 仅 199 distinct，不触发拟合（门不被旧票误触发）', async () => {
    const cid = await seedClaim('threshold-with-corrected claim')
    await seedMiscalibratedUsage(cid, MIN_FIT_SAMPLES - 1) // 199 个各自独立身份的 adopted/refuted
    // 第 200 个身份：先 adopted（看似凑满 200），后 corrected（最新表态 ⇒ 应作废）。
    await reportUsage(db, cid, 'adopted', {
      byRole: 'consumer:edge',
      taskId: 'task-edge',
      confidenceAtRecall: 0.9,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    await reportUsage(db, cid, 'corrected', {
      byRole: 'consumer:edge',
      taskId: 'task-edge',
      confidenceAtRecall: 0.9,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    const samples = await collectUsageCalibrationSamples(db)
    expect(samples).toHaveLength(MIN_FIT_SAMPLES - 1) // 199，不是 200（红：修前会是 200）
    const res = await fitAndMaybeRecalibrate(db)
    expect(res.fitted).toBe(false)
    if (res.fitted === false) {
      expect(res.reason).toBe('below_threshold')
      expect(res.sampleCount).toBe(MIN_FIT_SAMPLES - 1)
    }
    // g 维持 identity、无任何拟合行落库。
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
    expect(await getCalibrationHistory(db)).toHaveLength(0)
  })

  it('同一身份先 corrected 后 adopted → 最新 adopted 重新计为有效样本（覆盖是双向的，不是单调屏蔽）', async () => {
    const cid = await seedClaim('reinstate claim')
    await reportUsage(db, cid, 'corrected', {
      byRole: 'consumer:c2',
      taskId: 'task-c2',
      confidenceAtRecall: 0.7,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    await reportUsage(db, cid, 'adopted', {
      byRole: 'consumer:c2',
      taskId: 'task-c2',
      confidenceAtRecall: 0.7,
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    const samples = await collectUsageCalibrationSamples(db)
    expect(samples).toHaveLength(1)
    expect(samples[0]).toEqual({ rawPredicted: 0.7, correct: true })
  })
})

describe('S28 经验收门原子换 + ECE 下降证明', () => {
  it('全项通过 approve → 原子换、calibration_version 翻版、evidence 落 ΔECE + codeVersion', async () => {
    const cid = await seedClaim('ece claim')
    await seedMiscalibratedUsage(cid, 300)
    const res = await fitAndMaybeRecalibrate(db, { version: 'iso-ece-1' })
    expect(res.fitted).toBe(true)
    if (res.fitted) {
      expect(res.swapResult.swapped).toBe(true)
      expect(res.swapResult.verdict.approved).toBe(true)
      expect(await getActiveCalibrationVersion(db)).toBe('iso-ece-1')
      // ΔECE 绑定 + code_version 锚落库（A.8 验证依据 + A.3 #3 历史不可比标记）。
      expect(res.swapResult.committed?.evidence).toHaveProperty('deltaEce')
      expect(res.swapResult.committed?.evidence.codeVersion).toBe(CALIBRATION_CODE_VERSION)
    }
  })

  it('ECE 下降证明：拟合后 golden 上 ECE 严格低于 identity 基线', async () => {
    const cid = await seedClaim('ece proof claim')
    await seedMiscalibratedUsage(cid, 300)
    const samples = await collectUsageCalibrationSamples(db)
    expect(samples.length).toBeGreaterThanOrEqual(MIN_FIT_SAMPLES)
    // identity 基线 ECE（predicted=raw）。
    const eceIdentity = computeReliability(
      samples.map((s) => ({ predicted: s.rawPredicted, correct: s.correct })),
      10,
    ).ece
    const res = await fitAndMaybeRecalibrate(db, { version: 'iso-ece-proof' })
    expect(res.fitted).toBe(true)
    if (!res.fitted) throw new Error('expected a fit at ≥200 samples')
    // 硬断言**真的换上了**——绝不把核心 payoff 藏在 `if (swapped)` 后面，否则验收门一旦 HOLD 本证明就空过（gate#1 test-review）。
    expect(res.swapResult.swapped).toBe(true)
    // 换上的 g' 在同一 golden 上的 ECE。
    const g = res.swapResult.proposal.candidate
    const eceFitted = computeReliability(
      samples.map((s) => ({ predicted: applyGMap(s.rawPredicted, g), correct: s.correct })),
      10,
    ).ece
    expect(eceFitted).toBeLessThan(eceIdentity) // 核心 payoff
    // proposal 自带的 candidateEce/currentEce 也应同向（candidate 更准）。
    expect(res.swapResult.proposal.candidateEce).toBeLessThan(res.swapResult.proposal.currentEce)
  })

  it('拟合成功但验收门 REJECT → fail-silent HOLD：g 维持 identity，拒判绝不泄漏进活动 g（A.7 失效静音）', async () => {
    // 全 adopted 的足量样本 ⇒ isotonic 拟出**常量 g′**（每个 raw 同一 observed=1）⇒ 验收门 ⑥ output_spread（或 ③ 翻转率）拒。
    const cid = await seedClaim('hold claim')
    await seedFlatUsage(cid, MIN_FIT_SAMPLES + 40) // 真拟合（≥200）但门会拒
    const res = await fitAndMaybeRecalibrate(db, { version: 'iso-hold' })
    expect(res.fitted).toBe(true) // 真的拟合了
    if (!res.fitted) throw new Error('expected a fit at ≥200 samples')
    expect(res.swapResult.swapped).toBe(false) // 但验收门拒判
    expect(res.swapResult.verdict.approved).toBe(false)
    // 关键的 A.7 保证：拒判 = 维持现状，活动 g 一动不动（绝不让被拒候选漏进活动版本）。
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
    expect(await getCalibrationHistory(db)).toHaveLength(0)
  })
})

describe('S28 老快照冻结：换 g 不回溯改写历史', () => {
  it('换 g 前召回的快照保留 identity 版本 + value==raw；换上 g′ 后老 claim 仍按 identity 算', async () => {
    // 老 claim 钉 identity（appendClaim 在 g=identity 下写入 ⇒ 钉 identity）。
    await mkRecallableClaim('frozen snapshot claim')

    const before = pick(
      await recallClaims(db, embedder, 'frozen snapshot claim'),
      'frozen snapshot claim',
    )
    expect(before.confidence.calibrationVersion).toBe(CALIBRATION_IDENTITY)
    const rawBefore = before.confidence.raw
    expect(before.confidence.value).toBeCloseTo(rawBefore, 6) // identity: value==raw

    // 拟合并换上一个真实 g'（用足量错校准样本，挂在用量源——不可被该 query 召回）。
    const usageClaim = await seedClaim('zzz usage fuel row')
    await seedMiscalibratedUsage(usageClaim, 300)
    const res = await fitAndMaybeRecalibrate(db, { version: 'iso-frozen' })
    expect(res.fitted && res.swapResult.swapped).toBe(true)
    expect(await getActiveCalibrationVersion(db)).toBe('iso-frozen')

    // 老 claim 仍钉 identity → recall 仍按 identity 算 → value 不变（冻结、不回溯）。
    const after = pick(
      await recallClaims(db, embedder, 'frozen snapshot claim'),
      'frozen snapshot claim',
    )
    expect(after.confidence.calibrationVersion).toBe(CALIBRATION_IDENTITY)
    expect(after.confidence.value).toBeCloseTo(rawBefore, 6)
  })

  it('FIX 1：活动 g 非 identity 时，新建 claim 钉到活动版本、召回 value==g′(raw)≠raw', async () => {
    // 先换上一个会改值的 g'。
    const usageClaim = await seedClaim('zzz usage fuel row')
    await seedMiscalibratedUsage(usageClaim, 300)
    const res = await fitAndMaybeRecalibrate(db, { version: 'iso-active' })
    expect(res.fitted && res.swapResult.swapped).toBe(true)
    const activeV = await getActiveCalibrationVersion(db)
    expect(activeV).toBe('iso-active')
    const g = res.fitted ? res.swapResult.proposal.candidate : null

    // 此后新建的 claim 应钉到活动版本，召回的 value=g′(raw)。
    await mkRecallableClaim('pinned to active g claim')
    const rcl = pick(
      await recallClaims(db, embedder, 'pinned to active g claim'),
      'pinned to active g claim',
    )
    expect(rcl.confidence.calibrationVersion).toBe(activeV) // 钉到活动版本（FIX 1）
    expect(rcl.confidence.value).toBeCloseTo(applyGMap(rcl.confidence.raw, g!), 6) // value==g′(raw)
    // 且 g′ 确实改了值（非 identity）：raw 与 value 不同（否则没证明 g 生效）。
    expect(rcl.confidence.value).not.toBeCloseTo(rcl.confidence.raw, 4)
  })
})

describe('S28 FIX 1 承重：活动 g 非 identity 下 draft→active promote 不抛', () => {
  it('换上 g′ 后，新建 draft 钉活动版本，蓝边 promote 走 g′ 算 conf —— 不因缺 map 抛', async () => {
    // 先换上一个真实 g'（非 identity）。FIX 1 之前：此刻新 claim 钉非 identity 版本，draft→active 蓝边 promote
    // 调 applyG(raw, version) 却没传 map ⇒ applyG 抛 "requires a resolved map" —— 整条晋升路径炸。这就是 landmine。
    const usageClaim = await seedClaim('promote usage src')
    await seedMiscalibratedUsage(usageClaim, 300)
    const fit = await fitAndMaybeRecalibrate(db, { version: 'iso-promote' })
    expect(fit.fitted && fit.swapResult.swapped).toBe(true)
    const activeV = await getActiveCalibrationVersion(db)
    expect(activeV).not.toBe(CALIBRATION_IDENTITY)

    // 新建一条 draft（3 高权威独立源 ⇒ raw≈0.49；g′(raw) 大概率 ≥0.5 能晋升）。它钉到活动 g′ 版本。
    const provs = []
    for (let i = 0; i < 3; i++) {
      const { sourceId } = await addSource(db, {
        content: `promote-${randomUUID()}`,
        contentHash: randomUUID(),
        kind: 'structured_spec',
        authorityScore: 1,
      })
      provs.push({ sourceId, locator: `p${i}`, relevance: 'exact' as const })
    }
    const { claimId } = await appendClaim(
      db,
      embedder,
      { claimText: 'promote regression claim', createdBy: 'agent:distiller' },
      provs,
    )

    // 关键回归断言：draft→active 蓝边 promote 在活动 g′（非 identity）下**绝不抛 "requires a resolved map"**。
    let threw: unknown = null
    try {
      await transitionClaim(db, claimId, 'active', {
        actor: agentActor('agent:verifier'),
        entailmentPass: true,
      })
    } catch (e) {
      threw = e
    }
    // landmine 修复的硬断言：无论是否过门，错误都不能是「缺 map」。
    if (threw) expect(String(threw)).not.toMatch(/requires a resolved map/)
    if (threw) {
      // 唯一可接受的抛是「conf < 门」(stays draft)。
      expect(String(threw)).toMatch(/conf .* < 0\.5|entailment did not pass/)
    } else {
      // 没抛 ⇒ 已晋升 active，且其钉的版本是活动 g′（用 g′ 算的 conf 过了门）—— 正面闭合 FIX 1。
      const rcl = pick(
        await recallClaims(db, embedder, 'promote regression claim'),
        'promote regression claim',
      )
      expect(rcl.confidence.calibrationVersion).toBe(activeV)
    }
  })
})

describe('S28 w/g 分离（命门 A.3）', () => {
  it('改因子权重（Standards）不重拟 g：活动 g 版本一字不动', async () => {
    const usageClaim = await seedClaim('wg usage src')
    await seedMiscalibratedUsage(usageClaim, 300)
    await fitAndMaybeRecalibrate(db, { version: 'iso-wg' })
    const vBefore = await getActiveCalibrationVersion(db)
    expect(vBefore).toBe('iso-wg')
    // 改权重（配置态）——绝不触动活动 g（统计态）。
    await setStandards(db, {
      factorWeights: {
        authority: 0.5,
        humanReview: 0.2,
        entailment: 0.1,
        indepSupport: 0.1,
        usageCorrect: 0.1,
      },
    })
    expect(await getActiveCalibrationVersion(db)).toBe(vBefore) // g 不变
  })

  it('重拟 g 不改权重：换 g 后活动 Standards 的权重不变', async () => {
    await setStandards(db, {
      factorWeights: {
        authority: 0.4,
        humanReview: 0.3,
        entailment: 0.1,
        indepSupport: 0.1,
        usageCorrect: 0.1,
      },
    })
    const usageClaim = await seedClaim('wg2 usage src')
    await seedMiscalibratedUsage(usageClaim, 300)
    await fitAndMaybeRecalibrate(db, { version: 'iso-wg2' })
    expect(await getActiveCalibrationVersion(db)).toBe('iso-wg2')
    // 换 g 后权重（配置态）原样：换 g 走 calibration_map 表，绝不写 standards。
    const { getActiveStandards } = await import('../config/standards.js')
    const std = await getActiveStandards(db)
    expect(std.factorWeights.authority).toBeCloseTo(0.4, 6)
    expect(std.factorWeights.humanReview).toBeCloseTo(0.3, 6)
  })
})

describe('S28 g=identity 回退（真换上 g′ 后仍可一键退回裸 raw）', () => {
  it('换上拟合 g′ → rollbackToIdentity → 新写 claim 召回 value==raw', async () => {
    const usageClaim = await seedClaim('zzz usage fuel row')
    await seedMiscalibratedUsage(usageClaim, 300)
    const fit = await fitAndMaybeRecalibrate(db, { version: 'iso-rollback' })
    expect(fit.fitted && fit.swapResult.swapped).toBe(true)
    expect(await getActiveCalibrationVersion(db)).toBe('iso-rollback')

    await rollbackToIdentity(db)
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)

    // 回退后新写（钉 identity）的 claim 召回：value==raw。
    await mkRecallableClaim('post rollback fitted claim')
    const rcl = pick(
      await recallClaims(db, embedder, 'post rollback fitted claim'),
      'post rollback fitted claim',
    )
    expect(rcl.confidence.calibrationVersion).toBe(CALIBRATION_IDENTITY)
    expect(rcl.confidence.value).toBeCloseTo(rcl.confidence.raw, 6)
  })
})

describe('S28 isotonic 在真实 usage 取样下确定性', () => {
  it('同一 usage 数据集 → collectUsageCalibrationSamples + fitIsotonic 逐字可复现', async () => {
    const cid = await seedClaim('determinism claim')
    await seedMiscalibratedUsage(cid, 250)
    const s1 = await collectUsageCalibrationSamples(db)
    const s2 = await collectUsageCalibrationSamples(db)
    // 取样集合（按 raw 排序后）相同。
    const sortKey = (a: { rawPredicted: number; correct: boolean }) =>
      `${a.rawPredicted.toFixed(6)}:${a.correct}`
    expect(s2.map(sortKey).sort()).toEqual(s1.map(sortKey).sort())
    // 同一样本集 → 同一 g'（PAVA 确定性）。
    const g1 = fitIsotonic(s1, 'det')
    const g2 = fitIsotonic(s1, 'det')
    expect(g2.knots).toEqual(g1.knots)
  })
})

/**
 * 经**真实写路径**（appendClaim）建一条会被召回的 active claim：
 * 3 条高权威独立 source ⇒ base = authority(0.3) + entail 中性(0.075) + indep(3→0.75×0.15=0.1125) ≈ 0.49 ≥ floor 0.4，
 * 经合理 g′ 后仍 ≥0.4 可召回。走 appendClaim ⇒ 钉**写时的活动校准版本**（FIX 1 的核验点），再 promote 到 active。
 */
async function mkRecallableClaim(text: string): Promise<string> {
  const provs = []
  for (let i = 0; i < 3; i++) {
    const { sourceId } = await addSource(db, {
      content: `recallable-${randomUUID()}`,
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 1,
    })
    provs.push({ sourceId, locator: `p${i}`, relevance: 'exact' as const })
  }
  const { claimId } = await appendClaim(db, embedder, { claimText: text, createdBy: 'test' }, provs)
  await transitionClaim(db, claimId, 'active', { actor: trustedHumanActor('human:editor') })
  return claimId
}
