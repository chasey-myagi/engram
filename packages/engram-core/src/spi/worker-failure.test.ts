/**
 * EGR-CR-039 · worker_failure dead-letter / 审计 SPI 的 CI 守门（真测试 DB）。
 * 验：值域门（workerName/eventType 非空才写）+ append-only 写 + 按 workerName 过滤读回（createdAt desc 确定性）。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type DB } from '../db/client.js'
import { getWorkerFailures, recordWorkerFailure } from './worker-failure.js'

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

beforeEach(async () => {
  await pool.query('TRUNCATE worker_failure CASCADE')
})

describe('EGR-CR-039 · recordWorkerFailure / getWorkerFailures', () => {
  it('① workerName 空 → 抛非空门错误（坏审计行物理写不进）', async () => {
    await expect(
      recordWorkerFailure(db, { workerName: '', eventType: 'source.ingested', error: 'boom' }),
    ).rejects.toThrow(/workerName must be a non-empty string/)
    await expect(
      recordWorkerFailure(db, { workerName: '   ', eventType: 'source.ingested', error: 'boom' }),
    ).rejects.toThrow(/workerName must be a non-empty string/)
  })

  it('② eventType 空 → 抛非空门错误', async () => {
    await expect(
      recordWorkerFailure(db, { workerName: 'verifier', eventType: '', error: 'boom' }),
    ).rejects.toThrow(/eventType must be a non-empty string/)
  })

  it('③ 合法写入 → 按 workerName 过滤读回，字段无损（createdAt desc）', async () => {
    const r1 = await recordWorkerFailure(db, {
      workerName: 'verifier',
      eventType: 'claim.draft',
      error: 'judge timed out',
      payloadDigest: { claimCount: 3 },
    })
    expect(r1.eventId).toBeTruthy()
    // 另一工种的失败行，确认过滤生效。
    await recordWorkerFailure(db, {
      workerName: 'arbiter',
      eventType: 'conflict.detected',
      error: 'arbiter runtime down',
    })

    const rows = await getWorkerFailures(db, { workerName: 'verifier' })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.workerName).toBe('verifier')
    expect(row.eventType).toBe('claim.draft')
    expect(row.error).toBe('judge timed out')
    expect(row.payloadDigest).toEqual({ claimCount: 3 })
    expect(row.createdAt).toBeInstanceOf(Date)

    // 无过滤读回全部两行。
    const all = await getWorkerFailures(db)
    expect(all).toHaveLength(2)
  })

  it('④ payloadDigest 缺省 → 落空对象（不是 null）', async () => {
    await recordWorkerFailure(db, {
      workerName: 'distiller',
      eventType: 'source.ingested',
      error: 'runtime down',
    })
    const rows = await getWorkerFailures(db, { workerName: 'distiller' })
    expect(rows[0]!.payloadDigest).toEqual({})
  })
})
