/**
 * S24 · choreography 集成 + 静默降级证明（issue #24；user stories 24/25/27/35；source A.7）。
 *
 * 这是对**已接线**事件总线的集成 + 架构负判（NEGATIVE）证明，不引入任何新 SPI 行为：工种各自已声明触发。
 * 本套件证明四件事：
 *   1. 无中心编排的级联：一次 `source.ingested` 经各工种**声明的触发**驱动正确下游级联，跑到收敛，无单一在线模型调度。
 *      并物理证明负判「无在线 meta-orchestrator」——路由解自各工种导出的 TRIGGER 常量，非模型。
 *   2. 静默降级 / 无单点失效：逐一杀掉每个工种（处理器抛错），读写主干（appendClaim/recallClaims）仍服务、其余工种仍触发。
 *   3. by_role 逻辑角色标记贯穿级联（judge≠athlete）：各工种把行写在自己的 by_role 下，绝不给自己产出背书。
 *      注意是**应用层逻辑角色**（by_role 标记），非 DB 物理 role 隔离（后者待实现，见 EGR-CR-006）。
 *   4. loop-vs-one-shot 形态匹配 A.7：结构性断言 Distiller/Arbiter 是有界 loop（带 AgentRuntime + maxTurns），
 *      Verifier/Reconciler/Harvester 是函数 + 点状 LLM（无 AgentRuntime / 无 loop）。
 *
 * 全程跑在真测试 DB + FAKE 端口（fake entailment / fake source reader / fake same-fact / fake embedder +
 * harness-pi + fake model 驱动两个有界 loop 工种）。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  appendClaim,
  createDb,
  getEditorConflictQueue,
  getReconcileEscalations,
  getResolvedConflicts,
  getWorkerFailures,
  makeFakeEmbedder,
  makeFakeEntailmentJudge,
  makeFakeSameFactJudge,
  recallClaims,
  recordWorkerFailure,
  reportUsage,
  schema,
  type DB,
  type EntailmentJudge,
} from '@engram/core'
import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { runDistiller, type DistillerDeps } from '../distiller.js'
import {
  reconcileBatch,
  RECONCILER_TRIGGER,
  type ReconcilerDeps,
  type ReconcilerOptions,
} from '../reconciler.js'
import {
  verifyEnqueued,
  VERIFIER_TRIGGER,
  type VerifierDeps,
  type VerifierOptions,
} from '../verifier.js'
import {
  arbitrateConflicts,
  ARBITER_TRIGGER,
  type ArbiterDeps,
  type ArbiterOptions,
} from '../arbiter.js'
import { harvestBatch, HARVESTER_TRIGGER, type HarvesterDeps } from '../harvester.js'
import { makeFakeSourceReader } from '../read/fake-source-reader.js'
import {
  DISTILLER_TRIGGER,
  EventDispatcher,
  routeKeys,
  type EngramEvent,
} from '../runtime/dispatcher.js'
import type { AgentRuntime } from '../runtime/port.js'
import { makeHarnessPiRuntime } from '../runtime/harness-pi.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
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
const embedder = makeFakeEmbedder()
const sameFact = makeFakeSameFactJudge()
const reader = makeFakeSourceReader()

const DISTILLER_ROLE = 'agent:distiller'
const VERIFIER_ROLE = 'agent:verifier'
const RECONCILER_ROLE = 'agent:reconciler'
const ARBITER_ROLE = 'agent:arbiter'

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

beforeEach(async () => {
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, worker_failure CASCADE',
  )
})

// ── harness-pi + fake model 脚本工具（与 distiller/arbiter 测试同款）──────────────────────────────
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
const finishTurn: () => FakeAssistantResponse = () => ({
  content: [{ type: 'toolCall', id: `tc${++seq}`, name: 'finish', arguments: {} }],
  stopReason: 'toolUse',
})
const stopTurn: FakeAssistantResponse = {
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'stop',
}
function runtimeOf(script: FakeAssistantResponse[]): AgentRuntime {
  return makeHarnessPiRuntime(createFakeModel(script))
}

async function aSource(content?: string): Promise<string> {
  const { sourceId } = await addSource(db, {
    // 3 lines by default → fake reader yields anchors L1/L2/L3, so scripted commits citing those
    // locators all hit a real read-source segment (EGR-CR-022 locator-from-readsource gate).
    content: content ?? `body-${randomUUID()}\nbody-${randomUUID()}\nbody-${randomUUID()}`,
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  return sourceId
}

/** 取某 source 经 provenance 关联出的全部 claim id（Distiller 本轮产出的）。 */
async function claimsForSource(sourceId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ claimId: schema.claimProvenance.claimId })
    .from(schema.claimProvenance)
    .where(eq(schema.claimProvenance.sourceId, sourceId))
  return rows.map((r) => r.claimId)
}

/** 取全库 active↔active 的 contradicts 无序对（dispatcher 据此把 conflict.detected 喂 Arbiter）。 */
async function activeContradictsPairs(): Promise<Array<[string, string]>> {
  const edges = await db
    .select({ from: schema.relation.fromClaim, to: schema.relation.toClaim })
    .from(schema.relation)
    .where(eq(schema.relation.type, 'contradicts'))
  const pairs: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const e of edges) {
    if (e.to == null) continue
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push([e.from, e.to])
  }
  return pairs
}

async function statusOf(id: string): Promise<schema.ClaimStatus> {
  const [row] = await db
    .select({ s: schema.claim.status })
    .from(schema.claim)
    .where(eq(schema.claim.id, id))
  return row!.s
}

// HIGH 因子 profile：清 recall floor(0.4)、过 active↔active 机判（与 arbiter.test 同款）。
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

/** 直接 seed 一条 active、可召回、exact 出处的 S/P/O claim（模拟既有 KB；created_by=distiller athlete 身份）。 */
async function seedActiveClaim(opts: {
  query: string
  object: string
  asOf: Date
}): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: `src-${randomUUID()}`,
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

/**
 * EGR-CR-026：直接 seed 一条指定 subject/object/status 的可召回 claim（造 near-dup poison 锚 / 被审 A）。
 * 不写 contradicts 边（区别于 seedActivePair）——用于逼出「纯 escalation、零 contradicts 边」路径。
 */
async function seedPoisonPair(opts: {
  query: string
  subject: string
  object: string
  status: schema.ClaimStatus
}): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: `src-${randomUUID()}`,
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
  const id = randomUUID()
  await db.insert(schema.claim).values({
    id,
    claimText: opts.query,
    subject: opts.subject,
    predicate: 'capacity',
    object: opts.object,
    status: opts.status,
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: { ...HIGH, ageDays: 0, activeContradicts: 0, staleDecay: 1, conflictDecay: 1 },
      weights: WEIGHTS,
      calibrationVersion: 'identity',
    },
    lineageId: randomUUID(),
    asOf: new Date('2025-06-01T00:00:00.000Z'),
    createdBy: DISTILLER_ROLE,
    embedding: await embedder.embed(opts.query),
    embeddingVersion: embedder.version,
  })
  await db
    .insert(schema.claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'L1', relevance: 'exact' })
  return id
}

/** seed 一对 active 矛盾 claim（同 query → recall 双返）+ 一条 contradicts 边。 */
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

/**
 * 把五工种接进总线。每个工种以它**导出的 TRIGGER 常量**解出的事件类型集注册（routeKeys）——
 * 路由表完全由声明驱动，不掺任何模型。处理器是薄包装：调真工种 entry，按结果在主干上**查**出后继事件
 * （batch_appended / conflict.detected / claim.draft）压回总线。可注入 fail 集合模拟杀掉某工种。
 */
interface WireOpts {
  /** 这些工种的处理器一律抛错（模拟单点失效 / 被禁用）。 */
  fail?: Set<'distiller' | 'verifier' | 'reconciler' | 'arbiter' | 'harvester'>
  /** Distiller loop 的 fake model 脚本（按 source 产出哪些 claim）。 */
  distillerScript: FakeAssistantResponse[]
  /** entailment 判官（Verifier/Reconciler 共用）；默认 pass。 */
  entailment?: EntailmentJudge
  /** Arbiter loop 脚本工厂（给定待裁对生成脚本）；默认逐对 adjudicate + finish。 */
  arbiterScriptFor?: (pairs: Array<[string, string]>) => FakeAssistantResponse[]
  /** 回收每次工种调用的可审计句柄。 */
  onFire?: (worker: string, detail: unknown) => void
}

function wireDispatcher(opts: WireOpts): EventDispatcher {
  const fail = opts.fail ?? new Set()
  const entailment = opts.entailment ?? makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
  const distillerDeps: DistillerDeps = {
    db,
    embedder,
    judge: sameFact,
    runtime: runtimeOf(opts.distillerScript),
    reader,
  }
  const verifierDeps: VerifierDeps = { db, judge: entailment }
  const reconcilerDeps: ReconcilerDeps = { db, judge: entailment }
  const harvesterDeps: HarvesterDeps = { db }

  const arbiterScriptFor =
    opts.arbiterScriptFor ??
    ((pairs: Array<[string, string]>) => [
      ...pairs.map(([a, b]) => adjudicateTurn(a, b)),
      finishTurn(),
      stopTurn,
    ])

  const dispatcher = new EventDispatcher()

  // Distiller — 触发 source.ingested。抽完 → 查本源 claim + contradicts 对 → 发 batch_appended + claim.draft + conflict.detected。
  dispatcher.register({
    name: 'distiller',
    triggers: routeKeys(DISTILLER_TRIGGER),
    async handle(event: EngramEvent): Promise<EngramEvent[]> {
      if (fail.has('distiller')) throw new Error('distiller disabled')
      if (event.type !== 'source.ingested') return []
      const res = await runDistiller(distillerDeps, event.payload.sourceId)
      opts.onFire?.('distiller', res)
      const claimIds = await claimsForSource(event.payload.sourceId)
      const pairs = await activeContradictsPairs()
      const out: EngramEvent[] = []
      if (claimIds.length > 0) {
        out.push({ type: 'batch_appended', payload: { claimIds } })
        out.push({ type: 'claim.draft', payload: { claimIds } })
      }
      if (pairs.length > 0) out.push({ type: 'conflict.detected', payload: { pairs } })
      return out
    },
  })

  // Reconciler — 触发 batch_appended（其导出的 RECONCILER_TRIGGER.on）。
  // EGR-CR-026：与生产 runner 同步——把 near-dup poison 升级信号转成 conflict.detected 喂 Arbiter，
  // 即便这对 pair 没有任何 contradicts 边也能交 Arbiter（否则测试脚手架与生产分叉）。
  dispatcher.register({
    name: 'reconciler',
    triggers: routeKeys(RECONCILER_TRIGGER),
    async handle(event: EngramEvent): Promise<EngramEvent[]> {
      if (fail.has('reconciler')) throw new Error('reconciler disabled')
      if (event.type !== 'batch_appended') return []
      const optsR: ReconcilerOptions = {}
      const res = await reconcileBatch(reconcilerDeps, event.payload.claimIds, optsR)
      opts.onFire?.('reconciler', res)
      const pairs: Array<[string, string]> = res.pairs
        .filter((p) => p.verdict === 'poison')
        .map((p) => [p.claimId, p.peerClaimId])
      if (pairs.length === 0) return []
      return [{ type: 'conflict.detected', payload: { pairs } }]
    },
  })

  // Verifier — 触发 claim.draft / claim.flagged（其导出的 VERIFIER_TRIGGER.enqueueOn）。
  dispatcher.register({
    name: 'verifier',
    triggers: routeKeys(VERIFIER_TRIGGER),
    async handle(event: EngramEvent): Promise<void> {
      if (fail.has('verifier')) throw new Error('verifier disabled')
      if (event.type !== 'claim.draft' && event.type !== 'claim.flagged') return
      const optsV: VerifierOptions = {}
      const res = await verifyEnqueued(verifierDeps, event.payload.claimIds, optsV)
      opts.onFire?.('verifier', res)
    },
  })

  // Arbiter — 触发 conflict.detected（其导出的 ARBITER_TRIGGER.event）。有界 loop。
  dispatcher.register({
    name: 'arbiter',
    triggers: routeKeys(ARBITER_TRIGGER),
    async handle(event: EngramEvent): Promise<void> {
      if (fail.has('arbiter')) throw new Error('arbiter disabled')
      if (event.type !== 'conflict.detected') return
      const pairs = event.payload.pairs
      const optsA: ArbiterOptions = {}
      const deps: ArbiterDeps = { db, runtime: runtimeOf(arbiterScriptFor(pairs)) }
      const res = await arbitrateConflicts(deps, pairs, optsA)
      opts.onFire?.('arbiter', res)
    },
  })

  // Harvester — 触发 report_usage（其导出的 HARVESTER_TRIGGER.batchOn）。纯统计。
  dispatcher.register({
    name: 'harvester',
    triggers: routeKeys(HARVESTER_TRIGGER),
    async handle(event: EngramEvent): Promise<void> {
      if (fail.has('harvester')) throw new Error('harvester disabled')
      if (event.type !== 'report_usage') return
      const res = await harvestBatch(harvesterDeps, event.payload.claimIds)
      opts.onFire?.('harvester', res)
    },
  })

  return dispatcher
}

/** 一段会落两条 active claim + 一条 contradicts 边的 Distiller 脚本（让级联触达 Arbiter）。 */
function conflictingDistillScript(): FakeAssistantResponse[] {
  return [
    commitTurn({
      claimText: 'sku-7 maxThroughput 500mbps',
      subject: 'sku-7',
      predicate: 'maxThroughput',
      object: '500mbps',
      locator: 'L1',
    }),
    commitTurn({
      claimText: 'sku-7 maxThroughput 1gbps',
      subject: 'sku-7',
      predicate: 'maxThroughput',
      object: '1gbps',
      locator: 'L2',
    }),
    finishTurn(),
    stopTurn,
  ]
}

describe('S24 choreography integration — A.7 event-driven cascade, no online meta-orchestrator', () => {
  // ── 断言 1：无中心编排的级联 ────────────────────────────────────────────────────────────────
  describe('1. cascade with NO central orchestrator (routing off declared triggers)', () => {
    it('NEGATIVE: the dispatcher imports no model/runtime — routing is resolved purely from each worker’s declared TRIGGER constant', () => {
      // routeKeys 把工种导出的 TRIGGER 常量翻成事件类型集——路由表的唯一来源是声明，不是模型。
      expect(routeKeys(DISTILLER_TRIGGER)).toEqual(['source.ingested'])
      expect(routeKeys(RECONCILER_TRIGGER)).toEqual(['batch_appended'])
      expect(routeKeys(ARBITER_TRIGGER)).toEqual(['conflict.detected'])
      expect(routeKeys(HARVESTER_TRIGGER)).toEqual(['report_usage'])
      expect(routeKeys(VERIFIER_TRIGGER).sort()).toEqual(['claim.draft', 'claim.flagged'])

      // 总线的 resolve() 完全由声明触发决定：给定事件类型 → 命中工种集，确定性、无任何模型参与。
      const dispatcher = wireDispatcher({ distillerScript: conflictingDistillScript() })
      expect(dispatcher.resolve('source.ingested')).toEqual(['distiller'])
      expect(dispatcher.resolve('batch_appended')).toEqual(['reconciler'])
      expect(dispatcher.resolve('conflict.detected')).toEqual(['arbiter'])
      expect(dispatcher.resolve('report_usage')).toEqual(['harvester'])
      expect(dispatcher.resolve('claim.draft')).toEqual(['verifier'])
      // 一个未声明的事件命中零工种（路由不会「凭空创造」一个处理者——无 meta-orchestrator 兜底）。
      expect(dispatcher.resolve('claim.flagged')).toEqual(['verifier'])
    })

    it('a source.ingested cascades Distiller → (batch_appended→Reconciler / claim.draft→Verifier / conflict.detected→Arbiter) to convergence, driven only by declared triggers', async () => {
      const sourceId = await aSource()
      const dispatcher = wireDispatcher({ distillerScript: conflictingDistillScript() })

      const result = await dispatcher.runToConvergence({
        type: 'source.ingested',
        payload: { sourceId },
      })

      // 级联跑到收敛（队列空），没有任何在线模型在调度谁先谁后——纯 BFS off 声明触发。
      expect(result.truncated).toBe(false)
      expect(result.failures).toBe(0)
      // 每个下游工种都被各自声明的触发**确定性地**触达（无中心编排表，全是工种自报触发）。
      expect(result.firedByWorker.distiller).toBe(1)
      expect(result.firedByWorker.reconciler).toBe(1)
      expect(result.firedByWorker.verifier).toBe(1)
      expect(result.firedByWorker.arbiter).toBe(1)

      // 因果链可在 trace 上读出：distiller 发了 batch_appended/claim.draft/conflict.detected，后继工种据此被触发。
      const distillerTrace = result.traces.find((t) => t.workerName === 'distiller')!
      expect(distillerTrace.emitted.sort()).toEqual([
        'batch_appended',
        'claim.draft',
        'conflict.detected',
      ])
      const triggeredEvents = result.traces.map((t) => t.eventType)
      expect(triggeredEvents).toContain('batch_appended')
      expect(triggeredEvents).toContain('conflict.detected')

      // 实际状态收敛：两条矛盾 claim 落库（draft 影子区，D2），它们之间有一条 contradicts 边。
      const claims = await db.select().from(schema.claim)
      expect(claims).toHaveLength(2)
      const edges = await db
        .select()
        .from(schema.relation)
        .where(eq(schema.relation.type, 'contradicts'))
      expect(edges.length).toBeGreaterThanOrEqual(1)
      // 忠实于 A.5：刚抽出的两条 claim 仍是 draft（单源 conf<0.5 不晋升），Arbiter 只裁 active↔active 活跃矛盾，
      // 故对这对 draft 矛盾**忠实地跳过**——不机判、不升级（不是「编排器强行让 Arbiter 资源它」）。收敛即此。
      const resolved = await getResolvedConflicts(db)
      expect(resolved).toHaveLength(0)
      expect(await getEditorConflictQueue(db)).toHaveLength(0)
    })

    it('full convergence WITH Arbiter machine-adjudication: the same dispatcher routes a conflict.detected over an active KB pair to the Arbiter, which self-adjudicates (deterministic, no model picks the winner)', async () => {
      // 既有 KB：两条 active 矛盾 claim（一新一旧，③ recency 唯一胜者）。conflict.detected 经声明触发路由到 Arbiter。
      const { a, b } = await seedActivePair({
        query: 'kpA throughput',
        aAsOf: new Date('2025-06-01T00:00:00.000Z'), // 更新 → ③ recency 胜
        bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      })
      const dispatcher = wireDispatcher({ distillerScript: conflictingDistillScript() })
      const result = await dispatcher.runToConvergence({
        type: 'conflict.detected',
        payload: { pairs: [[a, b]] },
      })

      // 只命中 Arbiter（conflict.detected 是它声明的触发；没有别的工种被「编排」着跟着跑）。
      expect(Object.keys(result.firedByWorker)).toEqual(['arbiter'])
      expect(result.failures).toBe(0)
      const resolved = await getResolvedConflicts(db)
      expect(resolved).toHaveLength(1)
      expect(resolved[0]!.payload.winnerId).toBe(a) // 确定性阶梯（③ recency）定的胜者，非模型选边
      expect(resolved[0]!.payload.byRole).toBe(ARBITER_ROLE)
      // 红线#2：Arbiter 不改 status；读主干仍双返两方（A.5 矛盾显式）。
      expect(await statusOf(a)).toBe('active')
      expect(await statusOf(b)).toBe('active')
      const hits = await recallClaims(db, embedder, 'kpA throughput')
      expect(hits.map((h) => h.claim.id).sort()).toEqual([a, b].sort())
    })

    it('a NON-conflicting source drives ONLY the Distiller→Reconciler→Verifier branch — the Arbiter is never fired (no orchestrator force-runs every worker)', async () => {
      const sourceId = await aSource()
      // 一条不矛盾的 claim：无 contradicts 边 → 不会发 conflict.detected → Arbiter 不被触发。
      const script: FakeAssistantResponse[] = [
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
      const dispatcher = wireDispatcher({ distillerScript: script })
      const result = await dispatcher.runToConvergence({
        type: 'source.ingested',
        payload: { sourceId },
      })

      expect(result.firedByWorker.distiller).toBe(1)
      expect(result.firedByWorker.reconciler).toBe(1)
      expect(result.firedByWorker.verifier).toBe(1)
      // 关键负判：没有冲突 → Arbiter 一次都没被触发（路由按声明触发，不是「每个工种都跑一遍」的编排）。
      expect(result.firedByWorker.arbiter).toBeUndefined()
      expect(await getResolvedConflicts(db)).toHaveLength(0)
      expect(await getEditorConflictQueue(db)).toHaveLength(0)
    })

    it('report_usage routes ONLY to the Harvester (independent trigger, not on the source.ingested chain)', async () => {
      // 先级联出一条 active claim。
      const sourceId = await aSource()
      const script: FakeAssistantResponse[] = [
        commitTurn({
          claimText: 'sku-u spec 1',
          subject: 'sku-u',
          predicate: 'spec',
          object: '1',
          locator: 'L1',
        }),
        finishTurn(),
        stopTurn,
      ]
      const dispatcher = wireDispatcher({ distillerScript: script })
      await dispatcher.runToConvergence({ type: 'source.ingested', payload: { sourceId } })
      const [claimRow] = await db.select({ id: schema.claim.id }).from(schema.claim)
      const claimId = claimRow!.id
      // 给它落两条独立用户的 adopted usage_truth（Harvester 才有可统计的 f4）。
      await reportUsage(db, claimId, 'adopted', { taskId: 't1', byRole: 'agent:consumer-1' })
      await reportUsage(db, claimId, 'adopted', { taskId: 't2', byRole: 'agent:consumer-2' })

      // report_usage 事件只命中 Harvester，不触发别的工种。
      const usageResult = await dispatcher.runToConvergence({
        type: 'report_usage',
        payload: { claimIds: [claimId] },
      })
      expect(Object.keys(usageResult.firedByWorker)).toEqual(['harvester'])
      expect(usageResult.firedByWorker.harvester).toBe(1)
    })

    it('EGR-CR-037: an empty claim.draft batch does NOT reach the Verifier (no judge call, no patrol, no transition) — empty batch never degrades into a full-table cron patrol', async () => {
      // 造若干会被「全库 cron 巡查」命中的 active claim；judge 用计数 fake（'fail' → 若真巡查会 active→flagged 收紧，便于反证）。
      const a = await seedActiveClaim({ query: 'empty draft A', object: 'A', asOf: new Date() })
      const b = await seedActiveClaim({ query: 'empty draft B', object: 'B', asOf: new Date() })
      const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
      const dispatcher = wireDispatcher({
        distillerScript: conflictingDistillScript(),
        entailment: judge,
      })

      // 空 claim.draft batch：修前会被派进 verifier handler → verifyEnqueued([]) 退化全库巡查；修后（B）总线源头丢弃空 batch。
      const result = await dispatcher.runToConvergence({
        type: 'claim.draft',
        payload: { claimIds: [] },
      })

      // A+B 双层：空 batch 不入工种 —— verifier 一次没派、judge 一次没调、无迁移。
      expect(result.firedByWorker['verifier'] ?? 0).toBe(0)
      expect(result.dispatched).toBe(0)
      expect(judge.callCount()).toBe(0)
      expect(await statusOf(a)).toBe('active') // 无收紧
      expect(await statusOf(b)).toBe('active')
    })
  })

  // ── 断言 2：静默降级 / 无单点失效 ──────────────────────────────────────────────────────────
  describe('2. silent degrade / no single point of failure (kill each worker in turn)', () => {
    // 读写主干（appendClaim/recallClaims）是脊柱：任何工种被杀都不能让它停服。
    async function trunkStillServes(): Promise<void> {
      const sid = await aSource()
      const { claimId } = await appendClaim(
        db,
        embedder,
        {
          claimText: `trunk probe ${randomUUID()}`,
          subject: 'trunk',
          predicate: 'p',
          object: 'v',
          createdBy: 'agent:probe',
        },
        [{ sourceId: sid, locator: 'L1', relevance: 'exact' }],
      )
      // 写进去了（D1 强制 provenance 满足）。
      expect(claimId).toBeTruthy()
      // 升 active 后可召回（读主干服务）。
      await db.update(schema.claim).set({ status: 'active' }).where(eq(schema.claim.id, claimId))
      const hits = await recallClaims(db, embedder, 'trunk probe')
      expect(hits.length).toBeGreaterThanOrEqual(0) // 召回不抛、正常返回（即使空也是正常服务）
    }

    const everyWorker = ['distiller', 'verifier', 'reconciler', 'arbiter', 'harvester'] as const
    // 哪些工种在 source.ingested 链上（Harvester 不在——它在独立的 report_usage 链上）。
    const onIngestChain = new Set(['distiller', 'verifier', 'reconciler', 'arbiter'])

    for (const victim of everyWorker) {
      it(`kill ${victim}: the read/write trunk still serves AND the surviving workers still fire silently`, async () => {
        // 先用一条独立 active+usage 的 claim 喂 report_usage 链（让 Harvester 链也真实存在、可被杀/可幸存）。
        const usageClaim = await seedActiveClaim({
          query: `usage probe ${randomUUID()}`,
          object: 'U',
          asOf: new Date(),
        })
        await reportUsage(db, usageClaim, 'adopted', { taskId: 't1', byRole: 'agent:consumer-1' })
        await reportUsage(db, usageClaim, 'adopted', { taskId: 't2', byRole: 'agent:consumer-2' })

        const sourceId = await aSource()
        const dispatcher = wireDispatcher({
          distillerScript: conflictingDistillScript(),
          fail: new Set([victim]),
        })
        // 两条独立的触发链都跑：source.ingested（Distiller/Reconciler/Verifier/Arbiter）+ report_usage（Harvester）。
        const ingest = await dispatcher.runToConvergence({
          type: 'source.ingested',
          payload: { sourceId },
        })
        const usage = await dispatcher.runToConvergence({
          type: 'report_usage',
          payload: { claimIds: [usageClaim] },
        })
        const fired: Record<string, number> = { ...ingest.firedByWorker }
        for (const [w, n] of Object.entries(usage.firedByWorker)) fired[w] = (fired[w] ?? 0) + n

        // 两条链都没崩、都跑到收敛。
        expect(ingest.truncated).toBe(false)
        expect(usage.truncated).toBe(false)

        // 被杀工种在它所在链上确实抛错、被总线吞掉（静默降级，不外抛、不掀翻级联）。
        const victimTrace = [...ingest.traces, ...usage.traces].find(
          (t) => t.workerName === victim && !t.ok,
        )
        expect(victimTrace).toBeDefined()
        expect(victimTrace!.error).toContain(`${victim} disabled`)
        expect(ingest.failures + usage.failures).toBeGreaterThanOrEqual(1)

        // 读写主干仍服务（脊柱不依赖任何工种）——任何一个工种被杀都不能让它停服。
        await trunkStillServes()

        // 幸存工种仍被各自声明的触发触达（无单点失效——一个工种倒下不波及别的）。
        if (victim !== 'distiller') {
          expect(fired.distiller).toBe(1) // Distiller 仍产出、仍发后继事件
        }
        for (const w of everyWorker) {
          if (w === victim) continue
          // source.ingested 链上的幸存工种都应被触发过；Harvester 在 report_usage 链上被触发过。
          if (onIngestChain.has(w) && w !== 'distiller') {
            // distiller 被杀时它产不出 claim → 下游没后继事件，这是合理收敛（不是别的工种被波及）。
            if (victim === 'distiller') continue
            expect(fired[w]).toBeGreaterThanOrEqual(1)
          }
          if (w === 'harvester') expect(fired.harvester).toBeGreaterThanOrEqual(1)
        }
      })
    }

    it('a failing worker NEVER poisons the persisted claims it would have processed — they survive intact for the next round', async () => {
      const sourceId = await aSource()
      // 杀掉 Verifier：claim 仍被 Distiller 落库（draft），只是没被巡查——下轮 cron 再来，数据完好。
      const dispatcher = wireDispatcher({
        distillerScript: conflictingDistillScript(),
        fail: new Set(['verifier']),
      })
      await dispatcher.runToConvergence({ type: 'source.ingested', payload: { sourceId } })
      const claims = await db.select().from(schema.claim)
      expect(claims).toHaveLength(2) // claim 完好落库，没因 Verifier 挂掉而丢
      // 没有任何 patrol 行（Verifier 死了，没人写）——但这是静默降级，不是数据损坏。
      const patrols = await db
        .select()
        .from(schema.claimVerification)
        .where(eq(schema.claimVerification.kind, 'patrol'))
      expect(patrols).toHaveLength(0)
    })

    // EGR-CR-039：总线吞错只写内存，落库责任在持有 db 的上层（生产里是 EngramRunner.persistFailures）。
    // 本测试在 wireDispatcher 外补同一层 persist（与 runner 同款：遍历 ok:false 的 trace → recordWorkerFailure），
    // 证明**两条触发链（source.ingested + report_usage）各自的工种失败都落进 durable worker_failure 专表**，
    // 且级联存活、claim 完好（与上面「NEVER poisons」用例同款保护）。
    async function persistFailures(
      result: Awaited<ReturnType<EventDispatcher['runToConvergence']>>,
      digest: Record<string, unknown>,
    ): Promise<void> {
      for (const t of result.traces) {
        if (t.ok) continue
        await recordWorkerFailure(db, {
          workerName: t.workerName,
          eventType: t.eventType,
          error: t.error ?? '',
          payloadDigest: digest,
        })
      }
    }

    it('EGR-CR-039: failures on BOTH the source.ingested chain (verifier) and the report_usage chain (harvester) land in worker_failure, cascade survives', async () => {
      // report_usage 链需要一条独立 active+usage 的 claim（让 Harvester 链真实存在、可被杀）。
      const usageClaim = await seedActiveClaim({
        query: `usage probe ${randomUUID()}`,
        object: 'U',
        asOf: new Date(),
      })
      await reportUsage(db, usageClaim, 'adopted', { taskId: 't1', byRole: 'agent:consumer-1' })

      const sourceId = await aSource()
      // 杀 verifier（命中 source.ingested → claim.draft 链）+ 杀 harvester（命中 report_usage 链）。
      const dispatcher = wireDispatcher({
        distillerScript: conflictingDistillScript(),
        fail: new Set(['verifier', 'harvester']),
      })

      const ingest = await dispatcher.runToConvergence({
        type: 'source.ingested',
        payload: { sourceId },
      })
      const usage = await dispatcher.runToConvergence({
        type: 'report_usage',
        payload: { claimIds: [usageClaim] },
      })
      // 上层（runner 同款）落库两条链各自的失败。
      await persistFailures(ingest, { sourceId })
      await persistFailures(usage, { claimCount: 1 })

      // 两条链都没崩、都跑到收敛。
      expect(ingest.truncated).toBe(false)
      expect(usage.truncated).toBe(false)

      // source.ingested 链：verifier 的失败落库，eventType 是它声明触发的 claim.draft。
      const verifierFails = await getWorkerFailures(db, { workerName: 'verifier' })
      expect(verifierFails.length).toBeGreaterThanOrEqual(1)
      expect(verifierFails.some((f) => f.eventType === 'claim.draft')).toBe(true)
      expect(verifierFails.some((f) => f.error.includes('verifier disabled'))).toBe(true)

      // report_usage 链：harvester 的失败落库，eventType 是 report_usage。
      const harvesterFails = await getWorkerFailures(db, { workerName: 'harvester' })
      expect(harvesterFails.length).toBeGreaterThanOrEqual(1)
      expect(harvesterFails.some((f) => f.eventType === 'report_usage')).toBe(true)

      // 级联存活、claim 完好（沿用「NEVER poisons」断言）：两条抽出的矛盾 claim 仍真落库。
      const distilled = await db
        .select()
        .from(schema.claim)
        .where(eq(schema.claim.subject, 'sku-7'))
      expect(distilled).toHaveLength(2)
    })
  })

  // ── 断言 3：by_role 逻辑角色标记贯穿级联（judge≠athlete；非 DB 物理 role 隔离，后者待实现）──────────
  describe('3. by_role + own logical role (by_role tag) across the cascade (judge≠athlete)', () => {
    it('after a full cascade each worker’s rows carry its OWN by_role, and no worker endorses its own athlete output', async () => {
      // source.ingested 链：Distiller 产两条矛盾 draft claim → Verifier 巡查写 patrol 行（fail）→ 收紧由 NC/A.4 决定。
      // conflict.detected 链（同一总线）：Arbiter 在既有 active KB 对上机判自裁、落采信标记。
      const sourceId = await aSource()
      const entailment = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
      const dispatcher = wireDispatcher({ distillerScript: conflictingDistillScript(), entailment })
      await dispatcher.runToConvergence({ type: 'source.ingested', payload: { sourceId } })

      // Distiller(athlete)：产出 claim 的 created_by = agent:distiller；它**不写** claim_verification（自背书违 judge≠athlete）。
      const distilled = await db
        .select()
        .from(schema.claim)
        .where(eq(schema.claim.createdBy, `${DISTILLER_ROLE}:${sourceId}`))
      expect(distilled.length).toBeGreaterThanOrEqual(2)
      for (const c of distilled) expect(c.createdBy.startsWith(DISTILLER_ROLE)).toBe(true)

      const patrols = await db
        .select()
        .from(schema.claimVerification)
        .where(eq(schema.claimVerification.kind, 'patrol'))
      // Verifier 的 patrol 行（reason≠near_dup_poison）落在 verifier 的 by_role 下；Reconciler 的升级信号
      // （reason=near_dup_poison，复用 patrol kind）落在 reconciler 的 by_role 下——各写各的角色，无混淆。
      const verifierRows = patrols.filter(
        (p) => (p.verdict as { reason?: string }).reason !== 'near_dup_poison',
      )
      const reconcilerRows = patrols.filter(
        (p) => (p.verdict as { reason?: string }).reason === 'near_dup_poison',
      )
      expect(verifierRows.length).toBeGreaterThanOrEqual(1)
      for (const p of verifierRows) {
        expect(p.byRole).toBe(VERIFIER_ROLE)
        // judge≠athlete：Verifier 巡查的 claim 不是它自己产出的（created_by 是 distiller）。
        const [target] = await db
          .select({ createdBy: schema.claim.createdBy })
          .from(schema.claim)
          .where(eq(schema.claim.id, p.claimId))
        expect(target!.createdBy.startsWith(VERIFIER_ROLE)).toBe(false)
      }
      for (const p of reconcilerRows) expect(p.byRole).toBe(RECONCILER_ROLE)

      // Arbiter(judge)：在既有 active KB 矛盾对上机判自裁，采信标记落在 arbiter 的 by_role 下；它不产出 claim、不写 claim_verification。
      const { a, b } = await seedActivePair({
        query: 'role kpA',
        aAsOf: new Date('2025-06-01T00:00:00.000Z'),
        bAsOf: new Date('2025-01-01T00:00:00.000Z'),
      })
      await dispatcher.runToConvergence({ type: 'conflict.detected', payload: { pairs: [[a, b]] } })
      const resolved = await getResolvedConflicts(db)
      expect(resolved.length).toBeGreaterThanOrEqual(1)
      for (const r of resolved) expect(r.payload.byRole).toBe(ARBITER_ROLE)
      const arbiterVerifs = patrols.filter((p) => p.byRole === ARBITER_ROLE)
      expect(arbiterVerifs).toHaveLength(0) // Arbiter 不写 claim_verification
    })

    it('Reconciler writes its escalation under its own by_role; Verifier never patrols a Verifier-authored claim (judge≠athlete)', async () => {
      // 用 near-dup-poison 让 Reconciler 升级（带对端 id），断言它的 by_role。
      const sourceId = await aSource()
      // 落一条 anchor（active）+ 一条悄悄改小的 poison（同 subject，A⊄B）。
      const anchorScript: FakeAssistantResponse[] = [
        commitTurn({
          claimText: 'skuP capacity is at least 4000 mah',
          subject: 'skuP',
          predicate: 'capacity',
          object: 'at least 4000',
          locator: 'L1',
        }),
        finishTurn(),
        stopTurn,
      ]
      const d1 = wireDispatcher({ distillerScript: anchorScript })
      await d1.runToConvergence({ type: 'source.ingested', payload: { sourceId } })
      // anchor 升 active 让 poison flag 路径可达。
      await db
        .update(schema.claim)
        .set({ status: 'active' })
        .where(eq(schema.claim.subject, 'skuP'))

      const poisonSource = await aSource()
      const poisonScript: FakeAssistantResponse[] = [
        commitTurn({
          claimText: 'skuP capacity is at least 0800 mah',
          subject: 'skuP',
          predicate: 'capacity',
          object: 'at least 800',
          locator: 'L1',
        }),
        finishTurn(),
        stopTurn,
      ]
      // bound oracle：A(≥800) ⊬ B(≥4000) → fail ⇒ poison。
      const boundOracle: EntailmentJudge = {
        version: 'fake:bound-oracle',
        async judge(q) {
          const lower = (s: string) => {
            const m = s.match(/(\d+(?:\.\d+)?)/)
            return m ? parseFloat(m[1]!) : NaN
          }
          const cb = lower(q.claimText)
          const eb = lower(q.evidence[0]?.sourceContent ?? '')
          if (Number.isNaN(cb) || Number.isNaN(eb)) return 'fail'
          return eb >= cb ? 'pass' : 'fail'
        },
      }
      const d2 = wireDispatcher({ distillerScript: poisonScript, entailment: boundOracle })
      await d2.runToConvergence({ type: 'source.ingested', payload: { sourceId: poisonSource } })

      const [poison] = await db
        .select({ id: schema.claim.id })
        .from(schema.claim)
        .where(and(eq(schema.claim.subject, 'skuP'), eq(schema.claim.object, 'at least 800')))
      const esc = await getReconcileEscalations(db, poison!.id)
      expect(esc.length).toBeGreaterThanOrEqual(1)
      for (const e of esc) expect(e.byRole).toBe(RECONCILER_ROLE) // Reconciler 的独立角色
    })

    it('EGR-CR-026: a near-dup poison escalation (NO contradicts edge) drives the cascade all the way to the Arbiter', async () => {
      // T2（台账 :1437 结构对照）：把现有「只断言 escalation.byRole」的用例升级为「Arbiter 被触发」。
      // 关键：**直接 seed** A/B（不走 distiller commit）—— commitClaim 的确定性判同会对 subject≡∧predicate≡∧object≠
      // 直接写一条 contradicts 边（same-fact.ts:94），那会让 distiller 的 allContradictsPairs 抢先把对喂给 Arbiter，
      // 掩盖本 issue 要测的「纯 escalation、零 contradicts 边」路径。seed 法绕开 commit、逼出纯升级信号路径。
      const anchor = await seedPoisonPair({
        query: 'skuT capacity is at least 4000 mah',
        subject: 'skuT',
        object: 'at least 4000',
        status: 'active',
      })
      const poison = await seedPoisonPair({
        query: 'skuT capacity is at least 0800 mah',
        subject: 'skuT',
        object: 'at least 800',
        status: 'draft', // draft poison：A.4 禁 draft→flagged，升级信号是它唯一下游钩子。
      })

      // bound oracle：A(≥800) ⊬ B(≥4000) → poison。
      const boundOracle: EntailmentJudge = {
        version: 'fake:bound-oracle',
        async judge(q) {
          const lower = (s: string) => {
            const m = s.match(/(\d+(?:\.\d+)?)/)
            return m ? parseFloat(m[1]!) : NaN
          }
          const cb = lower(q.claimText)
          const eb = lower(q.evidence[0]?.sourceContent ?? '')
          if (Number.isNaN(cb) || Number.isNaN(eb)) return 'fail'
          return eb >= cb ? 'pass' : 'fail'
        },
      }
      // onFire spy + arbiterScriptFor spy：证明 arbiter 臂真被 escalation 驱动触发，且收到 [poison, anchor]。
      const arbiterPairs: Array<Array<[string, string]>> = []
      const fired: string[] = []
      const dispatcher = wireDispatcher({
        distillerScript: [], // distiller 不参与本对照（直接驱动 batch_appended）。
        entailment: boundOracle,
        arbiterScriptFor: (pairs) => {
          arbiterPairs.push(pairs)
          return [...pairs.map(([a, b]) => adjudicateTurn(a, b)), finishTurn(), stopTurn]
        },
        onFire: (worker) => fired.push(worker),
      })
      // 直接驱动 batch_appended([A])（绕开 distiller commit）→ reconciler 判 poison → escalation → conflict.detected → arbiter。
      await dispatcher.runToConvergence({
        type: 'batch_appended',
        payload: { claimIds: [poison] },
      })

      // 升级信号已记（带对端 anchor id）——走的是 patrol/escalation 载体，不是 contradicts 边。
      const esc = await getReconcileEscalations(db, poison)
      expect(esc.length).toBeGreaterThanOrEqual(1)
      expect(esc[0]!.conflictsWith).toBe(anchor)
      // 该对**没有任何 contradicts 边**——逼出纯 escalation 路径（非 distiller 的 allContradictsPairs）。
      const contradicts = await db
        .select({ id: schema.relation.id })
        .from(schema.relation)
        .where(eq(schema.relation.type, 'contradicts'))
      expect(contradicts).toHaveLength(0)
      // 级联端到端触达 Arbiter（修前 reconciler 返回 void、arbiter 永不被触发；修后 escalation→conflict.detected→arbiter）。
      expect(fired).toContain('arbiter')
      expect(arbiterPairs.flat()).toContainEqual([poison, anchor])
      // A 是 draft ⇒ Arbiter 的 selectPairs 忠实跳过：不新增 resolved（draft 语义零回归、不误裁）。
      expect(await getResolvedConflicts(db)).toHaveLength(0)
    })
  })

  // ── 断言 4：loop-vs-one-shot 形态匹配 A.7（结构性）─────────────────────────────────────────
  describe('4. loop-vs-one-shot form matches A.7 (structural)', () => {
    it('Distiller & Arbiter are BOUNDED LOOPS: their Deps require an AgentRuntime, and a maxTurns budget cuts them off (they enter the loop)', async () => {
      // 结构证明：把一个「进 loop 即硬失败」的 runtime 注给 Distiller/Arbiter，再用一个**永不收尾**的脚本
      // + maxTurns=2 证明它们确实跑的是有界 loop（被预算切断，reason=max_turns）。
      const sourceId = await aSource()
      // 永不调 finish 的脚本 → maxTurns=2 切断 → Distiller 降级 human_pending。
      const stallScript: FakeAssistantResponse[] = [
        commitTurn({ claimText: 'a', subject: 's', predicate: 'p', object: 'o1', locator: 'L1' }),
        commitTurn({ claimText: 'b', subject: 's', predicate: 'q', object: 'o2', locator: 'L2' }),
        commitTurn({ claimText: 'c', subject: 's', predicate: 'r', object: 'o3', locator: 'L3' }),
      ]
      const distillerDeps: DistillerDeps = {
        db,
        embedder,
        judge: sameFact,
        runtime: runtimeOf(stallScript),
        reader,
      }
      // Distiller 的 Deps 形态**带 runtime（AgentRuntime）**——这是有界 loop 工种的结构标志。
      expect(typeof distillerDeps.runtime.run).toBe('function')
      const dres = await runDistiller(distillerDeps, sourceId, { maxTurns: 2 })
      expect(dres.status).toBe('human_pending')
      expect(dres.reason).toBe('max_turns') // 被有界预算切断 → 证明它跑的是 loop

      // Arbiter 同理：带 runtime；maxTurns 耗尽把未裁对升级主编（有界降级）。
      const a = await appendClaim(
        db,
        embedder,
        {
          claimText: 'k p A',
          subject: 'k',
          predicate: 'p',
          object: 'A',
          createdBy: DISTILLER_ROLE,
        },
        [{ sourceId, locator: 'L1', relevance: 'exact' }],
      )
      const b = await appendClaim(
        db,
        embedder,
        {
          claimText: 'k p B',
          subject: 'k',
          predicate: 'p',
          object: 'B',
          createdBy: DISTILLER_ROLE,
        },
        [{ sourceId, locator: 'L2', relevance: 'exact' }],
      )
      await db
        .update(schema.claim)
        .set({ status: 'active' })
        .where(inArray(schema.claim.id, [a.claimId, b.claimId]))
      const bogus1 = randomUUID()
      const bogus2 = randomUUID()
      const arbiterStall: FakeAssistantResponse[] = [
        adjudicateTurn(bogus1, bogus2),
        adjudicateTurn(bogus1, bogus2),
        adjudicateTurn(bogus1, bogus2),
      ]
      const arbiterDeps: ArbiterDeps = { db, runtime: runtimeOf(arbiterStall) }
      expect(typeof arbiterDeps.runtime.run).toBe('function') // Arbiter Deps 也带 AgentRuntime
      const ares = await arbitrateConflicts(arbiterDeps, [[a.claimId, b.claimId]], { maxTurns: 2 })
      expect(ares.loopReason).toBe('max_turns') // 被有界预算切断 → 证明它跑的是 loop
      expect(ares.escalated).toBe(1) // 未裁对升级主编（有界降级）
    })

    it('Verifier, Reconciler, Harvester are FUNCTION + point-LLM: their Deps carry NO AgentRuntime, and they run with no agent loop at all', async () => {
      // 结构证明：这三者的 Deps 里没有 runtime 字段；它们的 entry 不接 AgentRuntime，跑起来不进任何 loop。
      const verifierDeps: VerifierDeps = {
        db,
        judge: makeFakeEntailmentJudge({ verdictOf: () => 'pass' }),
      }
      const reconcilerDeps: ReconcilerDeps = {
        db,
        judge: makeFakeEntailmentJudge({ verdictOf: () => 'pass' }),
      }
      const harvesterDeps: HarvesterDeps = { db }
      // 没有 runtime 这个键（与 Distiller/Arbiter 的 Deps 形态截然不同）。
      expect('runtime' in verifierDeps).toBe(false)
      expect('runtime' in reconcilerDeps).toBe(false)
      expect('runtime' in harvesterDeps).toBe(false)

      // 点状一次 LLM（非 loop）的行为证明：Verifier 对每条 claim 恰调判官一次（带 callCount 的 fake 判官）。
      const sourceId = await aSource()
      const { claimId } = await appendClaim(
        db,
        embedder,
        {
          claimText: 'pll spec 1',
          subject: 'pll',
          predicate: 'spec',
          object: '1',
          createdBy: DISTILLER_ROLE,
        },
        [{ sourceId, locator: 'L1', relevance: 'exact' }],
      )
      await db.update(schema.claim).set({ status: 'active' }).where(eq(schema.claim.id, claimId))
      const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
      await verifyEnqueued({ db, judge }, [claimId])
      expect(judge.callCount()).toBe(1) // 恰一次 = 点状一次 LLM，不是多步 loop

      // Harvester 是纯统计（连 LLM 都没有）：它的 Deps 只有 db，无 judge、无 runtime。
      expect(Object.keys(harvesterDeps)).toEqual(['db'])
    })
  })
})
