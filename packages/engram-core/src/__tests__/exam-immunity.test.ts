import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import {
  claim,
  claimProvenance,
  claimVerification,
  l5Candidates,
  type ClaimStatus,
} from '../db/schema.js'
import { addSource } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { runL5Suite } from '../eval/l5-gap.js'
import { getGoldenQuestions, getPromotionAudit, promoteCandidate } from '../spi/exam-immunity.js'
import { agentActor, trustedHumanActor } from '../spi/actor.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder = makeFakeEmbedder()

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL })
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
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
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, regression_pool, l5_candidates, golden_questions, promotion_audit CASCADE',
  )
})

const ABOVE_FLOOR = {
  authority: 0.8,
  humanReview: 0.8,
  entailment: 0.8,
  indepSupport: 0.8,
  usageCorrect: 0.8,
}

/** Seed a claim with an explicit embed-query + status + optional S/P/O, plus one exact provenance (D1). */
async function seedClaim(opts: {
  claimText: string
  embedQuery: string
  status: ClaimStatus
  subject?: string
  predicate?: string
  object?: string
}): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: opts.claimText,
    subject: opts.subject,
    predicate: opts.predicate,
    object: opts.object,
    status: opts.status,
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: {
        ...ABOVE_FLOOR,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: DEFAULT_WEIGHTS,
      calibrationVersion: CALIBRATION_IDENTITY,
    },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
    embedding: await embedder.embed(opts.embedQuery),
    embeddingVersion: embedder.version,
  })
  const { sourceId } = await addSource(db, {
    content: 'body',
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

/** Insert a queued L5 candidate directly (the candidate namespace). */
async function seedCandidate(
  query: string,
  claimId: string | null,
  confirmedBy = 'human:judge',
): Promise<string> {
  const id = randomUUID()
  await db.insert(l5Candidates).values({
    id,
    sourceEventId: randomUUID(),
    query,
    claimId,
    confirmedBy,
    status: 'queued',
  })
  return id
}

describe('S12 A1 exam-immunity pipeline before golden promotion (A.9 red line)', () => {
  it('queued candidates live in the candidate namespace and do not participate in scoring until promoted', async () => {
    const origin = await seedClaim({ claimText: 'origin', embedQuery: 'q', status: 'quarantined' })
    await seedCandidate('a queued but unpromoted gap question', origin)
    expect(await getGoldenQuestions(db)).toHaveLength(0) // nothing scored yet
    // scoring runs over the golden namespace; with nothing promoted, the scored set is empty
    const report = await runL5Suite(db, embedder, [])
    expect(report.total).toBe(0)
  })

  it('a clean candidate passes the immunity pipeline and is frozen into golden (reusing real append + patrol), scored but never recalled', async () => {
    const q = 'what is the documented purge interval for the staging cache'
    // originating claim is quarantined ⇒ recall(q) is empty ⇒ KB truly lacks the answer; still provenance-traceable
    const origin = await seedClaim({
      claimText: 'a once-wrong answer',
      embedQuery: q,
      status: 'quarantined',
    })
    const candidateId = await seedCandidate(q, origin)

    const res = await promoteCandidate(db, embedder, candidateId, {
      actor: trustedHumanActor('human:judge'),
    })
    expect(res.promoted).toBe(true)
    expect(res.result).toMatchObject({
      humanConfirmed: true,
      kbTrulyLacks: true,
      noSelfContradiction: true,
      locatorsTraceable: true,
      passed: true,
    })

    // frozen into the golden namespace; candidate transitions to promoted
    const golden = await getGoldenQuestions(db)
    expect(golden).toHaveLength(1)
    expect(golden[0]!.query).toBe(q)
    expect(golden[0]!.candidateId).toBe(candidateId)
    expect(golden[0]!.poisonClaimId).toBe(res.poisonClaimId) // the frozen row links the authored poison claim
    expect(golden[0]!.promotedBy).toBe('human:judge') // the human authority is recorded on the golden row (provenance)
    expect(golden[0]!.basis).toMatchObject({
      humanConfirmed: true,
      kbTrulyLacks: true,
      noSelfContradiction: true,
      locatorsTraceable: true,
      passed: true,
    }) // the full immunity snapshot is frozen alongside the question
    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('promoted')

    // reused the real append/patrol path: a poison claim was authored + a patrol verdict recorded on it
    expect(res.poisonClaimId).toBeDefined()
    const patrol = await db
      .select()
      .from(claimVerification)
      .where(
        and(
          eq(claimVerification.claimId, res.poisonClaimId!),
          eq(claimVerification.kind, 'patrol'),
        ),
      )
    expect(patrol).toHaveLength(1)
    expect((patrol[0]!.verdict as { check: string }).check).toBe('exam_immunity')

    // never recalled: golden lives outside `claim`, and the poison claim is draft ⇒ recall(q) stays empty
    expect(await recallClaims(db, embedder, q)).toHaveLength(0)

    // scored through the REAL L5 suite (eval == consumption, zero bespoke path): a frozen gap scores 1.0
    const report = await runL5Suite(
      db,
      embedder,
      golden.map((g) => ({ id: g.id, query: g.query })),
    )
    expect(report.total).toBe(1)
    expect(report.blindSpotScore).toBe(1)
  })

  it('a structured poison (S/P/O present) that does NOT contradict the KB passes the contradiction scan and promotes', async () => {
    const q = 'which lubricant grade is specified for the idler bearing'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    // S/P/O present (so recordContradictions actually runs the scan, unlike free-text) but nothing in the
    // KB shares this subject+predicate ⇒ no contradicts edge ⇒ the contra.length===0 TRUE branch is taken
    const res = await promoteCandidate(db, embedder, candidateId, {
      actor: trustedHumanActor('human:judge'),
      poison: { subject: 'idler-bearing', predicate: 'lubricant-grade', object: 'iso-vg-46' },
    })
    expect(res.result.noSelfContradiction).toBe(true) // the scan ran on a structured poison and found nothing
    expect(res.promoted).toBe(true)
    expect(await getGoldenQuestions(db)).toHaveLength(1)
  })

  it('A1 red line: a deliberately-poisoned candidate (the KB actually CAN answer it) is rejected and never enters golden', async () => {
    const q = 'what is the supported maximum batch size for the ingest endpoint'
    // an ACTIVE claim answers q ⇒ recall(q) is non-empty ⇒ this gap question is poison (would mis-score the KB)
    const answer = await seedClaim({
      claimText: 'the ingest endpoint supports batches of 512',
      embedQuery: q,
      status: 'active',
    })
    const candidateId = await seedCandidate(q, answer)

    const res = await promoteCandidate(db, embedder, candidateId, {
      actor: trustedHumanActor('human:judge'),
    })
    expect(res.promoted).toBe(false)
    expect(res.result.kbTrulyLacks).toBe(false) // the poison: the KB has an answer
    expect(res.result.passed).toBe(false)
    expect(res.result.reasons).toContain(
      'KB already answers the question (recall returned a claim)',
    )
    expect(res.poisonClaimId).toBeUndefined() // doomed candidate ⇒ authoring skipped (no wasted draft poison)
    expect(await getGoldenQuestions(db)).toHaveLength(0) // never enters the golden set

    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('rejected') // poisoned candidate burned, terminal
    // the auditable "凭何": the rejection reason is persisted in the audit basis, not just returned
    const audit = await getPromotionAudit(db, candidateId)
    expect(audit[0]!.basis.reasons).toContain(
      'KB already answers the question (recall returned a claim)',
    )
  })

  it('A1 red line: a self-contradicting candidate (its poison claim contradicts the active KB) is rejected even though the KB lacks the answer', async () => {
    const q = 'which torque spec applies to the rotor mount'
    // active claim S+P+O1 with an UNRELATED embedding ⇒ recall(q) stays empty (kbTrulyLacks holds) …
    await seedClaim({
      claimText: 'rotor mount torque is 40 nm',
      embedQuery: 'totally unrelated banana split dessert',
      status: 'active',
      subject: 'rotor-mount',
      predicate: 'torque',
      object: '40nm',
    })
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    // … but the human frames the poison claim with the same S+P, a different O ⇒ authoring creates a contradicts edge
    const res = await promoteCandidate(db, embedder, candidateId, {
      actor: trustedHumanActor('human:judge'),
      poison: { subject: 'rotor-mount', predicate: 'torque', object: '55nm' },
    })
    expect(res.result.kbTrulyLacks).toBe(true) // the KB indeed lacks an answer to q
    expect(res.result.noSelfContradiction).toBe(false) // …but the question self-contradicts the KB
    expect(res.result.reasons).toContain(
      'question self-contradicts the KB (a contradicts edge was created on authoring)',
    )
    expect(res.promoted).toBe(false)
    expect(await getGoldenQuestions(db)).toHaveLength(0)
    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('rejected')

    // "fail ⇒ logged": the poison-authoring rejection path STILL records an auditable rejection
    const audit = await getPromotionAudit(db, candidateId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('rejected')
    expect(audit[0]!.decidedBy).toBe('human:judge')
    expect(audit[0]!.basis.passed).toBe(false)

    // the rejected poison claim persists as the immune-system artifact, with its patrol verdict explaining why
    expect(res.poisonClaimId).toBeDefined()
    const patrol = await db
      .select()
      .from(claimVerification)
      .where(
        and(
          eq(claimVerification.claimId, res.poisonClaimId!),
          eq(claimVerification.kind, 'patrol'),
        ),
      )
    expect(patrol).toHaveLength(1)
    expect((patrol[0]!.verdict as { noSelfContradiction: boolean }).noSelfContradiction).toBe(false)
  })

  it('only a human can promote: an agent-confirmed attempt is rejected, audited, and does NOT burn the candidate (stays queued)', async () => {
    const q = 'agent-confirmed attempt query'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    const res = await promoteCandidate(db, embedder, candidateId, {
      actor: agentActor('agent:rogue'),
    })
    expect(res.promoted).toBe(false)
    expect(res.result.humanConfirmed).toBe(false)
    expect(res.result.reasons).toContain("not human-confirmed (by_role 'agent:rogue')")
    expect(res.poisonClaimId).toBeUndefined() // no poison authored on an unauthorized attempt
    expect(await getGoldenQuestions(db)).toHaveLength(0)

    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('queued') // unauthorized attempt must not burn the candidate

    const audit = await getPromotionAudit(db, candidateId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('rejected')
    expect(audit[0]!.decidedBy).toBe('agent:rogue')
    expect(audit[0]!.basis.reasons).toContain("not human-confirmed (by_role 'agent:rogue')")
  })

  // EGR-CR-002 对抗回归（gate exam-immunity.ts:117 HITL 权威门）：授权读 actor.isHuman，伪装 role 越不过。
  // agentActor('human:fake') ⇒ isHuman:false ⇒ 拒、不晋升、不烧候选；旧门 isHumanRole('human:fake') 会误判成人、
  // 把毒株考题晋进 golden 知识脊柱。审计落库 by_role 写 actor.role（伪装身份照实留痕）。
  it('EGR-CR-002: agentActor("human:fake") is REJECTED — a forged human role cannot promote a candidate into golden (authz reads isHuman, not the role string)', async () => {
    const q = 'forged human promote query'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    const res = await promoteCandidate(db, embedder, candidateId, {
      actor: agentActor('human:fake'),
    })
    expect(res.promoted).toBe(false)
    expect(res.result.humanConfirmed).toBe(false)
    expect(res.result.reasons).toContain("not human-confirmed (by_role 'human:fake')")
    expect(res.poisonClaimId).toBeUndefined() // no poison authored on a forged attempt
    expect(await getGoldenQuestions(db)).toHaveLength(0) // nothing entered the golden spine

    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('queued') // forged attempt must not burn the candidate

    const audit = await getPromotionAudit(db, candidateId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('rejected')
    expect(audit[0]!.decidedBy).toBe('human:fake') // audit records the forged role verbatim
  })

  it('locator traceability: a candidate with no originating claim is not traceable and is rejected (no poison authored)', async () => {
    const candidateId = await seedCandidate('untraceable gap question', null) // claimId null ⇒ no origin to trace

    const res = await promoteCandidate(db, embedder, candidateId, {
      actor: trustedHumanActor('human:judge'),
    })
    expect(res.result.locatorsTraceable).toBe(false)
    expect(res.result.reasons).toContain('candidate has no traceable originating claim')
    expect(res.promoted).toBe(false)
    expect(res.poisonClaimId).toBeUndefined()
    expect(await getGoldenQuestions(db)).toHaveLength(0)
  })

  it('locator traceability: an originating claim that exists but has NO provenance hits the !prov branch — rejected, no poison authored', async () => {
    const q = 'gap whose origin claim carries no provenance'
    // directly insert an origin claim with ZERO provenance rows (bypassing appendClaim's D1 guard);
    // quarantined ⇒ recall(q) stays empty so kbTrulyLacks holds and the traceability failure is isolated
    const originId = randomUUID()
    await db.insert(claim).values({
      id: originId,
      claimText: 'origin without any provenance',
      status: 'quarantined',
      confidence: 0.8,
      confidenceRaw: 0.8,
      confidenceFactors: {
        factors: {
          ...ABOVE_FLOOR,
          ageDays: 0,
          activeContradicts: 0,
          staleDecay: 1,
          conflictDecay: 1,
        },
        weights: DEFAULT_WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      lineageId: randomUUID(),
      asOf: new Date(),
      createdBy: 'test',
      embedding: await embedder.embed(q),
      embeddingVersion: embedder.version,
    })
    const candidateId = await seedCandidate(q, originId)

    const res = await promoteCandidate(db, embedder, candidateId, {
      actor: trustedHumanActor('human:judge'),
    })
    expect(res.result.kbTrulyLacks).toBe(true) // origin is quarantined ⇒ recall(q) empty
    expect(res.result.locatorsTraceable).toBe(false) // …but the origin claim has no provenance to trace
    expect(res.result.reasons).toContain('originating claim lacks provenance (not traceable)')
    expect(res.promoted).toBe(false)
    expect(res.poisonClaimId).toBeUndefined() // authoring skipped on the !prov branch
    expect(await getGoldenQuestions(db)).toHaveLength(0)
  })

  it('promotion is append-only and auditable (who / when / on-what-basis) for both pass and fail', async () => {
    const q = 'auditable promotion query'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    const t0 = (await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId)))[0]!
      .createdAt
    await promoteCandidate(db, embedder, candidateId, {
      actor: trustedHumanActor('human:architect'),
    })

    const audit = await getPromotionAudit(db, candidateId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('promoted') // who
    expect(audit[0]!.decidedBy).toBe('human:architect') // who
    expect(audit[0]!.basis.passed).toBe(true) // on-what-basis (the immunity result snapshot)
    expect(audit[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(t0.getTime()) // when
  })

  it('promotion is single-shot: re-promoting a non-queued (already promoted) candidate throws; unknown candidate throws', async () => {
    const q = 'single-shot query'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)
    await promoteCandidate(db, embedder, candidateId, { actor: trustedHumanActor('human:judge') }) // → promoted

    await expect(
      promoteCandidate(db, embedder, candidateId, { actor: trustedHumanActor('human:judge') }),
    ).rejects.toThrow(/only queued candidates/)
    await expect(
      promoteCandidate(db, embedder, randomUUID(), { actor: trustedHumanActor('human:judge') }),
    ).rejects.toThrow(/not found/)
  })

  it('rejection is terminal: a rejected candidate cannot be re-promoted (a burned poison can never sneak back)', async () => {
    const q = 'rejected-then-retried query'
    const answer = await seedClaim({
      claimText: 'kb can answer this',
      embedQuery: q,
      status: 'active',
    })
    const candidateId = await seedCandidate(q, answer)
    await promoteCandidate(db, embedder, candidateId, { actor: trustedHumanActor('human:judge') }) // → rejected (KB answers)

    await expect(
      promoteCandidate(db, embedder, candidateId, { actor: trustedHumanActor('human:judge') }),
    ).rejects.toThrow(/only queued candidates/)
  })

  it('getGoldenQuestions and the unfiltered getPromotionAudit return rows in created_at-ascending order across multiple candidates', async () => {
    const mk = async (n: number) => {
      const q = `gap question number ${n}`
      const origin = await seedClaim({
        claimText: `origin ${n}`,
        embedQuery: q,
        status: 'quarantined',
      })
      const cid = await seedCandidate(q, origin)
      await promoteCandidate(db, embedder, cid, { actor: trustedHumanActor('human:judge') })
      return q
    }
    const q1 = await mk(1)
    const q2 = await mk(2)
    const q3 = await mk(3)

    const golden = await getGoldenQuestions(db)
    expect(golden.map((g) => g.query)).toEqual([q1, q2, q3]) // promotion order preserved (feeds runL5Suite stably)

    const audit = await getPromotionAudit(db) // unfiltered (no candidateId) branch
    expect(audit).toHaveLength(3)
    expect(audit.every((a) => a.decision === 'promoted')).toBe(true)
    for (let i = 1; i < audit.length; i++) {
      expect(audit[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        audit[i - 1]!.createdAt.getTime(),
      )
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // EGR-CR-020 并发回归：promoteCandidate 缺候选行锁/条件更新，并发决定可造
  // (golden_questions 有该候选行 ∧ l5_candidates.status='rejected') 的矛盾终态。
  //
  // 历史教训（PR #141/#146/#191 均因 RED 不可靠被否）：两笔 promoteCandidate 在进决定
  // 事务前各做大量串行 async（recall/append/patrol），靠时序让它们「真并发」既不可靠也无必要。
  // 这里用**确定性屏障**钉死顺序而非靠时序：
  //   1. 先发 loser（注入一个在 recall 的 embed() 上阻塞的 gated embedder）。loser 在阻塞前
  //      已执行过事务外那道 `status !== 'queued'` 预读（读到 queued）—— TOCTOU 的「check」已发生。
  //   2. 待 loser 卡在 gate 后，激活一条能回答该 query 的 active claim（让 loser 的 recall 命中
  //      ⇒ kbTrulyLacks=false ⇒ loser 注定走 reject 分支、对候选行 blind UPDATE status='rejected'）。
  //   3. await winner（普通 embedder）跑完：insert golden + 候选 status='promoted'，已提交。
  //   4. 放闸：loser 续跑、进决定事务。
  //        - 未修代码：决定事务内无 FOR UPDATE 复核 ⇒ blind UPDATE 把已 promoted 的候选盖回
  //          rejected，而 golden 行仍在 ⇒ **可达 (golden ∧ rejected) 矛盾终态 ⇒ RED**。
  //        - 修后：决定事务最开始 SELECT … FOR UPDATE 复核读到非 queued ⇒ 抛 'already decided'
  //          早退，不 blind UPDATE、不写决定审计 ⇒ 终态自洽 ⇒ GREEN。
  // 全程零 sleep / 零时序依赖：winner 在放闸前已被完整 await，RED/GREEN 在未修/修后都确定。

  /** 包装真 embedder：第一次 embed 调用时先卡在 gate 上（同时触发 reached），放闸后才算向量。 */
  function gatedEmbedderOnFirstCall(
    inner: ReturnType<typeof makeFakeEmbedder>,
    onReached: () => void,
    blockUntil: Promise<void>,
  ): ReturnType<typeof makeFakeEmbedder> {
    let first = true
    return {
      version: inner.version,
      dim: inner.dim,
      embed: async (text: string, kind?: 'query' | 'document') => {
        if (first) {
          first = false
          onReached() // 通知：被 gate 的一方已到达 recall（即已越过事务外 status 预读）
          await blockUntil // 卡住，直到 winner 提交完毕、测试放闸
        }
        return inner.embed(text, kind)
      },
    }
  }

  it('EGR-CR-020 FOR UPDATE serializes concurrent promotions of the same candidate: never golden row + rejected status', async () => {
    // 一条无并发时本会 pass 的 queued 候选（quarantined 来源 ⇒ recall 空、可溯）。
    const q = 'a contended gap question whose ownership is raced'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    let reached!: () => void
    const reachedGate = new Promise<void>((r) => {
      reached = r
    })
    let release!: () => void
    const blockUntil = new Promise<void>((r) => {
      release = r
    })
    const losingEmbedder = gatedEmbedderOnFirstCall(embedder, reached, blockUntil)

    // loser：human，但其 recall 被 gate 阻塞；放闸时 KB 已能回答 ⇒ 它会 reject（blind UPDATE）。
    const loser = promoteCandidate(db, losingEmbedder, candidateId, {
      actor: trustedHumanActor('human:loser'),
    })

    // 等 loser 卡在 gate（此刻它已越过事务外 `status !== 'queued'` 预读、读到 queued）。
    await reachedGate

    // winner：普通 embedder，此刻 KB 仍无答案 ⇒ winner recall 空 ⇒ pass，完整跑完并提交（golden + 候选 promoted）。
    const winnerRes = await promoteCandidate(db, embedder, candidateId, {
      actor: trustedHumanActor('human:winner'),
    })
    expect(winnerRes.promoted).toBe(true) // winner 抢到占有权、晋升成功

    // winner 提交后，再激活一条回答该 query 的 claim ⇒ loser 放闸续跑后 recall 命中 ⇒ kbTrulyLacks=false
    // ⇒ loser 注定走 reject 分支、对候选行 blind UPDATE status='rejected'（未修代码即在此造矛盾终态）。
    await seedClaim({ claimText: 'the KB can now answer it', embedQuery: q, status: 'active' })

    // 放闸：loser 续跑、进决定事务。
    release()
    const loserSettled = await loser.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    )
    const results = [{ status: 'fulfilled' as const, value: winnerRes }, loserSettled]

    // 断言 A：恰好一个调用拿到占有权并落终态，另一个观察到 already-decided 被拒。
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as { reason: Error }).reason.message).toMatch(/already decided/)

    // 断言 B（核心不变量）：候选终态与 golden 命名空间一致，绝不矛盾。
    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    const golden = await getGoldenQuestions(db)
    const goldenForCand = golden.filter((g) => g.candidateId === candidateId)
    if (cand!.status === 'promoted') {
      expect(goldenForCand).toHaveLength(1) // 晋升 ⇒ 恰一条 golden 行
    } else {
      expect(cand!.status).toBe('rejected')
      expect(goldenForCand).toHaveLength(0) // 驳回 ⇒ 绝无 golden 行
    }
    // 反向硬断言：永远不存在 (golden 行 ∧ rejected) 的组合。
    expect(goldenForCand.length === 1 && cand!.status === 'rejected').toBe(false)

    // 断言 C：审计流不自相矛盾——同一候选不同时存在 promoted 与 rejected 两条决定。
    const audit = await getPromotionAudit(db, candidateId)
    const decisions = new Set(audit.map((a) => a.decision))
    expect(decisions.has('promoted') && decisions.has('rejected')).toBe(false)
  })

  it('EGR-CR-020 FOR UPDATE: two concurrent human promotions of the same queued candidate — exactly one golden row, the other already-decided (not a UNIQUE violation)', async () => {
    // 两个 pass 并发同一候选：靠确定性屏障钉死「winner 先提交、loser 后进决定事务」。
    const q = 'double-pass contended candidate'
    const origin = await seedClaim({ claimText: 'origin', embedQuery: q, status: 'quarantined' })
    const candidateId = await seedCandidate(q, origin)

    let reached!: () => void
    const reachedGate = new Promise<void>((r) => {
      reached = r
    })
    let release!: () => void
    const blockUntil = new Promise<void>((r) => {
      release = r
    })
    // loser 也走 pass 路径，故 gate 它的「第一次 embed」（recall）即可——append 的 embed 永不到达。
    const losingEmbedder = gatedEmbedderOnFirstCall(embedder, reached, blockUntil)

    const loser = promoteCandidate(db, losingEmbedder, candidateId, {
      actor: trustedHumanActor('human:loser'),
    })
    await reachedGate // loser 已越过事务外 status 预读、卡在 recall 的 embed 上

    const winnerRes = await promoteCandidate(db, embedder, candidateId, {
      actor: trustedHumanActor('human:winner'),
    })
    expect(winnerRes.promoted).toBe(true)

    release()
    const loserSettled = await loser.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    )

    // 恰一个 fulfilled（winner 晋升），loser 被 already-decided 早退拒（**不是** golden UNIQUE 约束冲突）。
    expect(winnerRes.promoted).toBe(true)
    expect(loserSettled.status).toBe('rejected')
    expect((loserSettled as { reason: Error }).reason.message).toMatch(/already decided/)

    // 恰一条 golden、候选终态 promoted、无重复。
    const golden = (await getGoldenQuestions(db)).filter((g) => g.candidateId === candidateId)
    expect(golden).toHaveLength(1)
    const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
    expect(cand!.status).toBe('promoted')

    // 审计只有一条 promoted 决定（loser 早退不写决定审计）。
    const audit = await getPromotionAudit(db, candidateId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('promoted')
  })
})
