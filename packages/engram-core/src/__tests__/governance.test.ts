/**
 * S26 GovernanceController 恒温器 — DB 集成测试。
 * 验证：真 SPI 喂五指标 / 版本化持久化 / gate 抬严遵 S7 + 历史快照冻结 / 可逆 + 审计 / 失效静音退回主干 /
 * falseQuarantineRate 由真 S22 human_overturn(un_quarantine) 喂。
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
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
} from '../confidence/confidence.js'
import { getActiveStandards, setStandards } from '../config/standards.js'
import { createDb, type DB } from '../db/client.js'
import {
  claim,
  claimProvenance,
  governanceState,
  standards,
  type ClaimStatus,
} from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { writePatrolVerdict } from '../verifier/patrol-verdict.js'
import { recordHumanOverturn } from '../editor/human-overturn.js'
import { escalateConflict } from '../spi/conflict-arbiter.js'
import {
  runGovernanceCycle,
  getActivePolicy,
  getGovernanceHistory,
  rollbackTo,
  writeGovernanceState,
  readMetrics,
  readDistillBacklog,
  readEntailRejectRate,
  readConflictQueueDepth,
  readImmuneLag,
  readFalseQuarantineRate,
  gateThresholdsFor,
  BASELINE_POLICY,
  type MetricReaders,
  type MetricRead,
} from '../governance/index.js'

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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, standards, governance_state CASCADE',
  )
})

async function seedClaim(opts: {
  text?: string
  status?: ClaimStatus
  factorAuthority?: number
}): Promise<string> {
  const id = randomUUID()
  const text = opts.text ?? `claim-${id}`
  await db.insert(claim).values({
    id,
    claimText: text,
    status: opts.status ?? 'draft',
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: {
      factors: {
        authority: opts.factorAuthority ?? 0,
        humanReview: 0,
        entailment: 0.5,
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

describe('S26 governance — metric readers fed by real SPIs', () => {
  it('readDistillBacklog counts draft claims', async () => {
    await seedClaim({ status: 'draft' })
    await seedClaim({ status: 'draft' })
    await seedClaim({ status: 'active' })
    expect((await readDistillBacklog(db)).value).toBe(2)
  })

  it('readEntailRejectRate = fraction of latest patrol verdicts that are fail/not_co_true', async () => {
    const a = await seedClaim({})
    const b = await seedClaim({})
    const c = await seedClaim({})
    const d = await seedClaim({})
    await writePatrolVerdict(db, {
      claimId: a,
      byRole: 'agent:verifier',
      verdict: { entailment: 'pass' },
    })
    await writePatrolVerdict(db, {
      claimId: b,
      byRole: 'agent:verifier',
      verdict: { entailment: 'fail' },
    })
    await writePatrolVerdict(db, {
      claimId: c,
      byRole: 'agent:verifier',
      verdict: { entailment: 'not_co_true' },
    })
    await writePatrolVerdict(db, {
      claimId: d,
      byRole: 'agent:verifier',
      verdict: { entailment: 'pass' },
    })
    expect((await readEntailRejectRate(db)).value).toBeCloseTo(0.5, 9) // 2 of 4 reject
  })

  it('readConflictQueueDepth counts escalated conflicts in the editor queue', async () => {
    const a = await seedClaim({})
    const b = await seedClaim({})
    await escalateConflict(db, { a, b, rung: 'human', reason: 'tie', byRole: 'agent:arbiter' })
    expect((await readConflictQueueDepth(db)).value).toBe(1)
  })

  it('readFalseQuarantineRate is fed by REAL S22 human_overturn(un_quarantine) events', async () => {
    const q1 = await seedClaim({ status: 'quarantined' })
    await seedClaim({ status: 'quarantined' }) // still quarantined → denominator
    // a human un-quarantined one claim (the false-quarantine signal)
    await recordHumanOverturn(db, {
      overturn: 'un_quarantine',
      claimId: q1,
      fromStatus: 'quarantined',
      toStatus: 'active',
      byRole: 'human:editor',
    })
    // 1 un_quarantine / (1 + 2 still-quarantined) = 0.333…
    expect((await readFalseQuarantineRate(db)).value).toBeCloseTo(1 / 3, 6)
  })

  it('readMetrics: real-source readers are not degraded, but the source-less immuneLag is', async () => {
    await seedClaim({ status: 'draft' })
    const { metrics, degraded } = await readMetrics(db)
    expect(metrics.distillBacklog).toBe(1)
    // immuneLag has no data source → honestly neutral 0 (never fabricate a lag)…
    expect(metrics.immuneLag).toBe(0)
    // …but a neutral 0 from "no source" is degraded, not a silent healthy read.
    expect(degraded).toContain('immuneLag')
    // readers with a real source must NOT be misflagged as degraded.
    expect(degraded).not.toContain('distillBacklog')
  })

  it('default readMetrics marks immuneLag degraded (no data source), not a silent healthy 0', async () => {
    await seedClaim({ status: 'draft' }) // 让其余 reader 有真数据，证明只有 immuneLag 降级
    const { metrics, degraded } = await readMetrics(db) // 默认 defaultMetricReaders
    // 诚实中性：不杜撰延迟
    expect(metrics.immuneLag).toBe(0)
    // 关键回归断言：无数据源 = degraded（台账 #1457）
    expect(degraded).toContain('immuneLag')
    // 有真源的指标不应被误标降级
    expect(degraded).not.toContain('distillBacklog')
  })

  it('readImmuneLag self-reports degraded with a reason (no fabricated lag)', async () => {
    const r: MetricRead = await readImmuneLag(db)
    expect(r.value).toBe(0)
    expect(r.degraded).toBe(true)
    expect(r.reason).toMatch(/no .*source/i)
  })
})

describe('S26 governance — versioned persistence (Standards-style append-only) + reversibility', () => {
  it('getActivePolicy returns the baseline when empty; each cycle appends a new version', async () => {
    expect(await getActivePolicy(db)).toEqual(BASELINE_POLICY)
    await seedClaim({ status: 'draft' })
    const r1 = await runGovernanceCycle(db)
    expect(r1.ran).toBe(true)
    expect(await getGovernanceHistory(db)).toHaveLength(1)
    await runGovernanceCycle(db)
    const history = await getGovernanceHistory(db)
    expect(history).toHaveLength(2) // append-only: both retained, auditable
    // active = latest
    expect(await getActivePolicy(db)).toEqual(history[0]!.policy)
  })

  it('every action is logged with the triggering metrics snapshot + reason (audit trail)', async () => {
    // 60 drafts → ingestionThrottle pressure
    for (let i = 0; i < 60; i++) await seedClaim({ status: 'draft' })
    const r = await runGovernanceCycle(db)
    expect(r.ran).toBe(true)
    const [row] = await getGovernanceHistory(db)
    expect(row!.reason).toMatch(/cycle/)
    expect(row!.metrics.distillBacklog).toBe(60)
    expect(row!.metrics.targets).toBeDefined() // derived balance point snapshot persisted
    expect(row!.createdBy).toBe('controller:governance')
  })

  it('governance cycle records immuneLag in the audit reason when its source is missing', async () => {
    await seedClaim({ status: 'draft' })
    const r = await runGovernanceCycle(db)
    expect(r.ran).toBe(true)
    expect(r.degraded).toContain('immuneLag')
    const [row] = await getGovernanceHistory(db)
    expect(row!.reason).toMatch(/degraded.*immuneLag/)
  })

  it('rollbackTo is reversible and append-only: it re-appends the old policy as a new logged version', async () => {
    const v0 = await writeGovernanceState(db, {
      policy: { ...BASELINE_POLICY, promotionGateLevel: 0.1 },
      metrics: {
        distillBacklog: 0,
        entailRejectRate: 0.1,
        conflictQueueDepth: 0,
        immuneLag: 0,
        falseQuarantineRate: 0,
      },
      reason: 'v0',
    })
    await writeGovernanceState(db, {
      policy: { ...BASELINE_POLICY, promotionGateLevel: 0.9 },
      metrics: {
        distillBacklog: 0,
        entailRejectRate: 0.9,
        conflictQueueDepth: 0,
        immuneLag: 0,
        falseQuarantineRate: 0,
      },
      reason: 'v1 tightened hard',
    })
    expect((await getActivePolicy(db)).promotionGateLevel).toBe(0.9)
    const rolled = await rollbackTo(db, v0.id, 'human:editor')
    expect(rolled.policy.promotionGateLevel).toBe(0.1) // restored
    expect(rolled.reason).toMatch(/rollback to/)
    expect(rolled.createdBy).toBe('human:editor')
    expect(await getGovernanceHistory(db)).toHaveLength(3) // v0, v1, rollback — nothing deleted
    expect((await getActivePolicy(db)).promotionGateLevel).toBe(0.1)
  })

  it('rollbackTo throws on a missing state id', async () => {
    await expect(rollbackTo(db, randomUUID())).rejects.toThrow(/not found/)
  })
})

describe('S26 governance — gate tightening respects S7 invariants + frozen snapshot', () => {
  it('a tightening cycle RAISES the consume gate (never below kernel floors) and only after enough pressure', async () => {
    // heavy entail-reject → promotionGateLevel target high → gate should raise
    for (let i = 0; i < 5; i++) {
      const id = await seedClaim({})
      await writePatrolVerdict(db, {
        claimId: id,
        byRole: 'agent:verifier',
        verdict: { entailment: 'fail' },
      })
    }
    const before = await getActiveStandards(db)
    expect(before.consumeFloor).toBe(KERNEL_CONFIDENCE_FLOOR) // default
    const r = await runGovernanceCycle(db)
    expect(r.ran).toBe(true)
    expect(r.raisedGate).toBe(true)
    const after = await getActiveStandards(db)
    expect(after.consumeFloor).toBeGreaterThan(KERNEL_CONFIDENCE_FLOOR)
    expect(after.consumeFloor).toBeGreaterThanOrEqual(KERNEL_CONFIDENCE_FLOOR) // never below kernel
    expect(after.mustVerifyThreshold).toBeGreaterThanOrEqual(MUST_VERIFY_THRESHOLD)
    expect(after.factorWeights).toEqual(before.factorWeights) // controller never touches weights
  })

  it('a healthy cycle does NOT raise the gate (closed-loop, not tighten-forever)', async () => {
    await seedClaim({ status: 'active' }) // no draft backlog, no rejects, no conflicts
    const r = await runGovernanceCycle(db)
    expect(r.ran).toBe(true)
    expect(r.raisedGate).toBe(false)
    expect(r.changed).toBe(false)
    expect((await getActiveStandards(db)).consumeFloor).toBe(KERNEL_CONFIDENCE_FLOOR)
  })

  it('the controller can never relax the gate below an existing human-set higher floor (only tightens)', async () => {
    // human sets a strict floor; a mild controller cycle must not lower it
    await setStandards(db, {
      factorWeights: DEFAULT_WEIGHTS,
      consumeFloor: 0.7,
      mustVerifyThreshold: 0.8,
    })
    await seedClaim({ status: 'active' }) // healthy → controller target gate ≈ baseline (lower)
    const r = await runGovernanceCycle(db)
    expect(r.ran).toBe(true)
    expect(r.raisedGate).toBe(false) // gateWouldTighten=false: controller never writes a relaxation
    const after = await getActiveStandards(db)
    expect(after.consumeFloor).toBe(0.7) // human floor preserved
    expect(after.mustVerifyThreshold).toBe(0.8)
  })

  it('threshold change affects only NEW recalls; a snapshot taken BEFORE the tightening stays frozen', async () => {
    // recomputes to 0.525 under DEFAULT weights (authority 1, entailment .5, indepSupport 1)
    const id = randomUUID()
    await db.insert(claim).values({
      id,
      claimText: 'engram frozen snapshot demo',
      status: 'active',
      confidence: 0,
      confidenceRaw: 0,
      confidenceFactors: {
        factors: {
          authority: 1,
          humanReview: 0,
          entailment: 0.5,
          indepSupport: 1,
          usageCorrect: 0,
          ageDays: 0,
          activeContradicts: 0,
          staleDecay: 1,
          conflictDecay: 1,
        },
        weights: DEFAULT_WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      embedding: await embedder.embed('engram frozen snapshot demo'),
      embeddingVersion: embedder.version,
      lineageId: randomUUID(),
      asOf: new Date(),
      createdBy: 'test',
    })
    const { sourceId } = await addSource(db, {
      content: 'b',
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.9,
    })
    await db
      .insert(claimProvenance)
      .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })

    // recall BEFORE the controller tightens — capture the snapshot value
    const [before] = await recallClaims(db, embedder, 'engram frozen snapshot demo')
    expect(before!.confidence.value).toBeCloseTo(0.525, 6)

    // controller raises the gate above 0.525 (drive promotionGateLevel via heavy entail-reject)
    for (let i = 0; i < 5; i++) {
      const cid = await seedClaim({})
      await writePatrolVerdict(db, {
        claimId: cid,
        byRole: 'agent:verifier',
        verdict: { entailment: 'fail' },
      })
    }
    await runGovernanceCycle(db) // raises consumeFloor well above 0.525
    expect((await getActiveStandards(db)).consumeFloor).toBeGreaterThan(0.525)

    // the OLD snapshot object is a frozen value copy — the tightening did not retro-mutate it
    expect(before!.confidence.value).toBeCloseTo(0.525, 6)
    // a NEW recall now drops the 0.525 claim (below the raised floor)
    expect(await recallClaims(db, embedder, 'engram frozen snapshot demo')).toHaveLength(0)
  })
})

/**
 * 把 db 包成「事务内对某张表的 .insert() 抛错」的代理：模拟 runGovernanceCycle 单事务里某一步 DB 故障，
 * 其余方法（含事务外读、另一张表的 insert）原样透传（绑回真实 db/tx，避免 this 丢失）。
 * 用于证明 write-policy + raise-gate 是单事务原子：任一 insert 失败 → 整轮回滚、无半提交行。
 * 仿 editor-actions.test.ts:543-566 的 dbThatThrowsOnUpdate Proxy 故障注入范式，注入点改为事务内对目标表的 insert。
 */
function dbThatThrowsOnInsertInto(realDb: DB, faultTable: object, message: string): DB {
  const wrapTx = (tx: object): object =>
    new Proxy(tx, {
      get(t, p, r) {
        if (p === 'insert') {
          const realInsert = Reflect.get(t, p, r) as (table: unknown) => unknown
          return (table: unknown) => {
            if (table === faultTable) {
              throw new Error(message)
            }
            return realInsert.call(t, table)
          }
        }
        const v = Reflect.get(t, p, r)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          (target as DB).transaction((tx) => fn(wrapTx(tx as object)), ...(rest as []))
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as DB
}

/** 构造一个会让控制器抬严 D2 门的局面：5 条 claim 各带一个 fail 巡检判定 → entail-reject 高 → promotionGateLevel 抬升。 */
async function seedGateTighteningPressure(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const id = await seedClaim({})
    await writePatrolVerdict(db, {
      claimId: id,
      byRole: 'agent:verifier',
      verdict: { entailment: 'fail' },
    })
  }
}

describe('S26 governance — rollbackTo restores the ACTIVE consume gate, not just the policy row (EGR-CR-021)', () => {
  it('rollback to a baseline policy synchronously rolls the standards gate back to the target thresholds', async () => {
    // baseline: 一行 promotionGateLevel:0 的 BASELINE 版本，作为回滚锚点。
    const baseline = await writeGovernanceState(db, {
      policy: BASELINE_POLICY,
      metrics: {
        distillBacklog: 0,
        entailRejectRate: 0,
        conflictQueueDepth: 0,
        immuneLag: 0,
        falseQuarantineRate: 0,
      },
      reason: 'baseline',
    })
    // 抬门前：活动门 = 内核基线（standards 表此刻为空 → DEFAULT_STANDARDS）。
    const before = await getActiveStandards(db)
    expect(before.consumeFloor).toBe(KERNEL_CONFIDENCE_FLOOR)
    expect(before.mustVerifyThreshold).toBe(MUST_VERIFY_THRESHOLD)

    // 一轮治理周期把门真抬上去（同时写 standards 表 + policy 表）。
    await seedGateTighteningPressure()
    const cycle = await runGovernanceCycle(db)
    expect(cycle.ran).toBe(true)
    expect(cycle.raisedGate).toBe(true)
    const raised = await getActiveStandards(db)
    expect(raised.consumeFloor).toBeGreaterThan(KERNEL_CONFIDENCE_FLOOR) // 门确已抬高、已写入 standards 表

    // 回滚到 baseline policy。
    const rolled = await rollbackTo(db, baseline.id, 'human:editor')
    // 控制面：policy 回到 baseline（沿用现测式样）。
    expect(rolled.policy.promotionGateLevel).toBe(0)
    expect((await getActivePolicy(db)).promotionGateLevel).toBe(0)

    // 关键新断言（修前必失败）：生效门同步回到目标 = 内核基线。
    const after = await getActiveStandards(db)
    expect(after.consumeFloor).toBe(KERNEL_CONFIDENCE_FLOOR)
    expect(after.mustVerifyThreshold).toBe(MUST_VERIFY_THRESHOLD)
    // 联动回写复用当前活动权重（rollback 只动门、不碰权重）。
    expect(after.factorWeights).toEqual(raised.factorWeights)
  })

  it('behavior-level: after rollback, recall re-admits a claim that the raised floor had excluded, with mustVerify recomputed off the rolled-back threshold', async () => {
    const baseline = await writeGovernanceState(db, {
      policy: BASELINE_POLICY,
      metrics: {
        distillBacklog: 0,
        entailRejectRate: 0,
        conflictQueueDepth: 0,
        immuneLag: 0,
        falseQuarantineRate: 0,
      },
      reason: 'baseline',
    })

    // 一条 value=0.525 的 active claim（DEFAULT 权重下 authority 1 / entailment .5 / indepSupport 1 → 0.525）。
    const id = randomUUID()
    await db.insert(claim).values({
      id,
      claimText: 'engram rollback re-admits this claim',
      status: 'active',
      confidence: 0,
      confidenceRaw: 0,
      confidenceFactors: {
        factors: {
          authority: 1,
          humanReview: 0,
          entailment: 0.5,
          indepSupport: 1,
          usageCorrect: 0,
          ageDays: 0,
          activeContradicts: 0,
          staleDecay: 1,
          conflictDecay: 1,
        },
        weights: DEFAULT_WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      embedding: await embedder.embed('engram rollback re-admits this claim'),
      embeddingVersion: embedder.version,
      lineageId: randomUUID(),
      asOf: new Date(),
      createdBy: 'test',
    })
    const { sourceId } = await addSource(db, {
      content: 'b',
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.9,
    })
    await db
      .insert(claimProvenance)
      .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })

    // 抬门到 0.525 以上 → 召回被生效门挡掉。
    await seedGateTighteningPressure()
    await runGovernanceCycle(db)
    expect((await getActiveStandards(db)).consumeFloor).toBeGreaterThan(0.525)
    expect(await recallClaims(db, embedder, 'engram rollback re-admits this claim')).toHaveLength(0)

    // 回滚 → 生效门回到 0.4/0.6 → 召回重新放行该 claim，且 mustVerify 依据回退后的 0.6 计算（0.525 < 0.6 → true）。
    await rollbackTo(db, baseline.id, 'human:editor')
    const after = await recallClaims(db, embedder, 'engram rollback re-admits this claim')
    expect(after).toHaveLength(1)
    expect(after[0]!.confidence.value).toBeCloseTo(0.525, 6)
    expect(after[0]!.mustVerify).toBe(true) // 0.525 < 回退后的 mustVerifyThreshold 0.6
  })

  it('append-only preserved: rollback adds new policy AND standards rows, deletes nothing', async () => {
    const baseline = await writeGovernanceState(db, {
      policy: BASELINE_POLICY,
      metrics: {
        distillBacklog: 0,
        entailRejectRate: 0,
        conflictQueueDepth: 0,
        immuneLag: 0,
        falseQuarantineRate: 0,
      },
      reason: 'baseline',
    })
    await seedGateTighteningPressure()
    await runGovernanceCycle(db) // +1 policy 行, +1 standards 行
    const policyRowsBefore = await getGovernanceHistory(db)
    const standardsRowsBefore = await db.select().from(standards)

    await rollbackTo(db, baseline.id, 'human:editor')

    // policy / standards 都是追写新行，无物理删除。
    expect(await getGovernanceHistory(db)).toHaveLength(policyRowsBefore.length + 1)
    expect(await db.select().from(standards)).toHaveLength(standardsRowsBefore.length + 1)
  })

  it('atomic: if the standards write throws inside rollback, the policy row is NOT half-committed (EGR-CR-033)', async () => {
    const baseline = await writeGovernanceState(db, {
      policy: BASELINE_POLICY,
      metrics: {
        distillBacklog: 0,
        entailRejectRate: 0,
        conflictQueueDepth: 0,
        immuneLag: 0,
        falseQuarantineRate: 0,
      },
      reason: 'baseline',
    })
    await seedGateTighteningPressure()
    await runGovernanceCycle(db) // 抬门，活动门 > 内核基线
    const raisedStandards = await getActiveStandards(db)
    const policyCountBefore = (await getGovernanceHistory(db)).length

    // 注入：rollback 事务内对 standards 表的 insert 抛错（governance_state 的 insert 必须放行 → 命中「policy 写成功之后」窗口）。
    const faultyDb = dbThatThrowsOnInsertInto(
      db,
      standards,
      'injected: standards insert fault during rollback',
    )
    await expect(rollbackTo(faultyDb, baseline.id, 'human:editor')).rejects.toThrow(
      /standards insert fault/,
    )

    // 整体回滚：policy 行未半提交，活动门保持抬高态（控制面/数据面无裂缝）。
    expect(await getGovernanceHistory(db)).toHaveLength(policyCountBefore)
    expect(await getActiveStandards(db)).toEqual(raisedStandards)
  })
})

describe('S26 governance — cycle is atomic: write-policy + raise-gate share one transaction (EGR-CR-033)', () => {
  it('state write succeeds but standards write throws → NO half-committed policy row, baseline untouched', async () => {
    await seedGateTighteningPressure()
    // 前置自检：无故障注入时这一局面确实会走到 setStandards（raisedGate=true），否则故障注入打不到本 bug 窗口。
    const baselineStandards = await getActiveStandards(db)
    expect(baselineStandards.consumeFloor).toBe(KERNEL_CONFIDENCE_FLOOR)
    expect(await getActivePolicy(db)).toEqual(BASELINE_POLICY)

    // 注入：事务内对 standards 表的 insert 抛错（governance_state 的 insert 必须放行 → 命中「policy 写成功之后」窗口）。
    const faultyDb = dbThatThrowsOnInsertInto(db, standards, 'injected: standards insert fault')
    const r = await runGovernanceCycle(faultyDb)

    // 外层 catch 仍兜底（fail-silent 契约不变）。
    expect(r.ran).toBe(false)
    expect(r.reason).toMatch(/degraded silently/)

    // 关键回归断言（修复前必失败：半提交的 policy 行存在 → 长度为 1）：policy 行被事务回滚，零半提交。
    expect(await getGovernanceHistory(db)).toHaveLength(0)
    // 下一轮基线未被半提交行污染。
    expect(await getActivePolicy(db)).toEqual(BASELINE_POLICY)
    // 数据面真实 recall 门未变（控制面/数据面无裂缝）。
    expect(await getActiveStandards(db)).toEqual(baselineStandards)
  })

  it('a healthy tightening cycle keeps the control plane and data plane consistent (no regression in the raise-gate path)', async () => {
    await seedGateTighteningPressure()
    const r = await runGovernanceCycle(db)

    expect(r.ran).toBe(true)
    expect(r.raisedGate).toBe(true)
    // 控制面：恰好落了一行新 policy 版本，且就是本轮派生的 policy。
    const history = await getGovernanceHistory(db)
    expect(history).toHaveLength(1)
    expect(history[0]!.policy).toEqual(r.policy)
    // 数据面：活动门 === gateThresholdsFor(本轮 promotionGateLevel)（控制面/数据面同步落地）。
    const after = await getActiveStandards(db)
    const expected = gateThresholdsFor(r.policy!.promotionGateLevel)
    expect(after.consumeFloor).toBeCloseTo(expected.consumeFloor, 9)
    expect(after.mustVerifyThreshold).toBeCloseTo(expected.mustVerifyThreshold, 9)
  })

  it('symmetric: when the governance_state write itself throws inside the tx, the data plane also gets zero writes', async () => {
    await seedGateTighteningPressure()
    const baselineStandards = await getActiveStandards(db)

    // 注入：事务内对 governance_state 表的 insert 抛错（step ③ 写 policy 就挂；与 dead-DB 测试在 step ① 挂互补）。
    const faultyDb = dbThatThrowsOnInsertInto(
      db,
      governanceState,
      'injected: governance_state insert fault',
    )
    const r = await runGovernanceCycle(faultyDb)

    expect(r.ran).toBe(false)
    expect(r.reason).toMatch(/degraded silently/)
    // 控制面与数据面均零写。
    expect(await getGovernanceHistory(db)).toHaveLength(0)
    expect(await getActiveStandards(db)).toEqual(baselineStandards)
  })
})

describe('S26 governance — silent degrade (zero orchestration single point)', () => {
  it('a throwing metric reader degrades that metric (not the cycle) and the cycle still completes deterministically', async () => {
    await seedClaim({ status: 'draft' })
    const flaky: MetricReaders = {
      distillBacklog: readDistillBacklog,
      entailRejectRate: async () => {
        throw new Error('entail reader exploded')
      },
      conflictQueueDepth: readConflictQueueDepth,
      immuneLag: async () => ({ value: 0 }),
      falseQuarantineRate: readFalseQuarantineRate,
    }
    const r = await runGovernanceCycle(db, { readers: flaky })
    expect(r.ran).toBe(true) // cycle survived the reader failure
    expect(r.degraded).toContain('entailRejectRate')
    expect(r.metrics!.entailRejectRate).toBe(0) // degraded to neutral, no phantom tightening
    expect(r.metrics!.distillBacklog).toBe(1) // healthy readers still read
  })

  it('if the whole cycle errors (e.g. DB pool down), it returns ran=false and the trunk (recall) still serves', async () => {
    // seed a recallable active claim on the live db
    const id = randomUUID()
    await db.insert(claim).values({
      id,
      claimText: 'engram trunk survives',
      status: 'active',
      confidence: 0,
      confidenceRaw: 0,
      confidenceFactors: {
        factors: {
          authority: 1,
          humanReview: 1,
          entailment: 0.5,
          indepSupport: 1,
          usageCorrect: 1,
          ageDays: 0,
          activeContradicts: 0,
          staleDecay: 1,
          conflictDecay: 1,
        },
        weights: DEFAULT_WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      embedding: await embedder.embed('engram trunk survives'),
      embeddingVersion: embedder.version,
      lineageId: randomUUID(),
      asOf: new Date(),
      createdBy: 'test',
    })
    const { sourceId } = await addSource(db, {
      content: 'b',
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.9,
    })
    await db
      .insert(claimProvenance)
      .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })

    // a controller wired to a dead DB handle: cycle must NOT throw, just no-op
    const deadPool = new pg.Pool({
      connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/none',
    })
    const deadDb = createDb(deadPool)
    const r = await runGovernanceCycle(deadDb)
    expect(r.ran).toBe(false)
    expect(r.reason).toMatch(/degraded silently/)
    await deadPool.end()

    // the trunk on the live db is completely unaffected — recall still serves
    expect(await recallClaims(db, embedder, 'engram trunk survives')).toHaveLength(1)
    // and no governance/standards rows were written by the failed cycle
    expect(await getGovernanceHistory(db)).toHaveLength(0)
  })
})
