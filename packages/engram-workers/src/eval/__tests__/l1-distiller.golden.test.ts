/**
 * L1 Distiller golden CI 红线（A.9）—— 端到端跑 Distiller 对全部领域无关 fixture，断言抽取准确率 ≥95% +
 * provenance 零错位。非 smoke：fake model 脚本从 fixture 的 golden claim 派生（逐条 commit_claim cite golden
 * locator），驱动**真** harness-pi loop + 真 commitClaim + 真 SourceReader；读回 persisted provenance 比对。
 * 一旦 Distiller 的 render/commit/locator 接线退化（丢锚、错位、render 漏块致 commit 失败），准确率跌破门 → 红。
 *
 * 隔离 / 领域无关（A.9 + 红线）：fixture 只临时 seed 进 per-test DB、随 DROP 消失，绝不经生产写路径落持久 claim、
 * recall 永不召回（见 l1-namespace.ts）；全是通用事实，不 import 任何 bidding golden。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addSource, createDb, makeFakeEmbedder, makeFakeSameFactJudge, type DB } from '@engram/core'
import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { makeFakeSourceReader } from '../../read/fake-source-reader.js'
import type { AgentRuntime } from '../../runtime/port.js'
import { makeHarnessPiRuntime } from '../../runtime/harness-pi.js'
import { DISTILLER_GOLDEN, type DistillerGoldenItem } from '../l1-distiller.golden.js'
import { commitArgsFor, runDistillerGolden } from '../l1-distiller.runner.js'

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
const embedder = makeFakeEmbedder()
const judge = makeFakeSameFactJudge()
const reader = makeFakeSourceReader()

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

let seq = 0
/** 从 fixture 的 golden claim 派生 fake-model 脚本：逐条 commit_claim（cite golden locator/excerpt）→ finish → stop。 */
function scriptFor(item: DistillerGoldenItem): FakeAssistantResponse[] {
  const turns: FakeAssistantResponse[] = item.claims.map((gc) => ({
    content: [
      { type: 'toolCall', id: `tc${++seq}`, name: 'commit_claim', arguments: commitArgsFor(gc) },
    ],
    stopReason: 'toolUse',
  }))
  turns.push({
    content: [{ type: 'toolCall', id: `tc${++seq}`, name: 'finish', arguments: {} }],
    stopReason: 'toolUse',
  })
  turns.push({ content: [{ type: 'text', text: 'done' }], stopReason: 'stop' })
  return turns
}

function makeRuntime(item: DistillerGoldenItem): AgentRuntime {
  return makeHarnessPiRuntime(createFakeModel(scriptFor(item)))
}

const DISTILLER_ACCURACY_FLOOR = 0.95 // A.9 判据

describe('S25 · L1 Distiller golden (CI redline, domain-agnostic) — A.9 extraction ≥95% + 0 provenance misalignment', () => {
  it('runs the real Distiller spine over all source-kind fixtures and meets the extraction-accuracy redline', async () => {
    const report = await runDistillerGolden({
      db,
      embedder,
      judge,
      reader,
      makeRuntime,
      resetDb: async () => {
        await pool.query(
          'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events CASCADE',
        )
      },
      seedSource: async (item) => {
        const { sourceId } = await addSource(db, {
          content: item.content,
          contentHash: randomUUID(),
          kind: item.kind,
          authorityScore: 0.9,
        })
        return sourceId
      },
    })

    // 每条 fixture 自洽：golden locator 确实是 reader 对该 content 的真实分块、且片段含 drillsBackTo（不靠硬编码）。
    for (const o of report.observations) {
      expect(
        o.fixtureSelfConsistent,
        `fixture not self-consistent: ${o.itemId} / ${o.claimText}`,
      ).toBe(true)
    }

    // A.9 红线：抽取准确率 ≥95%，provenance 零错位。
    expect(report.total).toBeGreaterThanOrEqual(15) // ≥7 kind 各≥2 claim（A.9「5 种 kind」超集）
    expect(report.provenanceMisaligned).toBe(0)
    expect(report.extractionAccuracy).toBeGreaterThanOrEqual(DISTILLER_ACCURACY_FLOOR)
    expect(report.extracted).toBe(report.total) // faithful 脚本下应全数抽出（留出 5% 余量给真实退化）
  })

  it('regression guard: a Distiller that drops a segment (mis-anchored locator) falls below the redline', async () => {
    // 用一个「漏掉最后一条 claim」的退化 makeRuntime 模拟 Distiller 抽漏 —— 准确率必须掉到阈下，证明红线真会变红。
    const droppingRuntime = (item: DistillerGoldenItem): AgentRuntime => {
      const dropped: DistillerGoldenItem = { ...item, claims: item.claims.slice(0, -1) }
      return makeHarnessPiRuntime(createFakeModel(scriptFor(dropped)))
    }
    const report = await runDistillerGolden({
      db,
      embedder,
      judge,
      reader,
      makeRuntime: droppingRuntime,
      resetDb: async () => {
        await pool.query(
          'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events CASCADE',
        )
      },
      seedSource: async (item) => {
        const { sourceId } = await addSource(db, {
          content: item.content,
          contentHash: randomUUID(),
          kind: item.kind,
          authorityScore: 0.9,
        })
        return sourceId
      },
    })
    // 每个 fixture 漏一条 → extracted < total → 准确率掉到阈下（红线确实会因 Distiller 退化变红）。
    expect(report.extracted).toBeLessThan(report.total)
    expect(report.extractionAccuracy).toBeLessThan(DISTILLER_ACCURACY_FLOOR)
  })
})
