import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type DB } from '../db/client.js'
import { source } from '../db/schema.js'
import { addSource } from '../spi/append-claim.js'
import {
  annotateSourceAuthority,
  getSourceMetadataEvents,
  updateSourceMetadata,
} from '../spi/source-metadata.js'
import { agentActor, trustedHumanActor } from '../spi/actor.js'

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
  pool.on('error', () => {})
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE source, source_metadata_events CASCADE')
})

describe('EGR-CR-011 source-metadata enrichment SPI (human-only, append-only audit)', () => {
  // T2：先裸写一条缺 source_type 的源（首写未带业务身份），再经富集 SPI 显式补上 → 身份真正可补、且留痕。
  it('updateSourceMetadata enriches a bare source business identity and leaves an append-only audit trail', async () => {
    const { sourceId } = await addSource(db, { content: 'raw body', kind: 'external_feed' })
    // 富集前：meta 为空，source_type 缺。
    const before = (await db.select().from(source).where(eq(source.id, sourceId)))[0]!
    expect(before.meta).toEqual({})

    const { eventId } = await updateSourceMetadata(db, {
      sourceId,
      meta: { source_type: 'official_datasheet' },
      actor: trustedHumanActor('human:ops'),
      reason: 'enrich after bare ingest',
    })
    expect(eventId).toBeTruthy()

    // 业务身份已可补上（live source.meta 反映新值）。
    const after = (await db.select().from(source).where(eq(source.id, sourceId)))[0]!
    expect(after.meta).toEqual({ source_type: 'official_datasheet' })

    // append-only 审计事件：含 sourceId / before(空 meta) / after(official) / byRole / reason。
    const events = await getSourceMetadataEvents(db, sourceId)
    expect(events).toHaveLength(1)
    expect(events[0]!.field).toBe('meta')
    expect(events[0]!.before).toEqual({})
    expect(events[0]!.after).toEqual({ source_type: 'official_datasheet' })
    expect(events[0]!.byRole).toBe('human:ops')
    expect(events[0]!.reason).toBe('enrich after bare ingest')
  })

  // 再 update 一次只**追新行**、绝不删改历史事件（append-only 不变量）。
  it('a second enrichment appends a new audit row without mutating or deleting the first', async () => {
    const { sourceId } = await addSource(db, { content: 'raw body', kind: 'external_feed' })
    await updateSourceMetadata(db, {
      sourceId,
      meta: { source_type: 'community_forum' },
      actor: trustedHumanActor('human:ops'),
      reason: 'first label',
    })
    await updateSourceMetadata(db, {
      sourceId,
      meta: { source_type: 'official_datasheet' },
      actor: trustedHumanActor('human:lead'),
      reason: 'correct to official',
    })
    const events = await getSourceMetadataEvents(db, sourceId)
    expect(events).toHaveLength(2) // both rows survive — append-only
    // 升序：第一条 before=空→after=forum；第二条 before=forum→after=official（before/after 链可还原每一步）。
    expect(events[0]!.before).toEqual({})
    expect(events[0]!.after).toEqual({ source_type: 'community_forum' })
    expect(events[1]!.before).toEqual({ source_type: 'community_forum' })
    expect(events[1]!.after).toEqual({ source_type: 'official_datasheet' })
    expect(events[1]!.byRole).toBe('human:lead')
    // live meta = 最新一次富集的值。
    const row = (await db.select().from(source).where(eq(source.id, sourceId)))[0]!
    expect(row.meta).toEqual({ source_type: 'official_datasheet' })
  })

  it('annotateSourceAuthority adjusts authority_score and records a typed audit event', async () => {
    const { sourceId } = await addSource(db, { content: 'raw body', kind: 'external_feed' })
    const { eventId } = await annotateSourceAuthority(db, {
      sourceId,
      authorityScore: 0.95,
      actor: trustedHumanActor('human:ops'),
      reason: 'verified official source',
    })
    expect(eventId).toBeTruthy()
    const row = (await db.select().from(source).where(eq(source.id, sourceId)))[0]!
    expect(row.authorityScore).toBe(0.95)
    const events = await getSourceMetadataEvents(db, sourceId)
    expect(events).toHaveLength(1)
    expect(events[0]!.field).toBe('authority_score')
    expect(events[0]!.before).toBe(0.5) // schema default first-write
    expect(events[0]!.after).toBe(0.95)
  })

  // 受信门（EGR-CR-002 同款）：agent 即便 role 伪装成 'human:fake' 也 isHuman:false → 富集被拒，meta/审计均不动。
  it('rejects enrichment from a non-human actor (even when role masquerades as human), writing nothing', async () => {
    const { sourceId } = await addSource(db, { content: 'raw body', kind: 'external_feed' })
    await expect(
      updateSourceMetadata(db, {
        sourceId,
        meta: { source_type: 'official_datasheet' },
        actor: agentActor('human:fake'),
        reason: 'sneaky',
      }),
    ).rejects.toThrow(/human-only/i)
    await expect(
      annotateSourceAuthority(db, {
        sourceId,
        authorityScore: 0.99,
        actor: agentActor('human:fake'),
        reason: 'sneaky',
      }),
    ).rejects.toThrow(/human-only/i)
    const row = (await db.select().from(source).where(eq(source.id, sourceId)))[0]!
    expect(row.meta).toEqual({}) // unchanged
    expect(row.authorityScore).toBe(0.5) // unchanged
    expect(await getSourceMetadataEvents(db, sourceId)).toHaveLength(0) // no audit written
  })

  it('rejects enrichment of a nonexistent source, and blank reason', async () => {
    await expect(
      updateSourceMetadata(db, {
        sourceId: randomUUID(),
        meta: { source_type: 'official_datasheet' },
        actor: trustedHumanActor('human:ops'),
        reason: 'x',
      }),
    ).rejects.toThrow(/not found/i)
    const { sourceId } = await addSource(db, { content: 'raw body', kind: 'external_feed' })
    await expect(
      updateSourceMetadata(db, {
        sourceId,
        meta: {},
        actor: trustedHumanActor('human:ops'),
        reason: '   ',
      }),
    ).rejects.toThrow(/reason/i)
  })

  it('annotateSourceAuthority rejects an out-of-range score', async () => {
    const { sourceId } = await addSource(db, { content: 'raw body', kind: 'external_feed' })
    await expect(
      annotateSourceAuthority(db, {
        sourceId,
        authorityScore: 1.5,
        actor: trustedHumanActor('human:ops'),
        reason: 'too high',
      }),
    ).rejects.toThrow(/\[0,1\]/)
  })
})
