/**
 * 适配器单调收紧算子（Consumer SPI，附录 A.2/A.6）。
 *
 * 领域适配器(consumer)只能在内核 g 的基础上**收紧**：降 conf、丢结果、抬 floor（floor 在 recall 的
 * request-state ctx，只能 ≥ 内核 0.4）。绝不能**放松**——抬高任一 conf、增加结果数、伪造/改写出处。
 * 任一违反即抛 Error('adapter relaxed: ...')。
 *
 * 内核对业务语义零认知：这个算子只比较 conf 数值与出处身份，绝不读任何业务 key（source_type 之类
 * 只在领域适配器包里解读）。这是 SPI 的最强收紧缝——评测、bidding 等所有 consumer 同走这道关。
 */
import { MUST_VERIFY_THRESHOLD, type RecallResult } from './recall-claims.js'

/** 浮点容差：判据是 adaptedConf ≤ gConf + ε。 */
export const DEFAULT_ADAPTER_EPSILON = 1e-9

/** 领域适配器回调：吃内核召回结果，产出收紧后的结果（可降 conf、可丢结果，绝不可放松）。 */
export type RecallAdapter = (kernelResults: readonly RecallResult[]) => RecallResult[]

// 按位置比对（保守：连「重排出处」也判 rewrite）。recall 的出处扇出顺序是确定的、且 applyAdapter 拿的是
// 同一 kernelResults 引用，故此切片下顺序天然一致；真出现合法重排需求时再改成 multiset 比对。
function provenanceEqual(a: RecallResult['provenances'], b: RecallResult['provenances']): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.sourceId !== y.sourceId || x.locator !== y.locator || x.relevance !== y.relevance) {
      return false
    }
  }
  return true
}

/**
 * 跑适配器并强制单调收紧不变量。任一违反抛 Error('adapter relaxed: ...')：
 *   - 结果数 > 内核召回数（增召回）
 *   - 出现内核召回里没有的 claim（伪造结果）/ 同一 claim 重复（灌数）
 *   - adaptedConf > gConf + ε（放松信心）
 *   - sub-0.6 结果被标 mustVerify=false（放松消费门：把"须先核验"谎报成"可直接用"）
 *   - 出处被改写（条数或任一 sourceId/locator/relevance 变化）
 *   - 丢弃 contradicts 标注（隐藏矛盾，放松"矛盾显式"红线；多标更谨慎放行）
 * 合法收紧（降 conf / 丢结果 / 原样返回）放行，返回收紧后的结果（内核召回的子集）。
 * 刻意只管 conf / count / provenance / mustVerify / contradicts；claimText / status / raw 等属直通。
 * 内核消费下界 0.4 在 recall 时强制、**不**在本算子兜底：sub-floor 结果（更收紧）会被放行——
 * 领域适配器若不想把"不可消费"档泄露给下游须自行丢弃（bidding-adapter 即如此）。
 */
export function applyAdapter(
  kernelResults: RecallResult[],
  adapter: RecallAdapter,
  opts: { epsilon?: number } = {},
): RecallResult[] {
  const eps = opts.epsilon ?? DEFAULT_ADAPTER_EPSILON
  const adapted = adapter(kernelResults)

  if (adapted.length > kernelResults.length) {
    throw new Error(
      `adapter relaxed: cannot increase recall count (${kernelResults.length} → ${adapted.length})`,
    )
  }
  // recall 保证同一次召回内 claim.id 唯一（按 claim 行去重），故这个 Map 不会塌缩两条同 id 结果。
  const original = new Map(kernelResults.map((r) => [r.claim.id, r]))
  const seen = new Set<string>()
  for (const a of adapted) {
    const o = original.get(a.claim.id)
    if (!o) {
      throw new Error(
        `adapter relaxed: fabricated result not in kernel recall (claim ${a.claim.id})`,
      )
    }
    if (seen.has(a.claim.id)) {
      throw new Error(`adapter relaxed: duplicated result (claim ${a.claim.id})`)
    }
    seen.add(a.claim.id)
    if (a.confidence.value > o.confidence.value + eps) {
      throw new Error(
        `adapter relaxed: raised confidence above kernel g (claim ${a.claim.id}: ${a.confidence.value} > ${o.confidence.value})`,
      )
    }
    // mustVerify 也是内核消费门字段：value<0.6 必须 mustVerify=true。把 sub-0.6 结果标成「可直接用」
    // 是在放松内核门（与抬 conf 同性质的放松）—— 拦住。≥0.6 仍标 true（过度谨慎）属收紧，放行。
    if (a.confidence.value < MUST_VERIFY_THRESHOLD && a.mustVerify !== true) {
      throw new Error(
        `adapter relaxed: under-flagged mustVerify on a sub-${MUST_VERIFY_THRESHOLD} result (claim ${a.claim.id})`,
      )
    }
    if (!provenanceEqual(a.provenances, o.provenances)) {
      throw new Error(`adapter relaxed: rewrote provenance (claim ${a.claim.id})`)
    }
    // 矛盾显式（红线）：adapter 不得**隐藏**内核标出的矛盾——adapted.contradicts 必须 ⊇ 内核的。
    // 多标（更谨慎）放行；少标（藏冲突）= 放松，拦住。
    const adaptedContra = new Set(a.contradicts)
    for (const cid of o.contradicts) {
      if (!adaptedContra.has(cid)) {
        throw new Error(
          `adapter relaxed: dropped a contradicts annotation (claim ${a.claim.id} no longer flags conflict with ${cid})`,
        )
      }
    }
  }
  return adapted
}
