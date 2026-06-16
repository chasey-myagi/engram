/**
 * S5 · Distiller 接线可观测 + claim→runId join-key 的 CI 守门(真测试 DB)。验:
 *  ① runDistiller 把 runId 盖到产出 claim 的 producing_run_id(S9 诊断 join 的键);
 *  ② 本轮 run 落进 agent_run_trace(worker/reason/turns/工具 rollup),且 traceRecorded=true;
 *  ③ **决策不变**:接线只加元数据——claim 的 text/三元/status/confidence 照常,commit 未被破坏。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import {
  addSource,
  createDb,
  getAgentRunTrace,
  makeFakeEmbedder,
  makeFakeSameFactJudge,
  schema,
  type DB,
} from '@engram/core'

import { runDistiller } from '../distiller.js'
import { makeFakeSourceReader } from '../read/fake-source-reader.js'
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
const judge = makeFakeSameFactJudge()
const reader = makeFakeSourceReader()

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

describe('S5 · Distiller 可观测接线 + claim→runId join-key', () => {
  it('盖 producing_run_id + 落 agent_run_trace + 决策不变', async () => {
    const src = await addSource(db, {
      content: 'The capital of France is Paris',
      kind: 'structured_spec',
      authorityScore: 0.9,
    })
    const script: FakeAssistantResponse[] = [
      {
        content: [
          {
            type: 'toolCall',
            id: 't1',
            name: 'commit_claim',
            arguments: {
              claimText: 'The capital of France is Paris',
              subject: 'The capital of France',
              predicate: 'is',
              object: 'Paris',
              locator: 'L1',
            },
          },
        ],
        stopReason: 'toolUse',
      },
      {
        content: [{ type: 'toolCall', id: 't2', name: 'finish', arguments: {} }],
        stopReason: 'toolUse',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
    ]
    const res = await runDistiller(
      { db, embedder, judge, reader, runtime: makeHarnessPiRuntime(createFakeModel(script)) },
      src.sourceId,
    )

    expect(res.status).toBe('done')
    expect(res.committed).toBe(1)
    expect(res.runId).toBeTruthy()
    expect(res.traceRecorded).toBe(true)

    // ① join-key:产出 claim 的 producing_run_id == 本轮 runId。
    const claims = await db.select().from(schema.claim)
    expect(claims.length).toBe(1)
    const c = claims[0]!
    expect(c.producingRunId).toBe(res.runId)

    // ③ 决策不变:接线只加元数据,commit 照常——text/三元/status/confidence 正确。
    expect(c.claimText).toBe('The capital of France is Paris')
    expect(c.subject).toBe('The capital of France')
    expect(c.object).toBe('Paris')
    expect(c.status).toBe('draft')
    expect(typeof c.confidence).toBe('number')
    expect(c.confidence).toBeGreaterThan(0)

    // ② agent_run_trace:本轮一行,worker/reason/turns + 工具 rollup 被捕获。
    const trace = await getAgentRunTrace(db, { runId: res.runId })
    expect(trace.length).toBe(1)
    const t = trace[0]!
    expect(t.workerName).toBe('agent:distiller')
    expect(t.reason).toBe('done')
    expect(t.turns).toBeGreaterThan(0)
    expect(t.toolNames).toContain('commit_claim')
    expect(t.toolNames).toContain('finish')
    expect(t.toolCalls).toBe(2)
  }, 60_000)
})
