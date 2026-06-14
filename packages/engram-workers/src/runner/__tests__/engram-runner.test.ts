/**
 * P4b · EngramRunner 集成 —— 证明北极星模块**真能跑起来**：一个 EngramRunner 实例把五工种 + 控制面 + 红蓝对抗
 * 接成可执行自闭环，全程真测试 DB + 真工种（fake 端口：fake model/embedder/judge/reader，零 bespoke 业务 mock）。
 *
 * 证明：
 *   1. 路由表 = 五工种（接线全解自各工种导出的 TRIGGER 常量，非模型）。
 *   2. runClosedLoop（live 一拍）：一源摄入经声明触发级联到收敛（Distiller→Reconciler/Verifier）、claim 真落库；
 *      恒温器(S26)真走一步落 governance_state；首次校准(S28)诚实 below_threshold（<200 样本 ⇒ g 维持 identity）。
 *   3. harvestUsage / runClosedLoop({usage})：report_usage 只命中 Harvester（闭合「使用→升信」f4）。
 *   4. **runner 真把 Arbiter 接进运行进程**（本 runner 存在的理由）：一对 active 矛盾经 runClosedLoop 被
 *      wire() 的 arbiter 臂 + allContradictsPairs + arbiterRuntimeFor 路由到 Arbiter 并确定性自裁（正向覆盖）。
 *   5. runner 级单点失效：一个工种处理器抛错被 EventDispatcher 吞、计 failures、级联不掀翻、读写主干不污染。
 *   6. adversarialRound（对抗北极星一回合，sandbox）：经 runner 真跑 P4a runRedBlueRound —— 四类题全过 A1 免疫
 *      进被计分 cohort、判分落 redteam_immunity_scores。两条铁律(A1/A3)由 P4a 的 21 测结构性钉死，此处只证 runner 能驱动。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { eq } from 'drizzle-orm'

import {
  addSource,
  createDb,
  getImmunityScores,
  getResolvedConflicts,
  makeFakeEmbedder,
  makeFakeEntailmentJudge,
  makeFakeSameFactJudge,
  reportUsage,
  schema,
  type DB,
  type Embedder,
  type EntailmentJudge,
  type RedTeamItem,
} from '@engram/core'
import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { type DistillerDeps } from '../../distiller.js'
import { type HarvesterDeps } from '../../harvester.js'
import { type ReconcilerDeps } from '../../reconciler.js'
import { type VerifierDeps } from '../../verifier.js'
import { makeFakeSourceReader } from '../../read/fake-source-reader.js'
import { makeHarnessPiRuntime } from '../../runtime/harness-pi.js'
import { REDTEAM_GENERATION_ITEMS } from '../../eval/redteam.gen.js'
import { truncateEvalWorkTablesSql } from '../../eval/work-tables.js'
import { EngramRunner } from '../engram-runner.js'

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
const sameFact = makeFakeSameFactJudge()
const reader = makeFakeSourceReader()
const entailment: EntailmentJudge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })

let seq = 0
function commitTurn(args: Record<string, unknown>): FakeAssistantResponse {
  return {
    content: [{ type: 'toolCall', id: `tc${++seq}`, name: 'commit_claim', arguments: args }],
    stopReason: 'toolUse',
  }
}
function adjudicateTurn(a: string, b: string): FakeAssistantResponse {
  return {
    content: [
      {
        type: 'toolCall',
        id: `tc${++seq}`,
        name: 'adjudicate_conflict',
        arguments: { claimA: a, claimB: b },
      },
    ],
    stopReason: 'toolUse',
  }
}
const finishTurn = (): FakeAssistantResponse => ({
  content: [{ type: 'toolCall', id: `tc${++seq}`, name: 'finish', arguments: {} }],
  stopReason: 'toolUse',
})
const stopTurn: FakeAssistantResponse = {
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'stop',
}

/** 默认 arbiter 运行时工厂：逐对 adjudicate + finish（确定性阶梯定胜者，model 不选边）。 */
function defaultArbiterRuntimeFor(pairs: Array<[string, string]>) {
  return makeHarnessPiRuntime(
    createFakeModel([...pairs.map(([a, b]) => adjudicateTurn(a, b)), finishTurn(), stopTurn]),
  )
}

/**
 * 造一个全 fake 端口的 EngramRunner（distiller 脚本注入有界 loop 的产出）。
 * arbiterRuntimeFor 可覆盖（spy 记录收到的对 / 注入抛错验 runner 级单点失效）。
 */
function buildRunner(
  distillerScript: FakeAssistantResponse[],
  arbiterRuntimeFor: (
    pairs: Array<[string, string]>,
  ) => ReturnType<typeof makeHarnessPiRuntime> = defaultArbiterRuntimeFor,
): EngramRunner {
  const distiller: DistillerDeps = {
    db,
    embedder,
    judge: sameFact,
    runtime: makeHarnessPiRuntime(createFakeModel(distillerScript)),
    reader,
  }
  const verifier: VerifierDeps = { db, judge: entailment }
  const reconciler: ReconcilerDeps = { db, judge: entailment }
  const harvester: HarvesterDeps = { db }
  return new EngramRunner({
    db,
    embedder,
    distiller,
    verifier,
    reconciler,
    harvester,
    arbiterRuntimeFor,
  })
}

/** 读 claim 存档的 f4 usageCorrect + raw（断言「空 batch 没触发全库重算」用）。 */
async function storedOf(claimId: string): Promise<{ usageCorrect: number; raw: number }> {
  const [row] = await db
    .select({ f: schema.claim.confidenceFactors, raw: schema.claim.confidenceRaw })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  const stored = row!.f as { factors: { usageCorrect: number } }
  return { usageCorrect: stored.factors.usageCorrect, raw: row!.raw }
}

async function aSource(content?: string): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: content ?? `body-${randomUUID()}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  return sourceId
}

/** 单条不矛盾 claim 的 distiller 脚本（commit 一条 → finish → stop）。 */
function oneClaimScript(): FakeAssistantResponse[] {
  return [
    commitTurn({
      claimText: 'sku-9 weight 5kg',
      subject: 'sku-9',
      predicate: 'weight',
      object: '5kg',
      locator: 'L1',
    }),
    finishTurn(),
    stopTurn,
  ]
}

async function resetWorkTables(): Promise<void> {
  await pool.query(truncateEvalWorkTablesSql())
}
async function resetRedTeamTables(): Promise<void> {
  await pool.query(
    'TRUNCATE redteam_immunity_scores, redteam_generations, recompete_events CASCADE',
  )
}
function oneOfEachClass(): RedTeamItem[] {
  const classes = ['false', 'contradiction', 'stale', 'near_dup_poison'] as const
  return classes.map((c) => REDTEAM_GENERATION_ITEMS.find((i) => i.redteamClass === c)!)
}

const DISTILLER_ROLE = 'agent:distiller'
const ARBITER_ROLE = 'agent:arbiter'
// HIGH 因子 profile：清 recall floor、让 seed 的 claim 真 active 且可召回（与 choreography 测同款）。
const WEIGHTS = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}
const HIGH = {
  authority: 0.8,
  humanReview: 0.8,
  entailment: 0.8,
  indepSupport: 0.8,
  usageCorrect: 0.8,
}

/** 直接 seed 一条 active、可召回、exact 出处的 S/P/O claim（模拟既有 KB）。 */
async function seedActiveClaim(opts: {
  query: string
  object: string
  asOf: Date
}): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: `src-${randomUUID()}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
  const id = randomUUID()
  await db.insert(schema.claim).values({
    id,
    claimText: opts.query,
    subject: 'k',
    predicate: 'p',
    object: opts.object,
    status: 'active',
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: { ...HIGH, ageDays: 0, activeContradicts: 0, staleDecay: 1, conflictDecay: 1 },
      weights: WEIGHTS,
      calibrationVersion: 'identity',
    },
    lineageId: randomUUID(),
    asOf: opts.asOf,
    createdBy: DISTILLER_ROLE,
    embedding: await embedder.embed(opts.query),
    embeddingVersion: embedder.version,
  })
  await db
    .insert(schema.claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'L1', relevance: 'exact' })
  return id
}

/** seed 一对 active 矛盾 claim（同 query → recall 双返）+ 一条 contradicts 边。a 较新 ⇒ ③ recency 唯一胜者。 */
async function seedActivePair(opts: {
  query: string
  aAsOf: Date
  bAsOf: Date
}): Promise<{ a: string; b: string }> {
  const a = await seedActiveClaim({ query: opts.query, object: 'A', asOf: opts.aAsOf })
  const b = await seedActiveClaim({ query: opts.query, object: 'B', asOf: opts.bAsOf })
  await db
    .insert(schema.relation)
    .values({ id: randomUUID(), fromClaim: a, toClaim: b, type: 'contradicts' })
  return { a, b }
}

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
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

describe('P4b · EngramRunner 把北极星接成可跑自闭环', () => {
  describe('数据面 + 控制面（live 一拍）', () => {
    beforeEach(resetWorkTables)

    it('① 路由表 = 五工种（接线全解自各工种声明的 TRIGGER 常量）', () => {
      const runner = buildRunner(oneClaimScript())
      expect(runner.registeredWorkers().sort()).toEqual([
        'arbiter',
        'distiller',
        'harvester',
        'reconciler',
        'verifier',
      ])
    })

    it('② runClosedLoop：一源摄入级联到收敛 + claim 真落库 + 恒温器走一步 + 校准诚实 below_threshold', async () => {
      const runner = buildRunner(oneClaimScript())
      const sourceId = await aSource()

      const report = await runner.runClosedLoop({ sources: [sourceId] })

      // 数据面：一次级联，distiller→reconciler→verifier 被声明触发确定性触达；无冲突 ⇒ arbiter 不触发；无单点失效。
      expect(report.ingests).toHaveLength(1)
      const cascade = report.ingests[0]!.result
      expect(cascade.truncated).toBe(false)
      expect(cascade.failures).toBe(0)
      expect(cascade.firedByWorker.distiller).toBe(1)
      expect(cascade.firedByWorker.reconciler).toBe(1)
      expect(cascade.firedByWorker.verifier).toBe(1)
      expect(cascade.firedByWorker.arbiter).toBeUndefined()
      // claim 真落库（Distiller 经真 commit_claim SPI 写入）。
      const claims = await db.select({ id: schema.claim.id }).from(schema.claim)
      expect(claims).toHaveLength(1)

      // 控制面①恒温器：真走一步、落了一行 governance_state（审计/可逆锚点）。
      expect(report.governance.ran).toBe(true)
      expect(report.governance.stateRow).toBeDefined()

      // 控制面②首次校准：<200 真值样本 ⇒ 不拟合、g 维持 identity（诚实 below_threshold —— 不是假装校准好了）。
      expect(report.recalibrate.fitted).toBe(false)
      if (report.recalibrate.fitted === false) {
        expect(report.recalibrate.reason).toBe('below_threshold')
        expect(report.recalibrate.sampleCount).toBe(0)
      }
    })

    it('③ harvestUsage：report_usage 只命中 Harvester（闭合「使用→升信」f4）', async () => {
      const runner = buildRunner(oneClaimScript())
      const sourceId = await aSource()
      await runner.ingest(sourceId)
      const [claimRow] = await db.select({ id: schema.claim.id }).from(schema.claim)
      const claimId = claimRow!.id
      // 两条独立用户的 adopted usage_truth（Harvester 才有可统计的独立门控 f4）。
      await reportUsage(db, claimId, 'adopted', { taskId: 't1', byRole: 'agent:consumer-1' })
      await reportUsage(db, claimId, 'adopted', { taskId: 't2', byRole: 'agent:consumer-2' })

      const usage = await runner.harvestUsage([claimId])
      expect(Object.keys(usage.firedByWorker)).toEqual(['harvester'])
      expect(usage.firedByWorker.harvester).toBe(1)
      expect(usage.failures).toBe(0)
    })

    it('③b runClosedLoop({usage})：usageHarvest 非空、单拍内 Harvester 真被触发（整合分支覆盖）', async () => {
      // 先有一条 active claim（seed）可供上报；再在**同一拍** runClosedLoop 里走 usage 分支。
      const a = await seedActiveClaim({
        query: 'kpZ throughput',
        object: 'A',
        asOf: new Date('2025-06-01T00:00:00.000Z'),
      })
      await reportUsage(db, a, 'adopted', { taskId: 'u1', byRole: 'agent:consumer-x' })
      await reportUsage(db, a, 'adopted', { taskId: 'u2', byRole: 'agent:consumer-y' })

      const runner = buildRunner(oneClaimScript())
      const report = await runner.runClosedLoop({ usage: [a] })

      // usageHarvest 非空分支（engram-runner.ts:157-159）真被走到，且只命中 Harvester。
      expect(report.usageHarvest).not.toBeNull()
      expect(report.usageHarvest!.result.firedByWorker.harvester).toBe(1)
      expect(report.usageHarvest!.result.failures).toBe(0)
      // 控制面两拍仍走完。
      expect(report.governance.ran).toBe(true)
      expect(report.recalibrate.fitted).toBe(false)
    })

    // EGR-CR-037 (#112): public SPI harvestUsage([]) must NOT degrade into a full-DB Harvester recompute.
    // Pre-fix: an empty report_usage event is dispatched, the Harvester handler runs harvestBatch([]) →
    // runHarvester({claimIds: []}) → selector cron branch recomputes EVERY usage_truth claim (here f4 0.8→1.0).
    // Post-fix (A+B): the SPI short-circuits and never publishes the empty event, so the Harvester is not fired
    // and no claim is touched.
    it('⑥ EGR-CR-037: public harvestUsage([]) is a no-op — Harvester not fired, no full-DB recompute', async () => {
      const a = await seedActiveClaim({
        query: 'kpEmpty throughput',
        object: 'A',
        asOf: new Date('2025-06-01T00:00:00.000Z'),
      })
      // give it usage that a cron recompute WOULD fold into f4 (3 independent adopted → f4 would become 1.0).
      for (const u of ['p', 'q', 'r']) {
        await reportUsage(db, a, 'adopted', { taskId: `t-${u}`, byRole: `agent:consumer-${u}` })
      }
      const before = await storedOf(a)
      expect(before.usageCorrect).toBe(0.8) // seeded snapshot (cron recompute would push this to 1.0)

      const runner = buildRunner(oneClaimScript())
      const res = await runner.harvestUsage([])

      // A+B: the empty event is not published → Harvester never dispatched, dispatch trace is clean.
      expect(res.firedByWorker.harvester ?? 0).toBe(0)
      expect(res.dispatched).toBe(0)
      expect(res.failures).toBe(0)
      // the decisive anti-degradation assertion: the claim's f4/raw were NOT recomputed.
      const after = await storedOf(a)
      expect(after.usageCorrect).toBe(before.usageCorrect) // still 0.8 — untouched
      expect(after.raw).toBe(before.raw)
    })

    it('④ runner 真把 Arbiter 接进运行进程：一对 active 矛盾经 runClosedLoop 被路由到 Arbiter 并确定性裁决', async () => {
      // 既有 KB：一对 active 矛盾 claim（a 较新 → ③ recency 唯一胜者）。这是 runner 存在的理由——把 Arbiter 接进跑起来的进程。
      const { a, b } = await seedActivePair({
        query: 'kpA throughput',
        aAsOf: new Date('2025-06-01T00:00:00.000Z'),
        bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      })
      // spy：记录 arbiterRuntimeFor 收到的对（证明 wire() 的 arbiter 臂 + allContradictsPairs + 工厂调用真跑）。
      const seenPairs: Array<Array<[string, string]>> = []
      const runner = buildRunner(
        // distiller 提交一条**不矛盾**的新 claim（驱动 distiller/reconciler/verifier 全级联），不引入新 contradicts 边。
        [
          commitTurn({
            claimText: 'sku-x spec 1',
            subject: 'sku-x',
            predicate: 'spec',
            object: '1',
            locator: 'L9',
          }),
          finishTurn(),
          stopTurn,
        ],
        (pairs) => {
          seenPairs.push(pairs)
          return defaultArbiterRuntimeFor(pairs)
        },
      )
      const sourceId = await aSource()
      const report = await runner.runClosedLoop({ sources: [sourceId] })
      const cascade = report.ingests[0]!.result

      // 全级联触达（含 Arbiter，正向覆盖——非此前的 toBeUndefined 负判）。
      expect(cascade.failures).toBe(0)
      expect(cascade.firedByWorker.distiller).toBe(1)
      expect(cascade.firedByWorker.reconciler).toBe(1)
      expect(cascade.firedByWorker.verifier).toBe(1)
      expect(cascade.firedByWorker.arbiter).toBe(1)
      // 工厂确实收到了那对待裁矛盾（allContradictsPairs → conflict.detected → arbiterRuntimeFor）。
      expect(seenPairs.flat()).toContainEqual([a, b])
      // Arbiter 确定性自裁（③ recency 定胜者 = a，model 不选边）；红线#2：不改 status，双方仍 active。
      const resolved = await getResolvedConflicts(db)
      expect(resolved).toHaveLength(1)
      expect(resolved[0]!.payload.winnerId).toBe(a)
      expect(resolved[0]!.payload.byRole).toBe(ARBITER_ROLE)
      const statuses = await db
        .select({ id: schema.claim.id, s: schema.claim.status })
        .from(schema.claim)
      expect(statuses.find((r) => r.id === a)!.s).toBe('active')
      expect(statuses.find((r) => r.id === b)!.s).toBe('active')
    })

    it('⑤ runner 级单点失效：一个工种处理器抛错被吞、计 failures、级联不掀翻、其余工种照常 + claim 仍落库', async () => {
      // 注入一个**会抛错**的 arbiter 工厂（模拟该工种被禁用/崩了）；备一对 active 矛盾让 arbiter 臂必被触发。
      await seedActivePair({
        query: 'kpB throughput',
        aAsOf: new Date('2025-06-01T00:00:00.000Z'),
        bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      })
      const runner = buildRunner(
        [
          commitTurn({
            claimText: 'sku-y spec 2',
            subject: 'sku-y',
            predicate: 'spec',
            object: '2',
            locator: 'L9',
          }),
          finishTurn(),
          stopTurn,
        ],
        () => {
          throw new Error('arbiter runtime down (injected single-point failure)')
        },
      )
      const sourceId = await aSource()
      // runClosedLoop 不应抛（EventDispatcher 吞掉处理器抛错）。
      const report = await runner.runClosedLoop({ sources: [sourceId] })
      const cascade = report.ingests[0]!.result

      // 单点失效被计、级联未掀翻：distiller/reconciler/verifier 照常触达。
      expect(cascade.failures).toBeGreaterThanOrEqual(1)
      expect(cascade.firedByWorker.distiller).toBe(1)
      expect(cascade.firedByWorker.reconciler).toBe(1)
      expect(cascade.firedByWorker.verifier).toBe(1)
      // 读写主干不受污染：distiller 抽的那条新 claim 仍真落库（sku-y）。
      const seeded = await db.select({ id: schema.claim.id }).from(schema.claim)
      expect(seeded.length).toBeGreaterThanOrEqual(3) // 2 seeded 矛盾对 + ≥1 新抽 claim
      // arbiter 抛错没产出任何裁决（被吞）。
      expect(await getResolvedConflicts(db)).toHaveLength(0)
      // 控制面两拍仍走完（runner 一拍完整）。
      expect(report.governance.ran).toBe(true)
    })
  })

  describe('对抗北极星一回合（sandbox，经 runner 驱动 P4a runRedBlueRound）', () => {
    beforeEach(async () => {
      await resetRedTeamTables()
      await resetWorkTables()
    })

    it('④ adversarialRound：四类题全过 A1 进被计分 cohort、判分落 redteam_immunity_scores', async () => {
      const runner = buildRunner([]) // distiller 不参与对抗回合
      const result = await runner.adversarialRound({
        generationVersion: 'rb-runner-perfect',
        items: oneOfEachClass(),
        resetWorkTables,
      })

      // 题免疫 A1：四条全过真 promoteCandidate → 进被计分 cohort（铁律：题=毒株先验真）。
      expect(result.admissions).toHaveLength(4)
      expect(result.admissions.every((a) => a.admitted)).toBe(true)
      expect(result.scoredItemIds).toHaveLength(4)
      expect(result.blockedItemIds).toHaveLength(0)
      // 判分作为纯报告维度落 redteam_immunity_scores（每类一行）。
      expect(result.classScores).toHaveLength(4)
      const rows = await getImmunityScores(db, 'rb-runner-perfect')
      expect(new Set(rows.map((r) => r.redteamClass))).toEqual(
        new Set(['false', 'contradiction', 'stale', 'near_dup_poison']),
      )
    })
  })
})
