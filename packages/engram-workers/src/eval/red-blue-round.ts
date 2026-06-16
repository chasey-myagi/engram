/**
 * P4a · 红蓝对抗回合编排（北极星 MVP 形态：单红队 + 冻结世代；league/market/self-reference 在更远的将来，OUT of scope）。
 *
 * 设计稿 §10 / FIG 10c 的动态对抗闭环（一回合）：
 *   红队 agent 造题（false/contradiction/stale/near_dup_poison 四类）
 *     → 题过 A1 免疫验真（题=毒株，先过 S12 promoteCandidate 才进 scored cohort）
 *       → 蓝队（= 生产消费者 = 内核+工种自身）答题（经 S29 注入器驱动**真** Verifier/Reconciler/Arbiter 免疫反应）
 *         → 裁判 Arbiter 判分（per-class detection rate，**纯报告维度**）
 *           → 失败按根因回流成增长（每个 breach 经 S31 attributeFailure 归到**恰好一个** loop）
 *             → 下一版更难的题（漏检项 escalate 成更难的下一代，冻结/版本化/append-only —— 知识被攻击其弱处而生长）。
 *
 * **全程零评测专用代码路径 / 零 bespoke mock**：
 *   - 红队 = 冻结世代（S29 freezeRedTeamGeneration / redteam.gen 的固定敌手）。
 *   - 题免疫 = S12 promoteCandidate（**真** A1 门：四检经真 appendClaim/recall_claims/S8）。
 *   - 蓝队答题 = S29 runRedTeamGeneration（经**真** append_claim SPI 注入 → **真**工种免疫反应；断言只读 DB 真状态）。
 *   - 判分 = S29 ClassScore + recordImmunityScore（落 redteam_immunity_scores，离线维度）。
 *   - 归因 = S31 attributeFailure（kind='redteam_breach' → loopForRedTeamClass，**恰好一个** loop）。
 *   - 下一代 = freezeRedTeamGeneration（漏检项 escalate；append-only、新版本，旧世代原样留存）。
 *
 * **两条铁律（结构性强制 + 测试）**：
 *   A1（题=毒株）：每条红队 item 须先过 promoteCandidate 才进**被计分** cohort；自败/带毒 item 被 BLOCK、永不计分。
 *   A3（ELO/胜负率禁入 g 与纵向）：detection rate / 胜负只经 recordImmunityScore 落维度表，**绝不**喂校准拟合器
 *      collectUsageCalibrationSamples，也**绝不**进纵向 recordRecompete（其白名单只有 ece/coverage）。本回合**从不调用**
 *      这两条写入路径，故检出率物理上无路进 g/纵向。
 */
import { randomUUID } from 'node:crypto'

import {
  agentActor,
  addSource,
  appendClaim,
  attributeFailure,
  freezeRedTeamGeneration,
  getRedTeamGeneration,
  promoteCandidate,
  schema,
  transitionClaim,
  recordImmunityScore,
  type Attribution,
  type DB,
  type Embedder,
  type ProvenanceInput,
  type RedTeamClass,
  type RedTeamItem,
} from '@engram/core'

import { runRedTeamGeneration, type ClassScore, type InjectionOutcome } from './redteam-injector.js'

/** 一回合的依赖（与 S29 注入器同款：真 DB + 嵌入器；工种经 fake 端口隐藏在注入器内）。 */
export interface RedBlueRoundDeps {
  db: DB
  embedder: Embedder
}

/** 一回合的输入。 */
export interface RedBlueRoundOptions {
  /** 本回合（= 这一代敌手）的冻结世代 version。世代由本回合 freeze（autoFreeze）或假定已冻结。 */
  generationVersion: string
  /** 这一代的对抗样本集（直接传入，回合负责冻结）。 */
  items: readonly RedTeamItem[]
  /** 每条样本注入前清库（每条独立注入，互不串扰）—— 与 S29 runRedTeamGeneration 同款。 */
  resetWorkTables: () => Promise<void>
  /** A1 晋升人（人的架构权威，须 'human…' 前缀）。默认 'human:red-blue-curator'。 */
  confirmedBy?: string
  /** 是否由本回合 freeze 这代世代（默认 true：append-only 冻结，撞名抛）。 */
  autoFreeze?: boolean
  /** 下一代世代 version（默认 `${generationVersion}+1`）。 */
  nextGenerationVersion?: string
  /**
   * escalation 的参考时钟（stale 类把 asOf 向"现在"靠拢半步时用）。**注入它让 escalation 成纯函数、确定性可复现**
   * ——冻结世代是纵向免疫比较的锚（A3 反-Goodhart 前提：敌手不可被悄悄改），绝不能烤进 wall-clock。默认捕获一次 `new Date()`。
   */
  now?: Date
}

/** A1 题免疫的逐条裁决（哪条进了被计分 cohort、哪条被 BLOCK）。 */
export interface ItemAdmission {
  itemId: string
  redteamClass: RedTeamClass
  /** 过了 A1（promoteCandidate.promoted）⇒ 进被计分 cohort。 */
  admitted: boolean
  /** A1 四检快照（人读理由 / 审计）。 */
  reasons: string[]
}

/** 一个 breach（蓝队漏检一条毒株）+ 它的**单环**归因（S31）。 */
export interface BreachAttribution {
  redteamClass: RedTeamClass
  injected: number
  detected: number
  /** S31 单环归因（恰好一个 responsibleLoop）。 */
  attribution: Attribution
}

/** 一回合的结构化结果。 */
export interface RoundResult {
  generationVersion: string
  /** A1 逐条裁决（admitted=true 才进被计分 cohort）。 */
  admissions: ItemAdmission[]
  /** 进入被计分 cohort 的 item id（过了 A1 的）。 */
  scoredItemIds: string[]
  /** 被 A1 BLOCK、永不计分的 item id。 */
  blockedItemIds: string[]
  /** per-class detection（裁判判分，纯报告维度；已落 redteam_immunity_scores）。 */
  classScores: ClassScore[]
  /** 全部 breach（detected<injected 的类）+ 各自的单环 S31 归因。 */
  breaches: BreachAttribution[]
  /** 下一代更难题（漏检项 escalate 而来）；perfect round ⇒ items 为空、未冻结。 */
  nextGeneration: {
    version: string
    items: RedTeamItem[]
    /** 是否真冻结进库（仅当有 misses 且 items 非空时冻结）。 */
    frozen: boolean
  }
}

/**
 * 给一条 claim 造 4 条独立 supports 源（authority=1.0）并经**真 append_claim** 写入、晋升 active。
 * 用于 A1 候选的「可溯源来源 claim」（promoteCandidate 的 locatorsTraceable 要求候选溯到一条带出处的 claim）。
 */
async function appendActiveSourceClaim(
  db: DB,
  embedder: Embedder,
  draft: { claimText: string; subject?: string; predicate?: string; object?: string },
): Promise<string> {
  const provs: ProvenanceInput[] = []
  for (let i = 0; i < 4; i++) {
    const src = await addSource(db, {
      content: `evidence: ${draft.claimText}`,
      contentHash: randomUUID(),
      kind: 'formal_document',
      authorityScore: 1.0,
    })
    provs.push({ sourceId: src.sourceId, locator: `rb:a1:${i}`, relevance: 'exact' })
  }
  const { claimId } = await appendClaim(
    db,
    embedder,
    { ...draft, createdBy: 'agent:distiller' },
    provs,
  )
  await transitionClaim(db, claimId, 'active', {
    actor: agentActor('agent:distiller'),
    entailmentPass: true,
  })
  return claimId
}

/**
 * 一条红队 item 过 A1 免疫门（**真** S12 promoteCandidate）：
 *   把 item 当一道「KB 缺口考题」（query = item.claimText），seed 一条**无关**来源 claim（candidate 溯源到它的出处），
 *   入 l5_candidates 队列，跑真 promoteCandidate。四检（HITL / kbTrulyLacks / noSelfContradiction / locatorsTraceable）
 *   全过 ⇒ admitted（进被计分 cohort）；任一检失败（库本能答 / 自相矛盾 / 不可溯）⇒ BLOCK，永不计分。
 *
 * 「题=毒株先验真」就落在这：一道**库本能答**的题（库已有同义 active claim ⇒ recall 命中 ⇒ kbTrulyLacks=false）
 * 是污染真值的带毒考题，被 promoteCandidate 物理拒（绝不进 golden / 绝不计分）。
 *
 * 在**当前 clean KB**（每条 item 前 resetWorkTables）上，正常 item 的 claimText 是库里没有的事实 ⇒ recall 空 ⇒ 过门；
 * 而蓄意 self-failing 的 item（其 claimText 与一条预先 active 的 claim 同义）会被 BLOCK —— 这正是要测的。
 */
async function admitViaA1(
  deps: RedBlueRoundDeps,
  item: RedTeamItem,
  confirmedBy: string,
): Promise<ItemAdmission> {
  const { db, embedder } = deps
  // 来源 claim：一条**无关**背景事实（不与 item.claimText 同义 ⇒ 不会让 recall(item.claimText) 命中）。
  // candidate 溯源到它的出处（locatorsTraceable）；A1 在它上面验「库真没这道题的答案」。
  // 确定性说明：fake 三元组嵌入器对短文本的桶碰撞噪声把任意两段文本的 cosine 抬到 ~0.05–0.09，本来源 claim
  // 与 item.claimText 的相似度落这区间（< minSimilarity floor 0.1）。但 A1 是 **per-item reset 后单 claim 库**上
  // 召回，且 recall 的 floor 过滤跑在 **精确**重算距离上（非 HNSW 近似序）—— 故「是否命中」与 cosine 0.085<0.1
  // 是确定的（绝不抖），换文本也压不到噪声地板以下、无必要。回合曾见的 cold-run 闪退**不**源于此，而是重载下
  // 连接耗尽（见 vitest.config.ts 的连接预算）。
  const sourceClaimId = await appendActiveSourceClaim(db, embedder, {
    claimText: `unrelated background fact for red-team item ${item.id}`,
  })
  const candidateId = randomUUID()
  await db.insert(schema.l5Candidates).values({
    id: candidateId,
    sourceEventId: randomUUID(),
    query: item.claimText,
    claimId: sourceClaimId,
    confirmedBy,
    status: 'queued',
  })
  // 透传 item 的结构化框架（S/P/O）给 A1 的 poison，让 S8 自相矛盾门对结构化自败题（同 S/P、反 object）能发火——
  // 否则毒株 claim 仅有 claimText、S8 恒 noSelfContradiction=true，带毒考题混进被计分 cohort（EGR-CR-018）。
  // 沿 exactOptionalPropertyTypes 惯例：仅在字段非 undefined 时塞入；纯文本 item（无 S/P/O）不传 poison、行为不变。
  const poison = {
    ...(item.subject !== undefined ? { subject: item.subject } : {}),
    ...(item.predicate !== undefined ? { predicate: item.predicate } : {}),
    ...(item.object !== undefined ? { object: item.object } : {}),
  }
  const res = await promoteCandidate(db, embedder, candidateId, {
    confirmedBy,
    ...(Object.keys(poison).length > 0 ? { poison } : {}),
  })
  return {
    itemId: item.id,
    redteamClass: item.redteamClass,
    admitted: res.promoted,
    reasons: res.result.reasons,
  }
}

/**
 * escalate 一条漏检 item 成**更难**的下一代变体（确定性、seed from miss）：
 * 「更难」= 把攻击者的对抗 margin **减半向防御边界靠拢**（更贴近检出阈值、更难逮）：
 *   - false：claim 下界向 evidence 下界靠拢一半（幻觉幅度更小，更贴近「刚好推不出」）。
 *   - near_dup_poison：被审 object 向 anchor object 靠拢一半（投毒削得更隐蔽，subset 边界更近）。
 *   - contradiction：被审 object 向 anchor object 靠拢一半（分歧更小，更难判矛盾）。
 *   - stale：asOf 向「现在」靠拢一半（更接近半衰期阈值，时效衰减更弱、更难压穿消费门）。
 * 无数字可调的 item ⇒ 原样升代（仍是 miss，至少要继续被攻击），只换 id/版本血缘。每个变体带新 id（`<id>::esc:<ver>`）。
 *
 * **确定性**：纯函数 of (item, nextVersion, now)。stale 类的参考"现在"由 `now` **注入**（绝不读 Date.now()），
 * 故同一 miss + 同一 now → 同一更难变体，纵向可比、冻结世代可复现。导出供直接逐类测试。
 */
export function escalateMiss(item: RedTeamItem, nextVersion: string, now: Date): RedTeamItem {
  const escId = `${item.id}::esc:${nextVersion}`
  const num = (s: string | undefined): number | null => {
    if (s === undefined) return null
    const m = s.match(/(\d+(?:\.\d+)?)/)
    return m ? parseFloat(m[1]!) : null
  }
  // 只替换**作为独立数字 token** 的那一处（前后非数字），杜绝把 '5' 错改进 '150'、'3' 错改进 '13' 等子串碰撞。
  const replaceNum = (s: string, from: number, to: number): string => {
    const escaped = String(from).replace(/[.]/g, '\\.')
    return s.replace(new RegExp(`(?<!\\d)${escaped}(?!\\d)`), String(to))
  }

  const base: RedTeamItem = { ...item, id: escId }

  switch (item.redteamClass) {
    case 'false': {
      // claim 下界向 evidence 下界（= 检出翻转的边界）靠拢一半 —— 更贴近检出阈值、更难逮：
      //   - 普通 false（claimLb>evidLb，会被逮）：下调 claimLb 逼近 evidLb（幻觉幅度更小、更贴近「刚好推不出」）。
      //   - 逃逸 false（claimLb≤evidLb，已逃逸）：上调 claimLb 逼近 evidLb（更贴近「刚好被推出」的检出边界）。
      // 两向都是「向边界收窄 margin」。任一向都得到一个更难的探针（仍在 miss 一侧或更贴边）。
      const claimLb = num(item.object) ?? num(item.claimText)
      const evidLb = num(item.evidence)
      if (claimLb !== null && evidLb !== null && claimLb !== evidLb) {
        const harder = Math.round((claimLb + evidLb) / 2)
        // 必须既 ≠ 原 claimLb（真有收窄）又 ≠ evidLb（别落到证据边界上、否则恰好被推出、不再是 false 探针）。
        if (harder !== claimLb && harder !== evidLb) {
          return {
            ...base,
            claimText: replaceNum(item.claimText, claimLb, harder),
            ...(item.object !== undefined
              ? { object: replaceNum(item.object, claimLb, harder) }
              : {}),
          }
        }
      }
      return base
    }
    case 'near_dup_poison':
    case 'contradiction': {
      // 被审 object 向 anchor object 靠拢一半（投毒/矛盾幅度更小，更难逮）。
      const aObj = num(item.anchor?.object)
      const iObj = num(item.object)
      if (aObj !== null && iObj !== null && iObj !== aObj) {
        const harder =
          iObj < aObj
            ? Math.min(aObj - 1, Math.ceil((iObj + aObj) / 2))
            : Math.max(aObj + 1, Math.floor((iObj + aObj) / 2))
        if (harder !== iObj && item.object !== undefined) {
          return {
            ...base,
            object: replaceNum(item.object, iObj, harder),
            claimText: replaceNum(item.claimText, iObj, harder),
          }
        }
      }
      return base
    }
    case 'stale': {
      // asOf 向「现在」靠拢一半（更接近半衰期阈值，时效更弱、更难压穿消费门）。
      const old = item.asOf ? new Date(item.asOf) : null
      if (old && !Number.isNaN(old.getTime())) {
        // **注入的 now**（非 Date.now()）→ 纯函数、可复现。向"现在"靠拢半步（更接近半衰期阈值、更难压穿消费门）。
        const mid = new Date((old.getTime() + now.getTime()) / 2)
        return { ...base, asOf: mid.toISOString() }
      }
      return base
    }
    default: {
      const _exhaustive: never = item.redteamClass
      throw new Error(`escalateMiss: unknown redteam class ${String(_exhaustive)}`)
    }
  }
}

/** 收集被蓝队漏检的原始 item（per-item detected=false）—— 下一代的种子。保持原序（确定性 / 可复现）。 */
function collectMisses(
  classScores: ClassScore[],
  scoredItems: readonly RedTeamItem[],
): RedTeamItem[] {
  const missedIds = new Set<string>()
  for (const s of classScores) {
    for (const o of s.outcomes as InjectionOutcome[]) {
      if (!o.detected) missedIds.add(o.itemId)
    }
  }
  return scoredItems.filter((i) => missedIds.has(i.id))
}

/**
 * 跑**一个完整红蓝对抗回合**（端到端、真 DB、真工种）。返回结构化 RoundResult。
 *
 * 顺序：① freeze 这代世代（append-only） → ② A1 逐条验真（题=毒株，只 admit 过门者） → ③ 蓝队对**被计分 cohort**
 * 注入答题（S29 真工种免疫反应） → ④ 裁判 per-class 判分 + recordImmunityScore（纯报告维度） → ⑤ 每个 breach 经 S31
 * 归到单环 → ⑥ 漏检项 escalate 成更难的下一代（有 miss 才冻结、append-only）。
 */
export async function runRedBlueRound(
  deps: RedBlueRoundDeps,
  opts: RedBlueRoundOptions,
): Promise<RoundResult> {
  const { db } = deps
  const confirmedBy = opts.confirmedBy ?? 'human:red-blue-curator'
  const autoFreeze = opts.autoFreeze ?? true
  const nextVersion = opts.nextGenerationVersion ?? `${opts.generationVersion}+1`
  const now = opts.now ?? new Date() // 捕获一次 → escalation 确定性（绝不每次调 Date.now()）

  if (opts.items.length === 0) {
    throw new Error('runRedBlueRound: a round must run >=1 adversarial item')
  }

  // ── ① 红队：冻结这代世代（append-only；撞名抛 —— 世代不可静默重写，纵向比较的锚）。 ──
  if (autoFreeze) {
    await freezeRedTeamGeneration(db, {
      version: opts.generationVersion,
      items: [...opts.items],
      reason: `red-blue round generation ${opts.generationVersion}`,
      createdBy: 'eval:red-blue',
    })
  } else {
    // autoFreeze=false：调用方须已预冻结本代——否则步④ recordImmunityScore 的 FK(generation_version) 会在
    // 蓝队注入(②③)白跑之后才炸。这里先快速失败（不做任何昂贵工作）。
    const existing = await getRedTeamGeneration(db, opts.generationVersion)
    if (existing === null) {
      throw new Error(
        `runRedBlueRound: autoFreeze=false but generation '${opts.generationVersion}' is not pre-frozen ` +
          `(recordImmunityScore would later FK-violate). Freeze it first or pass autoFreeze:true.`,
      )
    }
  }

  // ── ② 题免疫 A1（铁律）：每条 item 先过真 promoteCandidate；只 admitted 者进被计分 cohort。 ──
  // 每条 item 在 clean KB 上验真（与蓝队注入同款 per-item 隔离），故 A1 与注入共用 resetWorkTables。
  const admissions: ItemAdmission[] = []
  for (const item of opts.items) {
    await opts.resetWorkTables()
    admissions.push(await admitViaA1(deps, item, confirmedBy))
  }
  const admittedSet = new Set(admissions.filter((a) => a.admitted).map((a) => a.itemId))
  const scoredItems = opts.items.filter((i) => admittedSet.has(i.id))
  const blockedItemIds = admissions.filter((a) => !a.admitted).map((a) => a.itemId)

  // ── ③ 蓝队答题（= 内核+工种）：对**被计分 cohort** 经 S29 真注入器驱动真工种免疫反应。 ──
  // 蓝队「答案」= 系统是否正确处置毒株（detected/contained）。空 cohort（全被 A1 BLOCK）⇒ 无分可判。
  const classScores =
    scoredItems.length === 0
      ? []
      : await runRedTeamGeneration(deps, scoredItems, opts.resetWorkTables)

  // ── ④ 裁判判分：per-class detection（纯报告维度）落 redteam_immunity_scores（A3：绝不进 g / 纵向）。 ──
  for (const s of classScores) {
    await recordImmunityScore(db, {
      generationVersion: opts.generationVersion,
      redteamClass: s.redteamClass,
      injected: s.injected,
      detected: s.detected,
      payload: {
        round: opts.generationVersion,
        perItem: s.outcomes.map((o) => ({ id: o.itemId, detected: o.detected })),
      },
      createdBy: 'eval:red-blue',
    })
  }

  // ── ⑤ 失败归因回流（S31）：每个 breach（detected<injected）经 attributeFailure 归到**恰好一个** loop。 ──
  // redteam_breach 归因读 redteam_immunity_scores（步④刚落），按 loopForRedTeamClass 确定性映射到单环。
  const breaches: BreachAttribution[] = []
  for (const s of classScores) {
    if (s.detected < s.injected) {
      const attribution = await attributeFailure(db, {
        kind: 'redteam_breach',
        generationVersion: opts.generationVersion,
        redteamClass: s.redteamClass,
      })
      breaches.push({
        redteamClass: s.redteamClass,
        injected: s.injected,
        detected: s.detected,
        attribution,
      })
    }
  }

  // ── ⑥ 下一代更难题：漏检项（per-item detected=false）escalate 成更难变体，seed from misses。 ──
  // perfect round（零 miss）⇒ 下一代为空、不冻结（无可生长处）。有 miss ⇒ 冻结新版本（append-only、旧世代留存）。
  const missedItems = collectMisses(classScores, scoredItems)
  const escalated = missedItems.map((it) => escalateMiss(it, nextVersion, now))
  let frozen = false
  if (escalated.length > 0) {
    await freezeRedTeamGeneration(db, {
      version: nextVersion,
      items: escalated,
      reason: `escalation of ${escalated.length} missed item(s) from ${opts.generationVersion}`,
      createdBy: 'eval:red-blue',
    })
    frozen = true
  }

  return {
    generationVersion: opts.generationVersion,
    admissions,
    scoredItemIds: scoredItems.map((i) => i.id),
    blockedItemIds,
    classScores,
    breaches,
    nextGeneration: { version: nextVersion, items: escalated, frozen },
  }
}
