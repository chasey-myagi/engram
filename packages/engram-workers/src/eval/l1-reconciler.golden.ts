/**
 * L1 Reconciler golden（A.9 CI 红线 · 内核领域无关）—— 分层 L1a / L1b / L1c + 独立印证完整性。
 *
 * 盯 Reconciler「会污染库的危险错」：把伪装成精炼的**等价投毒**误并/误判 refines（不可逆丢信息），
 * 或把真精炼误 flag。判据：三层裁决全对 + 独立印证审计全对（runner / test 断言每层准确率 = 1）。
 *
 * 三层（A.9）：
 *   L1a 规则可判 same：object 等价（'4000 mah' ≡ '4.0 ah'）→ 不是 reconcile candidate → inconclusive、**不 flag、不 refines**。
 *   L1b 灰区 refines：A.object ⊆ B.object（更窄但仍在 B 真值域内）→ 记 refines 边、**不 flag**。
 *   L1c 反向/掏空 poison：A.object ⊄ B.object（被悄悄改小/反向）→ flag（active→flagged）+ 升级带对端 id。
 *
 * 独立印证完整性：claim 的 supports 含同 hash / 直接 derived_from 副本 → hasNonIndependentPair=true（同源不能各刷一次印证）；
 * 真正独立的两源 → false。
 *
 * 验真而非 smoke：runner 用 faithful ≥-bound oracle（实算 A⊢B），故 poison/refines 的**方向**被钉死——
 * 若 Reconciler 把 A/B（被审/锚）判反，refines↔poison 会互换、把准确率打到 0。
 * 领域无关：通用电池/容量事实；不 import bidding golden。
 */
import type { ClaimStatus, SourceKind } from '@engram/core'

/** Reconciler 三层裁决类型（人工真值）。 */
export type ReconcileTier =
  | 'L1a_same' // 规则可判等价 → 不审（inconclusive）、不 flag、不 refines
  | 'L1b_refines' // 灰区真精炼 → refines 边、不 flag
  | 'L1c_poison' // 反向/掏空投毒 → flag + escalate

/** 一对 (A=本批被审, B=既有锚) golden。 */
export interface ReconcilerPairItem {
  id: string
  tier: ReconcileTier
  subject: string
  predicate: string
  /** 锚 B 的文本 / object（既有、更宽或等价的一方）。 */
  anchorText: string
  anchorObject: string
  /** 被审 A 的文本 / object（本批新写）。 */
  candidateText: string
  candidateObject: string
  /** A 的 seed 状态（默认 active，可 draft 以测 draft poison 不收紧但记信号）。 */
  candidateStatus?: Extract<ClaimStatus, 'draft' | 'active'>
  /** 人工真值：本对裁决后 A 应否被 flag。 */
  expectFlagged: boolean
  /** 人工真值：是否应记一条带对端 id 的 escalation。 */
  expectEscalated: boolean
  /** 人工真值：是否应记一条 refines 边。 */
  expectRefines: boolean
}

/** 独立印证完整性 golden：一条 claim 的 supports 源结构 + 是否含不独立对。 */
export interface IndepGoldenItem {
  id: string
  subject: string
  predicate: string
  object: string
  claimText: string
  /** 额外 supports 源（默认 exact 主源外的副本）。 */
  extraSources: { contentHash?: string; derivedFromSourceId?: string; kind?: SourceKind }[]
  /** 人工真值：这批源里是否存在不独立对（同 hash / 直接 derived_from）。 */
  expectNonIndependent: boolean
}

// 同 subject+predicate 前缀 → trigram 近邻 ≥0.75，足以被 findAnchors 召回。
function pair(
  id: string,
  tier: ReconcileTier,
  subject: string,
  predicate: string,
  anchorLB: number,
  candLB: number,
  over: Partial<ReconcilerPairItem> = {},
): ReconcilerPairItem {
  const anchorText = `${subject} ${predicate} is at least ${anchorLB} units`
  const candidateText = `${subject} ${predicate} is at least ${candLB} units`
  return {
    id,
    tier,
    subject,
    predicate,
    anchorText,
    anchorObject: `at least ${anchorLB}`,
    candidateText,
    candidateObject: `at least ${candLB}`,
    expectFlagged: tier === 'L1c_poison' && (over.candidateStatus ?? 'active') === 'active',
    expectEscalated: tier === 'L1c_poison',
    expectRefines: tier === 'L1b_refines',
    ...over,
  }
}

/**
 * 冻结的 Reconciler pair golden：每层多对（领域无关）。
 *   L1b refines：A 更窄 (candLB ≥ anchorLB) ⇒ A⊢B ⇒ pass ⇒ refines。
 *   L1c poison：A 被改小 (candLB < anchorLB) ⇒ A⊬B ⇒ fail ⇒ poison（含一对 draft：不收紧但记信号）。
 *   L1a same：object 等价对（用 anchorText==candidateText 的等价数值）⇒ isReconcileCandidate=false ⇒ inconclusive。
 */
export const RECONCILER_PAIR_GOLDEN: readonly ReconcilerPairItem[] = Object.freeze(
  [
    // L1b 真精炼（更窄、仍在锚真值域内）。
    pair('recon-L1b-1', 'L1b_refines', 'cellpack', 'capacity', 4000, 4500),
    pair('recon-L1b-2', 'L1b_refines', 'rotor', 'speed', 1000, 1200),
    pair('recon-L1b-3', 'L1b_refines', 'buffer', 'depth', 64, 128),
    // L1c 等价投毒（object 被悄悄改小，A⊄B）。
    pair('recon-L1c-1', 'L1c_poison', 'powercell', 'capacity', 4000, 800),
    pair('recon-L1c-2', 'L1c_poison', 'turbine', 'output', 5000, 500),
    pair('recon-L1c-3', 'L1c_poison', 'tank', 'volume', 9000, 90),
    // L1c draft poison：A.4 下 draft→flagged 非法 → 不收紧（expectFlagged=false）但仍记 escalation。
    pair('recon-L1c-draft', 'L1c_poison', 'reservoir', 'volume', 8000, 80, {
      candidateStatus: 'draft',
    }),
    // L1a 规则可判等价（object 等价 → 非 candidate → inconclusive、不 flag、不 refines）。
    {
      id: 'recon-L1a-1',
      tier: 'L1a_same',
      subject: 'modulex',
      predicate: 'mass',
      anchorText: 'modulex mass is 4000 mah',
      anchorObject: '4000mah',
      candidateText: 'modulex mass is 4000 mah',
      candidateObject: '4000mah',
      expectFlagged: false,
      expectEscalated: false,
      expectRefines: false,
    },
    {
      id: 'recon-L1a-2',
      tier: 'L1a_same',
      subject: 'beamline',
      predicate: 'length',
      anchorText: 'beamline length is 1 m',
      anchorObject: '1m',
      candidateText: 'beamline length is 100 cm', // 单位归一等价 → objectEquivalent → 非 candidate
      candidateObject: '100cm',
      expectFlagged: false,
      expectEscalated: false,
      expectRefines: false,
    },
  ].map((it) => Object.freeze(it)),
)

/** 冻结的独立印证完整性 golden。 */
export const RECONCILER_INDEP_GOLDEN: readonly IndepGoldenItem[] = Object.freeze(
  [
    (() => {
      const sharedHash = 'l1-shared-hash-aaaa'
      return {
        id: 'recon-indep-samehash',
        subject: 'widget-a',
        predicate: 'weight',
        object: '250g',
        claimText: 'widget-a weight is 250 g',
        extraSources: [{ contentHash: sharedHash }, { contentHash: sharedHash }],
        expectNonIndependent: true,
      }
    })(),
    {
      id: 'recon-indep-clean',
      subject: 'widget-b',
      predicate: 'weight',
      object: '300g',
      claimText: 'widget-b weight is 300 g',
      extraSources: [{}, {}], // 两条 contentHash 各异、无血缘 → 独立
      expectNonIndependent: false,
    },
  ].map((it) => Object.freeze(it)),
)
