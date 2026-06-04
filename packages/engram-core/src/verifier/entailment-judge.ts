/**
 * entailment 判官端口（A.6 派生算法 / A.7 Verifier）—— 模型无关。
 *
 * entailment 定义（A.6）：claim 表述能否从其 provenance 原文逻辑推出。
 *   pass        = 可从出处原文逻辑推出（支持）。
 *   fail        = 推不出 / 与出处冲突 = 疑似幻觉 → claim 应被收紧（active→flagged）。
 *   not_co_true = 与另一条 claim 不可同真 → 记一条 conflict 信号交 Arbiter（S20，本切片只记不裁）。
 *
 * 工程形态（A.7「函数/统计 + 点状一次 LLM」，非 agent loop）：Verifier 对每条被巡查的 claim 调本判官**恰一次**，
 * 把 claim 文本 + 其全部出处摘要喂进去，拿回一个三态裁决。judge≠athlete：判官与产出 claim 的 athlete 解耦，
 * Verifier 用自己的 by_role 落 claim_verification（不给自己产出背书）。
 *
 * 模型无关：真 LLM 经此端口注入（DashScope env-gated，不进 CI）；测试走确定性 fake。
 */

/** entailment 三态裁决（A.6）。 */
export type EntailmentVerdict = 'pass' | 'fail' | 'not_co_true'

/** 喂给判官的一条出处片段（原文摘要 + 定位 + 相关度）。 */
export interface EntailmentEvidence {
  /** 出处原文（或其摘要片段）。 */
  sourceContent: string
  /** 出处在原文中的定位（行/段/字段）。 */
  locator: string
  /** 该出处对 claim 的相关度（A.6 四档）。 */
  relevance: string
  /** 可选的逐字片段。 */
  excerpt?: string
}

/** 一次 entailment 巡查的输入：被巡查 claim 的文本 + 其全部出处。 */
export interface EntailmentQuery {
  claimText: string
  /** claim 的结构化三元（若有），帮助判官理解命题。 */
  subject?: string | null
  predicate?: string | null
  object?: string | null
  /** 该 claim 的全部（supports）出处。空数组在内核里物理不可能（D1），判官应据此判 fail。 */
  evidence: EntailmentEvidence[]
}

/**
 * entailment 判官（模型无关）。judge(query) 对每条被巡查 claim 调用**恰一次**（点状一次 LLM）。
 * 返回三态之一；非法/异常由实现抛（Verifier 据「失败跳过本轮、下轮重试」处理，不崩、不无限重试）。
 */
export interface EntailmentJudge {
  readonly version: string
  judge(query: EntailmentQuery): Promise<EntailmentVerdict>
}
