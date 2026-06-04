/**
 * L1 Verifier golden（A.9 CI 红线 · 内核领域无关）—— ~50 条各状态 claim + 人工 entailment 真值，
 * 断言 Verifier 的 **flag/quarantine 决策**与人一致（precision / recall on flag decisions）。
 *
 * 盯 Verifier「会污染库的危险错」：漏检幻觉（unentailed claim 没被收紧 = recall 假阳）、或误伤可靠 claim
 * （sound claim 被错误 flag = recall 假阴/损失覆盖）。判据：flag 决策的 P/R 双 ≥ 阈（见 runner / test）。
 *
 * 验真而非 smoke：oracle **不是**硬编码 `()=>'fail'`——它从 claim 文本 + 出处原文**实算** entailment
 * （数值下界 + 关键词存在性），故 Verifier 的收紧逻辑（active→flagged / flagged→quarantined / 时效）若退化，
 * 决策会偏离人工标签、把 P/R 拉下阈值。
 *
 * 领域无关：全是通用事实（连接器、电池、网关…），不含 bidding SKU/列；不 import bidding golden。
 */
import type { ClaimStatus } from '@engram/core'

/** 人工真值：这条 claim 巡查后**应**被收紧（hallucination / stale / 与出处不可同真），还是应被保留/晋升。 */
export type VerifierLabel = 'should_flag' | 'should_keep'

/** 一条 Verifier golden claim。 */
export interface VerifierGoldenItem {
  id: string
  /** seed 时的状态（draft/active/flagged —— 只这三类可被巡查/收紧/晋升）。 */
  status: Extract<ClaimStatus, 'draft' | 'active' | 'flagged'>
  /** claim 文本（含可被 oracle 提取的数值/关键事实）。 */
  claimText: string
  subject: string
  predicate: string
  object: string
  /** 这条 claim 的出处原文（喂 oracle 实算 entailment 的 evidence）。 */
  evidence: string
  /** 出处源年龄（天）。> 该 kind 半衰期 → 时效巡查 stale。缺省 0（新鲜）。 */
  ageDays?: number
  /** 人工真值标签。 */
  label: VerifierLabel
  /** 标签理由（审计用，不进计分）。 */
  rationale: string
}

const HALFLIFE_STRUCTURED = 730 // structured_spec 半衰期（天）—— stale 阈

/**
 * 构造 ~50 条 golden。三类「应 flag」：① active 幻觉（出处推不出）；② flagged 仍无支撑（应进一步 quarantine）；
 * ③ active 时效过期（过半衰期）。两类「应 keep」：④ active 出处可推出（保持）；⑤ draft 出处可推出（晋升，不算 flag）。
 * draft 幻觉**不**算 should_flag（A.4：draft→flagged 非法，Verifier 保守留 draft，不收紧也不晋升 = keep 语义的 no-transition）。
 */
function buildGolden(): VerifierGoldenItem[] {
  const items: VerifierGoldenItem[] = []
  // 一批通用 (subject, predicate, 真值数值, 单位) 模板，足够生成 ~50 条且彼此事实独立。
  const facts: { s: string; p: string; truth: number; unit: string }[] = [
    { s: 'qx-7731', p: 'maxThroughput', truth: 480, unit: 'mbps' },
    { s: 'pump-a', p: 'capacity', truth: 4000, unit: 'mah' },
    { s: 'mesh-relay', p: 'failoverMs', truth: 120, unit: 'ms' },
    { s: 'cryo-pump', p: 'mttf', truth: 50000, unit: 'hours' },
    { s: 'sharded-ledger', p: 'maxTenants', truth: 256, unit: '' },
    { s: 'gateway', p: 'retryBudget', truth: 3, unit: 'attempts' },
    { s: 'actuator', p: 'dutyCycle', truth: 40, unit: 'percent' },
    { s: 'uplink', p: 'packetLoss', truth: 2, unit: 'percent' },
    { s: 'photonics', p: 'warranty', truth: 36, unit: 'months' },
    { s: 'analyzer', p: 'rangePpm', truth: 500, unit: 'ppm' },
  ]

  let n = 0
  const mk = (
    f: { s: string; p: string; truth: number; unit: string },
    over: Partial<VerifierGoldenItem> & { kind: string },
  ): VerifierGoldenItem => {
    n += 1
    const id = `verifier-${String(n).padStart(2, '0')}-${over.kind}`
    const truthStr = `${f.truth}${f.unit ? ' ' + f.unit : ''}`.trim()
    const claimVal = over.object ?? `${f.truth}${f.unit}`
    return {
      id,
      status: over.status ?? 'active',
      claimText: over.claimText ?? `${f.s} ${f.p} is ${truthStr}`,
      subject: f.s,
      predicate: f.p,
      object: claimVal,
      evidence: over.evidence ?? `the ${f.s} ${f.p} is ${truthStr} per the datasheet`,
      ...(over.ageDays !== undefined ? { ageDays: over.ageDays } : {}),
      label: over.label ?? 'should_keep',
      rationale: over.rationale ?? '',
    }
  }

  for (const f of facts) {
    // ④ sound active：出处明确陈述同一数值 → pass → keep（不收紧）。
    items.push(
      mk(f, {
        kind: 'sound-active',
        status: 'active',
        label: 'should_keep',
        rationale: 'evidence states the same value → entailed → stays active',
      }),
    )
    // ① hallucinated active：claim 数值被夸大，出处给的是真值 → fail → 应 flag。
    items.push(
      mk(f, {
        kind: 'halluc-active',
        status: 'active',
        object: `${f.truth * 10}${f.unit}`,
        claimText: `${f.s} ${f.p} is ${f.truth * 10}${f.unit ? ' ' + f.unit : ''}`.trim(),
        evidence: `the ${f.s} ${f.p} is ${f.truth}${f.unit ? ' ' + f.unit : ''} per the datasheet`,
        label: 'should_flag',
        rationale: 'claim inflates the value beyond what the evidence supports → hallucination',
      }),
    )
    // ⑤ sound draft：出处可推出 → pass → 晋升（active），不算 flag → keep。
    items.push(
      mk(f, {
        kind: 'sound-draft',
        status: 'draft',
        label: 'should_keep',
        rationale: 'draft with entailed evidence → promotes to active (not a flag)',
      }),
    )
  }

  // ③ stale active（过半衰期，但 entailment pass）：时效巡查应 flag。取前 10 个 fact。
  for (const f of facts) {
    items.push(
      mk(f, {
        kind: 'stale-active',
        status: 'active',
        ageDays: HALFLIFE_STRUCTURED + 100,
        label: 'should_flag',
        rationale:
          'past the kind half-life → staleness patrol flags it even though entailment passes',
      }),
    )
  }

  // ② flagged 仍无支撑：再巡仍 fail → 应进一步 quarantine（= tighten = should_flag）。取前 10 个 fact。
  for (const f of facts) {
    items.push(
      mk(f, {
        kind: 'flagged-unsupported',
        status: 'flagged',
        object: `${f.truth * 10}${f.unit}`,
        claimText: `${f.s} ${f.p} is ${f.truth * 10}${f.unit ? ' ' + f.unit : ''}`.trim(),
        evidence: `the ${f.s} ${f.p} is ${f.truth}${f.unit ? ' ' + f.unit : ''} per the datasheet`,
        label: 'should_flag',
        rationale: 'already-flagged claim still unentailed → tighten further to quarantined',
      }),
    )
  }

  return items
}

/** 冻结的 Verifier golden 集（~50 条，各状态 + 人工 flag/keep 真值）。 */
export const VERIFIER_GOLDEN: readonly VerifierGoldenItem[] = Object.freeze(
  buildGolden().map((it) => Object.freeze(it)),
)
