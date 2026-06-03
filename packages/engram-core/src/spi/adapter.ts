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
import type { RecallResult } from './recall-claims.js'

/** 浮点容差：判据是 adaptedConf ≤ gConf + ε。 */
export const DEFAULT_ADAPTER_EPSILON = 1e-9

/** 领域适配器回调：吃内核召回结果，产出收紧后的结果（可降 conf、可丢结果，绝不可放松）。 */
export type RecallAdapter = (kernelResults: readonly RecallResult[]) => RecallResult[]

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
 *   - 出处被改写（条数或任一 sourceId/locator/relevance 变化）
 * 合法收紧（降 conf / 丢结果 / 原样返回）放行，返回收紧后的结果（内核召回的子集）。
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
    if (!provenanceEqual(a.provenances, o.provenances)) {
      throw new Error(`adapter relaxed: rewrote provenance (claim ${a.claim.id})`)
    }
  }
  return adapted
}
