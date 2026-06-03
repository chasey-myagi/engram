/**
 * confidence 管线（**命门**，附录 A.3）：七因子 → raw → g。
 *
 *   base          = Σ wᵢ·fᵢ        （5 加性因子，Σw=1 ⇒ base∈[0,1]）
 *   staleDecay    = 0.5 ^ (ageDays / halfLifeDays)        （时效，乘性衰减）
 *   conflictDecay = 1 / (1 + α·activeContradicts)         （活跃矛盾，乘性衰减）
 *   raw           = base · staleDecay · conflictDecay ∈ [0,1]
 *   conf          = g(raw)         （g 起步 = identity；isotonic 校准是 S28）
 *
 * 这替换现状 `min(1, 来源数×0.3)` 的五档离散——raw 先连续化，reliability diagram / ECE 才有意义（S5）。
 * 数值为起步基线、可配置（S7 主编可调权重/门），冻结的是接口与判据。
 */

export interface FactorWeights {
  authority: number
  humanReview: number
  entailment: number
  indepSupport: number
  usageCorrect: number
}

/** 起步基线权重（A.3）：Σw=1。配置态（S7 主编可调）。 */
export const DEFAULT_WEIGHTS: FactorWeights = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}

/** 5 个加性因子，取值归一到 [0,1]。 */
export interface AdditiveFactors {
  authority: number
  humanReview: number
  entailment: number
  indepSupport: number
  usageCorrect: number
}

/** 无法计算的因子用中性值（A.3）：印证=0、人审未发生=0、entail 未跑=0.5。 */
export const NEUTRAL_FACTORS: AdditiveFactors = {
  authority: 0,
  humanReview: 0,
  entailment: 0.5,
  indepSupport: 0,
  usageCorrect: 0,
}

export interface PenaltyInputs {
  /** 原文时点距今天数（as_of → now）。 */
  ageDays: number
  /** 时效半衰期（天），按 source.kind。 */
  halfLifeDays: number
  /** 活跃 contradicts 边数（S8 起非零）。 */
  activeContradicts: number
}

/** conflictDecay 的 α 起步基线。 */
export const CONFLICT_ALPHA = 0.5

/** g 的起步版本：identity（conf=raw）。 */
export const CALIBRATION_IDENTITY = 'identity'

/** 内核消费门下界（A.2）：value 低于此绝不进召回结果。consumer / 配置态只能抬高，绝不能降低。 */
export const KERNEL_CONFIDENCE_FLOOR = 0.4
/** 信任门：value < 此值的召回结果须带 mustVerify=true（可用但先核验）；≥此值可直接用。 */
export const MUST_VERIFY_THRESHOLD = 0.6

/**
 * 时效半衰期（天）按 source kind。A.3 只点名 formal=730 / artifact=180 / conversation=90；
 * 其余 7 个 kind 归入最贴近的桶：external_feed 是近实时/未核实外部流（设计稿 FIG 4a 最低 unverified 层），
 * 最易变 → 最短半衰期 90，绝不能和正式文档同寿。
 */
export function halfLifeDaysForKind(kind: string): number {
  switch (kind) {
    case 'formal_document':
    case 'structured_spec':
      return 730
    case 'historical_artifact':
    case 'agent_synthesis':
      return 180
    case 'human_qa':
    case 'conversation_log':
    case 'external_feed':
      return 90
    default:
      return 180
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

const WEIGHT_KEYS = [
  'authority',
  'humanReview',
  'entailment',
  'indepSupport',
  'usageCorrect',
] as const

/**
 * 权重不变量（A.3，配置态写时强制）：各权重 ≥0（顺带挡 NaN）、0 < Σw ≤ 1、authority(出处)权重 >0（护 D1）。
 * S7 把 Σw=1 放松成 Σw≤1：主编可少分配（上限更保守，base 仍 ∈[0,1]）；Σw>1 仍拒。
 */
export function assertWeights(w: FactorWeights): void {
  for (const k of WEIGHT_KEYS) {
    if (!(w[k] >= 0)) throw new Error(`confidence: weight ${k} must be ≥ 0 (got ${w[k]})`)
  }
  const sum = w.authority + w.humanReview + w.entailment + w.indepSupport + w.usageCorrect
  if (sum > 1 + 1e-9) throw new Error(`confidence: Σw must be ≤ 1 (got ${sum})`)
  if (!(sum > 0)) throw new Error(`confidence: Σw must be > 0 (got ${sum})`)
  // 护住 D1：authority（出处权威）权重不可为 0，否则"无出处也可信"的口子被打开。
  if (!(w.authority > 0)) {
    throw new Error('confidence: authority weight must be > 0 (protects D1)')
  }
}

/** base = Σ wᵢ·fᵢ（因子先夹到 [0,1]，Σw=1 ⇒ base∈[0,1]）。 */
export function computeBase(f: AdditiveFactors, w: FactorWeights = DEFAULT_WEIGHTS): number {
  assertWeights(w)
  return (
    w.authority * clamp01(f.authority) +
    w.humanReview * clamp01(f.humanReview) +
    w.entailment * clamp01(f.entailment) +
    w.indepSupport * clamp01(f.indepSupport) +
    w.usageCorrect * clamp01(f.usageCorrect)
  )
}

/** staleDecay = 0.5^(ageDays/halfLife)；ageDays=halfLife 时 = 0.5；负 age 视为 0（=1）。 */
export function staleDecay(ageDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) throw new Error('confidence: halfLifeDays must be > 0')
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays)
}

/** conflictDecay = 1/(1+α·n)；n=0（或负）时 = 1。 */
export function conflictDecay(activeContradicts: number): number {
  return 1 / (1 + CONFLICT_ALPHA * Math.max(0, activeContradicts))
}

/** 独立印证数 → indepSupport ∈ [0,1)。1 源→0（无独立印证），越多越高（起步基线 1−0.5^(n−1)，可配置）。 */
export function independentSupportScore(independentCount: number): number {
  return 1 - Math.pow(0.5, Math.max(0, independentCount - 1))
}

/** raw = base · staleDecay · conflictDecay ∈ [0,1]。纯函数。 */
export function computeRaw(
  f: AdditiveFactors,
  p: PenaltyInputs,
  w: FactorWeights = DEFAULT_WEIGHTS,
): number {
  return (
    computeBase(f, w) * staleDecay(p.ageDays, p.halfLifeDays) * conflictDecay(p.activeContradicts)
  )
}

/**
 * 用一组权重对**已存因子**重算 raw（S7 配置态：召回时用活动权重重算）。
 * raw = base(加性因子, 权重) × 存档 staleDecay × conflictDecay。
 * opts.conflictDecay 可覆盖存档值 —— S8 召回时按**实时** active contradicts 边数现算 conflictDecay，
 * 让冲突双方实时各吃惩罚（存档的 conflictDecay 是写时 n=0 的快照，不反映后来才出现的矛盾）。
 */
export function rawFromStoredFactors(
  factors: ConfidenceFactorBreakdown,
  weights: FactorWeights,
  opts: { conflictDecay?: number } = {},
): number {
  const cDecay = opts.conflictDecay ?? factors.conflictDecay
  return computeBase(factors, weights) * factors.staleDecay * cDecay
}

/** g 映射：起步 identity（conf=raw）。未来在此分派 temperature / isotonic（S27/S28），与 w 职责分离。 */
export function applyG(raw: number, calibrationVersion: string = CALIBRATION_IDENTITY): number {
  switch (calibrationVersion) {
    case CALIBRATION_IDENTITY:
      return clamp01(raw)
    default:
      throw new Error(`confidence: unknown calibration version "${calibrationVersion}"`)
  }
}

/**
 * 写入/重算时算出的 confidence（持久化进 claim.confidence_factors）。
 * 注意与 A.2 recall-time `ConfidenceSnapshot`（带 takenAt、value/raw）区分：这是**写路径**的计算结果。
 */
export interface ComputedConfidence {
  confidence: number
  confidenceRaw: number
  factors: {
    authority: number
    humanReview: number
    entailment: number
    indepSupport: number
    usageCorrect: number
    ageDays: number
    activeContradicts: number
    staleDecay: number
    conflictDecay: number
  }
  weights: FactorWeights
  calibrationVersion: string
}

/** 因子拆解（持久化进 claim.confidence_factors.factors，A.3 七因子 + 两个衰减结果）。 */
export type ConfidenceFactorBreakdown = ComputedConfidence['factors']

/**
 * 持久化进 claim.confidence_factors 的 jsonb 形状。写路径（appendClaim）按此存，
 * 读路径（recallClaims）按此读 —— 一个类型锁住两端，防漂移。注意只存 raw 与因子/权重/校准版本，
 * **不存 value**：value=g(raw) 在召回时按当前 g 现算（S27/S28 换 g 即时生效，无需重写 claim）。
 */
export interface StoredConfidence {
  factors: ConfidenceFactorBreakdown
  weights: FactorWeights
  calibrationVersion: string
}

/** 一站式：因子 + 惩罚 → 完整计算结果。"为什么信"（w）与"数值=真实概率"（g）分开记。 */
export function computeConfidence(
  f: AdditiveFactors,
  p: PenaltyInputs,
  opts: { weights?: FactorWeights; calibrationVersion?: string } = {},
): ComputedConfidence {
  const weights = opts.weights ?? DEFAULT_WEIGHTS
  const calibrationVersion = opts.calibrationVersion ?? CALIBRATION_IDENTITY
  const confidenceRaw = computeRaw(f, p, weights)
  const confidence = applyG(confidenceRaw, calibrationVersion)
  return {
    confidence,
    confidenceRaw,
    factors: {
      // 快照存夹取后的值，与 computeBase 实际用的一致（replay 保真）
      authority: clamp01(f.authority),
      humanReview: clamp01(f.humanReview),
      entailment: clamp01(f.entailment),
      indepSupport: clamp01(f.indepSupport),
      usageCorrect: clamp01(f.usageCorrect),
      ageDays: p.ageDays,
      activeContradicts: p.activeContradicts,
      staleDecay: staleDecay(p.ageDays, p.halfLifeDays),
      conflictDecay: conflictDecay(p.activeContradicts),
    },
    weights,
    calibrationVersion,
  }
}
