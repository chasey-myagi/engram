/**
 * 红队四类对抗样本注入器 + 免疫反应断言 + 免疫力维度打分（S29，A.9 stories 50/51；L3 第六维「★免疫红队」）。
 *
 * 核心纪律（评测=消费，零评测专用代码路径）：每条对抗样本都经**真 append_claim SPI** 注入（不走任何旁路），
 * 免疫反应由**真工种**驱动（Verifier / Arbiter / Reconciler，经 fake 端口 entailment judge / harness-pi fake model），
 * 断言只读 DB 真状态（claim.status / contradicts 边 / conflict_adjudicated 事件 / reconcile escalation / recall 召回）。
 * 这样测的是真免疫系统、不是影子系统——任何工种回归会让对应类的 detection 掉、检出率跌。
 *
 * 四类 → 责任工种（A.6 红队表）：
 *   false           → Verifier entailment fail → claim 收紧到 flagged。
 *   contradiction   → append 时 S8 落 contradicts 边 + 真 Arbiter 路由（conflict_adjudicated 事件：resolved/escalated）。
 *   stale           → staleDecay 把 value 压穿消费门（recall 召不回）+ Verifier 时效巡查 flag。
 *   near_dup_poison → Reconciler 判 poison → flag + 升级信号（带对端 id，S18 路）。
 *
 * 免疫分作为**维度**（不进任何计分/校准 g/纵向趋势，A3 红线#5）：per-class detected/injected → detectionRate，
 * 经 recordImmunityScore 落 redteam_immunity_scores（与冻结世代同源、独立于校准拟合输入）。
 */
import { randomUUID } from 'node:crypto'

import {
  addSource,
  appendClaim,
  getReconcileEscalations,
  getResolvedConflicts,
  getEditorConflictQueue,
  recallClaims,
  schema,
  transitionClaim,
  type DB,
  type Embedder,
  type EntailmentJudge,
  type EntailmentQuery,
  type EntailmentVerdict,
  type RedTeamClass,
  type RedTeamItem,
  type SourceKind,
} from '@engram/core'
import { eq } from 'drizzle-orm'

import { runVerifier } from '../verifier.js'
import { reconcileBatch } from '../reconciler.js'
import { arbitrateConflicts } from '../arbiter.js'
import type { AgentRuntime } from '../runtime/port.js'

/**
 * Faithful ≥-下界 entailment oracle（与 l1-reconciler 单测同款，**实算非硬编码**）：
 * pass ⟺ evidence(出处) 的下界 ≥ claim(命题) 的下界（更严的出处蕴含更松的命题）。
 *
 *   - false 类（Verifier）：命题=claim、出处=该 claim 自己的 provenance 原文。claim 下界 > 原文下界 ⟹ fail（幻觉逮到）。
 *   - near_dup_poison（Reconciler.objectSubsetViaEntailment）：命题=B(锚/更宽)、出处=A(被审/更细)。
 *     A 被改小 ⟹ A 下界 < B 下界 ⟹ A⊬B ⟹ fail ⟹ poison（逮到）。真精炼 A⊇范围更窄但 ⊆B ⟹ pass ⟹ refines。
 * 无数字 → fail（保守）。每次调用计数，供「点状一次 LLM」断言。
 */
export function makeBoundEntailmentOracle(): EntailmentJudge & { callCount: () => number } {
  let calls = 0
  const lowerBound = (s: string): number => {
    const m = s.match(/(\d+(?:\.\d+)?)/)
    return m ? parseFloat(m[1]!) : NaN
  }
  return {
    version: 'fake:redteam-bound-oracle',
    async judge(q: EntailmentQuery): Promise<EntailmentVerdict> {
      calls += 1
      const claimBound = lowerBound(q.claimText)
      const evidBound = lowerBound(q.evidence[0]?.sourceContent ?? '')
      if (Number.isNaN(claimBound) || Number.isNaN(evidBound)) return 'fail'
      return evidBound >= claimBound ? 'pass' : 'fail'
    },
    callCount: () => calls,
  }
}

/**
 * harness-pi fake model 的极简 Arbiter loop 驱动（确定性、零真模型）：对每对待裁冲突调一次 adjudicate_conflict，
 * 收尾调 finish。胜者由内核确定性阶梯算定（Arbiter 工种内），fake model 只编排「下一步裁哪对」——不选边。
 * 这正是「免疫反应经真 Arbiter 驱动、只把 LLM 隔在端口后」的写法。
 */
export function makeArbiterFakeRuntime(): AgentRuntime {
  return {
    async run({ prompt, tools }) {
      // prompt 末段每行一对 "<a>\t<b>"，逐对调 adjudicate_conflict（与 arbiter.ts renderForLoop 对齐）。
      const adjudicate = tools.find((t) => t.name === 'adjudicate_conflict')
      const finish = tools.find((t) => t.name === 'finish')
      const lines = prompt
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('\t'))
      let turns = 0
      for (const line of lines) {
        const [a, b] = line.split('\t')
        if (adjudicate && a && b) {
          await adjudicate.execute({ claimA: a, claimB: b })
          turns += 1
        }
      }
      if (finish) {
        await finish.execute({})
        turns += 1
      }
      return { reason: 'done', turns }
    },
  }
}

/** 一条样本注入 + 免疫反应的处置（可审计）。 */
export interface InjectionOutcome {
  itemId: string
  redteamClass: RedTeamClass
  /** 注入产生的 claim id（被审/对抗 claim）。 */
  claimId: string
  /** contradiction / near_dup_poison 的既有锚 claim id（若有）。 */
  anchorId?: string
  /** 对应工种的免疫反应是否触发（= 这条被「逮到」）。 */
  detected: boolean
  /** 反应明细（哪个工种、落了什么）——离线诊断，不进计分。 */
  reaction: Record<string, unknown>
}

/** 每类一份打分（detected/injected → detectionRate）。维度报告口径。 */
export interface ClassScore {
  redteamClass: RedTeamClass
  injected: number
  detected: number
  detectionRate: number
  outcomes: InjectionOutcome[]
}

export interface RedTeamRunDeps {
  db: DB
  embedder: Embedder
  /**
   * 测试钩子：被审/对抗 claim 默认挂的独立 supports 源数（默认 INDEPENDENT_SOURCES_PER_CLAIM=4，base≥0.5 可晋升）。
   * 调小到 3 → base=0.487<0.5 → draft→active 晋升门抛错 → 留 draft（复现「独立印证薄、晋升回归」这一真实失败路径，
   * 用于回归测试 near_dup_poison 的 detected 口径不把停在 draft 的 poison 计为检出）。锚的源数不受此影响（锚须晋升 active）。
   */
  itemSourceCount?: number
}

/**
 * 一条对抗 claim 默认挂的**独立 supports 源数**。独立印证 indepSupport(n)=1−0.5^(n−1)，与 authority=1.0 一起把
 * base 抬过 D2 乐观晋升门（0.5）——模拟「攻击者用足够多独立来源把幻觉/投毒乐观地写进 active，事后才被巡查逮到」。
 * n=4：base(auth=1,entailment 中性 0.5)=0.506≥0.5，故 entailmentPass 桩晋升即可清门（无需先写 patrol）。
 */
const INDEPENDENT_SOURCES_PER_CLAIM = 4

/**
 * 入一条源，返回 sourceId。每条都各自成源、不去重——红队样本各自独立印证。
 * EGR-CR-012：content_hash 由内核据 content 自算，故独立性靠**真实 content 差异**——给 content 拼一段
 * 唯一标记（不改 evidence 语义），让 n 条「独立」源真的字节级不同（旧版靠不同随机 hash 抄近路）。
 */
async function injectSource(
  db: DB,
  content: string,
  kind: SourceKind,
  authorityScore: number,
): Promise<string> {
  const { sourceId } = await addSource(db, {
    content: `${content}\n[redteam-source:${randomUUID()}]`,
    kind,
    authorityScore,
  })
  return sourceId
}

/**
 * 给一条 claim 造 n 条**独立** supports 源（不同 contentHash、无 derived_from 血缘 ⇒ independent），都挂 exact。
 * authority=1.0 + n=4 让 base 过 0.5 晋升门（乐观写入）。每条 evidence 相同（Verifier 取最强源 entailment 实算）。
 */
function buildProvenances(
  db: DB,
  evidence: string,
  kind: SourceKind,
  locatorPrefix: string,
  n: number = INDEPENDENT_SOURCES_PER_CLAIM,
): Promise<{ sourceId: string; locator: string; relevance: 'exact' }[]> {
  const tasks = Array.from({ length: n }, async (_unused, i) => ({
    sourceId: await injectSource(db, evidence, kind, 1.0),
    locator: `${locatorPrefix}:${i}`,
    relevance: 'exact' as const,
  }))
  return Promise.all(tasks)
}

async function statusOf(db: DB, claimId: string): Promise<schema.ClaimStatus> {
  const [row] = await db
    .select({ s: schema.claim.status })
    .from(schema.claim)
    .where(eq(schema.claim.id, claimId))
  return row!.s
}

async function contradictsEdgeCount(db: DB, claimId: string): Promise<number> {
  const rows = await db
    .select({
      id: schema.relation.id,
      from: schema.relation.fromClaim,
      to: schema.relation.toClaim,
    })
    .from(schema.relation)
    .where(eq(schema.relation.type, 'contradicts'))
  return rows.filter((r) => r.from === claimId || r.to === claimId).length
}

/**
 * 注入一条 claim（经**真 append_claim**），可选先 seed 一条 active 锚（contradiction / near_dup_poison 用）。
 * 锚要先晋升到 active（既有事实），被审 claim 才能与之产生「活跃」对抗。
 *
 * 被审 claim 与锚都挂 INDEPENDENT_SOURCES_PER_CLAIM 条 authority=1.0 的独立 supports 源 ⇒ base≥0.5 过 D2 乐观晋升门
 * （模拟攻击者用足够多来源把对抗 claim 乐观写进 active，事后才被巡查逮到）。asOf 在 append 时不设远古（fresh 入库、
 * 可晋升）；stale 类的「时效」由 runStale 在晋升后**就地老化** as_of 列模拟（时间流逝，非旁路改状态）。
 */
async function injectClaim(
  deps: RedTeamRunDeps,
  item: RedTeamItem,
): Promise<{ claimId: string; anchorId?: string }> {
  const { db, embedder } = deps
  let anchorId: string | undefined

  // 1) 先 seed 既有 active 锚（若有）：append → 蓝边 promote 晋升 active（评测=消费，不旁路改状态）。
  if (item.anchor) {
    const a = item.anchor
    const anchorProvs = await buildProvenances(
      db,
      a.evidence,
      a.sourceKind as SourceKind,
      `redteam:anchor:${item.id}`,
    )
    const appended = await appendClaim(
      db,
      embedder,
      {
        claimText: a.claimText,
        ...(a.subject !== undefined ? { subject: a.subject } : {}),
        ...(a.predicate !== undefined ? { predicate: a.predicate } : {}),
        ...(a.object !== undefined ? { object: a.object } : {}),
        createdBy: 'agent:distiller',
      },
      anchorProvs,
    )
    anchorId = appended.claimId
    // 锚晋升 active（蓝边 promote，需 conf≥0.5 ∧ entailmentPass）——锚 evidence 蕴含锚 claim，pass 合法。
    await transitionClaim(db, anchorId, 'active', { by: 'agent:distiller', entailmentPass: true })
  }

  // 2) 注入被审/对抗 claim（经真 append_claim：D1 强制出处、S8 同事实落 contradicts 边、连续 confidence）。
  //    源数默认 INDEPENDENT_SOURCES_PER_CLAIM；测试可经 deps.itemSourceCount 调小以复现「独立印证薄→晋升不过门」。
  const provs = await buildProvenances(
    db,
    item.evidence,
    item.sourceKind as SourceKind,
    `redteam:item:${item.id}`,
    deps.itemSourceCount ?? INDEPENDENT_SOURCES_PER_CLAIM,
  )
  const appended = await appendClaim(
    db,
    embedder,
    {
      claimText: item.claimText,
      ...(item.subject !== undefined ? { subject: item.subject } : {}),
      ...(item.predicate !== undefined ? { predicate: item.predicate } : {}),
      ...(item.object !== undefined ? { object: item.object } : {}),
      createdBy: 'agent:distiller',
    },
    provs,
  )
  return anchorId !== undefined
    ? { claimId: appended.claimId, anchorId }
    : { claimId: appended.claimId }
}

/** 就地把一条 claim 的 as_of 老化到给定时点（模拟时间流逝，非旁路改状态/置信）。staleDecay 据它现算。 */
async function ageClaimInPlace(db: DB, claimId: string, asOf: Date): Promise<void> {
  await db.update(schema.claim).set({ asOf }).where(eq(schema.claim.id, claimId))
}

/**
 * false 类免疫：注入后跑**真 Verifier**（fake bound-oracle 实算 entailment fail）→ claim 被收紧到 flagged。
 * 被审 claim 先晋升 active（Verifier 才能 active→flagged），晋升时不让 oracle 介入（用 entailmentPass=true 桩晋升），
 * 然后真 Verifier 第二轮用 oracle 实算 → fail → flagged。detected = 最终 status===flagged。
 */
async function runFalse(deps: RedTeamRunDeps, item: RedTeamItem): Promise<InjectionOutcome> {
  const { db } = deps
  const { claimId } = await injectClaim(deps, item)
  // 晋升 active（桩 entailmentPass：晋升不是免疫断言点，免疫点是 Verifier 把**活跃**幻觉收紧到 flagged）。
  // **断言晋升真成功**：若 D2 floor 耦合（auth/indepSupport/PROMOTE_FLOOR 常量）变动让它停在 draft，则**大声失败**——
  // 而不是把「judge 说 fail 但停 draft」当弱检出蒙混过去（gate#1 test-review/linus：draft 兜底会掩盖晋升路径回归）。
  await transitionClaim(db, claimId, 'active', { by: 'agent:distiller', entailmentPass: true })
  const promoted = await statusOf(db, claimId)
  if (promoted !== 'active') {
    throw new Error(
      `runFalse: claim ${claimId} failed to promote to active (got '${promoted}') — D2 floor coupling broke; ` +
        `the false-class immune point requires an ACTIVE hallucination for the Verifier to flag.`,
    )
  }
  const judge = makeBoundEntailmentOracle()
  const res = await runVerifier({ db, judge }, { claimIds: [claimId], maxClaims: 50 })
  const finalStatus = await statusOf(db, claimId)
  // 逮到 = 真 Verifier 用 oracle 实算 fail 并把活跃幻觉 active→flagged（入 Verifier 前已断言是 active，故无 draft 弱判据）。
  const outcome = res.outcomes.find((o) => o.claimId === claimId)
  const detected = finalStatus === 'flagged'
  return {
    itemId: item.id,
    redteamClass: 'false',
    claimId,
    detected,
    reaction: { worker: 'verifier', entailment: outcome?.entailment ?? null, finalStatus },
  }
}

/**
 * contradiction 类免疫：注入与既有 active 锚同 subject+predicate、object 反向的 claim → append 时 S8 落 contradicts 边
 * → 跑**真 Arbiter**（harness-pi fake runtime 编排，胜者确定性）路由这对 → 落 conflict_adjudicated 事件（resolved/escalated）。
 * detected = (append 落了 contradicts 边) ∧ (Arbiter 对这对产出了裁决/升级)。被审 claim 也需先晋升 active（活跃矛盾）。
 */
async function runContradiction(
  deps: RedTeamRunDeps,
  item: RedTeamItem,
): Promise<InjectionOutcome> {
  const { db } = deps
  const injected = await injectClaim(deps, item)
  const { claimId, anchorId } = injected
  // 被审 claim 晋升 active（活跃矛盾 = 双方 active；Arbiter 只裁 active↔active）。
  try {
    await transitionClaim(db, claimId, 'active', { by: 'agent:distiller', entailmentPass: true })
  } catch {
    /* 留 draft：仍可断言 contradicts 边已落（S8），但 Arbiter 不裁非 active 对 */
  }
  const edgeBefore = await contradictsEdgeCount(db, claimId)
  // 真 Arbiter 路由这对（harness-pi fake runtime + 内核确定性阶梯）。
  const runtime = makeArbiterFakeRuntime()
  const arb =
    anchorId !== undefined
      ? await arbitrateConflicts({ db, runtime }, [[claimId, anchorId]])
      : { resolved: 0, escalated: 0, skipped: 0 }
  // 该对是否被 Arbiter 真路由（机判自裁 or 升级主编都算「免疫反应触发」）。
  const resolved = await getResolvedConflicts(db)
  const escalated = await getEditorConflictQueue(db)
  const pairTouched =
    anchorId !== undefined &&
    [...resolved, ...escalated].some(
      (e) =>
        (e.payload.claimA === claimId && e.payload.claimB === anchorId) ||
        (e.payload.claimA === anchorId && e.payload.claimB === claimId),
    )
  const detected = edgeBefore > 0 && pairTouched
  return {
    itemId: item.id,
    redteamClass: 'contradiction',
    claimId,
    ...(anchorId !== undefined ? { anchorId } : {}),
    detected,
    reaction: {
      worker: 'arbiter',
      contradictsEdges: edgeBefore,
      arbiterResolved: arb.resolved,
      arbiterEscalated: arb.escalated,
    },
  }
}

const ANCIENT_ASOF = new Date('1999-01-01T00:00:00.000Z')

/**
 * stale 类免疫（**两道防线**，各在其语义恰当的设置上验真——置信快照在写时冻结，故两防线天然分两路）：
 *
 *   ① D2 消费门（staleDecay 写时冻结）：写一条 **as_of 远古** 的对抗 claim → 其 staleDecay 冻在很低值 → raw < 晋升门
 *      ⇒ 连 active 都晋不上（乐观门已挡）；即便强行也召不回。对照：同一事实 fresh 写入则能晋升 active 且被 recall 召回。
 *      故断言 = staleClaim **召不回（且晋不上 active）** 而 freshControl **能召回** —— 是时效把 value 压穿门、非别的。
 *   ② D3 Verifier 时效巡查（按 live as_of 现算）：写 fresh → 晋升 active → **就地老化** as_of（时间流逝）→ 真 Verifier
 *      巡查按 live as_of 判 stale（年龄 > 半衰期）→ active→flagged。断言 = stale=true ∧ finalStatus='flagged'。
 *
 * detected = 两道防线都触发（消费门压穿 ∧ 巡查 flag）。reaction.recalled 记的是 staleClaim 是否被召回（应 false）。
 */
async function runStale(deps: RedTeamRunDeps, item: RedTeamItem): Promise<InjectionOutcome> {
  const { db, embedder } = deps
  const ancient = item.asOf ? new Date(item.asOf) : ANCIENT_ASOF

  // ── ① D2 消费门：写一条 as_of 远古的对抗 claim（staleDecay 写时冻在低值）。 ──
  const staleProvs = await buildProvenances(
    db,
    item.evidence,
    item.sourceKind as SourceKind,
    `redteam:stale:${item.id}`,
  )
  const stale = await appendClaim(
    db,
    embedder,
    {
      claimText: item.claimText,
      ...(item.subject !== undefined ? { subject: item.subject } : {}),
      ...(item.predicate !== undefined ? { predicate: item.predicate } : {}),
      ...(item.object !== undefined ? { object: item.object } : {}),
      asOf: ancient, // 写时即远古 → staleDecay 冻在低值 → 乐观晋升门挡下
      createdBy: 'agent:distiller',
    },
    staleProvs,
  )
  // 乐观晋升门：staleDecay 压低 raw → 晋不上 active（D2 已挡）。能晋上则这条防线失守。
  let promoted = true
  try {
    await transitionClaim(db, stale.claimId, 'active', {
      by: 'agent:distiller',
      entailmentPass: true,
    })
  } catch {
    promoted = false // 预期：staleDecay 把 raw 压穿 0.5 晋升门
  }
  // 对照：同一事实 fresh 写入 → 能晋升 active → 被 recall 召回（证明召不回是时效所致、非别的）。
  const freshProvs = await buildProvenances(
    db,
    item.evidence,
    item.sourceKind as SourceKind,
    `redteam:stale-control:${item.id}`,
  )
  const fresh = await appendClaim(
    db,
    embedder,
    {
      claimText: item.claimText,
      ...(item.subject !== undefined ? { subject: item.subject } : {}),
      ...(item.predicate !== undefined ? { predicate: item.predicate } : {}),
      ...(item.object !== undefined ? { object: item.object } : {}),
      createdBy: 'agent:distiller',
    },
    freshProvs,
  )
  await transitionClaim(db, fresh.claimId, 'active', {
    by: 'agent:distiller',
    entailmentPass: true,
  })
  const hits = await recallClaims(db, embedder, item.claimText)
  const staleRecalled = hits.some((h) => h.claim.id === stale.claimId)
  const freshRecalled = hits.some((h) => h.claim.id === fresh.claimId)
  const consumeGateHeld = !promoted && !staleRecalled && freshRecalled

  // ── ② D3 Verifier 时效巡查：fresh → active → 就地老化 → 真 Verifier 巡查 flag。 ──
  // 复用上面的 fresh active claim：把它就地老化（时间流逝），再跑真 Verifier（巡查按 live as_of 判 stale）。
  await ageClaimInPlace(db, fresh.claimId, ancient)
  const judge = makeBoundEntailmentOracle()
  const res = await runVerifier({ db, judge }, { claimIds: [fresh.claimId], maxClaims: 50 })
  const outcome = res.outcomes.find((o) => o.claimId === fresh.claimId)
  const finalStatus = await statusOf(db, fresh.claimId)
  const patrolFlagged = outcome?.stale === true && finalStatus === 'flagged'

  const detected = consumeGateHeld && patrolFlagged
  return {
    itemId: item.id,
    redteamClass: 'stale',
    claimId: stale.claimId,
    detected,
    reaction: {
      worker: 'verifier',
      stalePromoted: promoted,
      recalled: staleRecalled,
      freshRecalled,
      stale: outcome?.stale ?? null,
      finalStatus,
    },
  }
}

/**
 * near_dup_poison 类免疫：注入伪装成「精炼」但 object 被悄悄改小的 claim（同 subject、相似度近既有锚）→ 跑**真 Reconciler**
 * → objectSubsetViaEntailment 实算 A⊄B → poison → flag(active→flagged) + 升级信号（带对端 anchorId，S18）。
 * detected = 记了带 anchorId 的 escalation ∧ Reconciler 判 poison ∧ **claim 真被收紧到 flagged**（口径与 runFalse 对齐）。
 * 被审 claim 先晋升 active（poison 才能 active→flagged）；晋升失败留 draft 时由 promotionFailed 显式标注、且**不计**检出
 * （EGR-CR-050：停在 draft、从未被 flag 的 poison 只是 escalation-only 诊断，不能虚高计检出）。
 */
export async function runNearDupPoison(
  deps: RedTeamRunDeps,
  item: RedTeamItem,
): Promise<InjectionOutcome> {
  const { db } = deps
  const injected = await injectClaim(deps, item)
  const { claimId, anchorId } = injected
  // 晋升 active 失败不再静默吞掉：显式记 promotionFailed（晋升回归 / D2 floor 耦合 / entailment 不过门时留 draft）。
  // draft→flagged 非法（A.4），故留 draft；但 escalation 仍会记（信号不丢）——见下方 detected 口径与 reaction.promotionFailed。
  let promotionFailed = false
  try {
    await transitionClaim(db, claimId, 'active', { by: 'agent:distiller', entailmentPass: true })
  } catch {
    promotionFailed = true
  }
  const judge = makeBoundEntailmentOracle()
  const res = await reconcileBatch({ db, judge }, [claimId])
  const escalations = await getReconcileEscalations(db, claimId)
  const escalatedToAnchor =
    anchorId !== undefined && escalations.some((e) => e.conflictsWith === anchorId)
  const finalStatus = await statusOf(db, claimId)
  // 逮到 = Reconciler 判 poison ∧ 记了带对端 id 的升级信号 ∧ claim **真被收紧到 flagged**。
  // 停在 draft 的 poison（escalation 记了但未收紧）不计检出——口径与 runFalse 的 detected=finalStatus==='flagged' 对齐，
  // 防「晋升回归让 poison 留影子区」时这条评测仍虚报满分检出（EGR-CR-050）。escalation-only 诊断由 reaction 的
  // escalatedToAnchor && !flagged 表达，无需新增独立维度。
  const poisonPair = res.pairs.find((p) => p.claimId === claimId && p.verdict === 'poison')
  const detected = escalatedToAnchor && poisonPair !== undefined && finalStatus === 'flagged'
  return {
    itemId: item.id,
    redteamClass: 'near_dup_poison',
    claimId,
    ...(anchorId !== undefined ? { anchorId } : {}),
    detected,
    reaction: {
      worker: 'reconciler',
      verdict: poisonPair?.verdict ?? null,
      flagged: finalStatus === 'flagged',
      escalatedToAnchor,
      promotionFailed,
    },
  }
}

/** 路由一条样本到它的注入器（按类别）。 */
export async function injectAndAssert(
  deps: RedTeamRunDeps,
  item: RedTeamItem,
): Promise<InjectionOutcome> {
  switch (item.redteamClass) {
    case 'false':
      return runFalse(deps, item)
    case 'contradiction':
      return runContradiction(deps, item)
    case 'stale':
      return runStale(deps, item)
    case 'near_dup_poison':
      return runNearDupPoison(deps, item)
    default: {
      const _exhaustive: never = item.redteamClass
      throw new Error(`unknown redteam class: ${String(_exhaustive)}`)
    }
  }
}

/**
 * 跑整个世代的红队注入 → per-class 打分（detected/injected → detectionRate）。
 * resetDb 在**每条样本前**清库：每条对抗样本独立注入（互不串扰），与 l1-reconciler golden 的 per-item 隔离同款。
 *
 * **后置不变量（EGR-CR-049）**：调用返回后 work tables 已清空——`finally` 在正常返回与异常抛出两条路径上都补一次
 * resetDb，兜底清掉最后一条样本（红队 item 都是故意构造的毒株）。caller 拿回的永远是干净 DB，**无需**自己后清。
 * 取舍：不保留最后样本供调试（诊断应走返回的 outcome 快照，而非靠脏库）。
 */
export async function runRedTeamGeneration(
  deps: RedTeamRunDeps,
  items: readonly RedTeamItem[],
  resetDb: () => Promise<void>,
): Promise<ClassScore[]> {
  const byClass = new Map<RedTeamClass, InjectionOutcome[]>()
  try {
    for (const item of items) {
      await resetDb()
      const outcome = await injectAndAssert(deps, item)
      const list = byClass.get(item.redteamClass) ?? []
      list.push(outcome)
      byClass.set(item.redteamClass, list)
    }
    const scores: ClassScore[] = []
    for (const [redteamClass, outcomes] of byClass) {
      const injected = outcomes.length
      const detected = outcomes.filter((o) => o.detected).length
      scores.push({
        redteamClass,
        injected,
        detected,
        detectionRate: injected === 0 ? 0 : detected / injected,
        outcomes,
      })
    }
    return scores
  } finally {
    // 返回前（含异常路径）兜底清掉最后一条样本：把「返回后 DB 干净」从隐性契约升级为单点强制的不变量。
    await resetDb()
  }
}
