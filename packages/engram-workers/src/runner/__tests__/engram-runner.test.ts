/**
 * P4b · EngramRunner 集成 —— 证明北极星模块**真能跑起来**：一个 EngramRunner 实例把五工种 + 控制面 + 红蓝对抗
 * 接成可执行自闭环，全程真测试 DB + 真工种（fake 端口：fake model/embedder/judge/reader，零 bespoke 业务 mock）。
 *
 * 证明四件事：
 *   1. 路由表 = 五工种（接线全解自各工种导出的 TRIGGER 常量，非模型）。
 *   2. runClosedLoop（live 一拍）：一源摄入经声明触发级联到收敛（Distiller→Reconciler/Verifier）、claim 真落库；
 *      恒温器(S26)真走一步落 governance_state；首次校准(S28)诚实 below_threshold（<200 样本 ⇒ g 维持 identity）。
 *   3. harvestUsage：report_usage 只命中 Harvester（闭合「使用→升信」f4 的独立门控统计）。
 *   4. adversarialRound（对抗北极星一回合，sandbox）：经 runner 真跑 P4a runRedBlueRound —— 四类题全过 A1 免疫
 *      进被计分 cohort、判分落 redteam_immunity_scores。两条铁律(A1/A3)由 P4a 的 21 测结构性钉死，此处只证 runner 能驱动。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  getImmunityScores,
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

/** 造一个全 fake 端口的 EngramRunner（distiller 脚本注入有界 loop 的产出）。 */
function buildRunner(distillerScript: FakeAssistantResponse[]): EngramRunner {
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
    arbiterRuntimeFor: (pairs) =>
      makeHarnessPiRuntime(
        createFakeModel([...pairs.map(([a, b]) => adjudicateTurn(a, b)), finishTurn(), stopTurn]),
      ),
  })
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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, l5_candidates, golden_questions, promotion_audit CASCADE',
  )
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

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
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
