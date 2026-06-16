/**
 * A1 考卷免疫流水线（S12，A.9 永久红线）——「题=毒株」：带 reward 的造题是最强真值污染源，
 * 每道 L5/回归候选必须先过免疫流水线才能晋升 golden。HITL：晋升判断是**人的架构权威面**。
 *
 * 全程复用真路径（评测=消费，零评测专用代码路径）：出题 = 真 appendClaim 造一颗毒株 claim（draft、永不召回），
 * 巡查 = claim_verification(kind='patrol')，验「库确无答案」= 真 recall_claims。四检全过才晋升：
 *   ① humanConfirmed —— 晋升人是人（by_role 'human…'）；非人尝试不烧候选（留 queued）、只记审计。
 *   ② kbTrulyLacks   —— recall(query) 当下确实空（库真没答案）；非空 ⇒ 这是带毒考题（库本能答却要它判「不知道」）。
 *   ③ noSelfContradiction —— 把题造成毒株 claim 时没和库产生 contradicts 边（S8）；有 ⇒ 题自相矛盾/自败。
 *      **部分覆盖**：S8 仅在 S/P/O 齐全时检测，自由文本题（不传 opts.poison）结构上触发不了、恒为 true，
 *      靠人传结构化 poison 框架才发火；完整 same_fact 判定要等 S14，届时这条对纯文本题才成自动门。
 *   ④ locatorsTraceable —— 候选可溯到具体来源 claim（claim_id 非空），毒株 claim 带出处（D1）。
 * pass ⇒ 进独立 golden_questions 表（只判分、recall 结构上永不召回）；fail ⇒ 记审计、候选转 rejected（终态）、绝不晋升。
 * 每次尝试都落 promotion_audit（谁/何时/凭何）—— append-only 可审计。
 *
 * 原子性边界：造毒株（appendClaim 自带事务）+ patrol 记录在**决定事务之前**提交；决定（golden + 候选状态 + 审计）
 * 一把原子落，且决定事务开头对候选行 SELECT … FOR UPDATE 复核 status——并发决定被行锁串行化，loser 读到非
 * 'queued' 即 already-decided 早退（不写 golden / 不改候选状态 / 不写决定审计）。故若 loser 早退或决定事务失败，
 * 已提交的毒株是 draft 孤儿——永不被召回、永不进 golden，惰性无害（EGR-CR-020：补上候选行级锁后，并发 HITL
 * 晋升也不再有 check↔use 窗口）。
 */
import { randomUUID } from 'node:crypto'

import { and, asc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import {
  claimProvenance,
  claimVerification,
  goldenQuestions,
  l5Candidates,
  promotionAudit,
  relation,
  roundCohort,
  type PromotionDecision,
} from '../db/schema.js'
import { appendClaim } from './append-claim.js'
import { recallClaims } from './recall-claims.js'
import { type RedTeamClass } from './redteam-generation.js'
import type { ActorContext } from './actor.js'

/** 四项免疫检查 + 总判 + 失败原因（落进 basis 快照，可审计）。 */
export interface ImmunityResult {
  /** 晋升人是人（HITL 权威门）。 */
  humanConfirmed: boolean
  /** recall(query) 当下确实空 —— 库真没答案。 */
  kbTrulyLacks: boolean
  /** 造成毒株 claim 时没产生 contradicts 边 —— 题不自相矛盾。 */
  noSelfContradiction: boolean
  /** 候选可溯到具体来源 claim。 */
  locatorsTraceable: boolean
  passed: boolean
  /** 失败原因（人读，留审计）。 */
  reasons: string[]
}

export interface PromoteOptions {
  /** 晋升人身份（受信边界）。授权读 actor.isHuman；非人（含 role 伪装成 'human:fake' 的 agentActor）不授权。
   *  actor.role 落库审计（decidedBy / promotedBy / 毒株 createdBy / patrol by_role）。 */
  actor: ActorContext
  /** 可选：给毒株 claim 的结构化框架（S/P/O），让自相矛盾检查（S8）能被触发。缺省则毒株仅有 claimText。 */
  poison?: { subject?: string; predicate?: string; object?: string }
}

export interface PromoteResult {
  promoted: boolean
  result: ImmunityResult
  /** 晋升成功时的 golden_questions.id。 */
  goldenId?: string | undefined
  /** 免疫造的毒株 claim id（人确认通过、进了造题步才有）。 */
  poisonClaimId?: string | undefined
}

/** golden_questions 一行的读出形状。{id, query} 可直接当 L5Question 喂 S10 的 runL5Suite 打分。 */
export interface GoldenQuestion {
  id: string
  candidateId: string
  query: string
  poisonClaimId: string
  promotedBy: string
  basis: ImmunityResult
  createdAt: Date
}

export interface PromotionAuditRow {
  id: string
  candidateId: string
  decision: PromotionDecision
  decidedBy: string
  basis: ImmunityResult
  createdAt: Date
}

/**
 * 把一条 queued 的 L5 候选过 A1 免疫流水线、决定是否晋升 golden。
 * 候选不存在 / 非 queued ⇒ 抛（只晋升排队中的候选）。
 */
export async function promoteCandidate(
  db: DB,
  embedder: Embedder,
  candidateId: string,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const [cand] = await db.select().from(l5Candidates).where(eq(l5Candidates.id, candidateId))
  if (!cand) {
    throw new Error(`promoteCandidate: candidate ${candidateId} not found`)
  }
  if (cand.status !== 'queued') {
    throw new Error(
      `promoteCandidate: candidate ${candidateId} is '${cand.status}', only queued candidates can be promoted`,
    )
  }

  const reasons: string[] = []

  // ① HITL 权威门：非人尝试不授权 —— 记审计、**不烧候选**（留 queued，可后续由人重试），直接返回。
  // 授权读 actor.isHuman（受信边界）；agentActor（含 role 伪装成 'human:fake'）在此被拒。
  // 注：权威门先失败即短路，后三项检查**未运行**；basis 里它们为 false 表示「未评估而非判否」，
  // 权威说明在 reasons（'not human-confirmed …'）—— reasons 才是审计「凭何」的权威半，不要把这三个 false 读成结论。
  if (!opts.actor.isHuman) {
    reasons.push(`not human-confirmed (by_role '${opts.actor.role}')`)
    const result: ImmunityResult = {
      humanConfirmed: false,
      kbTrulyLacks: false,
      noSelfContradiction: false,
      locatorsTraceable: false,
      passed: false,
      reasons,
    }
    await db.insert(promotionAudit).values({
      id: randomUUID(),
      candidateId,
      decision: 'rejected',
      decidedBy: opts.actor.role,
      basis: result,
    })
    return { promoted: false, result }
  }

  // ② 库真没答案：复用真 recall_claims（评测=消费）。
  const hits = await recallClaims(db, embedder, cand.query)
  const kbTrulyLacks = hits.length === 0
  if (!kbTrulyLacks) reasons.push('KB already answers the question (recall returned a claim)')

  // ④ locator 可溯：候选要溯到具体来源 claim。无来源 claim ⇒ 不可溯（也无从拿出处去造毒株）。
  let locatorsTraceable = cand.claimId != null
  if (!locatorsTraceable) reasons.push('candidate has no traceable originating claim')

  // ③ 造毒株 + 自相矛盾检查：复用真 appendClaim（毒株 draft、永不召回）+ S8 contradicts + patrol 巡查记录。
  // 仅在已过 kbTrulyLacks ∧ locatorsTraceable 时才造毒株：库本能答（kbTrulyLacks=false）的候选已注定 rejected，
  // 不必再造一颗注定无人引用的毒株 claim（省一次 append、不留无谓的 draft 孤儿）。
  // 注：noSelfContradiction 复用 S8，而 S8 只在 S/P/O 齐全时检测；自由文本 gap 题（不传 opts.poison）结构上
  // 触发不了它、恒为 true —— 在 S14 完整 same_fact 判定到位前，这条红线对纯文本题是**部分覆盖**，靠人传结构化
  // poison 框架才发火，不是自动门。
  let poisonClaimId: string | undefined
  let noSelfContradiction = true
  if (kbTrulyLacks && locatorsTraceable) {
    // 毒株 claim 的出处溯到来源 claim 的源（D1 保证来源 claim ≥1 出处）。
    const [prov] = await db
      .select({ sourceId: claimProvenance.sourceId })
      .from(claimProvenance)
      .where(eq(claimProvenance.claimId, cand.claimId!))
      .limit(1)
    if (!prov) {
      locatorsTraceable = false
      reasons.push('originating claim lacks provenance (not traceable)')
    } else {
      const appended = await appendClaim(
        db,
        embedder,
        {
          claimText: cand.query,
          createdBy: `exam:immunity:${opts.actor.role}`,
          // 仅在给了结构化框架时带 S/P/O（exactOptionalPropertyTypes：不显式塞 undefined）。
          ...(opts.poison?.subject !== undefined ? { subject: opts.poison.subject } : {}),
          ...(opts.poison?.predicate !== undefined ? { predicate: opts.poison.predicate } : {}),
          ...(opts.poison?.object !== undefined ? { object: opts.poison.object } : {}),
        },
        [
          {
            sourceId: prov.sourceId,
            locator: `exam:from-claim:${cand.claimId}`,
            relevance: 'exact',
          },
        ],
      )
      poisonClaimId = appended.claimId
      // S8：造毒株时是否与库产生 contradicts 边？有 ⇒ 题自败。recordContradictions 只从新 claim 发出边
      // （from=新毒株），且此刻刚造完、无后续 append，故只查 from=poison 即可（to=poison 是死分支）。
      // 口径偏保守：S8 对**非 superseded** 的对端建边（含 quarantined/draft），不止 active KB —— 免疫门宁可错拒。
      // 完整 same_fact（active 范围、单位归一、灰区判定）是 S14；届时这条口径随之收窄。
      const contra = await db
        .select({ id: relation.id })
        .from(relation)
        .where(and(eq(relation.type, 'contradicts'), eq(relation.fromClaim, poisonClaimId)))
      noSelfContradiction = contra.length === 0
      if (!noSelfContradiction) {
        reasons.push(
          'question self-contradicts the KB (a contradicts edge was created on authoring)',
        )
      }
      // 巡查记录（复用 patrol 路径）挂在毒株 claim 上。
      await db.insert(claimVerification).values({
        id: randomUUID(),
        claimId: poisonClaimId,
        kind: 'patrol',
        verdict: { check: 'exam_immunity', noSelfContradiction, locatorsTraceable },
        byRole: opts.actor.role,
      })
    }
  }

  const passed = kbTrulyLacks && noSelfContradiction && locatorsTraceable
  const result: ImmunityResult = {
    humanConfirmed: true,
    kbTrulyLacks,
    noSelfContradiction,
    locatorsTraceable,
    passed,
    reasons,
  }

  // 决定写一把原子落：晋升 ⇒ golden + 候选 promoted + 审计；驳回 ⇒ 候选 rejected（终态）+ 审计。
  return db.transaction(async (tx) => {
    // 锁住候选行 + 事务内复核 status（对齐 transition.ts:104-108 / commit-claim 的 .for('update') 范式）：
    // 事务外的预读（:103-111）只作早退优化、不是权威。两个并发决定在此被行锁串行化——loser 阻塞到
    // winner 提交、再读到非 'queued' 占有权 ⇒ already-decided 早退，绝不执行 golden insert / blind UPDATE /
    // 写决定审计（杜绝 check↔use 窗口造出的 golden 行 ∧ rejected 矛盾终态，且 loser 不再撞 candidate_id UNIQUE）。
    const [locked] = await tx
      .select({ status: l5Candidates.status })
      .from(l5Candidates)
      .where(eq(l5Candidates.id, candidateId))
      .for('update')
    if (!locked || locked.status !== 'queued') {
      throw new Error(
        `promoteCandidate: candidate ${candidateId} is already decided ('${locked?.status ?? 'gone'}')`,
      )
    }
    if (passed) {
      const goldenId = randomUUID()
      await tx.insert(goldenQuestions).values({
        id: goldenId,
        candidateId,
        query: cand.query,
        poisonClaimId: poisonClaimId!,
        promotedBy: opts.actor.role,
        basis: result,
      })
      await tx
        .update(l5Candidates)
        .set({ status: 'promoted' })
        .where(eq(l5Candidates.id, candidateId))
      await tx.insert(promotionAudit).values({
        id: randomUUID(),
        candidateId,
        decision: 'promoted',
        decidedBy: opts.actor.role,
        basis: result,
      })
      return { promoted: true, result, goldenId, poisonClaimId }
    }
    await tx
      .update(l5Candidates)
      .set({ status: 'rejected' })
      .where(eq(l5Candidates.id, candidateId))
    await tx.insert(promotionAudit).values({
      id: randomUUID(),
      candidateId,
      decision: 'rejected',
      decidedBy: opts.actor.role,
      basis: result,
    })
    return { promoted: false, result, poisonClaimId }
  })
}

/** 读 golden 命名空间（按晋升时间升序）。{id, query} 可直接当 L5Question 喂 runL5Suite 打分。 */
export async function getGoldenQuestions(db: DB): Promise<GoldenQuestion[]> {
  const rows = await db
    .select()
    .from(goldenQuestions)
    .orderBy(asc(goldenQuestions.createdAt), asc(goldenQuestions.id))
  return rows.map((r) => ({
    id: r.id,
    candidateId: r.candidateId,
    query: r.query,
    poisonClaimId: r.poisonClaimId,
    promotedBy: r.promotedBy,
    basis: r.basis as ImmunityResult,
    createdAt: r.createdAt,
  }))
}

/** 读晋升审计（可按候选过滤），按时间升序。 */
export async function getPromotionAudit(
  db: DB,
  candidateId?: string,
): Promise<PromotionAuditRow[]> {
  const rows = await db
    .select()
    .from(promotionAudit)
    .where(candidateId === undefined ? undefined : eq(promotionAudit.candidateId, candidateId))
    .orderBy(asc(promotionAudit.createdAt), asc(promotionAudit.id))
  return rows.map((r) => ({
    id: r.id,
    candidateId: r.candidateId,
    decision: r.decision,
    decidedBy: r.decidedBy,
    basis: r.basis as ImmunityResult,
    createdAt: r.createdAt,
  }))
}

/** round_cohort 一行的读出形状（EGR-CR-017：回合 A1 逐条裁决的 append-only 快照）。 */
export interface RoundCohortRow {
  id: string
  generationVersion: string
  itemId: string
  redteamClass: RedTeamClass
  /** 过了 A1（promoteCandidate.promoted）⇒ 进被计分 cohort。 */
  admitted: boolean
  /** admitted 时回填的 golden id（值快照，无 FK）；blocked 时 null。 */
  goldenId: string | null
  /** admitted 时回填的毒株 claim id（值快照，无 FK）；blocked 时 null。 */
  poisonClaimId: string | null
  /** A1 四检判据快照（= PromoteResult.result）。 */
  basis: ImmunityResult
  decidedBy: string
  createdAt: Date
}

/**
 * 读一回合的 A1 裁决 cohort（EGR-CR-017），按裁决时间升序。
 * 证据落在不参与 per-item reset 的 round_cohort，故回合结束后仍可跨整回合审计「谁/何时/凭何过的 A1」。
 * scorer 据此（admitted=true 的子集）构 cohort——cohort 来源由持久事实而非内存 Set 驱动。
 */
export async function getRoundCohort(db: DB, generationVersion: string): Promise<RoundCohortRow[]> {
  const rows = await db
    .select()
    .from(roundCohort)
    .where(eq(roundCohort.generationVersion, generationVersion))
    .orderBy(asc(roundCohort.createdAt), asc(roundCohort.id))
  return rows.map((r) => ({
    id: r.id,
    generationVersion: r.generationVersion,
    itemId: r.itemId,
    redteamClass: r.redteamClass as RedTeamClass,
    admitted: r.admitted,
    goldenId: r.goldenId,
    poisonClaimId: r.poisonClaimId,
    basis: r.basis as ImmunityResult,
    decidedBy: r.decidedBy,
    createdAt: r.createdAt,
  }))
}
