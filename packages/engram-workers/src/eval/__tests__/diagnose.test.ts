/**
 * S9 · 诊断 join capstone CI 守门。
 *
 * 纯函数(零 DB):① categorizeFailure 三分(g_overcorrection / raw_too_weak / genuine_miscalibration)+ 边界;② summarizeDiagnoses 计数。
 * 真 DB:③ 诊断 join:seed 真 claim(带 producing_run_id)+ agent_run_trace,diagnoseWrongDecisions 正确 join 回 trace、按 (raw,g,τ) 归类、
 *   标 degenerate / missingTrace;④ **只读守卫**:诊断前后 claim/claim_verification/calibration_map/dimension_events 行数快照不变。
 * 静态:⑤ **import-graph 守卫**:诊断符号在 recall/confidence/fit-from-usage(core g 路径)+ harvester/engram-runner(workers g 驱动者)源码中**不可达**;
 *   且 diagnose.ts 自身**零写**(无 db.insert/update/delete)——诊断绝不回灌 g/recall(A3 邻接 anti-Goodhart)。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { count } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  makeFakeEmbedder,
  recordAgentRun,
  schema,
  type DB,
} from '@engram/core'

import {
  categorizeFailure,
  diagnoseWrongDecisions,
  summarizeDiagnoses,
  type DecisionDiagnosis,
} from '../decision-value/diagnose.js'

const TAU = 0.8

describe('S9 · 诊断归类(纯函数)', () => {
  it('① categorizeFailure 三分 + 边界(前置 g≥τ)', () => {
    // raw<τ ⇒ g 抬过门。
    expect(categorizeFailure(0.4, 0.85, TAU)).toBe('g_overcorrection')
    expect(categorizeFailure(0.79, 0.81, TAU)).toBe('g_overcorrection')
    // raw≥τ 且 g≤raw ⇒ raw 自身高估、g 没加码(含 g==raw 边界)。
    expect(categorizeFailure(0.9, 0.85, TAU)).toBe('raw_too_weak')
    expect(categorizeFailure(0.85, 0.85, TAU)).toBe('raw_too_weak')
    // raw≥τ 且 g>raw ⇒ g 放大已高估的 raw。
    expect(categorizeFailure(0.82, 0.9, TAU)).toBe('genuine_miscalibration')
    // τ 边界:raw==τ 归 raw_too_weak(不是 g_overcorrection)。
    expect(categorizeFailure(0.8, 0.8, TAU)).toBe('raw_too_weak')
    // 前置违反记录(g<τ 本不该被当 answered 传入):仍按 raw 给确定标签——是**当前行为**、非契约。
    expect(categorizeFailure(0.4, 0.5, TAU)).toBe('g_overcorrection') // raw<τ ⇒ 仍归 g_overcorrection(尽管 g 也<τ、并未真抬过门)
  })

  it('② summarizeDiagnoses:按 category 计数 + degenerate / missingTrace 旁路计数', () => {
    const stubTrace = (): DecisionDiagnosis['trace'] => ({
      id: randomUUID(),
      runId: randomUUID(),
      workerName: 'agent:distiller',
      byRole: 'agent:distiller',
      reason: 'done',
      turns: 1,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      toolCalls: 0,
      toolErrors: 0,
      toolNames: [],
      payload: {},
      createdAt: new Date(),
    })
    const mk = (
      category: DecisionDiagnosis['category'],
      degenerate: boolean,
      hasTrace: boolean,
    ): DecisionDiagnosis => ({
      claimId: randomUUID(),
      raw: 0.5,
      gValue: 0.85,
      tau: TAU,
      category,
      producingRunId: hasTrace ? randomUUID() : null,
      trace: hasTrace ? stubTrace() : null,
      producingRunDegenerate: degenerate,
      rationale: '',
    })
    const s = summarizeDiagnoses([
      mk('g_overcorrection', false, true),
      mk('g_overcorrection', true, true),
      mk('raw_too_weak', false, true),
      mk('genuine_miscalibration', false, false),
    ])
    expect(s.total).toBe(4)
    expect(s.byCategory).toEqual({
      g_overcorrection: 2,
      raw_too_weak: 1,
      genuine_miscalibration: 1,
    })
    expect(s.degenerateRuns).toBe(1)
    expect(s.missingTrace).toBe(1)
    expect(summarizeDiagnoses([]).total).toBe(0)
  })
})

describe('S9 · import-graph + 只读守卫(静态)', () => {
  const CORE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'engram-core',
    'src',
  )
  const WORKERS = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const DIAGNOSE_TOKENS = [
    'diagnose',
    'diagnoseWrongDecisions',
    'categorizeFailure',
    'getAgentRunTrace',
  ]

  it('⑤a g 路径 / g 驱动者源码对诊断模块不可达(诊断只能从评测/报告侧消费,绝不回灌 g/recall)', () => {
    const gPathFiles = [
      join(CORE, 'spi', 'recall-claims.ts'),
      join(CORE, 'confidence', 'confidence.ts'),
      join(CORE, 'calibration', 'fit-from-usage.ts'),
      join(WORKERS, 'harvester.ts'),
      join(WORKERS, 'runner', 'engram-runner.ts'),
    ]
    for (const f of gPathFiles) {
      const src = readFileSync(f, 'utf8')
      for (const tok of DIAGNOSE_TOKENS) expect(src.includes(tok)).toBe(false)
    }
  })

  it('⑤b diagnose.ts 自身零写(只 select,无 insert/update/delete)——诊断纯只读', () => {
    const src = readFileSync(join(WORKERS, 'eval', 'decision-value', 'diagnose.ts'), 'utf8')
    expect(/\.insert\s*\(/.test(src)).toBe(false)
    expect(/\.update\s*\(/.test(src)).toBe(false)
    expect(/\.delete\s*\(/.test(src)).toBe(false)
    expect(src.includes('.select(')).toBe(true) // 非空守卫:它确实在读
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

describe('S9 · 诊断 join + 只读守卫(真 DB)', () => {
  let admin: pg.Pool
  let pool: pg.Pool
  let db: DB
  let testDbName: string
  const embedder = makeFakeEmbedder()

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

  /** seed 一条 active claim(自定 raw/g/producingRunId),返回 claimId。 */
  async function seedClaim(opts: {
    raw: number
    g: number
    producingRunId: string | null
  }): Promise<string> {
    const src = await addSource(db, {
      content: `s-${randomUUID()}`,
      kind: 'formal_document',
      authorityScore: opts.raw,
    })
    const claimId = randomUUID()
    await db.insert(schema.claim).values({
      id: claimId,
      claimText: `c-${claimId}`,
      subject: 's',
      predicate: 'p',
      object: 'o',
      status: 'active',
      confidence: opts.g,
      confidenceRaw: opts.raw,
      confidenceFactors: { factors: {}, weights: {}, calibrationVersion: 'identity' },
      lineageId: randomUUID(),
      asOf: new Date(),
      createdBy: 'agent:distiller',
      ...(opts.producingRunId !== null ? { producingRunId: opts.producingRunId } : {}),
      embedding: await embedder.embed('c', 'document'),
      embeddingVersion: embedder.version,
    })
    await db.insert(schema.claimProvenance).values({
      id: randomUUID(),
      claimId,
      sourceId: src.sourceId,
      locator: 'loc',
      relevance: 'exact',
    })
    return claimId
  }

  it('③ 诊断 join:沿 producing_run_id join 回 trace、按 (raw,g,τ) 归类、标 degenerate / missingTrace', async () => {
    // 两条 run trace:一条正常、一条退化(截断 + 工具报错)。
    const cleanRun = randomUUID()
    const degenerateRun = randomUUID()
    expect(
      (
        await recordAgentRun(db, {
          runId: cleanRun,
          workerName: 'agent:distiller',
          byRole: 'agent:distiller',
          reason: 'done',
          turns: 3,
          toolErrors: 0,
        })
      ).ok,
    ).toBe(true)
    expect(
      (
        await recordAgentRun(db, {
          runId: degenerateRun,
          workerName: 'agent:distiller',
          byRole: 'agent:distiller',
          reason: 'max_turns',
          turns: 12,
          toolErrors: 2,
        })
      ).ok,
    ).toBe(true)

    const A = await seedClaim({ raw: 0.4, g: 0.85, producingRunId: cleanRun }) // g_overcorrection, clean
    const B = await seedClaim({ raw: 0.9, g: 0.85, producingRunId: cleanRun }) // raw_too_weak
    const C = await seedClaim({ raw: 0.82, g: 0.9, producingRunId: cleanRun }) // genuine_miscalibration
    const D = await seedClaim({ raw: 0.45, g: 0.88, producingRunId: degenerateRun }) // g_overcorrection, degenerate
    const E = await seedClaim({ raw: 0.4, g: 0.85, producingRunId: null }) // g_overcorrection, no trace

    const ds = await diagnoseWrongDecisions(db, [A, B, C, D, E], TAU)
    const byId = new Map(ds.map((d) => [d.claimId, d]))
    expect(ds.length).toBe(5)

    expect(byId.get(A)!.category).toBe('g_overcorrection')
    expect(byId.get(A)!.trace?.runId).toBe(cleanRun) // **join 成功**:拿到产出它的 run
    expect(byId.get(A)!.trace?.turns).toBe(3)
    expect(byId.get(A)!.producingRunDegenerate).toBe(false)

    expect(byId.get(B)!.category).toBe('raw_too_weak')
    expect(byId.get(C)!.category).toBe('genuine_miscalibration')

    expect(byId.get(D)!.category).toBe('g_overcorrection')
    expect(byId.get(D)!.trace?.runId).toBe(degenerateRun)
    expect(byId.get(D)!.producingRunDegenerate).toBe(true) // reason≠done + toolErrors>0

    expect(byId.get(E)!.category).toBe('g_overcorrection')
    expect(byId.get(E)!.producingRunId).toBeNull()
    expect(byId.get(E)!.trace).toBeNull() // missingTrace

    // rationale 实测(防 head/tail 漂移、formatting 退化):category head + trace tail 都该如实落进去。
    expect(byId.get(A)!.rationale).toContain('identity 本会弃答') // g_overcorrection head
    expect(byId.get(A)!.rationale).toContain('产出 run 正常') // 正常 run tail(A 的 run reason=done、零错)
    expect(byId.get(D)!.rationale).toContain('⚠ 产出 run 退化') // degenerate tail(D 的 run 截断+报错)
    expect(byId.get(E)!.rationale).toContain('无 producing run trace') // no-trace tail

    const s = summarizeDiagnoses(ds)
    expect(s.byCategory).toEqual({
      g_overcorrection: 3,
      raw_too_weak: 1,
      genuine_miscalibration: 1,
    })
    expect(s.degenerateRuns).toBe(1)
    expect(s.missingTrace).toBe(1)

    // 空入参 → 空出、不查库。
    expect(await diagnoseWrongDecisions(db, [], TAU)).toEqual([])
  })

  it('③b producingRunDegenerate 析取**单臂**各自触发(reason≠done 单独 / toolErrors>0 单独)+ 缺 claim 行跳过', async () => {
    // 臂①:reason≠done 但 toolErrors=0;臂②:reason=done 但 toolErrors=1 —— 各只触发析取的一边(||→&& 变异会被抓)。
    const runMaxTurnsOnly = randomUUID()
    const runErrOnly = randomUUID()
    await recordAgentRun(db, {
      runId: runMaxTurnsOnly,
      workerName: 'agent:distiller',
      byRole: 'agent:distiller',
      reason: 'max_turns',
      turns: 12,
      toolErrors: 0,
    })
    await recordAgentRun(db, {
      runId: runErrOnly,
      workerName: 'agent:distiller',
      byRole: 'agent:distiller',
      reason: 'done',
      turns: 4,
      toolErrors: 1,
    })
    const F = await seedClaim({ raw: 0.4, g: 0.85, producingRunId: runMaxTurnsOnly })
    const G = await seedClaim({ raw: 0.4, g: 0.85, producingRunId: runErrOnly })
    const ds = await diagnoseWrongDecisions(db, [F, G], TAU)
    const byId = new Map(ds.map((d) => [d.claimId, d]))
    // 臂①:reason≠done 单独 ⇒ degenerate(尽管 toolErrors=0)。
    expect(byId.get(F)!.trace?.toolErrors).toBe(0)
    expect(byId.get(F)!.producingRunDegenerate).toBe(true)
    // 臂②:toolErrors>0 单独 ⇒ degenerate(尽管 reason=done)。
    expect(byId.get(G)!.trace?.reason).toBe('done')
    expect(byId.get(G)!.producingRunDegenerate).toBe(true)
    // 缺 claim 行(随机 UUID 无对应 claim)→ 直接跳过(不抛、不臆造行)。
    expect(await diagnoseWrongDecisions(db, [randomUUID()], TAU)).toEqual([])
  })

  it('④ 只读守卫:诊断前后 claim/claim_verification/calibration_map/dimension_events 行数快照不变', async () => {
    const A = await seedClaim({ raw: 0.4, g: 0.85, producingRunId: null })
    const tables = [
      schema.claim,
      schema.claimVerification,
      schema.calibrationMap,
      schema.dimensionEvents,
    ]
    const snapshot = async (): Promise<number[]> =>
      Promise.all(tables.map(async (t) => (await db.select({ n: count() }).from(t))[0]!.n))
    const before = await snapshot()
    await diagnoseWrongDecisions(db, [A], TAU) // 诊断一轮
    const after = await snapshot()
    expect(after).toEqual(before) // 零写:四表行数一字不动
  })
})
