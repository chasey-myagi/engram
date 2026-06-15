import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  createDb,
  getRefusedRulings,
  makeFakeEmbedder,
  makeFakeEntailmentJudge,
  recallClaims,
  schema,
  type DB,
  type EntailmentJudge,
  type EntailmentQuery,
  type EntailmentVerdict,
} from '@engram/core'

import { runVerifier, verifyEnqueued } from '../verifier.js'

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
const MS_PER_DAY = 86_400_000
const VERIFIER_ROLE = 'agent:verifier'
// 内核未导出 DEFAULT_WEIGHTS/CALIBRATION_IDENTITY；测试内联起步基线（与 A.3 一致）。
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

beforeEach(async () => {
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events CASCADE',
  )
})

/** 一个一律按 verdict 判定、抛错可控、记调用次数的 fake EntailmentJudge。 */
function judgeOf(verdict: EntailmentVerdict | 'throw') {
  if (verdict === 'throw') {
    let calls = 0
    const j: EntailmentJudge & { callCount: () => number } = {
      version: 'fake:throw',
      async judge(_q: EntailmentQuery): Promise<EntailmentVerdict> {
        calls += 1
        throw new Error('entailment judge boom')
      },
      callCount: () => calls,
    }
    return j
  }
  return makeFakeEntailmentJudge({ verdictOf: () => verdict })
}

type Factors = {
  authority: number
  humanReview: number
  entailment: number
  indepSupport: number
  usageCorrect: number
  ageDays: number
  activeContradicts: number
  staleDecay: number
  conflictDecay: number
}

/** 直接 seed source + claim(+exact 出处)，精确控制 status / createdBy / asOf / 因子 / 是否可召回。 */
async function mkClaim(opts: {
  status: schema.ClaimStatus
  createdBy?: string
  claimText?: string
  asOf?: Date
  authorityScore?: number
  factors?: Partial<Factors>
  recallable?: boolean
  /** 出处相关度档（默认 exact，保持既有用例语义不变）。S21 用 supporting/tangential 喂弱反向证据。 */
  relevance?: schema.ProvRelevance
}): Promise<{ claimId: string; sourceId: string }> {
  const claimText = opts.claimText ?? `claim-${randomUUID()}`
  const { sourceId } = await addSource(db, {
    content: `src for ${claimText}`,
    contentHash: randomUUID(),
    kind: 'structured_spec', // half-life 730d
    authorityScore: opts.authorityScore ?? 0.9,
  })
  const factors: Factors = {
    authority: opts.authorityScore ?? 0.9,
    humanReview: 0,
    entailment: 0.5,
    indepSupport: 0,
    usageCorrect: 0,
    ageDays: 0,
    activeContradicts: 0,
    staleDecay: 1,
    conflictDecay: 1,
    ...opts.factors,
  }
  const claimId = randomUUID()
  const recallable = opts.recallable ?? false
  await db.insert(schema.claim).values({
    id: claimId,
    claimText,
    status: opts.status,
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: { factors, weights: WEIGHTS, calibrationVersion: 'identity' },
    lineageId: randomUUID(),
    asOf: opts.asOf ?? new Date(),
    createdBy: opts.createdBy ?? 'agent:distiller',
    embedding: recallable ? await embedder.embed(claimText) : null,
    embeddingVersion: recallable ? embedder.version : null,
  })
  await db.insert(schema.claimProvenance).values({
    id: randomUUID(),
    claimId,
    sourceId,
    locator: 'L1',
    relevance: opts.relevance ?? 'exact',
  })
  return { claimId, sourceId }
}

async function statusOf(claimId: string): Promise<schema.ClaimStatus> {
  const [row] = await db
    .select({ s: schema.claim.status })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  return row!.s
}
async function patrolRows(claimId: string) {
  return db
    .select()
    .from(schema.claimVerification)
    .where(
      and(
        eq(schema.claimVerification.kind, 'patrol'),
        eq(schema.claimVerification.claimId, claimId),
      ),
    )
}

/**
 * 把 db 包成「事务内首个 .update() 抛错」的代理（照搬 core editor-actions.test.ts 的故障注入式样）：
 * 模拟「patrol 裁决已写入、随后状态翻转那一步 DB 故障」。其余方法（select/insert、事务外 getActiveStandards）
 * 原样透传（绑定到真实 db/tx，避免 this 丢失）。用于证明 Verifier 巡查的写 patrol + 翻状态是单事务原子。
 */
function dbThatThrowsOnUpdate(realDb: DB): DB {
  const wrapTx = (tx: object): object =>
    new Proxy(tx, {
      get(t, p, r) {
        if (p === 'update') {
          return () => {
            throw new Error('injected: DB fault during status update')
          }
        }
        const v = Reflect.get(t, p, r)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          (target as DB).transaction((tx) => fn(wrapTx(tx as object)), ...(rest as []))
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as DB
}

describe('S17 Verifier worker (D3 patrol: 函数/统计 + 点状一次 LLM) — A.4/A.6/A.7', () => {
  it('hallucination: an unentailed active claim moves active→flagged with a {entailment:fail} patrol (by_role=verifier), and drops out of recall; exactly one LLM call', async () => {
    const { claimId } = await mkClaim({
      status: 'active',
      recallable: true,
      claimText: 'sku-h spec 7',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    const res = await runVerifier({ db, judge })

    expect(res.patrolled).toBe(1)
    expect(res.transitions).toBe(1)
    expect(await statusOf(claimId)).toBe('flagged') // active→flagged (blue tighten)
    expect(judge.callCount()).toBe(1) // 点状一次 LLM/claim

    const rows = await patrolRows(claimId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.byRole).toBe(VERIFIER_ROLE) // judge≠athlete: verifier role, not the athlete created_by
    expect((rows[0]!.verdict as { entailment: string }).entailment).toBe('fail')

    expect(await recallClaims(db, embedder, 'sku-h spec 7')).toHaveLength(0) // flagged ⇒ not recallable
  })

  it('staleness: a fresh-entailment but past-half-life claim is flagged by the staleness patrol', async () => {
    const old = new Date(Date.now() - 800 * MS_PER_DAY) // > structured_spec half-life (730d)
    const { claimId } = await mkClaim({ status: 'active', asOf: old })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' }) // not a hallucination — only stale
    const res = await runVerifier({ db, judge })

    expect(res.outcomes[0]!.stale).toBe(true)
    expect(await statusOf(claimId)).toBe('flagged')
  })

  it('draft→active: a passing real entailment + live-f2 conf≥0.5 auto-promotes a draft and makes it recallable', async () => {
    // stored base(entail0.5)=0.4875<0.5; with patrol pass live-f2=1 → 0.5625≥0.5 (see transition gate)
    const { claimId } = await mkClaim({
      status: 'draft',
      recallable: true,
      claimText: 'sku-p spec 9',
      factors: { authority: 1, indepSupport: 0.75, entailment: 0.5 },
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
    const res = await runVerifier({ db, judge })

    expect(res.outcomes[0]!.entailment).toBe('pass')
    expect(await statusOf(claimId)).toBe('active') // promoted via real entailment producer (closes S13 stub)
    const hits = await recallClaims(db, embedder, 'sku-p spec 9')
    expect(hits.map((h) => h.claim.id)).toContain(claimId) // recallable after promotion
    expect(hits.find((h) => h.claim.id === claimId)!.confidence.factors.entailment).toBe(1)
  })

  it('judge≠athlete: the Verifier never patrols/endorses a claim it itself authored (skipped, no verdict, status unchanged, LLM never called)', async () => {
    const { claimId } = await mkClaim({ status: 'active', createdBy: VERIFIER_ROLE })
    const judge = judgeOf('throw') // would throw if ever called — proves it isn't
    const res = await runVerifier({ db, judge })

    expect(res.skipped).toBe(1)
    expect(res.patrolled).toBe(0)
    expect(judge.callCount()).toBe(0)
    expect(await patrolRows(claimId)).toHaveLength(0) // no self-written patrol row
    expect(await statusOf(claimId)).toBe('active') // untouched
  })

  it('flagged→quarantined: a still-unsupported flagged claim is tightened further (fail patrol)', async () => {
    const { claimId } = await mkClaim({ status: 'flagged' })
    const res = await runVerifier({
      db,
      judge: makeFakeEntailmentJudge({ verdictOf: () => 'fail' }),
    })
    expect(res.transitions).toBe(1)
    expect(await statusOf(claimId)).toBe('quarantined')
  })

  it('failure degrades safely: a claim whose judge throws is skipped (no crash, no transition, no verdict) and can be retried next round', async () => {
    const { claimId } = await mkClaim({ status: 'active' })
    const judge = judgeOf('throw')
    const res = await runVerifier({ db, judge }) // must not reject
    expect(res.skipped).toBe(1)
    expect(res.patrolled).toBe(0)
    expect(res.transitions).toBe(0)
    expect(judge.callCount()).toBe(1) // it was called and threw
    expect(await patrolRows(claimId)).toHaveLength(0) // nothing written on failure
    expect(await statusOf(claimId)).toBe('active') // unchanged → next cron retries
  })

  it('one point-LLM call per patrolled claim; superseded/quarantined are never patrolled', async () => {
    await mkClaim({ status: 'active', claimText: 'a' })
    await mkClaim({ status: 'draft', claimText: 'b' })
    await mkClaim({ status: 'flagged', claimText: 'c' })
    await mkClaim({ status: 'quarantined', claimText: 'd' }) // 仅人能放松 → 不巡
    await mkClaim({ status: 'superseded', claimText: 'e' }) // 终态 → 不巡
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
    const res = await runVerifier({ db, judge })
    expect(res.patrolled).toBe(3) // only draft/active/flagged
    expect(judge.callCount()).toBe(3) // exactly one call per patrolled claim
  })

  it('enqueue trigger: verifyEnqueued patrols only the given claim ids', async () => {
    const target = await mkClaim({ status: 'active', claimText: 'enq-target' })
    await mkClaim({ status: 'active', claimText: 'other' }) // must be left alone
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    const res = await verifyEnqueued({ db, judge }, [target.claimId])
    expect(res.patrolled).toBe(1)
    expect(judge.callCount()).toBe(1)
    expect(await statusOf(target.claimId)).toBe('flagged')
  })

  it('EGR-CR-037: an EMPTY batch is a no-op — verifyEnqueued([]) does NOT degrade into a full-table cron patrol (no judge call, no transition, no verdict)', async () => {
    // 造若干会被「全库 cron 巡查」命中的 active/draft/flagged claim。judge 用 'fail'：若真巡查会 active→flagged 收紧，便于反证。
    const a = await mkClaim({ status: 'active', claimText: 'empty-batch active' })
    const d = await mkClaim({ status: 'draft', claimText: 'empty-batch draft' })
    const f = await mkClaim({ status: 'flagged', claimText: 'empty-batch flagged' })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })

    // 空 batch：本应 no-op。修前 verifyEnqueued([]) 透传空数组 → selector length>0 判 false → 落 cron 全库巡查 → judge 被调多次、status 被收紧。
    const res = await verifyEnqueued({ db, judge }, [])

    expect(res.patrolled).toBe(0)
    expect(judge.callCount()).toBe(0) // 点状 LLM 一次都没调
    expect(res.transitions).toBe(0)
    expect(res.outcomes).toEqual([])
    // 每条 claim 状态不变（无迁移）、无 patrol 裁决写入。
    expect(await statusOf(a.claimId)).toBe('active')
    expect(await statusOf(d.claimId)).toBe('draft')
    expect(await statusOf(f.claimId)).toBe('flagged')
    expect(await patrolRows(a.claimId)).toHaveLength(0)
    expect(await patrolRows(d.claimId)).toHaveLength(0)
    expect(await patrolRows(f.claimId)).toHaveLength(0)
  })

  // S20 routed follow-up: S17 deferred the conflict signal's peer id (conflictsWith). The Verifier now populates it
  // on a not_co_true verdict, finding the contradicting peer via the contradicts edge — handing the pairwise
  // conflict to the Arbiter (the owner of pairwise resolution).
  it('not_co_true populates the patrol verdict with the contradicting peer id (conflictsWith) — the routed conflict signal for the Arbiter', async () => {
    const target = await mkClaim({ status: 'active', claimText: 'k p A' })
    const peer = await mkClaim({ status: 'active', claimText: 'k p B' })
    await db.insert(schema.relation).values({
      id: randomUUID(),
      fromClaim: target.claimId,
      toClaim: peer.claimId,
      type: 'contradicts',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'not_co_true' })
    // patrol only the target so we assert its verdict precisely (peer would also be patrolled in a full round).
    const res = await verifyEnqueued({ db, judge }, [target.claimId])
    expect(res.patrolled).toBe(1)

    const rows = await patrolRows(target.claimId)
    expect(rows).toHaveLength(1)
    const verdict = rows[0]!.verdict as { entailment: string; conflictsWith?: string }
    expect(verdict.entailment).toBe('not_co_true')
    expect(verdict.conflictsWith).toBe(peer.claimId) // the deferred-from-S17 peer id is now filled
    // not_co_true is also a tighten signal: active→flagged (blue), unchanged red-line behavior.
    expect(await statusOf(target.claimId)).toBe('flagged')
  })

  it('a non-conflict verdict (fail) leaves conflictsWith unset even when a contradicts edge exists (only not_co_true routes the pairwise signal)', async () => {
    const target = await mkClaim({ status: 'active', claimText: 'k p A' })
    const peer = await mkClaim({ status: 'active', claimText: 'k p B' })
    await db.insert(schema.relation).values({
      id: randomUUID(),
      fromClaim: target.claimId,
      toClaim: peer.claimId,
      type: 'contradicts',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    await verifyEnqueued({ db, judge }, [target.claimId])
    const rows = await patrolRows(target.claimId)
    const verdict = rows[0]!.verdict as { entailment: string; conflictsWith?: string }
    expect(verdict.entailment).toBe('fail')
    expect(verdict.conflictsWith).toBeUndefined()
  })

  // S21 · NC-exact 红线（红线#3 / A.6）在 Verifier 路 —— 反向证据落在**矛盾对端 peer**上，绝非目标自身：
  //   not_co_true（与某 peer 不可同真）= 判目标 refuted → 须该 peer 有 ≥1 条 relevance='exact' 反向命题，
  //     否则拒判（收紧不落）+ 强制升级主编（ruling_refused）。找不到对端（无 contradicts 边）同样拒判。
  //   fail（幻觉/缺自身支撑）不是反向命题判负，是缺支撑的可疑 flag → 不过闸门，直接收紧。纯时效同理不过闸门。
  it('NC-exact: a fail (hallucination) ruling is NOT gated — it is an absence-of-support flag, not a counter-assertion; active→flagged proceeds with NO exact reverse evidence and NO escalation', async () => {
    const { claimId } = await mkClaim({ status: 'active', relevance: 'supporting' }) // own tier irrelevant for fail
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' })
    const res = await runVerifier({ db, judge })

    expect(res.patrolled).toBe(1)
    expect(res.transitions).toBe(1) // a hallucination is suspect → blue-edge tighten flags it freely
    expect(res.ncExactRefusals).toBe(0) // NOT a non_compliant/refuted counter-assertion → ungated
    expect(await statusOf(claimId)).toBe('flagged')
    expect(await getRefusedRulings(db)).toHaveLength(0)
  })

  it('NC-exact: a not_co_true ruling whose contradicting PEER carries only SUPPORTING (no exact) reverse evidence is REFUSED + escalated (refuted-kind); target stays active', async () => {
    const target = await mkClaim({ status: 'active', claimText: 'k p A', relevance: 'supporting' })
    // the reverse proposition lives on the PEER — but it is only supporting, so the ruling must be refused.
    const peer = await mkClaim({ status: 'active', claimText: 'k p B', relevance: 'supporting' })
    await db.insert(schema.relation).values({
      id: randomUUID(),
      fromClaim: target.claimId,
      toClaim: peer.claimId,
      type: 'contradicts',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'not_co_true' })
    const res = await verifyEnqueued({ db, judge }, [target.claimId]) // patrol only the target

    expect(res.transitions).toBe(0)
    expect(res.ncExactRefusals).toBe(1)
    expect(await statusOf(target.claimId)).toBe('active') // refused → NOT flagged
    const refused = await getRefusedRulings(db)
    expect(refused).toHaveLength(1)
    expect(refused[0]!.payload.ruledAgainstClaimId).toBe(target.claimId)
    expect(refused[0]!.payload.reverseEvidenceClaimId).toBe(peer.claimId) // the PEER was checked, NEVER self
    expect(refused[0]!.payload.rulingKind).toBe('refuted') // not_co_true → refuted
    expect(refused[0]!.payload.path).toBe('verifier')
    expect(res.outcomes[0]!.ncExactRefused?.eventId).toBe(refused[0]!.eventId)
  })

  // EGR-CR-001 (#82): the recall-side dual of the refused-not_co_true case above. The red line keeps the STATUS
  // (target stays active), but the refused not_co_true patrol row must NOT bleed into f2 on the read side — recall's
  // live-recomputed entailment factor must stay neutral 0.5, never 0. (Before the fix, latestEntailmentFactors reads
  // the refused not_co_true and maps it to f2=0, silently suppressing confidence below the recall floor.)
  //
  // Setup uses the NO-contradicting-peer refusal path (cf. the line-415 case above): not_co_true with no peer is
  // refused (own exact is support, not reverse evidence). No contradicts edge is inserted, so there is NO conflictDecay
  // confound — the only thing that could move the target's value is the (refused) entailment factor. That isolates the
  // finding: with the fix, factors.entailment stays 0.5 and value/recall are untouched; without it, f2=0 drops the
  // target below the 0.4 floor and out of recall entirely.
  it('EGR-CR-001: a refused not_co_true does NOT pollute recall f2 — target stays active AND its entailment factor stays neutral 0.5 (never 0)', async () => {
    // recallable target with its OWN exact support + independent support, so it clears the recall floor at neutral f2.
    const target = await mkClaim({
      status: 'active',
      recallable: true,
      claimText: 'k p A',
      relevance: 'exact',
      factors: { indepSupport: 1 },
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'not_co_true' })

    // baseline: before any patrol, the target is recalled with neutral entailment 0.5.
    const before = await recallClaims(db, embedder, 'k p A')
    const beforeHit = before.find((h) => h.claim.id === target.claimId)
    expect(beforeHit).toBeDefined()
    expect(beforeHit!.confidence.factors.entailment).toBe(0.5)
    const neutralValue = beforeHit!.confidence.value

    const res = await verifyEnqueued({ db, judge }, [target.claimId]) // patrol only the target

    // confirm we really walked the refusal path: no contradicting peer → not_co_true refused (own exact is NOT reverse
    // evidence); red line #2 held the status; escalation fired.
    expect(res.ncExactRefusals).toBe(1)
    expect(res.transitions).toBe(0)
    expect(await statusOf(target.claimId)).toBe('active')
    expect(await getRefusedRulings(db)).toHaveLength(1)

    // the finding: recall's live f2 must be neutral 0.5, NOT 0 — the refused not_co_true is non-scoring.
    const after = await recallClaims(db, embedder, 'k p A')
    const afterHit = after.find((h) => h.claim.id === target.claimId)
    expect(afterHit).toBeDefined() // still recalled (would drop out at f2=0)
    expect(afterHit!.confidence.factors.entailment).toBe(0.5)
    expect(afterHit!.confidence.value).toBe(neutralValue) // value unchanged — never suppressed
  })

  it('NC-exact: a not_co_true ruling whose contradicting PEER carries an EXACT reverse proposition PROCEEDS — active→flagged, no escalation', async () => {
    // Discriminator: the TARGET has only supporting provenance; the EXACT lives on the peer. Under the old
    // (inverted) gate this would refuse (target has no own-exact); under the fix it proceeds.
    const target = await mkClaim({ status: 'active', claimText: 'k p A', relevance: 'supporting' })
    const peer = await mkClaim({ status: 'active', claimText: 'k p B', relevance: 'exact' })
    await db.insert(schema.relation).values({
      id: randomUUID(),
      fromClaim: target.claimId,
      toClaim: peer.claimId,
      type: 'contradicts',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'not_co_true' })
    const res = await verifyEnqueued({ db, judge }, [target.claimId])

    expect(res.transitions).toBe(1)
    expect(res.ncExactRefusals).toBe(0)
    expect(await statusOf(target.claimId)).toBe('flagged') // peer's exact reverse evidence → ruling proceeds
    expect(await getRefusedRulings(db)).toHaveLength(0)
  })

  it('NC-exact: a not_co_true ruling with NO identifiable contradicting peer (no contradicts edge) is REFUSED — the claim has its OWN exact support, yet that is not reverse evidence; it escalates instead of tightening', async () => {
    // The sharpest anti-inversion test: own exact support must NOT let the claim be ruled refuted.
    const { claimId } = await mkClaim({ status: 'active', relevance: 'exact' })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'not_co_true' })
    const res = await runVerifier({ db, judge })

    expect(res.transitions).toBe(0)
    expect(res.ncExactRefusals).toBe(1)
    expect(await statusOf(claimId)).toBe('active') // own exact does NOT enable negation
    const refused = await getRefusedRulings(db)
    expect(refused).toHaveLength(1)
    expect(refused[0]!.payload.reverseEvidenceClaimId).toBeNull() // no peer identified
    expect(refused[0]!.payload.rulingKind).toBe('refuted')
  })

  it('NC-exact: a flagged claim ruled not_co_true is NOT tightened to quarantined when its peer lacks exact (refused) — agents only tighten WITH exact reverse evidence', async () => {
    const target = await mkClaim({ status: 'flagged', claimText: 'k p A', relevance: 'exact' })
    const peer = await mkClaim({ status: 'active', claimText: 'k p B', relevance: 'supporting' }) // peer only supporting
    await db.insert(schema.relation).values({
      id: randomUUID(),
      fromClaim: target.claimId,
      toClaim: peer.claimId,
      type: 'contradicts',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'not_co_true' })
    const res = await verifyEnqueued({ db, judge }, [target.claimId])

    expect(res.transitions).toBe(0)
    expect(res.ncExactRefusals).toBe(1)
    expect(await statusOf(target.claimId)).toBe('flagged') // stays flagged — quarantine refused for lack of exact
    expect(await getRefusedRulings(db)).toHaveLength(1)
  })

  it('NC-exact red line does NOT block a pure-staleness flag (staleness is decay, not a non_compliant/refuted ruling): supporting-only stale claim still flags', async () => {
    const old = new Date(Date.now() - 800 * MS_PER_DAY) // > structured_spec half-life (730d)
    const { claimId } = await mkClaim({ status: 'active', asOf: old, relevance: 'supporting' })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' }) // entailment OK, only stale
    const res = await runVerifier({ db, judge })

    expect(res.outcomes[0]!.stale).toBe(true)
    expect(res.transitions).toBe(1)
    expect(res.ncExactRefusals).toBe(0) // staleness is not gated by NC-exact
    expect(await statusOf(claimId)).toBe('flagged')
    expect(await getRefusedRulings(db)).toHaveLength(0)
  })

  // EGR-CR-034 · fail-closed empty-evidence guard (红线#2 真实语义 / A.6):
  //   一条全部出处都是 tangential/irrelevant 的 claim，loadEvidence 把它们全过滤掉 → evidence=[]。
  //   Verifier 必须在调 LLM 前确定性短路：空 exact/supporting 证据 → 不调判官、判 'fail'。
  //   否则空证据被原样喂判官，fake 默认 pass（或 DashScope 错判）会把无证据 draft 洗成 active，污染知识库。
  //   根治点在 Verifier（非 prompt、非 judge 默认）：`evidence.length === 0` 短路。
  it('EGR-CR-034: a draft with ONLY tangential provenance (empty exact/supporting evidence) is NOT sent to the judge and is NOT promoted — fail-closed, stays draft with a {entailment:fail} patrol', async () => {
    // 高 conf 因子（同 draft→active 用例）：排除「conf 不足」这个假阴性 —— 若没被护栏拦住，conf 足以过晋升门。
    const { claimId } = await mkClaim({
      status: 'draft',
      relevance: 'tangential',
      recallable: true,
      claimText: 'tang-only draft',
      factors: { authority: 1, indepSupport: 0.75, entailment: 0.5 },
    })
    // 默认 pass path（正是危险路径）：若空证据被喂进去就会判 pass 并晋升。
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
    const res = await runVerifier({ db, judge })

    expect(judge.callCount()).toBe(0) // 空证据不调 LLM（确定性短路，非 judge≠athlete 跳过）
    expect(await statusOf(claimId)).toBe('draft') // 未晋升，保持 draft
    expect(res.transitions).toBe(0)

    const rows = await patrolRows(claimId)
    expect(rows).toHaveLength(1) // 仍写一行 patrol 裁决（审计留痕）
    expect((rows[0]!.verdict as { entailment: string }).entailment).toBe('fail') // 确定性判负

    const hits = await recallClaims(db, embedder, 'tang-only draft')
    expect(hits.map((h) => h.claim.id)).not.toContain(claimId) // 未进召回（draft 本不可召回，回归保险）
  })

  it('EGR-CR-034: an ACTIVE claim with ONLY tangential provenance is tightened active→flagged with a {entailment:fail} patrol (NOT a NC-exact counter-assertion, NOT recallable) — judge never called', async () => {
    const { claimId } = await mkClaim({
      status: 'active',
      relevance: 'tangential',
      recallable: true,
      claimText: 'tang-only active',
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
    const res = await runVerifier({ db, judge })

    expect(judge.callCount()).toBe(0) // 空证据不调 LLM
    expect(res.transitions).toBe(1)
    expect(await statusOf(claimId)).toBe('flagged') // 缺支撑收紧 active→flagged
    expect(res.ncExactRefusals).toBe(0) // fail 是缺支撑 flag、不过 NC-exact 闸门
    expect(await getRefusedRulings(db)).toHaveLength(0)

    const rows = await patrolRows(claimId)
    expect((rows[0]!.verdict as { entailment: string }).entailment).toBe('fail')
    expect(await recallClaims(db, embedder, 'tang-only active')).toHaveLength(0) // flagged 不可召回
  })

  it('EGR-CR-034: irrelevant-only is likewise ruled fail — even a judge that THROWS on call is never reached (distinguishes the empty-evidence short-circuit from the swallowed-error path)', async () => {
    const { claimId } = await mkClaim({ status: 'draft', relevance: 'irrelevant' })
    const judge = judgeOf('throw') // 一旦被调用就抛 → 反证它没被调用（区别于异常被吞的 skipped 路径）
    const res = await runVerifier({ db, judge })

    expect(res.skipped).toBe(0) // 不是异常跳过，是确定性判负的 patrolled
    expect(res.patrolled).toBe(1)
    expect(judge.callCount()).toBe(0)
    expect(await statusOf(claimId)).toBe('draft')
  })

  // EGR-CR-045 (#120) · 单事务原子性：写 patrol 裁决与状态迁移必须同事务，要么一起成功、要么一起回滚。
  //   故障注入点 = 状态翻转那一步（事务内 claim.update 抛错），发生在 writePatrolVerdict 之后。
  //   修前：patrol 用普通 deps.db 先落已 commit、迁移在独立事务里抛错 → 留下孤儿 fail patrol、不回滚、记 skipped；
  //         孤儿 fail patrol 被 recall/promote 门实时读最新 patrol 喂 f2，把 f2 实时压成 0（污染检索可信度链路）。
  //   修后：两步绑进同一 db.transaction，迁移抛错整事务回滚 → 无孤儿 patrol、状态不动、f2 不被污染；外层 catch 仍记 skipped、下轮重试。
  it('EGR-CR-045: a fault during the status transition rolls back the WHOLE patrol — NO orphan scoring patrol, status untouched, recall f2 not polluted (active→flagged path)', async () => {
    // recallable active claim with independent support so it clears the recall floor at neutral f2 either way —
    // 这把判别点收窄到 f2：修前孤儿 fail 把 entailment 压 0，修后回滚后保持存档中性 0.5。
    const { claimId } = await mkClaim({
      status: 'active',
      recallable: true,
      claimText: 'orphan spec',
      factors: { indepSupport: 1 },
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'fail' }) // fail → 收紧迁移 active→flagged（走 claim.update）
    const faultyDb = dbThatThrowsOnUpdate(db) // patrol 写入成功之后、transition 的 claim.update 抛错
    const res = await runVerifier({ db: faultyDb, judge }) // 单条异常被吞、不外抛

    // ① transition 失败后整事务回滚 → 无孤儿 patrol（修前会是 1）。
    expect(await patrolRows(claimId)).toHaveLength(0)
    // ② 状态未动。
    expect(await statusOf(claimId)).toBe('active')
    // ③ 计数与「未处置」一致：skipped 而非 patrolled（修前 patrolled 会是 1，与 skipped 自相矛盾）。
    expect(res.skipped).toBe(1)
    expect(res.patrolled).toBe(0)
    expect(res.transitions).toBe(0)
    // ④ claim 仍可召回，且其 f2 未被孤儿 fail 压成 0 —— 沿用存档中性 0.5（修前会被孤儿 fail patrol 实时压成 0）。
    const hits = await recallClaims(db, embedder, 'orphan spec')
    expect(hits.map((h) => h.claim.id)).toContain(claimId)
    expect(hits.find((h) => h.claim.id === claimId)!.confidence.factors.entailment).toBe(0.5)
  })

  // EGR-CR-045 (#120) · draft 路径对称：promote 失败不留孤儿 pass patrol（台账 :1044 —— draft 拿到 pass 但晋升失败，
  //   后续被最新 f2 当成"已巡查通过"）。draft 本不进 recall，重点是不留一条会污染下轮判读的孤儿 pass patrol。
  it('EGR-CR-045: a fault during the draft→active promotion rolls back the patrol — NO orphan {entailment:pass} patrol, claim stays draft (draft path symmetry)', async () => {
    // 对齐 draft→active 晋升用例的因子（authority1 + indepSupport0.75 + entailment0.5 → 配 pass 的 live-f2 过 0.5 门）。
    const { claimId } = await mkClaim({
      status: 'draft',
      recallable: true,
      claimText: 'orphan draft spec',
      factors: { authority: 1, indepSupport: 0.75, entailment: 0.5 },
    })
    const judge = makeFakeEntailmentJudge({ verdictOf: () => 'pass' }) // pass → 走晋升的 claim.update
    const faultyDb = dbThatThrowsOnUpdate(db) // patrol 写入成功之后、晋升的 claim.update 抛错
    const res = await runVerifier({ db: faultyDb, judge })

    expect(await patrolRows(claimId)).toHaveLength(0) // 无孤儿 pass patrol（修前会是 1）
    expect(await statusOf(claimId)).toBe('draft') // 未晋升
    expect(res.skipped).toBe(1)
    expect(res.patrolled).toBe(0)
    expect(res.transitions).toBe(0)
  })
})
