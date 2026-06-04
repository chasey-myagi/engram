import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  getHumanPendingSources,
  makeFakeEmbedder,
  makeFakeSameFactJudge,
  recallClaims,
  schema,
  transitionClaim,
  type DB,
} from '@engram/core'
import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { runDistiller } from '../distiller.js'
import { makeHarnessPiRuntime } from '../runtime/harness-pi.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
// workers test → engram-core 的 drizzle 迁移目录（../../../engram-core/drizzle）。
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
const judge = makeFakeSameFactJudge() // 默认 'unrelated'；本测试用结构化三元，走确定性规则

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

beforeEach(async () => {
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events CASCADE',
  )
})

let toolCallSeq = 0
function commitTurn(args: Record<string, unknown>): FakeAssistantResponse {
  return {
    content: [
      { type: 'toolCall', id: `tc${++toolCallSeq}`, name: 'commit_claim', arguments: args },
    ],
    stopReason: 'toolUse',
  }
}
const finishTurn: () => FakeAssistantResponse = () => ({
  content: [{ type: 'toolCall', id: `tc${++toolCallSeq}`, name: 'finish', arguments: {} }],
  stopReason: 'toolUse',
})
const stopTurn: FakeAssistantResponse = {
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'stop',
}

function runtimeOf(script: FakeAssistantResponse[]) {
  return makeHarnessPiRuntime(createFakeModel(script))
}

async function aSource(opts: { kind?: string; content?: string } = {}) {
  return addSource(db, {
    content: opts.content ?? `body-${randomUUID()}`,
    contentHash: randomUUID(),
    kind: (opts.kind ?? 'structured_spec') as 'structured_spec',
    authorityScore: 0.9, // strong ⇒ a 2-source merge clears the recall floor
  })
}

describe('S15 Distiller worker (bounded loop on harness-pi) — A.7 five-stage spine', () => {
  it('source.ingested → distills to provenance-backed claims: equivalents merge, contradictions kept with a contradicts edge, athlete identity on created_by', async () => {
    const { sourceId } = await aSource({ kind: 'structured_spec' })
    const script: FakeAssistantResponse[] = [
      commitTurn({
        claimText: 'sku-7 maxThroughput 500mbps',
        subject: 'sku-7',
        predicate: 'maxThroughput',
        object: '500mbps',
        locator: 'L1',
      }),
      commitTurn({
        claimText: 'throughput of sku-7 is 500 mbps',
        subject: 'sku-7',
        predicate: 'maxThroughput',
        object: '500mbps',
        locator: 'L2',
      }), // equivalent ⇒ merge
      commitTurn({
        claimText: 'sku-7 maxThroughput 1gbps',
        subject: 'sku-7',
        predicate: 'maxThroughput',
        object: '1gbps',
        locator: 'L3',
      }), // contradicts
      finishTurn(),
      stopTurn,
    ]
    const res = await runDistiller({ db, embedder, judge, runtime: runtimeOf(script) }, sourceId)

    expect(res.status).toBe('done')
    expect(res.committed).toBe(3) // three successful commit_claim calls (the equivalent one merges)

    const claims = await db.select().from(schema.claim)
    expect(claims).toHaveLength(2) // equivalent merged into one; contradiction is a separate claim

    // a contradicts edge connects the two claims
    const rels = await db.select().from(schema.relation)
    expect(rels.some((r) => r.type === 'contradicts')).toBe(true)

    // every committed claim is provenance-backed (D1) and carries the Distiller's athlete identity on created_by
    for (const c of claims) {
      const prov = await db
        .select()
        .from(schema.claimProvenance)
        .where(eq(schema.claimProvenance.claimId, c.id))
      expect(prov.length).toBeGreaterThanOrEqual(1)
      // judge≠athlete: identity is the athlete's created_by, NOT a self-written claim_verification row
      expect(c.createdBy.startsWith('agent:distiller')).toBe(true)
    }
    // the Distiller writes NO claim_verification rows (self-endorsement would violate judge≠athlete)
    const verifs = await db.select().from(schema.claimVerification)
    expect(verifs).toHaveLength(0)
  })

  it('forced provenance: a commit_claim with an empty locator is rejected and not committed', async () => {
    const { sourceId } = await aSource()
    const script: FakeAssistantResponse[] = [
      commitTurn({
        claimText: 'ungrounded fact',
        subject: 'x',
        predicate: 'p',
        object: 'o',
        locator: '',
      }), // rejected
      commitTurn({
        claimText: 'grounded fact',
        subject: 'y',
        predicate: 'p',
        object: 'o',
        locator: 'L1',
      }),
      finishTurn(),
      stopTurn,
    ]
    const res = await runDistiller({ db, embedder, judge, runtime: runtimeOf(script) }, sourceId)
    expect(res.status).toBe('done')
    expect(res.committed).toBe(1) // only the grounded claim
    expect(await db.select().from(schema.claim)).toHaveLength(1)
  })

  it('cross-source equivalents merge: distilling the same fact from two independent sources raises indepSupport (single recallable claim)', async () => {
    const triple = { subject: 'sku-9', predicate: 'weight', object: '5kg' }
    const a = await aSource()
    await runDistiller(
      {
        db,
        embedder,
        judge,
        runtime: runtimeOf([
          commitTurn({ claimText: 'sku-9 weight 5kg', ...triple, locator: 'A1' }),
          finishTurn(),
          stopTurn,
        ]),
      },
      a.sourceId,
    )

    const b = await aSource()
    await runDistiller(
      {
        db,
        embedder,
        judge,
        runtime: runtimeOf([
          commitTurn({ claimText: 'the sku-9 weighs 5 kg', ...triple, locator: 'B1' }),
          finishTurn(),
          stopTurn,
        ]),
      },
      b.sourceId,
    )

    const claims = await db.select().from(schema.claim)
    expect(claims).toHaveLength(1) // cross-source equivalent merged, not duplicated

    // promote (human Approve) and recall: indepSupport reflects two independent supporting sources
    await transitionClaim(db, claims[0]!.id, 'active', { by: 'human:editor' })
    const hits = await recallClaims(db, embedder, 'sku-9 weight 5kg')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.confidence.factors.indepSupport).toBeCloseTo(0.5) // 0 (one source) → 0.5 (two)
  })

  it('bounded loop: budget (maxTurns) exhaustion degrades the source to human-pending without blocking (no infinite retry)', async () => {
    const { sourceId } = await aSource()
    // never calls finish; with maxTurns=2 the loop is cut off → reason max_turns
    const script: FakeAssistantResponse[] = [
      commitTurn({
        claimText: 'fact one',
        subject: 's',
        predicate: 'p',
        object: 'o1',
        locator: 'L1',
      }),
      commitTurn({
        claimText: 'fact two',
        subject: 's',
        predicate: 'q',
        object: 'o2',
        locator: 'L2',
      }),
      commitTurn({
        claimText: 'fact three',
        subject: 's',
        predicate: 'r',
        object: 'o3',
        locator: 'L3',
      }),
    ]
    const res = await runDistiller({ db, embedder, judge, runtime: runtimeOf(script) }, sourceId, {
      maxTurns: 2,
    })
    expect(res.status).toBe('human_pending')
    expect(res.reason).toBe('max_turns')
    const pending = await getHumanPendingSources(db)
    expect(pending.some((p) => p.sourceId === sourceId && p.byRole === 'agent:distiller')).toBe(
      true,
    )
  })

  it('unsupported source kind degrades to human-pending without running the loop (S15 reads structured_spec / human_qa only)', async () => {
    const { sourceId } = await aSource({ kind: 'external_feed' })
    // a runtime whose model would throw if ever run — proves the loop is NOT invoked for an unsupported kind
    const res = await runDistiller({ db, embedder, judge, runtime: runtimeOf([]) }, sourceId)
    expect(res.status).toBe('human_pending')
    expect(res.reason).toBe('unsupported_kind')
    expect(res.committed).toBe(0)
    expect((await getHumanPendingSources(db)).some((p) => p.sourceId === sourceId)).toBe(true)
  })

  it('a missing source throws', async () => {
    await expect(
      runDistiller({ db, embedder, judge, runtime: runtimeOf([]) }, randomUUID()),
    ).rejects.toThrow(/not found/)
  })
})
