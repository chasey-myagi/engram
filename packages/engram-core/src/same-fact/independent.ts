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

/**
 * 沿 derived_from 链上溯，返回 s 在**给定集合**里的血缘根代表元（最远可追祖先）。
 * 集合须已含完整祖先链（调用方用 loadSourcesWithAncestors 补齐）；越出集合即止于当前节点（它就是根锚点）。
 * 返回 null 表示链在**环**上终止（无真根锚点）—— 自引血缘环里所有节点都是衍生、谁都不算独立锚（与旧语义一致：
 * 互环折叠为 0）。正常 DB 数据不会成环（derivedFrom 创建时指向已存在源），这只是退化兜底。
 */
function lineageRoot(s: SourceIndep, byId: Map<string, SourceIndep>): SourceIndep | null {
  let cur = s
  const visited = new Set<string>([cur.id])
  while (cur.derivedFromSourceId != null) {
    const parent = byId.get(cur.derivedFromSourceId)
    if (parent === undefined) return cur // 父越出集合 ⇒ cur 是集合内可追到的根锚点
    if (visited.has(parent.id)) return null // 成环：无真根锚点
    visited.add(parent.id)
    cur = parent
  }
  return cur // derivedFromSourceId == null ⇒ 真血缘根
}

/**
 * 独立 supports 源的（可为小数的）计数：① 按 contentHash 去重（同内容只计一次）→ ② 沿 derived_from 折叠到**血缘根**
 * （同根的多个 sibling 只计一次，根的 kind 定折扣）→ ③ agent_synthesis 根按 0.5 折扣求和。返回独立印证数（喂
 * independentSupportScore）。
 *
 * **折叠依赖完整祖先链：** `sources` 必须带上被引用源沿 derived_from 上溯的**全部祖先**——否则跨引用集合的共同祖先
 * （sibling 共享一个未被本 claim 引用的上游 R）追不到，会被误计成多条独立印证（EGR-CR-024）。DB 侧用
 * loadSourcesWithAncestors 递归补齐。`citedIds` 标出**本 claim 真正引用**的源：仅为补血缘拉进来的祖先（不在 citedIds）
 * 只作折叠锚点、本身不计一次印证；缺省（undefined）= 全部源都视为被引用（向后兼容旧的「集合内即引用」语义）。
 */
export function countIndependentSupports(sources: SourceIndep[], citedIds?: Set<string>): number {
  // ① 按 hash 去重
  const byHash = new Map<string, SourceIndep>()
  for (const s of sources) if (!byHash.has(s.contentHash)) byHash.set(s.contentHash, s)
  const distinct = [...byHash.values()]
  const byId = new Map(distinct.map((s) => [s.id, s]))
  // ② 把每个**被引用**源折叠到血缘根；同根只留一个代表元（根本身，根的 kind 定折扣）。
  const isCited = (s: SourceIndep): boolean => citedIds === undefined || citedIds.has(s.id)
  const rootReps = new Map<string, SourceIndep>()
  for (const s of distinct) {
    if (!isCited(s)) continue // 仅补血缘的祖先：只当折叠锚点，不算一条独立印证
    const root = lineageRoot(s, byId)
    if (root === null) continue // 环上无真根锚点 ⇒ 不计（互环折叠为 0，与旧语义一致）
    rootReps.set(root.id, root) // 同根的多个 sibling 收敛到同一代表元
  }
  // ③ agent_synthesis 根按 0.5 折扣求和
  let count = 0
  for (const root of rootReps.values()) count += root.kind === 'agent_synthesis' ? 0.5 : 1
  return count
}

/** f3 = independentSupportScore(独立印证数)。sources 须含完整祖先链（见 countIndependentSupports）。 */
export function independentSupportFactor(sources: SourceIndep[], citedIds?: Set<string>): number {
  return independentSupportScore(countIndependentSupports(sources, citedIds))
}
