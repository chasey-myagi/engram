/**
 * A1 题免疫 admission（共享原语）：一条红队 item 过**真** S12 promoteCandidate 才进被计分 cohort。
 *
 * 抽到独立模块（EGR-CR-019）的原因：A1 admission 既是 `runRedBlueRound` 编排层的②步，也是公开评分入口
 * `runRedTeamGeneration` 自带的边界（公开入口在结构上无法对未 A1-admitted item 计分）。两处复用同一条 admission
 * 路径，避免「编排层有门、公开入口无门」的旁路面，也避免两份各跑一遍 A1。放在 `red-blue-round.ts` 会让注入器
 * `redteam-injector.ts` 反向依赖编排层（循环依赖），故下沉到二者都依赖的共享层。
 */
import { randomUUID } from 'node:crypto'

import {
  addSource,
  agentActor,
  appendClaim,
  promoteCandidate,
  schema,
  transitionClaim,
  trustedHumanActor,
  type DB,
  type Embedder,
  type ImmunityResult,
  type ProvenanceInput,
  type RedTeamClass,
  type RedTeamItem,
} from '@engram/core'

/** A1 admission 的依赖（真 DB + 嵌入器；A1 四检走真 promoteCandidate/recall/S8）。 */
export interface A1AdmissionDeps {
  db: DB
  embedder: Embedder
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

/** A1 一条裁决 + 落 round_cohort 所需的晋升证据快照（goldenId/poisonClaimId/basis）。 */
export interface A1Decision {
  admission: ItemAdmission
  goldenId: string | null
  poisonClaimId: string | null
  basis: ImmunityResult
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
      // 4 条独立 supports 源：content 须字节级不同（EGR-CR-012 内核自算 hash ⇒ 同 content 会折叠成 1 条）。
      content: `evidence ${i}: ${draft.claimText}`,
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
export async function admitViaA1(
  deps: A1AdmissionDeps,
  item: RedTeamItem,
  confirmedBy: string,
): Promise<A1Decision> {
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
    actor: trustedHumanActor(confirmedBy),
    ...(Object.keys(poison).length > 0 ? { poison } : {}),
  })
  return {
    admission: {
      itemId: item.id,
      redteamClass: item.redteamClass,
      admitted: res.promoted,
      reasons: res.result.reasons,
    },
    // EGR-CR-017：把 promoteCandidate 回填的 golden/毒株 id + 四检判据快照一并带回，供 admission 循环在「下一次
    // reset 之前」落进 append-only 的 round_cohort（证据从此持久、per-item TRUNCATE 物理上够不着它）。
    goldenId: res.goldenId ?? null,
    poisonClaimId: res.poisonClaimId ?? null,
    basis: res.result,
  }
}
