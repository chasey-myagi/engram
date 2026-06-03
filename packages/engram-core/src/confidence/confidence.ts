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

/** 时效半衰期（天）按 source kind（A.3：formal=730 / artifact=180 / conversation=90）。 */
export function halfLifeDaysForKind(kind: string): number {
  switch (kind) {
    case 'formal_document':
    case 'structured_spec':
    case 'external_feed':
      return 730
    case 'historical_artifact':
    case 'agent_synthesis':
      return 180
    case 'human_qa':
    case 'conversation_log':
      return 90
    default:
      return 180
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function assertWeights(w: FactorWeights): void {
  const sum = w.authority + w.humanReview + w.entailment + w.indepSupport + w.usageCorrect
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`confidence: Σw must equal 1 (got ${sum})`)
  }
  // 护住 D1：authority（出处权威）权重不可为 0，否则"无出处也可信"的口子被打开。
  if (!(w.authority > 0)) {
    throw new Error('confidence: authority weight must be > 0 (protects D1)')
  }
}

/** base = Σ wᵢ·fᵢ（Σw=1 ⇒ base∈[0,1]）。 */
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

/** staleDecay = 0.5^(ageDays/halfLife)；ageDays=halfLife 时 = 0.5。 */
export function staleDecay(ageDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) throw new Error('confidence: halfLifeDays must be > 0')
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays)
}

/** conflictDecay = 1/(1+α·n)；n=0 时 = 1。 */
export function conflictDecay(activeContradicts: number): number {
  return 1 / (1 + CONFLICT_ALPHA * Math.max(0, activeContradicts))
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

/** g 映射：起步 identity（conf=raw）。未来在此分派 temperature / isotonic（S27/S28），与 w 职责分离。 */
export function applyG(raw: number, calibrationVersion: string = CALIBRATION_IDENTITY): number {
  switch (calibrationVersion) {
    case CALIBRATION_IDENTITY:
      return clamp01(raw)
    default:
      throw new Error(`confidence: unknown calibration version "${calibrationVersion}"`)
  }
}

/** 召回当刻可复盘的 confidence 快照（持久化进 claim.confidence_factors）。 */
export interface ConfidenceSnapshot {
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

/** 一站式：因子 + 惩罚 → 完整快照。"为什么信"（w）与"数值=真实概率"（g）分开记。 */
export function computeConfidence(
  f: AdditiveFactors,
  p: PenaltyInputs,
  opts: { weights?: FactorWeights; calibrationVersion?: string } = {},
): ConfidenceSnapshot {
  const weights = opts.weights ?? DEFAULT_WEIGHTS
  const calibrationVersion = opts.calibrationVersion ?? CALIBRATION_IDENTITY
  const confidenceRaw = computeRaw(f, p, weights)
  const confidence = applyG(confidenceRaw, calibrationVersion)
  return {
    confidence,
    confidenceRaw,
    factors: {
      authority: f.authority,
      humanReview: f.humanReview,
      entailment: f.entailment,
      indepSupport: f.indepSupport,
      usageCorrect: f.usageCorrect,
      ageDays: p.ageDays,
      activeContradicts: p.activeContradicts,
      staleDecay: staleDecay(p.ageDays, p.halfLifeDays),
      conflictDecay: conflictDecay(p.activeContradicts),
    },
    weights,
    calibrationVersion,
  }
}
