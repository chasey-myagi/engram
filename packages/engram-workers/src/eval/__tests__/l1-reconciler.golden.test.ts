/**
 * L1 Reconciler golden CI 红线（A.9）—— 端到端跑 Reconciler 对分层 L1a/L1b/L1c pair + 独立印证完整性 golden，
 * 断言每层裁决准确率 = 1 + 独立印证审计准确率 = 1。非 smoke：注入 faithful ≥-bound oracle（实算 A⊢B，钉死
 * refines/poison 方向），驱动真 reconcileBatch（真 findAnchors 召回 / 真 reconcilePair / 真蓝边收紧 / 真 escalation 写入）。
 * Reconciler 把投毒当 refines、漏记 escalation、漏 flag、或把 A/B 判反 → 本层准确率 <1 → 红。
 *
 * 隔离 / 领域无关：fixture 临时 seed、随 DROP 消失、不进生产写路径、recall 永不召回；通用电池/容量事实，不 import bidding golden。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  getReconcileEscalations,
  makeFakeEmbedder,
  schema,
  type DB,
  type EntailmentJudge,
} from '@engram/core'

import { reconcileBatch, runReconciler } from '../../reconciler.js'
import {
  RECONCILER_PAIR_GOLDEN,
  type IndepGoldenItem,
  type ReconcilerPairItem,
} from '../l1-reconciler.golden.js'
import { runReconcilerGolden } from '../l1-reconciler.runner.js'

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

/** seed 一条 claim（真 fake-embedder embedding + 一条 exact 出处），精确 subject/object/status。 */
async function mkClaim(opts: {
  claimText: string
  subject: string
  predicate: string
  object: string
  status: schema.ClaimStatus
}): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: `src for ${opts.claimText}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  const claimId = randomUUID()
  await db.insert(schema.claim).values({
    id: claimId,
    claimText: opts.claimText,
    subject: opts.subject,
    predicate: opts.predicate,
    object: opts.object,
    status: opts.status,
    confidence: 0.6,
    confidenceRaw: 0.6,
    confidenceFactors: { factors: {}, weights: WEIGHTS, calibrationVersion: 'identity' },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'agent:distiller',
    embedding: await embedder.embed(opts.claimText),
    embeddingVersion: embedder.version,
  })
  await db
    .insert(schema.claimProvenance)
    .values({ id: randomUUID(), claimId, sourceId, locator: 'L1', relevance: 'exact' })
  return claimId
}

/** seed 一对 (anchor B 既有, candidate A 本批)：同 subject、embedding 近（findAnchors 召回 A 时命中 B）。 */
async function seedPair(item: ReconcilerPairItem) {
  const anchorId = await mkClaim({
    claimText: item.anchorText,
    subject: item.subject,
    predicate: item.predicate,
    object: item.anchorObject,
    status: 'active', // 既有锚恒 active
  })
  const candidateId = await mkClaim({
    claimText: item.candidateText,
    subject: item.subject,
    predicate: item.predicate,
    object: item.candidateObject,
    status: item.candidateStatus ?? 'active',
  })
  return { anchorId, candidateId }
}

/** seed 一条带额外 supports 源的独立印证 golden claim，返回 claimId。 */
async function seedIndep(item: IndepGoldenItem): Promise<string> {
  const claimId = await mkClaim({
    claimText: item.claimText,
    subject: item.subject,
    predicate: item.predicate,
    object: item.object,
    status: 'active',
  })
  for (const ex of item.extraSources) {
    const extra = await addSource(db, {
      content: `extra for ${item.claimText} ${randomUUID()}`,
      contentHash: ex.contentHash ?? randomUUID(),
      kind: ex.kind ?? 'formal_document',
      authorityScore: 0.7,
      ...(ex.derivedFromSourceId != null ? { derivedFromSourceId: ex.derivedFromSourceId } : {}),
    })
    await db.insert(schema.claimProvenance).values({
      id: randomUUID(),
      claimId,
      sourceId: extra.sourceId,
      locator: 'L2',
      relevance: 'supporting',
    })
  }
  return claimId
}

async function statusOf(claimId: string): Promise<string> {
  const [row] = await db
    .select({ s: schema.claim.status })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  return row!.s
}

async function escalationsOf(claimId: string): Promise<{ conflictsWith: string | null }[]> {
  const esc = await getReconcileEscalations(db, claimId)
  return esc.map((e) => ({ conflictsWith: e.conflictsWith }))
}

async function refinesTargetsOf(claimId: string): Promise<string[]> {
  const rows = await db
    .select({ to: schema.relation.toClaim })
    .from(schema.relation)
    .where(and(eq(schema.relation.type, 'refines'), eq(schema.relation.fromClaim, claimId)))
  return rows.map((r) => r.to).filter((t): t is string => t != null)
}

function deps() {
  return {
    resetDb: async () => {
      await pool.query(
        'TRUNCATE source, claim, claim_provenance, relation, claim_verification CASCADE',
      )
    },
    seedPair,
    seedIndep,
    reconcileWith: (judge: EntailmentJudge, candidateIds: string[]) =>
      reconcileBatch({ db, judge }, candidateIds),
    runReconcilerWith: (judge: EntailmentJudge, claimIds: string[]) =>
      runReconciler({ db, judge }, { claimIds }),
    statusOf,
    escalationsOf,
    refinesTargetsOf,
  }
}

describe('S25 · L1 Reconciler golden (CI redline, domain-agnostic) — A.9 L1a/L1b/L1c + independent-integrity', () => {
  it('runs the real Reconciler over the tiered pair golden + indep golden and gets every tier + the audit exactly right', async () => {
    const report = await runReconcilerGolden(deps())

    // 分层覆盖（A.9 L1a same / L1b refines / L1c poison）+ 独立印证两类。
    expect(report.pairTotal).toBeGreaterThanOrEqual(8)
    expect(report.indepTotal).toBeGreaterThanOrEqual(2)
    // A.9 红线：每层裁决全对 + 独立印证审计全对（faithful ≥-bound oracle 钉死方向 ⇒ 满分）。
    expect(report.pairAccuracy, JSON.stringify(report.pairObservations)).toBe(1)
    expect(report.indepAccuracy, JSON.stringify(report.indepObservations)).toBe(1)
  })

  it('regression guard: a Reconciler whose A/B judge direction is inverted turns refines↔poison and fails the redline', async () => {
    // 注入「方向反了」的 oracle（pass⟺ A 的下界 ≤ B，即把更宽的 A 误判为精炼）—— L1b/L1c 的 refines/poison 全互换，
    // pairAccuracy 必然掉到 <1，证明本红线真会因 Reconciler 判反方向而变红。
    const invertedOracle: EntailmentJudge = {
      version: 'fake:inverted-bound',
      judge: (q) => {
        const lb = (s: string): number => {
          const m = s.match(/(\d+(?:\.\d+)?)/)
          return m ? parseFloat(m[1]!) : NaN
        }
        const claimB = lb(q.claimText)
        const evidA = lb(q.evidence[0]?.sourceContent ?? '')
        if (Number.isNaN(claimB) || Number.isNaN(evidA)) return Promise.resolve('fail')
        // 正确方向应是 evidA >= claimB → pass；这里故意反向 evidA <= claimB → pass。
        return Promise.resolve(evidA <= claimB ? 'pass' : 'fail')
      },
    }
    const d = deps()
    let pairCorrect = 0
    for (const item of RECONCILER_PAIR_GOLDEN) {
      await d.resetDb()
      const { anchorId, candidateId } = await d.seedPair(item)
      await d.reconcileWith(invertedOracle, [candidateId])
      const status = await d.statusOf(candidateId)
      const flagged = status === 'flagged'
      const esc = await d.escalationsOf(candidateId)
      const escalated = esc.some((e) => e.conflictsWith === anchorId)
      const refines = (await d.refinesTargetsOf(candidateId)).includes(anchorId)
      if (
        flagged === item.expectFlagged &&
        escalated === item.expectEscalated &&
        refines === item.expectRefines
      )
        pairCorrect += 1
    }
    expect(pairCorrect).toBeLessThan(RECONCILER_PAIR_GOLDEN.length) // 方向反 → 至少一层裁错 → 不再满分
  })
})
