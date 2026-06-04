/**
 * Reconciler 核心域逻辑（A.6 near-dup-poison + 独立印证完整性）—— 模型无关、纯函数 + 端口注入。
 *
 * 守两件事（A.6/A.7「Reconciler」）：
 *   ① near-dup-poison：embedding 近 + `subject≡` 但 `object` 被悄悄改小/反 = 可疑。调 entailment 验
 *      `A.object ⊆ B.object`？是 → 真精炼(refines)；否（改小/反向）→ 疑投毒(poison)，flag 升 Arbiter。
 *      ——「伪装成精炼的等价投毒」：表面像在细化既有事实，实则把 object 悄悄掏空/反转，骗过 commit 的合并路径。
 *   ② 独立印证完整性：surface 近重复 / 同 lineage / 同源对，让同源抄写**不能**刷高 indepSupport（强化 S14）。
 *
 * 工程形态（A.7「函数 + 灰区 1×LLM」，非 agent loop）：找对靠确定性规则（subject≡、object 非等价、相似度门）；
 * 仅在「object 既非等价又非显式反向」的灰区，对 EntailmentJudge 调**恰一次**判 A.object⊆B.object。保守：
 * 不确定 / 失败 → 既不合并也不判 refines，留两条 + flag 升级（宁可误升、不可误并 —— 过度合并丢信息不可逆）。
 *
 * judge≠athlete：Reconciler 用自己的 DB role/by_role，绝不裁/背书自己产出的 claim（编排层 reconciler.ts 强制）。
 * 模型无关：subset 判定经注入的 EntailmentJudge（测试走确定性 fake，生产 DashScope env-gated，不进 CI）。
 */
import type { EntailmentJudge } from '../verifier/entailment-judge.js'
import { independent, type SourceIndep } from './independent.js'
import { objectEquivalent, type ClaimShape } from './same-fact.js'

/** Reconciler 对一对 (A=新/被审, B=既有/锚) claim 的处置裁决。 */
export type ReconcileVerdict =
  /** A 是 B 的真精炼（A.object ⊆ B.object，谓词/范围更细但不出 B 的真值域）→ 记 refines 边，不 flag。 */
  | 'refines'
  /** object 被悄悄改小/反向（A.object ⊄ B.object）→ 疑 near-dup-poison：flag A + 升 Arbiter（带对端 id）。 */
  | 'poison'
  /** 灰区判不准 / 判官失败 / object 等价（疑同源近重复）→ 保守：不合并、不判 refines，留两条。 */
  | 'inconclusive'

/** Reconciler 配对的相似度下界（沿 A.6 lineage stage-1 同款 0.75：足够近才值得查 object 是否被掏空）。 */
export const RECONCILE_PAIR_SIMILARITY = 0.75

/**
 * 一对候选是否够格进 Reconciler 的 near-dup-poison 审查（确定性预筛，不烧 LLM）：
 *   subject 两侧齐全且 `subject≡`（同主语）∧ object 两侧齐全且**非等价**（等价的归 commit 的 same 合并、不是投毒）
 *   ∧ embedding 相似度 ≥ 0.75。
 * 自由文本（无结构 object）不进此关 —— near-dup-poison 的攻击面是「结构化 object 被悄悄改小/反」。
 */
export function isReconcileCandidate(a: ClaimShape, b: ClaimShape, similarity: number): boolean {
  if (similarity < RECONCILE_PAIR_SIMILARITY) return false
  if (a.subject == null || b.subject == null || a.subject !== b.subject) return false
  if (a.object == null || b.object == null) return false
  if (objectEquivalent(a.object, b.object)) return false // 等价 = 同一事实，不是 object 被改小/反
  return true
}

/**
 * 判 A.object 是否 ⊆ B.object（真精炼）—— 经 EntailmentJudge 一次 LLM（灰区点状一次）。
 * 把「A 的命题能否从 B 推出」翻成 entailment：以 B.object（更宽的既有断言）当出处原文，问 A.claimText 能否被它蕴含。
 *   pass        → A ⊆ B：A 在 B 的真值域内、只是更细 → 真精炼(refines)。
 *   fail        → A ⊄ B：A 把 object 改小到 B 之外 / 与 B 矛盾 → 疑投毒(poison)。
 *   not_co_true → A 与 B 不可同真（object 被反向）→ 疑投毒(poison)。
 * 判官抛错由调用方接住（编排层降级保守，不崩、不无限重试）。
 */
export async function objectSubsetViaEntailment(
  judge: EntailmentJudge,
  a: ClaimShape,
  b: ClaimShape,
): Promise<ReconcileVerdict> {
  const verdict = await judge.judge({
    claimText: a.claimText,
    subject: a.subject,
    predicate: a.predicate,
    object: a.object,
    // 把既有（更宽）claim 当作唯一出处：A.object⊆B.object ⟺ A 可从 B 推出。
    // relevance=exact：B 是对该命题的明确（更宽）陈述，正合 NC-exact 口径，让反向(not_co_true)可被判出。
    evidence: [
      {
        sourceContent: b.claimText,
        locator: `peer-claim:${b.subject ?? ''}/${b.predicate ?? ''}=${b.object ?? ''}`,
        relevance: 'exact',
      },
    ],
  })
  switch (verdict) {
    case 'pass':
      return 'refines' // A ⊆ B：真精炼
    case 'fail':
    case 'not_co_true':
      return 'poison' // A ⊄ B（改小/反向）：疑投毒
    default:
      return 'inconclusive'
  }
}

/**
 * 对一对够格候选跑 near-dup-poison 审查：refines / poison / inconclusive。
 * 仅对够格对（isReconcileCandidate）花**恰一次** LLM；不够格直接 inconclusive（不烧 LLM、保守留两条）。
 * 判官抛错 → inconclusive（保守降级，编排层吞掉计 skipped、下轮重试）。
 */
export async function reconcilePair(
  judge: EntailmentJudge,
  a: ClaimShape,
  b: ClaimShape,
  similarity: number,
): Promise<ReconcileVerdict> {
  if (!isReconcileCandidate(a, b, similarity)) return 'inconclusive'
  try {
    return await objectSubsetViaEntailment(judge, a, b)
  } catch {
    return 'inconclusive' // 判官失败 → 保守：不合并、不判 refines、不误 flag
  }
}

/**
 * 独立印证完整性（A.6 防同源刷 f3，强化 S14）：在一组挂在同一事实上的源里，找出「**不独立**于已有源」的对。
 * independent(s1,s2) = id≠ ∧ hash≠ ∧ 无直接 derived_from 血缘。任一对不独立 ⇒ 它们不能各算一次印证。
 *
 * 返回 false 表示「这批源里存在近重复/同源对，indepSupport 不应按源条数线性增长」。Reconciler 借此 surface
 * 异常 lineage（同 contentHash / 直接 derived_from）——commit/重算路径的 countIndependentSupports 已折叠它们，
 * 此函数是 Reconciler 侧的**显式探测**：让审计能指出「这两源不独立、别拿来刷印证」。
 */
export function hasNonIndependentPair(sources: SourceIndep[]): boolean {
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      if (!independent(sources[i]!, sources[j]!)) return true
    }
  }
  return false
}
