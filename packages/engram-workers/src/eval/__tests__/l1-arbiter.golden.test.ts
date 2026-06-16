/**
 * L1 Arbiter golden CI 红线（A.9）—— 端到端跑 Arbiter 对真冲突对 + 「该信谁」人工标签，断言裁决正确率 = 1 +
 * 顺序一致率 = 1（adjudication-order consistency）。非 smoke：跑真 runArbiter（真 loadConflictSide 现拍 + 真
 * adjudicateConflict 纯阶梯 + 真 resolveConflict/escalateConflict 落库）；fake model 只逐对调工具、不替阶梯选边。
 * 把胜负挪进 LLM / 阶梯次序写反 → 同一对在不同入参/loop 顺序下分叉 → orderConsistency<1 → 红。
 *
 * 隔离 / 领域无关：冲突对临时 seed、随 DROP 消失、不进生产写路径、recall 永不召回；通用传感器/固件事实，不 import bidding golden。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  getEditorConflictQueue,
  getResolvedConflicts,
  makeFakeEmbedder,
  schema,
  type DB,
} from '@engram/core'
import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { arbitrateConflicts } from '../../arbiter.js'
import { makeHarnessPiRuntime } from '../../runtime/harness-pi.js'
import { ARBITER_GOLDEN, type ArbiterGoldenItem, type ArbiterSide } from '../l1-arbiter.golden.js'
import { runArbiterGolden } from '../l1-arbiter.runner.js'

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
const WEIGHTS = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}
// HIGH profile：清召回门，且让 indepSupport 因子不压制各阶（裁决读的是 ConflictSide 现拍快照，非 confidence）。
const HIGH = {
  authority: 0.8,
  humanReview: 0.8,
  entailment: 0.8,
  indepSupport: 0.8,
  usageCorrect: 0.8,
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

/** seed 一侧 active claim：同 query 文本（recall 双返）+ 给定 object/asOf/authority + 额外独立 supports 源数。 */
async function seedSide(query: string, object: string, side: ArbiterSide): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: `src-${randomUUID()}`,
    kind: 'structured_spec',
    authorityScore: side.authority,
  })
  const id = randomUUID()
  await db.insert(schema.claim).values({
    id,
    claimText: query,
    subject: 'k',
    predicate: 'p',
    object,
    status: 'active',
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: { ...HIGH, ageDays: 0, activeContradicts: 0, staleDecay: 1, conflictDecay: 1 },
      weights: WEIGHTS,
      calibrationVersion: 'identity',
    },
    lineageId: randomUUID(),
    asOf: new Date(side.asOf),
    createdBy: 'agent:distiller',
    embedding: await embedder.embed(query),
    embeddingVersion: embedder.version,
  })
  await db
    .insert(schema.claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'L1', relevance: 'exact' })
  // 额外独立 supports 源（A.5 ⑤ indepSupport）：各 contentHash 各异 → 真独立。
  for (let i = 0; i < (side.extraIndepSources ?? 0); i += 1) {
    const extra = await addSource(db, {
      content: `indep-${randomUUID()}`,
      kind: 'formal_document',
      authorityScore: side.authority,
    })
    await db.insert(schema.claimProvenance).values({
      id: randomUUID(),
      claimId: id,
      sourceId: extra.sourceId,
      locator: 'L2',
      relevance: 'supporting',
    })
  }
  return id
}

async function seedConflict(item: ArbiterGoldenItem) {
  const aId = await seedSide(item.query, 'A', item.a)
  const bId = await seedSide(item.query, 'B', item.b)
  await db
    .insert(schema.relation)
    .values({ id: randomUUID(), fromClaim: aId, toClaim: bId, type: 'contradicts' })
  if (item.aSupersedesB) {
    await db
      .insert(schema.relation)
      .values({ id: randomUUID(), fromClaim: aId, toClaim: bId, type: 'supersedes' })
  }
  if (item.bSupersedesA) {
    await db
      .insert(schema.relation)
      .values({ id: randomUUID(), fromClaim: bId, toClaim: aId, type: 'supersedes' })
  }
  return {
    aId,
    bId,
    refOf: (claimId: string): 'a' | 'b' | null =>
      claimId === aId ? 'a' : claimId === bId ? 'b' : null,
  }
}

let seq = 0
/** fake model 脚本：按给定入参顺序调一次 adjudicate_conflict → finish → stop（不替阶梯选边）。 */
function scriptFor(pair: [string, string]): FakeAssistantResponse[] {
  return [
    {
      content: [
        {
          type: 'toolCall',
          id: `tc${++seq}`,
          name: 'adjudicate_conflict',
          arguments: { claimA: pair[0], claimB: pair[1] },
        },
      ],
      stopReason: 'toolUse',
    },
    {
      content: [{ type: 'toolCall', id: `tc${++seq}`, name: 'finish', arguments: {} }],
      stopReason: 'toolUse',
    },
    { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
  ]
}

const ROLE = 'agent:arbiter'

describe('S25 · L1 Arbiter golden (CI redline, domain-agnostic) — A.9 adjudication-order consistency', () => {
  it('runs the real Arbiter over labeled conflict pairs: deterministic ladder picks the labeled winner, order-independent', async () => {
    const report = await runArbiterGolden({
      resetDb: async () => {
        await pool.query(
          'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events CASCADE',
        )
      },
      seedConflict,
      arbitrateWith: (pair) =>
        arbitrateConflicts(
          { db, runtime: makeHarnessPiRuntime(createFakeModel(scriptFor(pair))) },
          [pair],
        ),
      resolvedWinner: async () => {
        const resolved = await getResolvedConflicts(db)
        if (resolved.length === 0) return null
        const p = resolved[0]!.payload
        return p.winnerId != null ? { winnerId: p.winnerId, rung: p.rung } : null
      },
      escalation: async () => {
        const queue = await getEditorConflictQueue(db)
        return queue.length > 0 ? { rung: queue[0]!.payload.rung } : null
      },
    })

    expect(report.total).toBeGreaterThanOrEqual(5) // 每个机判阶 ≥1 对 + 压制对 + 并列升级对
    // A.9 红线：裁决正确率 = 1（胜方 + rung 对齐人工标签）+ 顺序一致率 = 1（入参/loop 顺序无关）。
    expect(report.accuracy, JSON.stringify(report.observations)).toBe(1)
    expect(report.orderConsistency, JSON.stringify(report.observations)).toBe(1)
  })

  it('every resolved adjudication is recorded under the Arbiter role (judge≠athlete; status untouched)', async () => {
    // 单独跑一对 recency winner，校验落库的采信标记 by_role + 红线#2「Arbiter 不动 status」。
    await pool.query(
      'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events CASCADE',
    )
    const item = ARBITER_GOLDEN.find((g) => g.id === 'arbiter-recency')!
    const { aId, bId } = await seedConflict(item)
    await arbitrateConflicts(
      { db, runtime: makeHarnessPiRuntime(createFakeModel(scriptFor([aId, bId]))) },
      [[aId, bId]],
    )
    const resolved = await getResolvedConflicts(db)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.payload.byRole).toBe(ROLE)
    expect(resolved[0]!.payload.winnerId).toBe(aId) // newer wins at recency
    // 红线#2：Arbiter 标信任、绝不放松/改 status —— 双方仍 active。
    const rows = await db
      .select({ id: schema.claim.id, status: schema.claim.status })
      .from(schema.claim)
    for (const r of rows) expect(r.status).toBe('active')
  })
})
