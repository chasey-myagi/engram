import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  trustedHumanActor,
  addSource,
  createDb,
  getHumanPendingSources,
  makeFakeEmbedder,
  makeFakeSameFactJudge,
  recallClaims,
  schema,
  transitionClaim,
  type DB,
  type SourceKind,
} from '@engram/core'
import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { makeFakeSourceReader } from '../read/fake-source-reader.js'
import type { SourceReader } from '../read/source-reader.js'
import { runDistiller } from '../distiller.js'
import type { AgentRuntime } from '../runtime/port.js'
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
const reader = makeFakeSourceReader() // S16 read_source：确定性、零网络、按 kind 选读法

/** 给 runDistiller 拼一份 deps（默认注入共享 reader；可覆盖 runtime/reader）。 */
function deps(over: { runtime: AgentRuntime; reader?: SourceReader }) {
  return { db, embedder, judge, reader: over.reader ?? reader, runtime: over.runtime }
}

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

// A port-level runtime whose loop, if ever entered, hard-fails the test — proves a code path runs
// BEFORE the loop (e.g. the unsupported-kind guard short-circuits without touching the runtime).
const throwingRuntime: AgentRuntime = {
  run() {
    throw new Error('agent loop must not run')
  },
}

// A port-level runtime that commits one grounded claim and THEN reports a non-'done' terminus —
// simulates "loop did real work, then crashed/aborted" so we can assert error-degrade + partial-work survival.
const commitThenErrorRuntime: AgentRuntime = {
  async run(req) {
    const commit = req.tools.find((t) => t.name === 'commit_claim')
    if (!commit) throw new Error('commit_claim tool not provided to runtime')
    await commit.execute({
      claimText: 'partial fact',
      subject: 's',
      predicate: 'p',
      object: 'o',
      locator: 'L1',
    })
    return { reason: 'error', turns: 1 }
  },
}

async function aSource(opts: { kind?: SourceKind; content?: string } = {}) {
  return addSource(db, {
    content: opts.content ?? `body-${randomUUID()}`,
    contentHash: randomUUID(),
    kind: opts.kind ?? 'structured_spec',
    authorityScore: 0.9, // strong ⇒ a 2-source merge clears the recall floor
  })
}

describe('S15 Distiller worker (bounded loop on harness-pi) — A.7 five-stage spine', () => {
  it('source.ingested → distills to provenance-backed claims: equivalents merge, contradictions kept with a contradicts edge, athlete identity on created_by', async () => {
    // 3 lines → fake reader yields locators L1/L2/L3, all valid anchors for the script below.
    const { sourceId } = await aSource({
      kind: 'structured_spec',
      content:
        'sku-7 maxThroughput 500mbps\nthroughput of sku-7 is 500 mbps\nsku-7 maxThroughput 1gbps',
    })
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
    const res = await runDistiller(deps({ runtime: runtimeOf(script) }), sourceId)

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

  it('forced provenance: a commit_claim with an empty locator is rejected, not committed, and the ungrounded attempt degrades the source to human-pending (auditable)', async () => {
    const { sourceId } = await aSource()
    const script: FakeAssistantResponse[] = [
      commitTurn({
        claimText: 'ungrounded fact',
        subject: 'x',
        predicate: 'p',
        object: 'o',
        locator: '',
      }), // rejected (empty locator counts as an unknown-locator attempt → degrade)
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
    const res = await runDistiller(deps({ runtime: runtimeOf(script) }), sourceId)
    // an ungrounded commit attempt is an auditable signal: the loop finished, but not a clean 'done'.
    expect(res.status).toBe('human_pending')
    expect(res.reason).toBe('unknown_locator')
    expect(res.committed).toBe(1) // only the grounded claim got written
    expect(await db.select().from(schema.claim)).toHaveLength(1)
  })

  // EGR-CR-022 — commit_claim must constrain the model-reported locator to the set produced by
  // read_source (read.segments). A non-empty-but-fabricated locator (e.g. L999) used to be persisted
  // verbatim as a relevance:'exact' provenance; now it is rejected before commitClaim and the source
  // degrades to human-pending so the abuse is auditable.
  it('a commit_claim citing an unknown locator (not in read.segments) is rejected, not persisted, and the source degrades to human-pending with an auditable reason', async () => {
    // default single-line source → fake reader yields exactly one valid anchor: L1. So L999 is unknown.
    const { sourceId } = await aSource()
    const script: FakeAssistantResponse[] = [
      commitTurn({
        claimText: 'fabricated fact',
        subject: 'x',
        predicate: 'p',
        object: 'o',
        locator: 'L999', // not a segment of this source
      }),
      finishTurn(),
      stopTurn,
    ]
    const res = await runDistiller(deps({ runtime: runtimeOf(script) }), sourceId)

    expect(res.status).toBe('human_pending')
    expect(res.reason).toBe('unknown_locator')
    expect(res.committed).toBe(0)
    // the fabricated locator never reached commitClaim: nothing persisted.
    expect(await db.select().from(schema.claim)).toHaveLength(0)
    expect(await db.select().from(schema.claimProvenance)).toHaveLength(0)
    // the degrade is auditable in the human-pending queue under the Distiller's identity.
    const pending = await getHumanPendingSources(db)
    expect(pending.some((p) => p.sourceId === sourceId && p.byRole === 'agent:distiller')).toBe(
      true,
    )
  })

  it('a commit_claim with a known locator but an excerpt that is not a substring of that segment is rejected; a verbatim-substring excerpt on the same locator is committed', async () => {
    const { sourceId } = await aSource({ content: 'sku-7 maxThroughput 500mbps' }) // single line → anchor L1
    const script: FakeAssistantResponse[] = [
      commitTurn({
        claimText: 'sku-7 throughput',
        subject: 'sku-7',
        predicate: 'maxThroughput',
        object: '500mbps',
        locator: 'L1',
        excerpt: 'THIS TEXT IS NOT IN THE SEGMENT', // not a substring of segment L1 → rejected
      }),
      finishTurn(),
      stopTurn,
    ]
    const res = await runDistiller(deps({ runtime: runtimeOf(script) }), sourceId)
    // the only commit on this source was rejected: nothing persisted, zero clean claims.
    expect(await db.select().from(schema.claim)).toHaveLength(0)
    expect(res.committed).toBe(0)
    expect(res.status).toBe('human_pending')
    expect(res.reason).toBe('no_claims') // excerpt mismatch rejects the claim but is not an unknown-locator attempt

    // positive control: a verbatim-substring excerpt on the same known locator is accepted and persisted exact.
    const { sourceId: sourceId2 } = await aSource({ content: 'sku-7 maxThroughput 500mbps' })
    const okScript: FakeAssistantResponse[] = [
      commitTurn({
        claimText: 'sku-7 throughput',
        subject: 'sku-7',
        predicate: 'maxThroughput',
        object: '500mbps',
        locator: 'L1',
        excerpt: '500mbps', // verbatim substring of segment L1
      }),
      finishTurn(),
      stopTurn,
    ]
    const ok = await runDistiller(deps({ runtime: runtimeOf(okScript) }), sourceId2)
    expect(ok.status).toBe('done')
    expect(ok.committed).toBe(1)
    const claims = await db
      .select()
      .from(schema.claim)
      .where(eq(schema.claim.createdBy, `agent:distiller:${sourceId2}`))
    expect(claims).toHaveLength(1)
    const prov = await db
      .select()
      .from(schema.claimProvenance)
      .where(eq(schema.claimProvenance.claimId, claims[0]!.id))
    expect(prov).toHaveLength(1)
    expect(prov[0]!.locator).toBe('L1')
    expect(prov[0]!.excerpt).toBe('500mbps')
    expect(prov[0]!.relevance).toBe('exact')
  })

  it('a loop that finishes without committing any claim degrades to human-pending rather than reporting done', async () => {
    const { sourceId } = await aSource()
    const script: FakeAssistantResponse[] = [finishTurn(), stopTurn] // commit nothing
    const res = await runDistiller(deps({ runtime: runtimeOf(script) }), sourceId)
    expect(res.status).toBe('human_pending')
    expect(res.reason).toBe('no_claims')
    expect(res.committed).toBe(0)
    const pending = await getHumanPendingSources(db)
    expect(pending.some((p) => p.sourceId === sourceId && p.byRole === 'agent:distiller')).toBe(
      true,
    )
  })

  it('cross-source equivalents merge: distilling the same fact from two independent sources raises indepSupport (single recallable claim)', async () => {
    const triple = { subject: 'sku-9', predicate: 'weight', object: '5kg' }
    // each single-line default source yields exactly one valid anchor: L1.
    const a = await aSource()
    await runDistiller(
      deps({
        runtime: runtimeOf([
          commitTurn({ claimText: 'sku-9 weight 5kg', ...triple, locator: 'L1' }),
          finishTurn(),
          stopTurn,
        ]),
      }),
      a.sourceId,
    )

    const b = await aSource()
    await runDistiller(
      deps({
        runtime: runtimeOf([
          commitTurn({ claimText: 'the sku-9 weighs 5 kg', ...triple, locator: 'L1' }),
          finishTurn(),
          stopTurn,
        ]),
      }),
      b.sourceId,
    )

    const claims = await db.select().from(schema.claim)
    expect(claims).toHaveLength(1) // cross-source equivalent merged, not duplicated

    // promote (human Approve) and recall: indepSupport reflects two independent supporting sources
    await transitionClaim(db, claims[0]!.id, 'active', { actor: trustedHumanActor('human:editor') })
    const hits = await recallClaims(db, embedder, 'sku-9 weight 5kg')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.confidence.factors.indepSupport).toBeCloseTo(0.5) // 0 (one source) → 0.5 (two)
  })

  it('bounded loop: budget (maxTurns) exhaustion degrades the source to human-pending without blocking (no infinite retry)', async () => {
    // 3 lines → valid anchors L1/L2/L3 for the script below.
    const { sourceId } = await aSource({ content: 'fact one\nfact two\nfact three' })
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
    const res = await runDistiller(deps({ runtime: runtimeOf(script) }), sourceId, {
      maxTurns: 2,
    })
    expect(res.status).toBe('human_pending')
    expect(res.reason).toBe('max_turns')
    expect(res.committed).toBe(2) // two facts committed within the 2-turn budget before the cutoff
    const pending = await getHumanPendingSources(db)
    expect(pending.some((p) => p.sourceId === sourceId && p.byRole === 'agent:distiller')).toBe(
      true,
    )
    // partial work survives degradation: the claims committed before the cutoff are persisted
    expect(await db.select().from(schema.claim)).toHaveLength(2)
  })

  it('bounded loop: a non-done terminus (reason=error) degrades to human-pending; claims committed before the failure survive', async () => {
    const { sourceId } = await aSource()
    const res = await runDistiller(deps({ runtime: commitThenErrorRuntime }), sourceId)
    expect(res.status).toBe('human_pending')
    expect(res.reason).toBe('error')
    expect(res.committed).toBe(1) // the one claim committed before the loop errored
    expect(await db.select().from(schema.claim)).toHaveLength(1) // partial work persisted, not rolled back
    const pending = await getHumanPendingSources(db)
    expect(pending.some((p) => p.sourceId === sourceId && p.byRole === 'agent:distiller')).toBe(
      true,
    )
  })

  it('an empty/malformed source (read_source yields no locatable segments) degrades to human-pending without running the loop', async () => {
    // whitespace-only body → fake reader parses zero segments → degrade BEFORE the loop.
    const { sourceId } = await aSource({ kind: 'structured_spec', content: '   \n\n  \t \n' })
    // throwingRuntime hard-fails if the loop is entered — green proves the empty-read guard short-circuits.
    const res = await runDistiller(deps({ runtime: throwingRuntime }), sourceId)
    expect(res.status).toBe('human_pending')
    expect(res.reason).toBe('empty_read')
    expect(res.committed).toBe(0)
    expect((await getHumanPendingSources(db)).some((p) => p.sourceId === sourceId)).toBe(true)
  })

  it('a missing source throws before the loop runs', async () => {
    await expect(runDistiller(deps({ runtime: throwingRuntime }), randomUUID())).rejects.toThrow(
      /not found/,
    )
  })
})
