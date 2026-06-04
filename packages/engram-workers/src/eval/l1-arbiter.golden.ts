/**
 * L1 Arbiter golden（A.9 CI 红线 · 内核领域无关）—— 真冲突对 + 「该信谁」人工标签，
 * 断言 Arbiter 的裁决**确定性 + 顺序一致**（adjudication-order consistency）。
 *
 * 盯 Arbiter「会污染库的危险错」：让 LLM（而非确定性阶梯）决定胜负，从而同一对冲突在不同 loop 顺序 / 不同
 * 入参顺序下得到不同胜者（不可回归 = 知识库被「谁先被处理」这种无关因素污染）。判据（A.5/A.9）：
 *   ① 正确性：机判胜者 / 升级 与人工标签一致（按 ②supersede>③recency>④authority>⑤indepSupport 阶梯）。
 *   ② 顺序一致：同一对 + 同一库状态，**无论入参 (A,B) 还是 (B,A)、无论 loop 先处理谁**，胜者 + rung 恒同。
 *
 * 这是**行为 golden**（per-agent component golden），从不被写成 claim、从不被 recall 召回（见 l1-namespace.ts）。
 * 领域无关：通用事实（传感器读数、固件版本…），不含 bidding SKU/列；不 import bidding golden。
 *
 * 验真而非 smoke：runner 跑真 runArbiter（真 loadConflictSide 现拍快照 + 真 adjudicateConflict 纯阶梯 + 真
 * resolveConflict/escalateConflict 落库），fake model 只驱动「逐对调 adjudicate_conflict 工具」——**绝不替阶梯选边**。
 * 故若有人把胜负判定挪进 LLM、或把阶梯次序写反（如 authority 越过 recency），正确性/顺序一致会立刻掉到阈下 → 红。
 */
import type { LadderRung } from '@engram/core'

/** 一侧 claim 的裁决输入（领域无关、确定性可重建）。 */
export interface ArbiterSide {
  /** 稳定标号（'a' / 'b'），runner 据此把人工标签里的胜者映射到实际 seed 的 claimId。 */
  ref: 'a' | 'b'
  /** A.5 ③ 时效：原文时点（ISO）。越新越优。 */
  asOf: string
  /** A.5 ④ 权威：本 claim 最强 supports 源 authority_score。越高越优。 */
  authority: number
  /** 额外独立 supports 源数（A.5 ⑤ indepSupport）；默认 0（只主源）。每条都是 contentHash 各异的独立源。 */
  extraIndepSources?: number
}

/** 一对 Arbiter golden 冲突 + 人工真值。 */
export interface ArbiterGoldenItem {
  id: string
  /** 冲突事实的可读查询（两侧同文本 → recall 双返；object 不同 → 真冲突）。 */
  query: string
  a: ArbiterSide
  b: ArbiterSide
  /** A→B 是否有一条 supersedes 边（A.5 ② 取代关系；缺省无）。 */
  aSupersedesB?: boolean
  bSupersedesA?: boolean
  /** 人工真值：'a' / 'b' = 该 ref 胜（机判自裁）；'escalate' = 并列 → 升级主编。 */
  expectWinner: 'a' | 'b' | 'escalate'
  /** 人工真值：在哪一阶定的（resolved=②③④⑤；escalate='human'）。 */
  expectRung: LadderRung
  /** 标签理由（审计用，不进计分）。 */
  rationale: string
}

const NEWER = '2025-06-01T00:00:00.000Z'
const OLDER = '2025-01-01T00:00:00.000Z'
const SAME = '2025-03-01T00:00:00.000Z'

/**
 * 冻结的 Arbiter golden 集：每个机判阶梯各 ≥1 对 + 阶梯先命中先裁的「低阶被高阶压制」对 + 一对全相等的并列升级对。
 * 全是领域无关通用事实。胜者标签按 A.5 阶梯人工算定（runner 用真阶梯验证 = 人机同一张表）。
 */
const ARBITER_GOLDEN_ITEMS: ArbiterGoldenItem[] = [
  // ③ recency：严格更新者胜（其余相等）。
  {
    id: 'arbiter-recency',
    query: 'sensor s9 reading is stable',
    a: { ref: 'a', asOf: NEWER, authority: 0.5 },
    b: { ref: 'b', asOf: OLDER, authority: 0.5 },
    expectWinner: 'a',
    expectRung: 'recency',
    rationale: 'a is strictly newer; equal authority/indep, no supersede → ③ recency picks a',
  },
  // ④ authority：同时效，更强源者胜。
  {
    id: 'arbiter-authority',
    query: 'firmware r12 ships dual-band failover',
    a: { ref: 'a', asOf: SAME, authority: 0.9 },
    b: { ref: 'b', asOf: SAME, authority: 0.2 },
    expectWinner: 'a',
    expectRung: 'authority',
    rationale: 'equal recency, no supersede; a has the stronger source → ④ authority picks a',
  },
  // ⑤ indepSupport：同时效同权威，独立印证更多者胜。
  {
    id: 'arbiter-indep',
    query: 'pump p3 duty cycle is rated',
    a: { ref: 'a', asOf: SAME, authority: 0.5, extraIndepSources: 2 },
    b: { ref: 'b', asOf: SAME, authority: 0.5, extraIndepSources: 0 },
    expectWinner: 'a',
    expectRung: 'indepSupport',
    rationale: 'equal recency/authority, no supersede; a has more independent support → ⑤ picks a',
  },
  // ② supersede 压制 ③④：取代者胜，即便更旧 + 更弱（先命中先裁，低阶不再看）。
  {
    id: 'arbiter-supersede-outranks',
    query: 'gateway g7 retry budget is set',
    a: { ref: 'a', asOf: NEWER, authority: 0.9 }, // 表面更优（新+强）
    b: { ref: 'b', asOf: OLDER, authority: 0.2 }, // 旧+弱，但取代了 a
    bSupersedesA: true,
    expectWinner: 'b',
    expectRung: 'supersede',
    rationale:
      'b supersedes a → ② supersede wins even though b is older + weaker (ladder hit-first)',
  },
  // 全相等并列 → 升级主编（机判阶梯走尽仍处处相等）。
  {
    id: 'arbiter-tie-escalates',
    query: 'relay node clock drift is bounded',
    a: { ref: 'a', asOf: SAME, authority: 0.5 },
    b: { ref: 'b', asOf: SAME, authority: 0.5 },
    expectWinner: 'escalate',
    expectRung: 'human',
    rationale:
      'equal supersede/recency/authority/indepSupport → tie → escalate to editor (① human)',
  },
]

export const ARBITER_GOLDEN: readonly ArbiterGoldenItem[] = Object.freeze(
  ARBITER_GOLDEN_ITEMS.map((it) => Object.freeze(it)),
)
