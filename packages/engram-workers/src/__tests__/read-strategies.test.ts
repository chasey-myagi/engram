/**
 * S16 · read_source 全 kind 读法 + locator 形状测试。两层：
 *   ① reader 单元层：makeFakeSourceReader 按 kind 选对策略、产出 kind-appropriate locator 锚（cell/turn/page…），且锚可钻回。
 *   ② SPI 缝端到端层：runDistiller 把 7 个 kind 各跑一遍 S15 脊柱（read→extract loop→commitClaim→commit），
 *      断言每个 kind 都产出**带正确形状 locator 的 provenance**，且 table 的 cell / conversation 的 turn 钻回正确。
 *      脊柱 + 降级路径与 S15 一字不动——这里只验「① 按 kind 选读法」长出来了。
 */
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
  makeFakeEmbedder,
  makeFakeSameFactJudge,
  schema,
  type DB,
  type SourceKind,
} from '@engram/core'
import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { makeFakeSourceReader } from '../read/fake-source-reader.js'
import type { AgentRunRequest, AgentRuntime } from '../runtime/port.js'
import { makeHarnessPiRuntime } from '../runtime/harness-pi.js'
import { runDistiller } from '../distiller.js'

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

async function aSource(kind: SourceKind, content: string) {
  return addSource(db, { content, kind, authorityScore: 0.9 })
}

/** 单条 claim 的 provenance 行（locator + excerpt）。 */
async function provOf(claimId: string) {
  return db.select().from(schema.claimProvenance).where(eq(schema.claimProvenance.claimId, claimId))
}

// ─────────────────────────────────────────────────────────────────────────────
describe('S16 · fake reader selects the correct strategy + locator shape per source_kind (unit)', () => {
  it('maps each of the 7 source_kind values to its kind-appropriate strategy and locator vocabulary', async () => {
    // structured_spec 非表格 → lines/L<n>
    const lines = await reader.read({ kind: 'structured_spec', content: 'alpha\nbeta' })
    expect(lines.strategy).toBe('lines')
    expect(lines.usedVision).toBe(false)
    expect(lines.segments.map((s) => s.locator)).toEqual(['L1', 'L2'])

    // structured_spec 表格（TSV） → table/cell:R<r>C<c>
    const table = await reader.read({ kind: 'structured_spec', content: 'sku\tweight\nsku-9\t5kg' })
    expect(table.strategy).toBe('table')
    expect(table.segments.map((s) => s.locator)).toEqual([
      'cell:R1C1',
      'cell:R1C2',
      'cell:R2C1',
      'cell:R2C2',
    ])

    // human_qa → qa/qa:<n>
    const qa = await reader.read({
      kind: 'human_qa',
      content: 'Q: how heavy?\nA: 5kg\nQ: color?\nA: red',
    })
    expect(qa.strategy).toBe('qa')
    expect(qa.segments.map((s) => s.locator)).toEqual(['qa:1', 'qa:2'])

    // conversation_log → turns/turn:<n>
    const conv = await reader.read({
      kind: 'conversation_log',
      content: 'ann: hi\nbob: the price is 10usd',
    })
    expect(conv.strategy).toBe('turns')
    expect(conv.segments.map((s) => s.locator)).toEqual(['turn:1', 'turn:2'])

    // historical_artifact → segments/seg:<n>
    const arti = await reader.read({ kind: 'historical_artifact', content: 'para one\n\npara two' })
    expect(arti.strategy).toBe('segments')
    expect(arti.segments.map((s) => s.locator)).toEqual(['seg:1', 'seg:2'])

    // agent_synthesis → sections/sec:<n>
    const syn = await reader.read({
      kind: 'agent_synthesis',
      content: '## intro\nbody a\n## detail\nbody b',
    })
    expect(syn.strategy).toBe('sections')
    expect(syn.segments.map((s) => s.locator)).toEqual(['sec:1', 'sec:2'])

    // external_feed → items/item:<n>
    const feed = await reader.read({ kind: 'external_feed', content: 'item a\nitem b\nitem c' })
    expect(feed.strategy).toBe('items')
    expect(feed.segments.map((s) => s.locator)).toEqual(['item:1', 'item:2', 'item:3'])

    // formal_document (image-bearing by default) → vlm/p<page>:L<line>, usedVision=true
    const doc = await reader.read({
      kind: 'formal_document',
      content: 'title line\nbody line\f page2 line',
    })
    expect(doc.strategy).toBe('vlm')
    expect(doc.usedVision).toBe(true)
    expect(doc.segments.map((s) => s.locator)).toEqual(['p1:L1', 'p1:L2', 'p2:L1'])
  })

  it('VLM path can be forced on a non-default kind via hasImages, and skipped on formal_document via hasImages=false', async () => {
    // external_feed is text by default, but a domain adapter can mark it image-bearing → VLM path.
    const visual = await reader.read({
      kind: 'external_feed',
      content: 'scanned a\nscanned b',
      hasImages: true,
    })
    expect(visual.strategy).toBe('vlm')
    expect(visual.usedVision).toBe(true)
    expect(visual.segments[0]!.locator).toBe('p1:L1')

    // formal_document forced text-only → layout strategy (still page/line anchors), no vision.
    const textOnly = await reader.read({
      kind: 'formal_document',
      content: 'a\nb',
      hasImages: false,
    })
    expect(textOnly.strategy).toBe('layout')
    expect(textOnly.usedVision).toBe(false)
  })

  it('a content with no locatable segments reads to an empty segment list (the empty_read degrade trigger)', async () => {
    const empty = await reader.read({ kind: 'structured_spec', content: '   \n\n \t ' })
    expect(empty.segments).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('S16 · runDistiller drives the right read strategy per kind through the UNCHANGED S15 spine (SPI seam)', () => {
  it('a TABLE source (structured_spec TSV) yields CELL-anchored provenance that drills back to the right cell', async () => {
    const content = 'sku\tweight\nsku-9\t5kg'
    const { sourceId } = await aSource('structured_spec', content)

    // capture what the reader fed the loop — proves the cell anchors were exposed to the LLM.
    let seen: AgentRunRequest | null = null
    const capture: AgentRuntime = {
      async run(req) {
        seen = req
        const commit = req.tools.find((t) => t.name === 'commit_claim')!
        // the LLM cites cell:R2C2 (the weight value) for the fact "sku-9 weight 5kg".
        await commit.execute({
          claimText: 'sku-9 weight 5kg',
          subject: 'sku-9',
          predicate: 'weight',
          object: '5kg',
          locator: 'cell:R2C2',
          excerpt: '5kg',
        })
        return { reason: 'done', turns: 1 }
      },
    }
    const res = await runDistiller({ db, embedder, judge, reader, runtime: capture }, sourceId)
    expect(res.status).toBe('done')
    expect(res.committed).toBe(1)

    // the loop prompt exposed cell anchors (read strategy = table) — the seam between reader and loop.
    expect(seen!.prompt).toContain('Read strategy: table')
    expect(seen!.prompt).toContain('cell:R2C2\t5kg')

    const [claim] = await db.select().from(schema.claim)
    const prov = await provOf(claim!.id)
    expect(prov).toHaveLength(1)
    expect(prov[0]!.locator).toBe('cell:R2C2') // cell-anchored provenance

    // drill back: cell:R2C2 in the source resolves to "5kg" — the value the claim asserts.
    const back = await reader.read({ kind: 'structured_spec', content })
    const cell = back.segments.find((s) => s.locator === 'cell:R2C2')
    expect(cell!.text).toBe('5kg')
    expect(claim!.object).toBe(cell!.text) // drill-back-correct
  })

  it('a CONVERSATION_LOG source yields TURN-anchored provenance that drills back to the right turn', async () => {
    const content = 'ann: kickoff\nbob: the deadline is march 3\ncarol: noted'
    const { sourceId } = await aSource('conversation_log', content)

    let seen: AgentRunRequest | null = null
    const capture: AgentRuntime = {
      async run(req) {
        seen = req
        const commit = req.tools.find((t) => t.name === 'commit_claim')!
        await commit.execute({
          claimText: 'the deadline is march 3',
          subject: 'project',
          predicate: 'deadline',
          object: 'march 3',
          locator: 'turn:2', // bob's utterance is turn 2
          excerpt: 'the deadline is march 3',
        })
        return { reason: 'done', turns: 1 }
      },
    }
    const res = await runDistiller({ db, embedder, judge, reader, runtime: capture }, sourceId)
    expect(res.status).toBe('done')
    expect(seen!.prompt).toContain('Read strategy: turns')
    expect(seen!.prompt).toContain('turn:2\tbob: the deadline is march 3')

    const [claim] = await db.select().from(schema.claim)
    const prov = await provOf(claim!.id)
    expect(prov[0]!.locator).toBe('turn:2') // turn-anchored provenance

    // drill back: turn:2 resolves to bob's utterance carrying the fact.
    const back = await reader.read({ kind: 'conversation_log', content })
    const turn = back.segments.find((s) => s.locator === 'turn:2')
    expect(turn!.text).toContain('deadline is march 3') // drill-back-correct
  })

  it('a FORMAL_DOCUMENT (image-bearing) source goes through the VLM path and yields page/line provenance', async () => {
    const content = 'Spec Sheet\nmax load 200kg\f Appendix\nrev date 2024'
    const { sourceId } = await aSource('formal_document', content)

    let seen: AgentRunRequest | null = null
    const capture: AgentRuntime = {
      async run(req) {
        seen = req
        const commit = req.tools.find((t) => t.name === 'commit_claim')!
        await commit.execute({
          claimText: 'max load 200kg',
          subject: 'unit',
          predicate: 'maxLoad',
          object: '200kg',
          locator: 'p1:L2', // page 1, line 2 of the transcribed layout
          excerpt: 'max load 200kg',
        })
        return { reason: 'done', turns: 1 }
      },
    }
    const res = await runDistiller({ db, embedder, judge, reader, runtime: capture }, sourceId)
    expect(res.status).toBe('done')
    // VLM transcription strategy fed page/line anchors into the loop.
    expect(seen!.prompt).toContain('Read strategy: vlm')
    expect(seen!.prompt).toContain('p1:L2\tmax load 200kg')

    const [claim] = await db.select().from(schema.claim)
    const prov = await provOf(claim!.id)
    expect(prov[0]!.locator).toBe('p1:L2') // page/line provenance from the vision path
  })

  it('all 7 source_kind values flow through the SAME spine and produce kind-appropriate, provenance-backed claims', async () => {
    // one source per kind, each with a content shaped for its reader; the LLM cites the kind's anchor shape.
    const cases: { kind: SourceKind; content: string; locator: string; claimText: string }[] = [
      {
        kind: 'formal_document',
        content: 'header\nload 9kg',
        locator: 'p1:L2',
        claimText: 'load 9kg',
      },
      {
        kind: 'structured_spec',
        content: 'capacity: 9000',
        locator: 'L1',
        claimText: 'capacity 9000',
      },
      {
        kind: 'human_qa',
        content: 'Q: warranty?\nA: 2 years',
        locator: 'qa:1',
        claimText: 'warranty 2 years',
      },
      {
        kind: 'conversation_log',
        content: 'amy: budget is 50k',
        locator: 'turn:1',
        claimText: 'budget 50k',
      },
      {
        kind: 'historical_artifact',
        content: 'founded in 1990',
        locator: 'seg:1',
        claimText: 'founded 1990',
      },
      {
        kind: 'agent_synthesis',
        content: '## summary\nrevenue rose 12%',
        locator: 'sec:1',
        claimText: 'revenue rose 12%',
      },
      {
        kind: 'external_feed',
        content: 'price ticked to 42usd',
        locator: 'item:1',
        claimText: 'price 42usd',
      },
    ]

    for (const c of cases) {
      await pool.query(
        'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events CASCADE',
      )
      const { sourceId } = await aSource(c.kind, c.content)
      const res = await runDistiller(
        {
          db,
          embedder,
          judge,
          reader,
          // real harness-pi runtime + scripted fake model: same loop the production path uses.
          runtime: makeHarnessPiRuntime(
            createFakeModel([
              // claimText is a paraphrase (not a verbatim quote); omit excerpt so the substring gate
              // doesn't reject it. This test asserts on locator/relevance, not excerpt (EGR-CR-022).
              commitTurn({ claimText: c.claimText, locator: c.locator }),
              finishTurn(),
              stopTurn,
            ]),
          ),
        },
        sourceId,
      )
      expect(res.status, `${c.kind} should distill`).toBe('done')
      expect(res.committed, `${c.kind} commits one claim`).toBe(1)

      const [claim] = await db.select().from(schema.claim)
      expect(claim, `${c.kind} produced a claim`).toBeTruthy()
      const prov = await provOf(claim!.id)
      // D1: provenance-backed, exact, with the kind-appropriate locator the reader exposed.
      expect(prov.length, `${c.kind} claim is provenance-backed`).toBeGreaterThanOrEqual(1)
      expect(prov[0]!.locator, `${c.kind} carries its kind-appropriate locator`).toBe(c.locator)
      expect(prov[0]!.relevance).toBe('exact')
      // judge≠athlete: athlete identity on created_by, no self-written verification.
      expect(claim!.createdBy.startsWith('agent:distiller')).toBe(true)
      expect(await db.select().from(schema.claimVerification)).toHaveLength(0)
    }
  })
})
