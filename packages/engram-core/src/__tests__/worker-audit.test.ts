import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type DB } from '../db/client.js'
import { metricsEvents } from '../db/schema.js'
import { addSource } from '../spi/append-claim.js'
import { getHumanPendingSources, markSourceHumanPending } from '../spi/worker-audit.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

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
  pool.on('error', () => {}) // 吞 teardown 期 DROP ... WITH(FORCE) 终止连接的 57P01
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
    'TRUNCATE source, claim, claim_provenance, claim_verification, metrics_events CASCADE',
  )
})

async function aSource() {
  return addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
}

describe('worker-audit: source_human_pending payload invariants (EGR-CR-040)', () => {
  // T1 — 写侧拒空 sourceId / reason / byRole（参数化三字段 × 空串/纯空白）
  describe('T1: write side refuses empty/blank required fields', () => {
    it.each([
      ['empty sourceId', { sourceId: '', reason: 'r', byRole: 'agent:distiller' }],
      ['blank sourceId', { sourceId: '   ', reason: 'r', byRole: 'agent:distiller' }],
    ])('rejects %s', async (_label, badOpts) => {
      // a real source exists, but the bad field is what must be rejected
      await aSource()
      await expect(markSourceHumanPending(db, badOpts)).rejects.toThrow(/empty|blank/i)
    })

    it.each([
      ['empty reason', { reason: '' }],
      ['blank reason', { reason: '   ' }],
      ['empty byRole', { byRole: '' }],
      ['blank byRole', { byRole: '   ' }],
    ])('rejects %s on a real source', async (_label, override) => {
      const { sourceId } = await aSource()
      const opts = { sourceId, reason: 'r', byRole: 'agent:distiller', ...override }
      await expect(markSourceHumanPending(db, opts)).rejects.toThrow(/empty|blank/i)
    })

    it('writes nothing when a field is empty (queue stays clean)', async () => {
      const { sourceId } = await aSource()
      await expect(
        markSourceHumanPending(db, { sourceId, reason: '', byRole: 'agent:distiller' }),
      ).rejects.toThrow(/empty|blank/i)
      const rows = await db.select().from(metricsEvents)
      expect(rows).toHaveLength(0) // refused write never reached the table
    })
  })

  // T2 — 写侧拒不存在的 source
  describe('T2: write side refuses a non-existent source', () => {
    it('rejects a sourceId that points at no source row', async () => {
      await expect(
        markSourceHumanPending(db, {
          sourceId: randomUUID(),
          reason: 'r',
          byRole: 'agent:distiller',
        }),
      ).rejects.toThrow(/not found|does not exist/i)
    })
  })

  // T3 — 读侧对 DB 直插 malformed payload fail-loud（核心）
  describe('T3: read side is fail-loud on malformed payloads (no empty pseudo-todos)', () => {
    it.each([
      ['empty object {}', {}],
      ['all-empty-string fields', { sourceId: '', reason: '', byRole: '' }],
      ['missing fields', { sourceId: 's' }],
    ])('rejects a row with %s, naming the bad row id', async (_label, badPayload) => {
      const badId = randomUUID()
      // bypass the SPI to simulate a bad writer / manual migration
      await db.insert(metricsEvents).values({
        id: badId,
        kind: 'source_human_pending',
        queryText: null,
        payload: badPayload,
      })
      await expect(getHumanPendingSources(db)).rejects.toThrow(/malformed/i)
      // the thrown error must locate the offending row (so a human can find it)
      await expect(getHumanPendingSources(db)).rejects.toThrow(badId)
    })
  })

  // T4 — 正路径回归（写读闭环不被新校验误伤）
  describe('T4: happy-path write/read round-trip survives the new guards', () => {
    it('writes then reads back exactly one non-empty pending todo', async () => {
      const { sourceId } = await aSource()
      const reason = 'bounded loop ended with reason=max_turns'
      const byRole = 'agent:distiller'
      const { eventId } = await markSourceHumanPending(db, { sourceId, reason, byRole })
      expect(eventId).toBeTruthy()

      const pending = await getHumanPendingSources(db)
      expect(pending).toHaveLength(1)
      const p = pending[0]!
      expect(p.sourceId).toBe(sourceId)
      expect(p.reason).toBe(reason)
      expect(p.byRole).toBe(byRole)
      expect(p.sourceId.length).toBeGreaterThan(0)
      expect(p.reason.length).toBeGreaterThan(0)
      expect(p.byRole.length).toBeGreaterThan(0)
      expect(p.createdAt).toBeInstanceOf(Date)
    })

    it('trims surrounding whitespace before persisting (no whitespace pollution)', async () => {
      const { sourceId } = await aSource()
      await markSourceHumanPending(db, {
        sourceId,
        reason: '  max_turns  ',
        byRole: '  agent:distiller  ',
      })
      const pending = await getHumanPendingSources(db)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.reason).toBe('max_turns')
      expect(pending[0]!.byRole).toBe('agent:distiller')
    })
  })
})
