/**
 * 归因脊柱（S31，P3 门，A.9 stories 47/49/51，设计稿 FIG 10c「失败按根因分流 = 派工单」）——
 * **单环失败归因**：把任一已落库的系统级失败**确定性地**追溯回**恰好一个** loop/工种。
 *
 * 设计稿 FIG 10c 的根因四分流（不只是扣分，是派工单）正是这四类责任环：
 *   - 缺知识 → ingestion（红队=缺口发现引擎）        ↔ **Distiller 抽错**（claim 被错误蒸馏 / 出处对不齐）
 *   - 错知识 → 免疫信号（注入测试）                  ↔ **Verifier 漏检**（该 flag 没 flag）
 *   - 召回了用错 → consumption                       ↔ **Arbiter 裁错**（裁了错的赢家）
 *   - 自信却错 → 校准信号 → g（红队=g 的梯度来源）   ↔ **calibration 漂移**（g 过自信：值高但错）
 *
 * **失败的三个来路**（已落库的真实失败，零评测专用路径——全是别的切片产的事件）：
 *   ① 反流回归项（S11 reflux）：usage_truth outcome∈{refuted,corrected} → regression_pool。
 *   ② 红队突破（S29 redteam）：一个该被对应工种逮到却**漏检**的毒株（detected<injected ⇒ breach）。
 *   ③ 人翻案的误隔离（S22 human_overturn，overturn='un_quarantine'）：agent 误隔离、被人解隔离。
 *
 * **归因输入**（by_role + 谱系 + metrics 事件，全是只读现有切片落的库）：
 *   - by_role：claim.created_by（运动员=蒸馏者身份）/ claim_verification.by_role（裁判=Verifier 巡查身份）/
 *     conflict_adjudicated.payload.byRole（Arbiter 裁决身份）/ human_overturn.payload.byRole（人）。
 *   - 谱系：claim_provenance（出处对齐——Distiller 抽错的判据）+ relation type='supersedes'/'contradicts'。
 *   - 事件：getResolvedConflicts（Arbiter 裁了哪对、谁赢）/ getMetricsEvents（ruling_refused 等）。
 *
 * **恰好一个**（P3 门的判据）：失败**不得**归因到零个或多个环。每条失败先按其**来路类型**确定一个**主责环**，
 * 同来路可能命中多条证据时用一张**确定性优先级表**（PRECEDENCE）裁，永远落到**单一**环。**确定性**：同一条已落库
 * 失败 → 同一单一责任环，每次都一样（纯读 + 纯函数，无随机、无时钟依赖、无并发态读）。
 *
 * **A3 红线**：归因只读 by_role/谱系/事件，**绝不**读任何 ELO/胜负率/reward——责任环判定与奖励信号无关。
 */
import { and, asc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { claim, claimProvenance, claimVerification, relation } from '../db/schema.js'
import { getResolvedConflicts } from '../spi/conflict-arbiter.js'
import { getHumanOverturns } from '../editor/human-overturn.js'
import { getRegressionPool, type RegressionItem } from '../spi/reflux.js'
import { getImmunityScores, type RedTeamClass } from '../spi/redteam-generation.js'

/**
 * 四个责任环（与设计稿 FIG 10c 的根因四分流一一对齐；纯文本标签，内核不解释其领域语义）。
 * 这是「单环」的取值域——每条失败**恰好**落其中一个。
 */
export const RESPONSIBLE_LOOP = Object.freeze({
  /** Distiller 抽错：claim 被错误蒸馏（出处对不齐 / 凭空抽）—— 设计稿「缺知识→ingestion」侧。 */
  distillerMisExtract: 'distiller_mis_extract',
  /** Verifier 漏检：该 flag/逮的毒株没逮到 —— 设计稿「错知识→免疫信号」侧。 */
  verifierMiss: 'verifier_miss',
  /** Arbiter 裁错：裁了错的赢家 —— 设计稿「召回了用错→consumption」侧。 */
  arbiterMisAdjudicate: 'arbiter_mis_adjudicate',
  /** calibration 漂移：g 过自信（值高却错）—— 设计稿「自信却错→校准信号→g」侧。 */
  calibrationDrift: 'calibration_drift',
} as const)

export type ResponsibleLoop = (typeof RESPONSIBLE_LOOP)[keyof typeof RESPONSIBLE_LOOP]

export const RESPONSIBLE_LOOPS: readonly ResponsibleLoop[] = Object.freeze(
  Object.values(RESPONSIBLE_LOOP),
) as readonly ResponsibleLoop[]

/**
 * **确定性优先级表**（tie-break）：当一条失败的证据同时命中多个环时，按此**固定顺序**取**第一个**命中的环，
 * 保证恰好一个、且可复现。顺序的由来（最具体的根因优先于最泛化的）：
 *   1. distiller_mis_extract —— 出处对齐是最上游的根因：claim 一旦抽错（无出处对齐的源），下游全错；最具体，先归它。
 *   2. arbiter_mis_adjudicate —— 裁错赢家是「这条失败 claim 是某次冲突的败者本应赢/赢家本应败」的结构性证据，比
 *      「漏检」更具体（有一条具名 resolved 裁决指向它），故先于 verifier。
 *   3. verifier_miss —— 「该 flag 没 flag」是较泛的兜底：claim 出处对齐、又不是某次误裁的产物，却仍错 ⇒ 巡查漏检。
 *   4. calibration_drift —— 最泛：claim 出处齐、非误裁、有过 Verifier 巡查（没漏检），却**高自信地**错 ⇒ 是 g 过自信。
 * 这张表是**单环判据的唯一裁决处**：任何来路最终都经它收敛到单一环（见 attributeFailure）。
 */
export const PRECEDENCE: readonly ResponsibleLoop[] = Object.freeze([
  RESPONSIBLE_LOOP.distillerMisExtract,
  RESPONSIBLE_LOOP.arbiterMisAdjudicate,
  RESPONSIBLE_LOOP.verifierMiss,
  RESPONSIBLE_LOOP.calibrationDrift,
])

/** 一条失败的三种来路（已落库的真实失败事件类型）。 */
export type FailureKind = 'reflux_regression' | 'redteam_breach' | 'human_overturn_mis_quarantine'

/** 一条待归因的失败（来路 + 锚 id；归因函数据此只读相应切片的库）。 */
export type FailureInput =
  | {
      kind: 'reflux_regression'
      /** regression_pool 行 id（S11）。 */
      regressionId: string
    }
  | {
      kind: 'redteam_breach'
      /** 漏检的冻结世代 version（S29）。 */
      generationVersion: string
      /** 漏检的对抗类别（detected<injected 的那一类）。 */
      redteamClass: RedTeamClass
    }
  | {
      kind: 'human_overturn_mis_quarantine'
      /** human_overturn 事件 id（S22，overturn='un_quarantine'）。 */
      overturnEventId: string
    }

/** 归因到单一责任环的裁决（含为何——可审计、可复现）。 */
export interface Attribution {
  /** 失败来路。 */
  failureKind: FailureKind
  /** 失败锚（regressionId / `${gen}:${class}` / overturnEventId），同一锚恒得同一归因。 */
  failureRef: string
  /** **恰好一个**责任环（P3 门）。 */
  responsibleLoop: ResponsibleLoop
  /** 命中的全部候选环（按 PRECEDENCE 顺序；responsibleLoop = candidates[0]）。审计单环裁决用。 */
  candidates: ResponsibleLoop[]
  /** 人读理由（凭何归此环）。 */
  reason: string
  /** 失败牵连的 claim（reflux/overturn 有；redteam_breach 无具体 claim ⇒ null）。 */
  claimId: string | null
}

/** 把候选集按 PRECEDENCE 排序、取第一个 —— **单环收敛的唯一裁决处**。空集是编程错（每来路都至少给一个候选）。 */
function pickSingleLoop(candidates: Set<ResponsibleLoop>): ResponsibleLoop[] {
  const ordered = PRECEDENCE.filter((l) => candidates.has(l))
  if (ordered.length === 0) {
    throw new Error(
      'attributeFailure: no responsible loop resolved (a failure must attribute to exactly one)',
    )
  }
  return ordered
}

/**
 * 判 claim 是否「出处对不齐」（Distiller 抽错的判据）：**结构上没有任何 exact/supporting 出处**。
 * D1 保证活 claim ≥1 出处行，但出处的 relevance 可以是 tangential/irrelevant —— 那等于「抽了 claim 却没对齐到
 * 真正支撑它的源」，正是 Distiller 抽错。确定性纯读。
 */
async function isMisaligned(db: DB, claimId: string): Promise<boolean> {
  const provs = await db
    .select({ relevance: claimProvenance.relevance })
    .from(claimProvenance)
    .where(eq(claimProvenance.claimId, claimId))
  if (provs.length === 0) return true
  return !provs.some((p) => p.relevance === 'exact' || p.relevance === 'supporting')
}

/**
 * 判 claim 是否「被某次 resolved 冲突裁为败者」：存在一条 conflict_adjudicated(resolved) 其 loserId === 该 claim。
 * **极性（EGR-CR-057）**：这只是「该 claim 在裁决里是输方」的事实，是否构成 Arbiter 裁错取决于来路——
 *   - human_overturn（误隔离的好 claim）：好 claim 被判输 ⇒ Arbiter 把好 claim 压下 ⇒ **裁错**，用本判据。
 *   - reflux（被证伪的错 claim）：错 claim 被判输是**正确**裁决，不是裁错 ⇒ 用 wasAdjudicatedWinner。
 * 确定性纯读（getResolvedConflicts 已按 (created_at,id) 排序）。
 */
async function wasAdjudicatedLoser(db: DB, claimId: string): Promise<boolean> {
  const resolved = await getResolvedConflicts(db)
  return resolved.some((r) => r.payload.loserId === claimId)
}

/**
 * 判 claim 是否「被某次 resolved 冲突裁为赢家」：存在一条 conflict_adjudicated(resolved) 其 winnerId === 该 claim。
 * **极性（EGR-CR-057）**：对 reflux 的失败 claim（usage truth 证伪的错 claim），「被 Arbiter 捧成赢家」才是真·裁错
 * （把错的捧成赢家），故 reflux 用本判据而非 wasAdjudicatedLoser。与 wasAdjudicatedLoser 对称、复用同一只读源。
 * 确定性纯读（getResolvedConflicts 已按 (created_at,id) 排序）。
 */
async function wasAdjudicatedWinner(db: DB, claimId: string): Promise<boolean> {
  const resolved = await getResolvedConflicts(db)
  return resolved.some((r) => r.payload.winnerId === claimId)
}

/**
 * 判 claim 是否「从未被 Verifier 巡查过」（Verifier 漏检的判据）：没有任何 claim_verification(kind='patrol')。
 * 有 usage_truth 但无 patrol ⇒ 这条 claim 进了消费、出了事，却从没被巡查工种看过一眼 ⇒ 漏检。确定性纯读。
 */
async function wasNeverPatrolled(db: DB, claimId: string): Promise<boolean> {
  const rows = await db
    .select({ id: claimVerification.id })
    .from(claimVerification)
    .where(and(eq(claimVerification.claimId, claimId), eq(claimVerification.kind, 'patrol')))
    .limit(1)
  return rows.length === 0
}

/**
 * 「Arbiter 裁错」判据的**极性（EGR-CR-057）**：失败 claim 在裁决里应处的角色——
 *   - `'won'`（reflux）：失败 claim = 被证伪的**错** claim ⇒ Arbiter 把它捧成赢家才是裁错（读 winnerId）。
 *   - `'lost'`（human_overturn）：失败 claim = 被误隔离的**好** claim ⇒ Arbiter 把它判输才是裁错（读 loserId）。
 * 不能用一个判据套所有来路——两条来路里失败 claim 的「对错」相反，故 Arbiter 裁错的极性也相反。
 */
export type ArbiterMisAdjudicateWhen = 'won' | 'lost'

/**
 * 一条牵连具体 claim 的失败（reflux / overturn）的**候选环**集合。四个判据各自确定性、互不依赖顺序；
 * 收敛由 PRECEDENCE 在 pickSingleLoop 里做。**至少给一个**候选（calibration_drift 是兜底环——出处齐、非误裁、
 * 巡查过却仍错，只剩「g 过自信」一种解释），故空集不可能。
 * `opts.arbiterMisAdjudicateWhen` 显式指定 Arbiter 裁错极性（见 ArbiterMisAdjudicateWhen），由来路决定。
 */
async function loopCandidatesForClaim(
  db: DB,
  claimId: string,
  opts: { arbiterMisAdjudicateWhen: ArbiterMisAdjudicateWhen },
): Promise<Set<ResponsibleLoop>> {
  const candidates = new Set<ResponsibleLoop>()
  if (await isMisaligned(db, claimId)) candidates.add(RESPONSIBLE_LOOP.distillerMisExtract)
  const arbiterMisAdjudicated =
    opts.arbiterMisAdjudicateWhen === 'won'
      ? await wasAdjudicatedWinner(db, claimId)
      : await wasAdjudicatedLoser(db, claimId)
  if (arbiterMisAdjudicated) candidates.add(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
  if (await wasNeverPatrolled(db, claimId)) candidates.add(RESPONSIBLE_LOOP.verifierMiss)
  // 兜底：以上皆否（出处齐 + 非误裁 + 巡查过）却仍是失败 claim ⇒ 只剩 g 过自信（calibration 漂移）。
  if (candidates.size === 0) candidates.add(RESPONSIBLE_LOOP.calibrationDrift)
  return candidates
}

/**
 * **单环失败归因**（P3 门）：把一条已落库的失败追溯回**恰好一个**责任环。确定性、纯读、可复现。
 * 失败锚不存在 / 来路非法 → 抛（不吐零环也不吐多环——恰好一个是硬契约）。
 */
export async function attributeFailure(db: DB, input: FailureInput): Promise<Attribution> {
  switch (input.kind) {
    case 'reflux_regression': {
      const pool = await getRegressionPool(db)
      const item: RegressionItem | undefined = pool.find((p) => p.id === input.regressionId)
      if (!item) {
        throw new Error(`attributeFailure: regression item ${input.regressionId} not found`)
      }
      // EGR-CR-057 极性='won'：reflux 失败 claim 是被证伪的错 claim ⇒ Arbiter 把它捧成赢家才是裁错。
      const candidates = pickSingleLoop(
        await loopCandidatesForClaim(db, item.claimId, { arbiterMisAdjudicateWhen: 'won' }),
      )
      return {
        failureKind: 'reflux_regression',
        failureRef: item.id,
        responsibleLoop: candidates[0]!,
        candidates,
        reason: reasonFor(candidates[0]!, item.claimId, `reflux outcome=${item.outcome}`, 'won'),
        claimId: item.claimId,
      }
    }
    case 'redteam_breach': {
      // 红队突破 = 某世代某类 detected<injected（漏检了对抗样本）。这是**注入测试**侧的失败：
      // 注入的毒株该被对应工种逮到却漏 ⇒ 责任环由**对抗类别**确定性映射（与四注入器对齐），无 claim 牵连。
      const scores = await getImmunityScores(db, input.generationVersion, input.redteamClass)
      if (scores.length === 0) {
        throw new Error(
          `attributeFailure: no immunity score for generation '${input.generationVersion}' class '${input.redteamClass}'`,
        )
      }
      // 取该 (世代,类) 最新一行（getImmunityScores 已按 (created_at,id) 升序 ⇒ 末元素最新）。
      const latest = scores[scores.length - 1]!
      if (latest.detected >= latest.injected) {
        throw new Error(
          `attributeFailure: generation '${input.generationVersion}' class '${input.redteamClass}' has no breach (detected ${latest.detected} >= injected ${latest.injected})`,
        )
      }
      const loop = loopForRedTeamClass(input.redteamClass)
      return {
        failureKind: 'redteam_breach',
        failureRef: `${input.generationVersion}:${input.redteamClass}`,
        responsibleLoop: loop,
        candidates: [loop],
        reason: `redteam breach: class '${input.redteamClass}' detected ${latest.detected}/${latest.injected} → ${loop}`,
        claimId: null,
      }
    }
    case 'human_overturn_mis_quarantine': {
      const all = await getHumanOverturns(db)
      const ov = all.find((o) => o.eventId === input.overturnEventId)
      if (!ov) {
        throw new Error(`attributeFailure: human_overturn ${input.overturnEventId} not found`)
      }
      if (ov.payload.overturn !== 'un_quarantine') {
        throw new Error(
          `attributeFailure: overturn ${input.overturnEventId} is '${ov.payload.overturn}', only un_quarantine is a mis-quarantine failure`,
        )
      }
      // 人解隔离 = agent 误隔离了一条本该 active 的**好** claim。误隔离的根因经同一张 claim 证据表归因（确定性）。
      // EGR-CR-057 极性='lost'：好 claim 被 Arbiter 判输才是裁错（把好 claim 压下）——与 reflux 相反。
      const claimId = ov.payload.claimId
      const candidates = pickSingleLoop(
        await loopCandidatesForClaim(db, claimId, { arbiterMisAdjudicateWhen: 'lost' }),
      )
      return {
        failureKind: 'human_overturn_mis_quarantine',
        failureRef: ov.eventId,
        responsibleLoop: candidates[0]!,
        candidates,
        reason: reasonFor(
          candidates[0]!,
          claimId,
          'human un-quarantined a mis-quarantined claim',
          'lost',
        ),
        claimId,
      }
    }
    default: {
      // 穷尽（never）：来路是 union，新增来路必须在此显式处理（不静默落空）。
      const _exhaustive: never = input
      throw new Error(`attributeFailure: unknown failure kind ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/**
 * 红队四类 → 责任环的**确定性映射**（与四注入器/设计稿对齐）：
 *   - false / near_dup_poison → Verifier 漏检：注入的「假/近重毒株」该被巡查工种 entailment 验真逮到。
 *   - contradiction          → Arbiter 裁错：矛盾注入该被冲突裁决逮到（裁了错的赢家 ⇒ 漏了这条矛盾）。
 *   - stale                  → calibration 漂移：陈旧注入该被时效衰减压下消费门（g 没把它的自信压下 ⇒ 过自信）。
 * 每类**恰好一个**环（单环），无 claim 牵连故不走 claim 证据表。
 */
export function loopForRedTeamClass(klass: RedTeamClass): ResponsibleLoop {
  switch (klass) {
    case 'false':
    case 'near_dup_poison':
      return RESPONSIBLE_LOOP.verifierMiss
    case 'contradiction':
      return RESPONSIBLE_LOOP.arbiterMisAdjudicate
    case 'stale':
      return RESPONSIBLE_LOOP.calibrationDrift
    default: {
      const _exhaustive: never = klass
      throw new Error(`loopForRedTeamClass: unknown class ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/** 组装人读理由（凭何归此环）。`arbiterWhen` 决定 Arbiter 裁错理由的极性（EGR-CR-057）。 */
function reasonFor(
  loop: ResponsibleLoop,
  claimId: string,
  context: string,
  arbiterWhen: ArbiterMisAdjudicateWhen,
): string {
  const arbiterWhy =
    arbiterWhen === 'won'
      ? `claim ${claimId} was crowned the winner of a resolved conflict yet proved wrong (wrong winner adjudicated)`
      : `claim ${claimId} was the loser of a resolved conflict yet was a good claim (a good claim wrongly ruled down)`
  const why: Record<ResponsibleLoop, string> = {
    distiller_mis_extract: `claim ${claimId} has no exact/supporting provenance (mis-extracted / mis-aligned)`,
    arbiter_mis_adjudicate: arbiterWhy,
    verifier_miss: `claim ${claimId} was never patrolled by the Verifier (should have flagged, didn't)`,
    calibration_drift: `claim ${claimId} was grounded, patrolled, not mis-adjudicated, yet wrong (g over-confident)`,
  }
  return `${context}: ${why[loop]}`
}

/**
 * （工具）一条 claim 的当前 created_by（蒸馏者运动员身份）—— 审计 by_role 归因半边用，确定性纯读。
 * 归因主路径用的是**结构性谱系/事件**（出处对齐/裁决/巡查），created_by 是辅助审计锚（谁抽的）。
 */
export async function claimCreatedBy(db: DB, claimId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: claim.createdBy })
    .from(claim)
    .where(eq(claim.id, claimId))
    .limit(1)
  return row?.createdBy ?? null
}

/**
 * （工具）一条 claim 经 supersedes/contradicts 边牵连的对端集合 —— 谱系归因审计用，确定性纯读（按 to/from 升序）。
 * 归因不直接用它（主判据是出处对齐 + resolved 裁决），但暴露给消费方做谱系可视化/二次核验。
 */
export async function lineageEdges(
  db: DB,
  claimId: string,
): Promise<{ supersedes: string[]; contradicts: string[] }> {
  const rows = await db
    .select({ from: relation.fromClaim, to: relation.toClaim, type: relation.type })
    .from(relation)
    .where(eq(relation.fromClaim, claimId))
    .orderBy(asc(relation.type), asc(relation.toClaim))
  const supersedes: string[] = []
  const contradicts: string[] = []
  for (const r of rows) {
    if (r.to == null) continue
    if (r.type === 'supersedes') supersedes.push(r.to)
    else if (r.type === 'contradicts') contradicts.push(r.to)
  }
  return { supersedes, contradicts }
}
