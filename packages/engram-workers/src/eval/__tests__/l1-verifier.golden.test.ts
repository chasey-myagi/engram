/**
 * L1 Verifier golden CI 红线（A.9）—— 端到端跑 Verifier 对 ~50 条各状态 golden，断言 flag/quarantine 决策的
 * precision / recall 双 ≥ 阈，且整体决策准确率 = 1。非 smoke：注入 faithful 的 goldenEntailmentOracle（从 claim
 * 文本 + 出处原文**实算** entailment，不硬编码 verdict），驱动真 runVerifier（真 transitionClaim 蓝边收紧 / 真
 * 时效巡查 / 真 patrol 写入）。Verifier 漏检幻觉 → recall 跌；误伤 sound/draft → precision 跌 —— 都把分拉下阈 → 红。
 *
 * 隔离 / 领域无关：claim 临时 seed、随 DROP 消失、不进生产写路径、recall 永不召回；全通用事实，不 import bidding golden。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  makeFakeEmbedder,
  schema,
  type DB,
  type EntailmentJudge,
} from '@engram/core'

import { runVerifier } from '../../verifier.js'
import { VERIFIER_GOLDEN, type VerifierGoldenItem } from '../l1-verifier.golden.js'
import { runVerifierGolden } from '../l1-verifier.runner.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const MS_PER_DAY = 86_400_000
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
// 起步基线权重（与 A.3 一致；draft 晋升要 conf≥0.5，故 sound-draft 用足够高的因子清门）。
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
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

/**
 * seed 一条 golden claim：structured_spec 源（半衰期 730d，含 evidence 原文），asOf=now-ageDays（驱动真时效巡查），
 * 一条 exact 出处。draft 用 HIGH 因子（authority/indepSupport/entailment 0.5）以便 patrol pass 时晋升清 conf≥0.5 门。
 */
async function seedClaim(item: VerifierGoldenItem): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: item.evidence,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  const claimId = randomUUID()
  const isDraft = item.status === 'draft'
  const factors = {
    authority: isDraft ? 1 : 0.9,
    humanReview: 0,
    entailment: 0.5,
    indepSupport: isDraft ? 0.75 : 0,
    usageCorrect: 0,
    ageDays: 0,
    activeContradicts: 0,
    staleDecay: 1,
    conflictDecay: 1,
  }
  const ageDays = item.ageDays ?? 0
  await db.insert(schema.claim).values({
    id: claimId,
    claimText: item.claimText,
    subject: item.subject,
    predicate: item.predicate,
    object: item.object,
    status: item.status,
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: { factors, weights: WEIGHTS, calibrationVersion: 'identity' },
    lineageId: randomUUID(),
    asOf: new Date(Date.now() - ageDays * MS_PER_DAY),
    createdBy: 'agent:distiller',
    embedding: null,
    embeddingVersion: null,
  })
  await db
    .insert(schema.claimProvenance)
    .values({ id: randomUUID(), claimId, sourceId, locator: 'L1', relevance: 'exact' })
  return claimId
}

async function statusOf(claimId: string): Promise<string> {
  const [row] = await db
    .select({ s: schema.claim.status })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  return row!.s
}

const PRECISION_FLOOR = 0.9
const RECALL_FLOOR = 0.9

describe('S25 · L1 Verifier golden (CI redline, domain-agnostic) — A.9 flag/quarantine P/R vs human entailment truth', () => {
  it('runs the real Verifier over ~50 staged claims and matches human flag/keep labels at P/R ≥ threshold', async () => {
    const report = await runVerifierGolden({
      resetDb: async () => {
        await pool.query(
          'TRUNCATE source, claim, claim_provenance, relation, claim_verification CASCADE',
        )
      },
      seedClaim,
      statusOf,
      runVerifierWith: (judge: EntailmentJudge) => runVerifier({ db, judge }, { maxClaims: 1000 }),
    })

    expect(report.total).toBeGreaterThanOrEqual(50) // A.9「~50 条各状态 claim」
    // 每条 claim 点状一次 oracle（被巡查的都调一次；自产出会跳过，但本 golden 全是 distiller 产出 → 全巡）。
    expect(report.judgeCalls).toBe(report.total)
    // A.9 红线：flag 决策 P/R 双 ≥ 阈；faithful oracle + 真收紧逻辑下应满分对齐人工标签。
    expect(report.precision, `precision below floor: ${report.precision}`).toBeGreaterThanOrEqual(
      PRECISION_FLOOR,
    )
    expect(report.recall, `recall below floor: ${report.recall}`).toBeGreaterThanOrEqual(
      RECALL_FLOOR,
    )
    expect(report.accuracy).toBe(1) // 所有决策（flag + keep）都对齐人工标签
    // 既有真阳也有真阴（防退化成「全 flag」刷满 recall 或「全 keep」刷满 precision）。
    expect(report.tp).toBeGreaterThan(0)
    expect(report.tn).toBeGreaterThan(0)
  })

  it('regression guard: a Verifier that never tightens (no patrol effect) collapses recall below the redline', async () => {
    // 注入「永远 pass」的 oracle 模拟 Verifier 漏检全部幻觉/投毒 —— 该 flag 的都没收紧 → recall 崩 → 红线变红。
    // （时效 stale 仍会 flag，故 recall 不为 0，但远低于阈，足以证明回归会被抓。）
    const passOracle: EntailmentJudge = {
      version: 'fake:always-pass',
      judge: () => Promise.resolve('pass'),
    }
    const report = await runVerifierGolden(
      {
        resetDb: async () => {
          await pool.query(
            'TRUNCATE source, claim, claim_provenance, relation, claim_verification CASCADE',
          )
        },
        seedClaim,
        statusOf,
        runVerifierWith: () => runVerifier({ db, judge: passOracle }, { maxClaims: 1000 }),
      },
      VERIFIER_GOLDEN,
    )
    expect(report.recall).toBeLessThan(RECALL_FLOOR) // 漏检幻觉/投毒 → 召回崩
  })
})
