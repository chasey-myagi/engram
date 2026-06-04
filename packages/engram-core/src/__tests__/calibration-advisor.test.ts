/**
 * S27 DB 集成测试 —— 校准映射版本化 store / 验收门原子换 / **老快照冻结**（recall 按 claim 钉的版本算 g）/
 * **g=identity 即时回退**（confidence 退回 raw）/ **能力≠权力**（Advisor 只读、绝不改活动 g）。
 * 纯函数（g′/applyG/Advisor/5 项门各咬）在 calibration/calibration-map.test.ts。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  CALIBRATION_IDENTITY,
  DEFAULT_WEIGHTS,
  IDENTITY_MAP,
  applyGMap,
  type CalibrationMap,
} from '../confidence/confidence.js'
import {
  advise,
  commitCalibrationMap,
  evaluateAndMaybeSwap,
  getActiveCalibrationMap,
  getActiveCalibrationVersion,
  getCalibrationHistory,
  identityLikeCandidate,
  rollbackToIdentity,
  type GoldenSample,
} from '../index.js'
import { createDb, type DB } from '../db/client.js'
import { claim, claimProvenance, type ClaimStatus } from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { writeGovernanceState } from '../governance/index.js'
import { BASELINE_POLICY } from '../governance/control-law.js'

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
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
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

/** 一组足量、桶都 ≥5 的 golden 样本（让验收门 ⑤ 默认过）。 */
function wellSampled(): GoldenSample[] {
  const s: GoldenSample[] = []
  for (let b = 0; b < 10; b++) {
    const center = b / 10 + 0.05
    for (let k = 0; k < 6; k++) s.push({ rawPredicted: center, correct: k % 2 === 0 })
  }
  return s
}

describe('S27 校准映射版本化 store（append-only / 活动=最新一行）', () => {
  it('表空 → 活动版本 = identity（g=raw）', async () => {
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
    const m = await getActiveCalibrationMap(db)
    expect(m.version).toBe(CALIBRATION_IDENTITY)
    expect(m.knots).toHaveLength(0)
  })

  it('commit 一个版本后 → 它成活动；再 commit 另一个 → 后者活动（最新一行即活动）', async () => {
    const v1: CalibrationMap = {
      version: 'v1',
      knots: [
        { x: 0, y: 0 },
        { x: 1, y: 0.8 },
      ],
    }
    await commitCalibrationMap(db, { map: v1, reason: 'test v1' })
    expect(await getActiveCalibrationVersion(db)).toBe('v1')

    const v2: CalibrationMap = {
      version: 'v2',
      knots: [
        { x: 0, y: 0 },
        { x: 1, y: 0.9 },
      ],
    }
    await commitCalibrationMap(db, { map: v2, reason: 'test v2' })
    expect(await getActiveCalibrationVersion(db)).toBe('v2')

    const hist = await getCalibrationHistory(db)
    expect(hist.map((h) => h.version)).toEqual(['v2', 'v1']) // append-only，最新在前
  })

  it('非单调候选 commit → 抛（写时 assertCalibrationMap 硬拒）', async () => {
    const bad: CalibrationMap = {
      version: 'bad',
      knots: [
        { x: 0, y: 0.9 },
        { x: 1, y: 0.1 },
      ],
    }
    await expect(commitCalibrationMap(db, { map: bad, reason: 'bad' })).rejects.toThrow(
      /non-decreasing/,
    )
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY) // 未写、活动不动
  })
})

describe('S27 验收门原子换（5/5 才换；能力≠权力）', () => {
  it('Advisor advise 只产建议、绝不改活动 g（能力半边无写权）', async () => {
    const samples = wellSampled()
    const candidate = identityLikeCandidate('id-like')
    const before = await getActiveCalibrationVersion(db)
    const proposal = advise(samples, IDENTITY_MAP, candidate)
    expect(proposal.candidate.version).toBe('id-like')
    // 关键断言：调 advise 后活动版本一字未动。
    expect(await getActiveCalibrationVersion(db)).toBe(before)
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
  })

  it('5/5 approve → 原子激活候选（committed 落库 + 活动版本翻到候选）', async () => {
    const samples = wellSampled()
    const candidate = identityLikeCandidate('accepted-v1')
    const res = await evaluateAndMaybeSwap(db, samples, candidate)
    expect(res.swapped).toBe(true)
    expect(res.verdict.approved).toBe(true)
    expect(res.committed?.version).toBe('accepted-v1')
    expect(await getActiveCalibrationVersion(db)).toBe('accepted-v1')
    // 验证依据（ΔECE）随激活行落库（审计）。
    expect(res.committed?.evidence).toHaveProperty('deltaEce')
  })

  it('reject（桶样本不足）→ HOLD：记裁决 + 活动 g 不动 + 不抛', async () => {
    const sparse: GoldenSample[] = [
      { rawPredicted: 0.25, correct: true },
      { rawPredicted: 0.65, correct: false },
    ]
    const res = await evaluateAndMaybeSwap(db, sparse, identityLikeCandidate('rej-v1'))
    expect(res.swapped).toBe(false)
    expect(res.verdict.approved).toBe(false)
    expect(res.verdict.failedCheck).toBe('bin_samples')
    expect(res.committed).toBeUndefined()
    // fail-silent HOLD：活动仍 identity，calibration_map 表里没有 rej-v1。
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
    const hist = await getCalibrationHistory(db)
    expect(hist.find((h) => h.version === 'rej-v1')).toBeUndefined()
  })

  it('reject（恒温器收紧 + 候选净放松）→ HOLD（④ 咬住，活动不动）', async () => {
    // 恒温器正收紧。
    await writeGovernanceState(db, {
      policy: { ...BASELINE_POLICY, promotionGateLevel: 0.5 },
      metrics: {
        distillBacklog: 0,
        entailRejectRate: 0.5,
        conflictQueueDepth: 0,
        immuneLag: 0,
        falseQuarantineRate: 0,
      },
      reason: 'tightening',
    })
    // 候选小幅抬高 [0.3,0.4) 段，让少量样本新越过门（翻转占比 6/36≈0.167 ≤0.2、③ 过；④ 因恒温器收紧咬住）。
    const loosen: CalibrationMap = {
      version: 'loosen-v1',
      knots: [
        { x: 0, y: 0 },
        { x: 0.35, y: 0.45 },
        { x: 1, y: 1 },
      ],
    }
    const samples: GoldenSample[] = []
    for (let k = 0; k < 6; k++) samples.push({ rawPredicted: 0.32, correct: k % 2 === 0 })
    for (let k = 0; k < 30; k++) samples.push({ rawPredicted: 0.9, correct: true })
    const res = await evaluateAndMaybeSwap(db, samples, loosen)
    expect(res.swapped).toBe(false)
    expect(res.verdict.failedCheck).toBe('thermostat_conflict')
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
  })
})

describe('S27 老快照冻结：recall 按 claim 钉的版本算 g', () => {
  it('换活动 g 不回溯改写老 claim 的锚；钉 identity 的 claim 仍 value==raw', async () => {
    // 钉 identity、raw=0.6（≥floor 0.4 会被召回）的 claim。
    const seeded = await seedActiveClaim2({
      text: 'frozen identity claim',
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    // 先在 identity 下召回：value==raw。
    const before = await recallClaims(db, embedder, 'frozen identity claim')
    expect(before).toHaveLength(1)
    expect(before[0]!.confidence.calibrationVersion).toBe(CALIBRATION_IDENTITY)
    expect(before[0]!.confidence.value).toBeCloseTo(seeded.raw, 6)

    // 把活动 g 换成一个会压低值的非 identity 版本（5/5 approve 用 identityLike 不改值；这里直接 commit 一个压值 g）。
    const squash: CalibrationMap = {
      version: 'squash-v1',
      knots: [
        { x: 0, y: 0 },
        { x: 1, y: 0.5 },
      ], // 把所有 raw 砍半
    }
    await commitCalibrationMap(db, { map: squash, reason: 'squash' })
    expect(await getActiveCalibrationVersion(db)).toBe('squash-v1')

    // 老 claim 仍钉 identity → recall 仍按 identity 算 → value 不变（冻结）。
    const after = await recallClaims(db, embedder, 'frozen identity claim')
    expect(after).toHaveLength(1)
    expect(after[0]!.confidence.calibrationVersion).toBe(CALIBRATION_IDENTITY)
    expect(after[0]!.confidence.value).toBeCloseTo(seeded.raw, 6) // 换活动 g 后仍不动
  })

  it('钉非 identity 版本的 claim → recall 用该版本的 g′（不是活动版本）', async () => {
    // claim 钉 pinned-v1（×0.8，raw 0.6→0.48 仍≥floor 会被召回），活动是 pinned-v2（恒等）。
    const mild: CalibrationMap = {
      version: 'pinned-v1',
      knots: [
        { x: 0, y: 0 },
        { x: 1, y: 0.8 },
      ],
    }
    await commitCalibrationMap(db, { map: mild, reason: 'mild' })
    const identityish: CalibrationMap = {
      version: 'pinned-v2',
      knots: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    }
    await commitCalibrationMap(db, { map: identityish, reason: 'idish' }) // 活动 = pinned-v2

    const seeded = await seedActiveClaim2({
      text: 'pinned v1 claim',
      calibrationVersion: 'pinned-v1',
    })
    const res = await recallClaims(db, embedder, 'pinned v1 claim')
    expect(res).toHaveLength(1)
    expect(res[0]!.confidence.calibrationVersion).toBe('pinned-v1')
    // value 应是 pinned-v1（×0.8）算出的，而非活动 pinned-v2（恒等 → 0.6）。
    expect(res[0]!.confidence.value).toBeCloseTo(applyGMap(seeded.raw, mild), 6)
    expect(res[0]!.confidence.value).toBeCloseTo(seeded.raw * 0.8, 6)
    expect(res[0]!.confidence.value).not.toBeCloseTo(seeded.raw, 6) // 确非活动 g
  })
})

describe('S27 g=identity 即时回退（Story 29）', () => {
  it('rollbackToIdentity 一次原子 flip → 活动退回 identity；新写 claim 召回 value==raw', async () => {
    // 先激活一个非 identity 压值版本。
    const squash: CalibrationMap = {
      version: 'sq',
      knots: [
        { x: 0, y: 0 },
        { x: 1, y: 0.5 },
      ],
    }
    await commitCalibrationMap(db, { map: squash, reason: 'squash' })
    expect(await getActiveCalibrationVersion(db)).toBe('sq')

    // 一次回退。
    const row = await rollbackToIdentity(db)
    expect(row.version).toBe(CALIBRATION_IDENTITY)
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
    const active = await getActiveCalibrationMap(db)
    expect(active.knots).toHaveLength(0)

    // 回退后新写（钉 identity）的 claim 召回：value == raw（g=bare raw）。
    const seeded = await seedActiveClaim2({
      text: 'post rollback claim',
      calibrationVersion: CALIBRATION_IDENTITY,
    })
    const res = await recallClaims(db, embedder, 'post rollback claim')
    expect(res).toHaveLength(1)
    expect(res[0]!.confidence.value).toBeCloseTo(seeded.raw, 6)
    expect(res[0]!.confidence.value).toBeCloseTo(res[0]!.confidence.raw, 6) // value==raw
  })
})

/**
 * 直插一条会被召回的 active claim（base≥floor）：authority=1 (×0.3) + humanReview=1 (×0.3) = raw 0.6。
 * entailment 关 0（避免中性 0.5 干扰）。raw 0.6 ≥ floor 0.4 → 召回得到。
 */
async function seedActiveClaim2(opts: {
  text: string
  calibrationVersion: string
}): Promise<{ id: string; raw: number }> {
  const id = randomUUID()
  const raw = 1 * DEFAULT_WEIGHTS.authority + 1 * DEFAULT_WEIGHTS.humanReview // 0.6
  await db.insert(claim).values({
    id,
    claimText: opts.text,
    status: 'active' as ClaimStatus,
    confidence: 0,
    confidenceRaw: raw,
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
      calibrationVersion: opts.calibrationVersion,
    },
    embedding: await embedder.embed(opts.text),
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
  return { id, raw }
}
