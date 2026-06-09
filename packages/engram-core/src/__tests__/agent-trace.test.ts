/**
 * S3 · agent-loop trace sink SPI 的 CI 守门(真测试 DB)。验:append-only 写 + 按 runId/workerName 读回 +
 * **best-effort 契约**(坏输入/写失败返回 ok:false、绝不抛——trace 不可拖垮真活)。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDb, type DB } from '../db/client.js'
import { getAgentRunTrace, recordAgentRun } from '../observability/agent-trace.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

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

describe('S3 · agent-loop trace sink SPI', () => {
  it('① 记一条完整留痕 → 按 runId 读回字段无损', async () => {
    const runId = randomUUID()
    const r = await recordAgentRun(db, {
      runId,
      workerName: 'agent:distiller',
      byRole: 'agent:distiller',
      reason: 'done',
      turns: 3,
      inputTokens: 120,
      outputTokens: 40,
      toolCalls: 2,
      toolErrors: 1,
      toolNames: ['commit_claim', 'finish'],
      payload: { model: 'qwen-plus' },
    })
    expect(r.ok).toBe(true)
    expect(r.eventId).toBeTruthy()

    const rows = await getAgentRunTrace(db, { runId })
    expect(rows.length).toBe(1)
    const row = rows[0]!
    expect(row.workerName).toBe('agent:distiller')
    expect(row.reason).toBe('done')
    expect(row.turns).toBe(3)
    expect(row.inputTokens).toBe(120)
    expect(row.outputTokens).toBe(40)
    expect(row.toolCalls).toBe(2)
    expect(row.toolErrors).toBe(1)
    expect(row.toolNames).toEqual(['commit_claim', 'finish'])
    expect(row.payload).toEqual({ model: 'qwen-plus' })
  })

  it('② 缺省 token/工具字段 → null / 0 / [](append-only,字段可空)', async () => {
    const runId = randomUUID()
    const r = await recordAgentRun(db, {
      runId,
      workerName: 'agent:arbiter',
      byRole: 'agent:arbiter',
      reason: 'max_turns',
      turns: 12,
    })
    expect(r.ok).toBe(true)
    const [row] = await getAgentRunTrace(db, { runId })
    expect(row!.inputTokens).toBeNull()
    expect(row!.outputTokens).toBeNull()
    expect(row!.reasoningTokens).toBeNull()
    expect(row!.toolCalls).toBe(0)
    expect(row!.toolErrors).toBe(0)
    expect(row!.toolNames).toEqual([])
    expect(row!.payload).toEqual({})
  })

  it('③ best-effort:坏输入(空 runId)→ ok:false、不抛、不写行', async () => {
    const before = (await getAgentRunTrace(db, { limit: 1000 })).length
    const r = await recordAgentRun(db, {
      runId: '   ',
      workerName: 'agent:distiller',
      byRole: 'agent:distiller',
      reason: 'done',
      turns: 1,
    })
    expect(r.ok).toBe(false)
    expect(r.eventId).toBeUndefined()
    const after = (await getAgentRunTrace(db, { limit: 1000 })).length
    expect(after).toBe(before) // 没写进任何行
  })

  it('④ 按 workerName 过滤 + createdAt 降序 + limit', async () => {
    const wn = `agent:verifier-${randomUUID().slice(0, 8)}`
    for (let i = 0; i < 3; i++) {
      await recordAgentRun(db, {
        runId: randomUUID(),
        workerName: wn,
        byRole: wn,
        reason: 'done',
        turns: i,
      })
    }
    const rows = await getAgentRunTrace(db, { workerName: wn, limit: 2 })
    expect(rows.length).toBe(2) // limit 生效
    expect(rows.every((r) => r.workerName === wn)).toBe(true) // 过滤生效
  })
})
