/**
 * 冲突收敛优先级阶梯（A.5）—— **纯函数、确定性、可回归**。S20 Arbiter 的裁决核心。
 *
 * 一张优先级表，人机共用（设计稿 / PRD A.5 / 红线「机和人同一张表」）：
 *   ① 人工裁定        —— **仅人**，不在机判路径（Arbiter 永不用 ①，留给主编手裁）。
 *   ② 取代关系 supersede —— 一方经 supersedes 边取代了另一方 → 取代者胜。
 *   ③ 时效 recency     —— as_of 更新者胜。
 *   ④ 来源权威 authority —— 最强 supports 源 authority 更高者胜。
 *   ⑤ 独立印证数 indepSupport —— 独立印证更多者胜。
 *
 * 自上而下、**先命中先裁**：在某一阶产出严格不等 → 该阶定胜负，更低阶不再看（②命中就不看③④⑤…）。
 * 走完 ②③④⑤ 仍处处相等（同取代态、同时效、同权威、同印证）= 并列 → 不机判，升级主编（主编用同表 + ①）。
 *
 * **可回归红线**：同一对 conflict 输入 + 同一 library 状态 ⇒ 同一胜者。本函数零 LLM、零随机、零时钟、零 IO ——
 * 只读注入的不可变快照（ConflictSide），故天然 replayable/explainable：rung 字段直指「在第几阶分出胜负」。
 *
 * 本模块**只**算「该信谁」；落 contradicts 边 / 写采信标记 / 升级队列是 Arbiter worker（带 IO）的活，不在这里。
 */

/** 阶梯的某一阶标识（含 'human' 占位：仅人用，机判永不返回它当 winner 的依据）。 */
export type LadderRung = 'human' | 'supersede' | 'recency' | 'authority' | 'indepSupport'

/** 机判可触达的阶（②③④⑤），自上而下。① human 不在内（仅人）。 */
export const MACHINE_RUNGS: readonly LadderRung[] = [
  'supersede',
  'recency',
  'authority',
  'indepSupport',
]

/**
 * 一条 claim 在冲突裁决里的不可变快照（裁决只读它，保证 replayable）。
 * 由 Arbiter worker 从库里现拍：as_of/authority/indepSupport/supersedes 都是确定性可重建的输入。
 */
export interface ConflictSide {
  claimId: string
  /** A.5 ③ 时效：原文时点。越新越优。 */
  asOf: Date
  /** A.5 ④ 权威：本 claim 最强 supports 源的 authority_score（exact/supporting 源里最高）。 */
  authority: number
  /** A.5 ⑤ 印证：本 claim 的独立印证数（已折叠同源/血缘后的连续分）。越多越优。 */
  indepSupport: number
  /**
   * A.5 ② 取代：本 claim 经 supersedes 边**直接或传递**取代掉的对端 claimId 集合。
   * 若对端 claimId ∈ 本集合 ⇒ 本方取代了对端 ⇒ 本方胜（②先命中）。
   */
  supersedes: ReadonlySet<string>
}

/** 裁决结论。winner = 唯一胜者（机判自裁）；escalate = 并列/不可机判（升级主编）。 */
export interface Adjudication {
  outcome: 'winner' | 'escalate'
  /** outcome='winner' 时的胜者 / 败者 claimId。 */
  winnerId?: string
  loserId?: string
  /** 在哪一阶定的胜负（winner）；escalate 时为 'human'（待人在 ① 手裁）。可解释性锚点。 */
  rung: LadderRung
  /** 人类可读的裁决理由（审计/解释用，不进任何计分）。 */
  reason: string
}

/** ② 取代：a 是否取代了 b（a.supersedes ∋ b.claimId）。仅单向命中才算（双向取代是病态数据，按未命中处理交更低阶）。 */
function supersedeWinner(a: ConflictSide, b: ConflictSide): ConflictSide | null {
  const aOverB = a.supersedes.has(b.claimId)
  const bOverA = b.supersedes.has(a.claimId)
  if (aOverB && !bOverA) return a
  if (bOverA && !aOverB) return b
  return null // 都没取代 / 互相取代（病态）→ 本阶不裁，交更低阶
}

/**
 * 按 A.5 优先级阶梯裁决一对矛盾 claim。**纯函数、确定性**：同输入恒同输出（可回归红线）。
 * 自上而下先命中先裁（②supersede → ③recency → ④authority → ⑤indepSupport）；走完仍处处相等 → escalate。
 *
 * ① 人工裁定不在机判路径：Arbiter 调本函数永远拿不到机判 winner 之外的东西 —— escalate 才把球交给人在 ① 手裁。
 */
export function adjudicateConflict(a: ConflictSide, b: ConflictSide): Adjudication {
  if (a.claimId === b.claimId) {
    throw new Error('adjudicateConflict: a claim cannot conflict with itself')
  }

  // ② 取代关系：一方取代了另一方 → 取代者胜（最高机判阶，先命中先裁）。
  const sw = supersedeWinner(a, b)
  if (sw) {
    const loser = sw === a ? b : a
    return {
      outcome: 'winner',
      winnerId: sw.claimId,
      loserId: loser.claimId,
      rung: 'supersede',
      reason: `supersede: ${sw.claimId} supersedes ${loser.claimId}`,
    }
  }

  // ③ 时效：as_of 更新者胜。
  const at = a.asOf.getTime()
  const bt = b.asOf.getTime()
  if (at !== bt) {
    const newer = at > bt ? a : b
    const older = newer === a ? b : a
    return {
      outcome: 'winner',
      winnerId: newer.claimId,
      loserId: older.claimId,
      rung: 'recency',
      reason: `recency: as_of ${newer.asOf.toISOString()} newer than ${older.asOf.toISOString()}`,
    }
  }

  // ④ 来源权威：最强源 authority 更高者胜。
  if (a.authority !== b.authority) {
    const stronger = a.authority > b.authority ? a : b
    const weaker = stronger === a ? b : a
    return {
      outcome: 'winner',
      winnerId: stronger.claimId,
      loserId: weaker.claimId,
      rung: 'authority',
      reason: `authority: ${stronger.authority} > ${weaker.authority}`,
    }
  }

  // ⑤ 独立印证数：更多者胜。
  if (a.indepSupport !== b.indepSupport) {
    const more = a.indepSupport > b.indepSupport ? a : b
    const fewer = more === a ? b : a
    return {
      outcome: 'winner',
      winnerId: more.claimId,
      loserId: fewer.claimId,
      rung: 'indepSupport',
      reason: `indepSupport: ${more.indepSupport} > ${fewer.indepSupport}`,
    }
  }

  // 走完 ②③④⑤ 仍处处相等（同取代态、同时效、同权威、同印证）= 并列 → 不机判，升级主编（用同表 + ①）。
  return {
    outcome: 'escalate',
    rung: 'human',
    reason:
      'tie: equal supersede/recency/authority/indepSupport — machine ladder is exhausted, escalate to editor-in-chief (rung ① human ruling)',
  }
}
