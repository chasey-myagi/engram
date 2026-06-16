import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  recallClaims,
  schema,
  trustedHumanActor,
  updateSourceMetadata,
  type DB,
  makeFakeEmbedder,
  type RecallResult,
} from '@engram/core'

import { OFFICIAL_DATASHEET, biddingAdapter, biddingTighten } from './index.js'

// ---- pure unit tests (no DB, no schema) ----
//
// EGR-CR-043 边界单元（T2）：business identity 由 recall result 的受控 `sourceMeta` 提供，
// adapter 仅凭 recall result 即可完成 source_type 收紧——本块不 import schema、不连 DB。

function makeResult(
  id: string,
  value: number,
  sourceId: string,
  sourceMeta: Record<string, unknown> = {},
): RecallResult {
  return {
    claim: {
      id,
      claimText: `claim ${id}`,
      subject: null,
      predicate: null,
      object: null,
      status: 'active',
      lineageId: `lin-${id}`,
      asOf: new Date('2025-01-01T00:00:00Z'),
    },
    confidence: {
      value,
      raw: value,
      factors: {
        authority: 0.5,
        humanReview: 0,
        entailment: 0.5,
        indepSupport: 0,
        usageCorrect: 0,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: {
        authority: 0.3,
        humanReview: 0.3,
        entailment: 0.15,
        indepSupport: 0.15,
        usageCorrect: 0.1,
      },
      calibrationVersion: 'identity',
      takenAt: new Date('2025-01-01T00:00:00Z'),
    },
    provenances: [{ sourceId, locator: 'p1', relevance: 'exact', sourceMeta }],
    mustVerify: value < 0.6,
    contradicts: [],
    embeddingVersion: null,
  }
}

describe('biddingAdapter — meta-driven tightening via recall-result sourceMeta (pure, no DB/schema)', () => {
  it('official_datasheet keeps conf (factor 1); other source_type is discounted; both ≤ gConf', () => {
    const out = biddingAdapter({ discount: 0.5 })([
      makeResult('o', 0.9, 's-off', { source_type: OFFICIAL_DATASHEET }),
      makeResult('f', 0.9, 's-forum', { source_type: 'community_forum' }),
      makeResult('u', 0.9, 's-unknown', {}), // no source_type → discounted like non-official
    ])
    expect(out[0]!.confidence.value).toBeCloseTo(0.9) // official → unchanged
    expect(out[1]!.confidence.value).toBeCloseTo(0.45) // forum → discounted
    expect(out[2]!.confidence.value).toBeCloseTo(0.45) // unknown type → discounted like non-official
  })

  it('recomputes mustVerify when the discount drops conf below the kernel trust bar', () => {
    const out = biddingAdapter({ discount: 0.5 })([
      makeResult('f', 0.9, 's-forum', { source_type: 'community_forum' }),
    ])
    expect(out[0]!.confidence.value).toBeCloseTo(0.45)
    expect(out[0]!.mustVerify).toBe(true) // 0.45 < 0.6
  })

  it('biddingTighten composes with the kernel applyAdapter operator — a legitimate tightening passes the invariant (no db arg)', () => {
    const kernel = [
      makeResult('o', 0.9, 's-off', { source_type: OFFICIAL_DATASHEET }),
      makeResult('f', 0.8, 's-forum', { source_type: 'community_forum' }),
    ]
    const out = biddingTighten(kernel) // EGR-CR-043: new signature takes only recall result
    expect(out).toHaveLength(2)
    expect(out[0]!.confidence.value).toBeCloseTo(0.9)
    expect(out[1]!.confidence.value).toBeCloseTo(0.64) // 0.8 * 0.8 default discount, ≤ gConf
  })

  it('a discount > 1 raises conf above kernel g — the kernel applyAdapter backstop throws (adapter cannot self-relax)', () => {
    const kernel = [makeResult('f', 0.8, 's-forum', { source_type: 'community_forum' })]
    expect(() => biddingTighten(kernel, { discount: 1.5 })).toThrow(/adapter relaxed/i)
  })

  it('drops results whose discounted conf falls below the kernel consume-floor 0.4 — never leaks the do-not-consume band', () => {
    const out = biddingAdapter({ discount: 0.8 })([
      makeResult('f', 0.45, 's-forum', { source_type: 'community_forum' }),
    ]) // 0.45*0.8=0.36 < 0.4
    expect(out).toEqual([])
  })

  it('a result with no provenances is treated as non-official (discounted)', () => {
    const bare = { ...makeResult('np', 0.9, 's-x'), provenances: [] }
    const out = biddingAdapter({ discount: 0.5 })([bare])
    expect(out[0]!.confidence.value).toBeCloseTo(0.45)
  })

  it('best-source-wins: a claim backed by BOTH an official and a non-official source is held at g (factor 1), regardless of provenance order', () => {
    const mixed = (provs: RecallResult['provenances']): RecallResult => ({
      ...makeResult('m', 0.9, 's-off', { source_type: OFFICIAL_DATASHEET }),
      provenances: provs,
    })
    const provsA: RecallResult['provenances'] = [
      {
        sourceId: 's-off',
        locator: 'l1',
        relevance: 'exact',
        sourceMeta: { source_type: OFFICIAL_DATASHEET },
      },
      {
        sourceId: 's-forum',
        locator: 'l2',
        relevance: 'supporting',
        sourceMeta: { source_type: 'community_forum' },
      },
    ]
    const adapt = biddingAdapter({ discount: 0.5 })
    expect(adapt([mixed(provsA)])[0]!.confidence.value).toBeCloseTo(0.9) // one official ⇒ held at g
    expect(adapt([mixed([...provsA].reverse())])[0]!.confidence.value).toBeCloseTo(0.9) // order-independent
  })

  it('an official claim above 0.6 keeps mustVerify=false (conf unchanged, not over-flagged)', () => {
    const out = biddingAdapter()([
      makeResult('o', 0.9, 's-off', { source_type: OFFICIAL_DATASHEET }),
    ])
    expect(out[0]!.confidence.value).toBeCloseTo(0.9)
    expect(out[0]!.mustVerify).toBe(false)
  })

  it('discount 0 zeroes non-official conf → dropped below the consume-floor', () => {
    expect(
      biddingAdapter({ discount: 0 })([
        makeResult('f', 0.9, 's-forum', { source_type: 'community_forum' }),
      ]),
    ).toEqual([])
  })
})

// ---- DB integration: recall carries controlled sourceMeta, tighten through the SPI (no schema-coupled bypass) ----
//
// EGR-CR-043 T4：旧的 readSourceTypes/schema.source 直查断言已随生产代码删除；e2e 改走新缝——
// seed 用 SPI addSource（注入 meta.source_type）+ 直落 active claim，断言只读 recall result / biddingTighten 返回值。

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'engram-core',
  'drizzle',
)
const embedder = makeFakeEmbedder()

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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, page_claims CASCADE',
  )
})

// 直落一条已知 raw 的 active claim + 出处（seed 路径，非断言）。recall(S7) 用活动权重重算 value，
// 5 因子全置 raw、衰减置 1 ⇒ recalled value == raw。
async function seedActiveClaim(text: string, sourceId: string, raw = 0.9): Promise<string> {
  const id = randomUUID()
  await db.insert(schema.claim).values({
    id,
    claimText: text,
    status: 'active',
    confidence: raw,
    confidenceRaw: raw,
    confidenceFactors: {
      factors: {
        authority: raw,
        humanReview: raw,
        entailment: raw,
        indepSupport: raw,
        usageCorrect: raw,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: {
        authority: 0.3,
        humanReview: 0.3,
        entailment: 0.15,
        indepSupport: 0.15,
        usageCorrect: 0.1,
      },
      calibrationVersion: 'identity',
    },
    embedding: await embedder.embed(text),
    embeddingVersion: embedder.version,
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
  })
  await db
    .insert(schema.claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

describe('bidding-adapter DB integration — business identity via recall-result sourceMeta (adapter → SPI, no reverse dep)', () => {
  it('end-to-end: recall → biddingTighten holds an official_datasheet-backed claim at g, discounts a forum-backed one, all ≤ kernel g (no db arg, no schema query)', async () => {
    const off = await addSource(db, {
      content: 'datasheet',
      kind: 'formal_document',
      meta: { source_type: OFFICIAL_DATASHEET },
    })
    const forum = await addSource(db, {
      content: 'thread',
      kind: 'conversation_log',
      meta: { source_type: 'community_forum' },
    })
    const idOff = await seedActiveClaim('bidding spec official', off.sourceId, 0.9)
    const idForum = await seedActiveClaim('bidding spec forum', forum.sourceId, 0.9)

    const kernel = await recallClaims(db, embedder, 'bidding spec')
    const gConf = new Map(kernel.map((r) => [r.claim.id, r.confidence.value]))
    expect(gConf.get(idOff)).toBeCloseTo(0.9)
    expect(gConf.get(idForum)).toBeCloseTo(0.9)

    // recall result 已带受控 metadata 缝——adapter 据此收紧，无需任何 schema/db 旁路。
    const byClaimKernel = new Map(kernel.map((r) => [r.claim.id, r]))
    expect(byClaimKernel.get(idOff)!.provenances[0]!.sourceMeta.source_type).toBe(
      OFFICIAL_DATASHEET,
    )
    expect(byClaimKernel.get(idForum)!.provenances[0]!.sourceMeta.source_type).toBe(
      'community_forum',
    )

    const tightened = biddingTighten(kernel) // EGR-CR-043: 只吃 recall result
    const byId = new Map(tightened.map((r) => [r.claim.id, r]))
    expect(byId.get(idOff)!.confidence.value).toBeCloseTo(0.9) // official: held at kernel g
    expect(byId.get(idForum)!.confidence.value).toBeCloseTo(0.72) // forum: 0.9 * 0.8 discount
    for (const r of tightened) {
      expect(r.confidence.value).toBeLessThanOrEqual(gConf.get(r.claim.id)! + 1e-9) // tightening upheld
    }
  })

  // EGR-CR-011 (T3) 端到端业务影响：一条 claim 的唯一出处是「本应官方、但首写为裸 source（缺 source_type）」，
  //   其 g-conf 落在 [0.4, 0.5)（0.8 折后跌破 floor 0.4 被丢弃）。富集前该 claim 在 biddingTighten 结果里消失（复现危害）；
  //   经 updateSourceMetadata 补上 official_datasheet 后，再跑 biddingTighten 该 claim 回到结果集、且 conf 不打折（factor=1）。
  it('a bare source locks the wrong identity and drops the claim; enrichment via updateSourceMetadata restores it to recall', async () => {
    // 首写为裸 source：无 source_type（official 业务身份缺失）。
    const bare = await addSource(db, {
      content: 'official datasheet, bare ingest',
      kind: 'formal_document',
    })
    expect(bare.metadataConflict).toBe(false) // 新建，无冲突
    const RAW = 0.45 // ∈ [0.4, 0.5)：official(factor 1) → 0.45 留；非官方(0.8 折) → 0.36 < 0.4 floor → 丢。
    const claimId = await seedActiveClaim('bidding spec near floor', bare.sourceId, RAW)

    // 富集前：recall 带回的 sourceMeta 无 source_type → adapter 当非官方 0.8 折 → 0.36 < 0.4 → 被 filter 丢弃。
    const kernelBefore = await recallClaims(db, embedder, 'bidding spec')
    expect(
      new Map(kernelBefore.map((r) => [r.claim.id, r.confidence.value])).get(claimId),
    ).toBeCloseTo(RAW)
    const tightenedBefore = biddingTighten(kernelBefore)
    expect(tightenedBefore.some((r) => r.claim.id === claimId)).toBe(false) // 危害复现：claim 在召回里消失

    // 富集：人显式补上 official_datasheet（updateSourceMetadata 写 live source.meta + 审计）。
    await updateSourceMetadata(db, {
      sourceId: bare.sourceId,
      meta: { source_type: OFFICIAL_DATASHEET },
      actor: trustedHumanActor('human:ops'),
      reason: 'enrich bare official source',
    })

    // 富集后：recall 此刻带回 source_type=official → adapter 不打折(factor 1) → 0.45 ≥ 0.4 → claim 回到结果集。
    const kernelAfter = await recallClaims(db, embedder, 'bidding spec')
    const tightenedAfter = biddingTighten(kernelAfter)
    const restored = tightenedAfter.find((r) => r.claim.id === claimId)
    expect(restored).toBeDefined() // claim 恢复
    expect(restored!.confidence.value).toBeCloseTo(RAW) // official 不打折 → 等于原 g-conf
  })
})
