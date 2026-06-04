/**
 * 独立来源判定 + 印证计数（A.6）—— 让 f3(indepSupport) 不能被同源抄写刷高。
 *   independent(s1,s2) = id≠ ∧ hash≠ ∧ 无 derived_from 血缘
 * 印证只数独立 supports 源：hash 相同不重复计、derived_from 同链折叠、agent_synthesis 衍生源按 0.5 折扣。
 */
import { independentSupportScore } from '../confidence/confidence.js'

/** 计数所需的源结构面。 */
export interface SourceIndep {
  id: string
  contentHash: string
  kind: string
  derivedFromSourceId: string | null
}

/**
 * 两源是否独立（直接判据）：不同 id、不同内容 hash、且互不直接 derived_from 对方。
 * （传递血缘的折叠在 countIndependentSupports 的集合级里做。）
 */
export function independent(a: SourceIndep, b: SourceIndep): boolean {
  return (
    a.id !== b.id &&
    a.contentHash !== b.contentHash &&
    a.derivedFromSourceId !== b.id &&
    b.derivedFromSourceId !== a.id
  )
}

/** s 是否（在集合内、传递地）派生自集合里的另一个源 —— 是则它不计独立印证（同链只数根）。 */
function hasInSetAncestor(
  s: SourceIndep,
  derivedFrom: Map<string, string | null>,
  inSet: Set<string>,
): boolean {
  let cur = s.derivedFromSourceId
  const visited = new Set<string>()
  while (cur != null && !visited.has(cur)) {
    if (inSet.has(cur)) return true // 链上有集合内的上游 ⇒ s 是衍生、不独立计
    visited.add(cur)
    cur = derivedFrom.get(cur) ?? null // map 只含集合内源；越出集合即止
  }
  return false
}

/**
 * 独立 supports 源的（可为小数的）计数：① 按 contentHash 去重（同内容只计一次）→ ② 折叠 derived_from 同链
 * （只数根、不重复计衍生）→ ③ agent_synthesis 源按 0.5 折扣求和。返回独立印证数（喂 independentSupportScore）。
 */
export function countIndependentSupports(sources: SourceIndep[]): number {
  // ① 按 hash 去重
  const byHash = new Map<string, SourceIndep>()
  for (const s of sources) if (!byHash.has(s.contentHash)) byHash.set(s.contentHash, s)
  const distinct = [...byHash.values()]
  // ② 折叠集合内 derived_from 链
  const inSet = new Set(distinct.map((s) => s.id))
  const derivedFrom = new Map(distinct.map((s) => [s.id, s.derivedFromSourceId]))
  const survivors = distinct.filter((s) => !hasInSetAncestor(s, derivedFrom, inSet))
  // ③ agent_synthesis 折扣求和
  let count = 0
  for (const s of survivors) count += s.kind === 'agent_synthesis' ? 0.5 : 1
  return count
}

/** f3 = independentSupportScore(独立印证数)。 */
export function independentSupportFactor(sources: SourceIndep[]): number {
  return independentSupportScore(countIndependentSupports(sources))
}
