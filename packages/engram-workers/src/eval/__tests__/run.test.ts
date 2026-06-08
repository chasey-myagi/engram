/**
 * S10 · 决策价值报告 + fail-closed A3 复检 CI 守门(真 Qwen 路径 env-gated,不进 CI)。
 *
 * 纯函数:① assertLongitudinalAndEnumsFrozen 冻结通过 / 漂移即抛(纵向维度 + 两枚举);assertA3Frozen 对真常量不抛;
 *   ② renderDecisionValueReport 渲染三段(baseline 表 / R1→R2 series / 错答下钻含三类 + 退化 + 无 trace),空错答走"零违诺"行。
 * 真 DB:③ runDecisionValueReport 端到端(合成语料 ~180 facts):报告含三段 + ≥1 条**真** claim+trace 的错答下钻;fail-closed 复检通过。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDb, makeFakeEmbedder, type AgentRunTraceRecord, type DB } from '@engram/core'

import type { BaselineResult, PromiseProfile } from '../decision-value/baselines.js'
import type { DecisionDiagnosis, DiagnosisSummary } from '../decision-value/diagnose.js'
import type { LearningLoopResult } from '../decision-value/learning-loop.js'
import {
  assertA3Frozen,
  assertLongitudinalAndEnumsFrozen,
  renderDecisionValueReport,
  type ReportInput,
} from '../decision-value/report.js'
import { buildSyntheticCorpus, runDecisionValueReport } from '../decision-value/run.js'

const TAU = 0.8
const FROZEN_DIMS = ['ece', 'coverage'] as const
const FROZEN_VKINDS = ['patrol', 'usage_truth', 'reembed_marker'] as const
const FROZEN_MKINDS = [
  'gap_recorded',
  'source_human_pending',
  'conflict_adjudicated',
  'ruling_refused',
  'human_overturn',
] as const

describe('S10 · fail-closed A3 复检 + 报告渲染(纯函数)', () => {
  it('① assertLongitudinalAndEnumsFrozen:冻结通过、任一漂移即抛;assertA3Frozen 对真常量不抛', () => {
    expect(() =>
      assertLongitudinalAndEnumsFrozen(FROZEN_DIMS, FROZEN_VKINDS, FROZEN_MKINDS),
    ).not.toThrow()
    // 纵向维度混入 elo(典型 Goodhart 注入)→ 抛。
    expect(() =>
      assertLongitudinalAndEnumsFrozen(['ece', 'coverage', 'elo'], FROZEN_VKINDS, FROZEN_MKINDS),
    ).toThrow(/纵向维度漂移/)
    // verification_kind 塞 trace kind → 抛。
    expect(() =>
      assertLongitudinalAndEnumsFrozen(
        FROZEN_DIMS,
        ['patrol', 'usage_truth', 'reembed_marker', 'agent_trace'],
        FROZEN_MKINDS,
      ),
    ).toThrow(/verification_kind/)
    // metrics_event_kind 漂移 → 抛。
    expect(() =>
      assertLongitudinalAndEnumsFrozen(FROZEN_DIMS, FROZEN_VKINDS, ['gap_recorded']),
    ).toThrow(/metrics_event_kind/)
    // 真常量:必不抛(否则就是 A3 冻结被破坏)。
    expect(() => assertA3Frozen()).not.toThrow()
  })

  it('② renderDecisionValueReport:三段齐全 + 三类下钻 + 退化/无 trace 标记;空错答走零违诺行', () => {
    const profile = (
      coverage: number,
      realizedAccuracy: number,
      promiseError: number,
      regret: number,
    ): PromiseProfile => ({
      tau: TAU,
      answered: 10,
      total: 30,
      coverage,
      realizedAccuracy,
      regret,
      promiseError,
    })
    const baseline = (lift: number, lo: number, hi: number): BaselineResult => ({
      tau: TAU,
      gMap: {
        version: 'g1',
        knots: [
          { x: 0.5, y: 0.4 },
          { x: 0.9, y: 0.86 },
        ],
      },
      identity: profile(0.67, 0.575, 0.225, 0.29),
      fitted: profile(0.33, 0.85, 0, 0.056),
      oracle: profile(0.33, 0.85, 0, 0.05),
      decisionLift: lift,
      tunedCoverageLift: 0,
      ci: { estimate: lift, lo, hi, iterations: 1000, seed: 1 },
    })
    const loop: LearningLoopResult = {
      tau: TAU,
      r1: baseline(0.24, 0.1, 0.36),
      r2: baseline(0.238, 0.094, 0.353),
      roundDelta: -0.002,
    }
    const stubTrace = (reason: string, toolErrors: number): AgentRunTraceRecord => ({
      id: randomUUID(),
      runId: randomUUID(),
      workerName: 'agent:distiller',
      byRole: 'agent:distiller',
      reason,
      turns: 12,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      toolCalls: 0,
      toolErrors,
      toolNames: [],
      payload: {},
      createdAt: new Date(),
    })
    const diag = (
      category: DecisionDiagnosis['category'],
      trace: AgentRunTraceRecord | null,
      degenerate: boolean,
    ): DecisionDiagnosis => ({
      claimId: randomUUID(),
      raw: 0.9,
      gValue: 0.85,
      tau: TAU,
      category,
      producingRunId: trace ? trace.runId : null,
      trace,
      producingRunDegenerate: degenerate,
      rationale: `rationale-${category}`,
    })
    const diagnoses = [
      diag('g_overcorrection', stubTrace('done', 0), false),
      diag('raw_too_weak', stubTrace('max_turns', 2), true),
      diag('genuine_miscalibration', null, false),
    ]
    const summary: DiagnosisSummary = {
      total: 3,
      byCategory: { g_overcorrection: 1, raw_too_weak: 1, genuine_miscalibration: 1 },
      degenerateRuns: 1,
      missingTrace: 1,
    }
    const input: ReportInput = {
      tau: TAU,
      r1Size: 90,
      r2Size: 90,
      source: 'fake',
      loop,
      diagnoses,
      summary,
    }
    const report = renderDecisionValueReport(input)

    // 三段标题齐全。
    expect(report).toContain('Plan A 决策价值报告')
    expect(report).toContain('Baseline @ τ=0.80')
    expect(report).toContain('R1 → R2 series')
    expect(report).toContain('错答下钻')
    // baseline 三变体 + lift/CI。
    expect(report).toContain('identity')
    expect(report).toContain('fitted')
    expect(report).toContain('oracle')
    expect(report).toContain('0.238')
    expect(report).toContain('[0.094, 0.353]')
    expect(report).toContain('排除 0 ⇒ 显著')
    // R1→R2 series + roundDelta。
    expect(report).toContain('R1(in-sample)')
    expect(report).toContain('R2(held-out)')
    expect(report).toContain('-0.002')
    // 三类下钻 + 退化标记 + 无 trace。
    expect(report).toContain('g_overcorrection 1 / raw_too_weak 1 / genuine_miscalibration 1')
    expect(report).toContain('⚠ 退化')
    expect(report).toContain('无 producing run trace')
    // fail-closed footer(已通过的陈述,措辞不冒充渲染层自检)。
    expect(report).toContain('打印前已通过 A3 fail-closed 复检')

    // 空错答:走"零违诺"行(不渲染逐条)。
    const empty = renderDecisionValueReport({
      ...input,
      diagnoses: [],
      summary: {
        total: 0,
        byCategory: { g_overcorrection: 0, raw_too_weak: 0, genuine_miscalibration: 0 },
        degenerateRuns: 0,
        missingTrace: 0,
      },
    })
    expect(empty).toContain('无错答')
  })

  it('②b 呈现分支:CI 跨 0「不显著」、|roundDelta|≥0.1「迁移有损」、>5 条截断、realizedAcc=NaN→n/a', () => {
    const profile = (
      coverage: number,
      realizedAccuracy: number,
      promiseError: number,
      regret: number,
    ): PromiseProfile => ({
      tau: TAU,
      answered: 0,
      total: 30,
      coverage,
      realizedAccuracy,
      regret,
      promiseError,
    })
    // r2:CI 跨 0(lo<0<hi)+ identity.realizedAcc=NaN(answered=0)走 n/a 分支。
    const baseline = (lift: number, lo: number, hi: number): BaselineResult => ({
      tau: TAU,
      gMap: { version: 'g1', knots: [] },
      identity: profile(0, Number.NaN, 0, Number.NaN),
      fitted: profile(0.3, 0.82, 0, 0.05),
      oracle: profile(0.3, 0.82, 0, 0.05),
      decisionLift: lift,
      tunedCoverageLift: 0,
      ci: { estimate: lift, lo, hi, iterations: 1000, seed: 1 },
    })
    const loop: LearningLoopResult = {
      tau: TAU,
      r1: baseline(0.0, -0.1, 0.1),
      r2: baseline(0.0, -0.12, 0.13), // ci.lo<0<hi ⇒ 不显著
      roundDelta: 0.4, // |·|≥0.1 ⇒ 迁移有损
    }
    // 7 条诊断(>SHOW=5)⇒ 触发"… 另 N 条(略)"截断。
    const diagnoses: DecisionDiagnosis[] = Array.from({ length: 7 }, () => ({
      claimId: randomUUID(),
      raw: 0.9,
      gValue: 0.85,
      tau: TAU,
      category: 'raw_too_weak',
      producingRunId: null,
      trace: null,
      producingRunDegenerate: false,
      rationale: 'r',
    }))
    const report = renderDecisionValueReport({
      tau: TAU,
      r1Size: 90,
      r2Size: 90,
      source: 'fake',
      loop,
      diagnoses,
      summary: {
        total: 7,
        byCategory: { g_overcorrection: 0, raw_too_weak: 7, genuine_miscalibration: 0 },
        degenerateRuns: 0,
        missingTrace: 7,
      },
    })
    expect(report).toContain('CI 跨 0 ⇒ 不显著')
    expect(report).toContain('迁移有损')
    expect(report).toContain('… 另 2 条(略)') // 7 - 5
    expect(report).toContain(' n/a ') // identity.realizedAcc=NaN 走 f3 的 n/a 分支
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

describe('S10 · runDecisionValueReport 端到端(合成语料,真 DB)', () => {
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

  it('③ 端到端:合成 ~180 facts → 报告三段 + ≥1 条真 claim+trace 的错答下钻;decisionLift 显著', async () => {
    const corpus = buildSyntheticCorpus()
    expect(corpus.r1.length + corpus.r2.length).toBeGreaterThanOrEqual(150) // 语料扩到 ~150–200
    expect(corpus.r1.length + corpus.r2.length).toBeLessThanOrEqual(200)

    const { report, loop, wrongAnswerClaimIds } = await runDecisionValueReport(db, {
      corpus,
      embedder: makeFakeEmbedder(),
      seed: 1,
    })

    // 价值兑现:fitted 在未见 R2 上守约、identity 违诺,lift 显著。
    expect(loop.r2.decisionLift).toBeGreaterThan(0.05)
    expect(loop.r2.ci.lo).toBeGreaterThan(0)

    // 至少一条错答被连 trace 落库 + diagnose(下钻有料)。
    expect(wrongAnswerClaimIds.length).toBeGreaterThan(0)

    // 报告三段齐全 + 含真错答行。
    expect(report).toContain('Plan A 决策价值报告')
    expect(report).toContain('Baseline @ τ=0.80')
    expect(report).toContain('R1 → R2 series')
    expect(report).toContain('错答下钻')
    expect(report).toContain('claim ') // 至少渲染了一条 claim 下钻
    expect(report).toContain('⚠ 退化') // capstone 兑现:join 出的真 trace 把退化产出 run 标了出来(优先排查抽取本身)
    expect(report).toContain('打印前已通过 A3 fail-closed 复检')
    // 报告里的数字与真实计算耦合(防渲染层与计算漂移):decisionLift 文本 = loop 对象值。
    expect(report).toContain(loop.r2.decisionLift.toFixed(3))

    // 这些 claimId 是真在库里的(诊断 join 拿得到、非臆造)——抽一条断言报告里出现其前缀。
    expect(report).toContain(wrongAnswerClaimIds[0]!.slice(0, 8))
  }, 60_000)
})
