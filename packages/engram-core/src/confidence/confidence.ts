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

/** g 的起步/sentinel 版本：identity（conf=raw）。也是 g=identity 即时回退（Story 29）的目标版本。 */
export const CALIBRATION_IDENTITY = 'identity'

/**
 * 单调校准映射 g' 的一个结点（S27）。g' = [0,1]→[0,1] 的分段线性、**非递减**插值，由升序 knots 定义。
 * x = 输入（raw）锚点，y = 该锚点处的校准输出（已校准概率）。两端无需覆盖 0/1：插值在端点外做夹断外推。
 */
export interface CalibrationKnot {
  x: number
  y: number
}

/**
 * 校准映射 g'（S27，A.3 命门「g=value==真实概率，statistical」）。version 是它在 calibration_map 表里的具名版本；
 * knots 是定义它的升序结点（identity 版本 knots=[]，直通 raw）。这是「w 为什么信 / g 数值多准」职责分离里的 g 半边。
 * **不可变值对象**：拟合算法（S28 isotonic）产出它，验收门（S27）审它，recall 按 claim 钉的版本应用它。
 */
export interface CalibrationMap {
  version: string
  knots: CalibrationKnot[]
}

/** 内核 sentinel 校准映射：identity（空 knots，applyGMap 直通 raw）。表空 / 回退到它即 g=raw。 */
export const IDENTITY_MAP: CalibrationMap = { version: CALIBRATION_IDENTITY, knots: [] }

/**
 * 校验校准映射的两个**几何不变量**（验收门 ①② 与 store 写时都靠它，单一口径防漂移）：
 *   ① knots 的 x **严格升序**（同 x 无定义、会让插值除零）；
 *   ② y **非递减**（g' 单调不减——校准不能把高 raw 压到比低 raw 还低，否则破坏排序语义）；
 *   ③ 所有 x、y ∈ [0,1]（值域闭合）。
 * 违反即抛（写时硬拒）。identity（空 knots）平凡满足。NaN 一律视为违反（>/≥/范围比较对 NaN 恒 false）。
 */
export function assertCalibrationMap(map: CalibrationMap): void {
  const ks = map.knots
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i]!
    if (!(k.x >= 0 && k.x <= 1)) {
      throw new Error(`calibration: knot.x must be in [0,1] (got ${k.x} at #${i})`)
    }
    if (!(k.y >= 0 && k.y <= 1)) {
      throw new Error(`calibration: knot.y must be in [0,1] (got ${k.y} at #${i})`)
    }
    if (i > 0) {
      const prev = ks[i - 1]!
      if (!(k.x > prev.x)) {
        throw new Error(`calibration: knot.x must be strictly ascending (got ${prev.x} → ${k.x})`)
      }
      if (!(k.y >= prev.y)) {
        throw new Error(`calibration: g' must be non-decreasing (got y ${prev.y} → ${k.y})`)
      }
    }
  }
}

/**
 * 纯函数：把校准映射 g' 应用到 raw（分段线性插值，端点外夹断）。空 knots（identity）= 直通 clamp01(raw)。
 * 已假定 map 满足不变量（升序、非递减、值域 [0,1]）——调用方/store 写时已 assertCalibrationMap。
 * 给定 x 落在 [knots[i].x, knots[i+1].x] 内时线性插值；左于首结点 → 首结点 y；右于末结点 → 末结点 y。
 */
export function applyGMap(raw: number, map: CalibrationMap): number {
  const x = clamp01(raw)
  const ks = map.knots
  if (ks.length === 0) return x // identity
  if (x <= ks[0]!.x) return clamp01(ks[0]!.y) // 左夹断
  const last = ks[ks.length - 1]!
  if (x >= last.x) return clamp01(last.y) // 右夹断
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!
    const b = ks[i + 1]!
    if (x >= a.x && x <= b.x) {
      const span = b.x - a.x
      const t = span > 0 ? (x - a.x) / span : 0 // 升序保证 span>0；除零守卫纯防御
      return clamp01(a.y + t * (b.y - a.y))
    }
  }
  return clamp01(last.y) // 兜底（理论不可达：上面区间已覆盖 [first.x,last.x]）
}

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

/**
 * g 映射（S27：按版本应用）。与 w（为什么信，配置态）职责**分离**：这里只算「数值=多准」（statistical）。
 *
 * - identity 版本（或缺省）→ clamp01(raw)，**无需** DB / 无需 map 入参（热路径默认零开销）。
 * - 非 identity 版本 → **必须**传入该版本已解析的 `map`（升序、非递减、值域 [0,1] 的 knots），分段线性插值。
 *   保持纯/同步：recall 与 live-recompute 在请求开头按候选 claim 钉的版本批量解析 map，再逐条同步 applyG 传入。
 *   传入 map.version 与 calibrationVersion 不一致 → 抛（防张冠李戴用错版本的 g）。
 *
 * **快照冻结**靠这条性质天然成立：每条 claim 钉死自己的 calibrationVersion，recall 解析的就是它钉的那版 g'，
 * 后来换活动版本不回溯改写老 claim 的锚 → 老快照永远按它当年的 g 算。
 */
export function applyG(
  raw: number,
  calibrationVersion: string = CALIBRATION_IDENTITY,
  map?: CalibrationMap,
): number {
  if (calibrationVersion === CALIBRATION_IDENTITY) return clamp01(raw)
  if (!map) {
    throw new Error(
      `confidence: calibration version "${calibrationVersion}" requires a resolved map (none supplied)`,
    )
  }
  if (map.version !== calibrationVersion) {
    throw new Error(
      `confidence: map version "${map.version}" does not match requested "${calibrationVersion}"`,
    )
  }
  return applyGMap(raw, map)
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
