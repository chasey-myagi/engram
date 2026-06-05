/**
 * GovernanceController 恒温器的**纯控制律**（S26，PRD A.7/A.8）—— 零 DB、零 LLM、零随机：
 * 给定（上一策略 + 五标量度量 + 不变的 config），恒产出同一新策略 + 同一动作。可回归、可复现。
 *
 * 这是「确定性恒温器」的数学核心：周期比对五指标，把健康度下降映射成 D2 **收紧**，但**闭环**——
 * 不是单调收紧到死：上升的 falseQuarantineRate 反向**放宽**巡查激进度（counter-force），让系统能回弹。
 *
 * 控制律（逐旋钮，proportional + deadband + bounded damped step）保证**收敛不振荡**：
 *   error = target − prev
 *   |error| ≤ deadband              → next = prev      （死区/迟滞：贴近设定点不再抖）
 *   |error| >  deadband             → next = prev + clamp(gain·error, ±maxStep)，再夹到 [lo,hi]
 * 在 target 恒定时：|next − target| = |prev − target|·(1−gain)（当未触 maxStep / 边界），
 * 即 0<gain≤1 的**收缩映射** → 几何收敛、单调逼近、**绝不过冲**（步长幅值 ≤ error 幅值，永不反号），
 * 触 deadband 即停 → 控制序列**有界总变差**、有限步落定、无极限环抖动。这就是 P2 门要的「收敛证明」。
 *
 * target 是**活的派生值**（metrics 的纯函数），不是硬编码常量：不同健康度画像 → 不同 target → 不同策略。
 * 这正是「乐观/悲观平衡点是 live derived value」的兑现。
 */

/** 五指标标量（A.8）。读取口径见 metric-readers.ts；L2 仿真可直接注入合成时序。 */
export interface GovernanceMetrics {
  /** 蒸馏队列积压（绝对计数，≥0）。↑ → 限流 ingestion。 */
  distillBacklog: number
  /** entailment 拒绝率 ∈ [0,1]（fail/not_co_true 占巡查总数）。↑ → 抬 draft→active 晋升门。 */
  entailRejectRate: number
  /** 待裁冲突深度（绝对计数，≥0）。↑ → 提 Arbiter 优先级。 */
  conflictQueueDepth: number
  /** flag→quarantine 中位延迟（秒，≥0）。↑ → 提 Verifier 巡查频次。 */
  immuneLag: number
  /** 人工翻案的误隔离率 ∈ [0,1]（un_quarantine 占被隔离数）。↑ → **放宽**巡查激进度（闭环反作用力）。 */
  falseQuarantineRate: number
}

/**
 * 派生策略（四旋钮，皆 ∈ [0,1]，0=基线乐观、1=最收紧）。控制器产出、版本化持久化（governance-state.ts）。
 *   - promotionGateLevel：draft→active 晋升门收紧档（0 不抬门；>0 抬 consumeFloor/mustVerify，遵 S7 不变量）。
 *     这就是「乐观/悲观平衡点」——live derived，随健康度变。
 *   - patrolFrequency：Verifier 巡查激进度（受 immuneLag 推高、受 falseQuarantineRate 反向拉低）。
 *   - ingestionThrottle：ingestion 限流档（0 全开、1 全限）。
 *   - arbiterPriority：Arbiter 裁决优先级档。
 */
export interface GovernancePolicy {
  promotionGateLevel: number
  patrolFrequency: number
  ingestionThrottle: number
  arbiterPriority: number
}

/** 控制律可调参数（不变量；不进策略，确定性的一部分）。 */
export interface ControlConfig {
  /** 比例增益 ∈ (0,1]：每步逼近 target 的比例。<1 提供阻尼。 */
  readonly gain: number
  /** 死区半宽 ≥0：|target−prev|≤deadband 时不动（迟滞，防贴设定点抖）。 */
  readonly deadband: number
  /** 单步最大幅度 ∈ (0,1]：限步，防一步跳变（额外阻尼/平滑）。 */
  readonly maxStep: number
  /** distillBacklog 归一刻度（达此值视为「满压」target→1）。 */
  readonly backlogScale: number
  /** conflictQueueDepth 归一刻度。 */
  readonly conflictScale: number
  /** immuneLag 归一刻度（秒）。 */
  readonly lagScale: number
  /** falseQuarantineRate → patrol 反向拉低的强度系数（闭环 counter-force 增益）。 */
  readonly falseQuarantineLoosen: number
}

/** 起步基线控制参数。gain<1 + maxStep<1 双重阻尼；deadband 给迟滞。刻度按当前体量的经验值，可调。 */
export const DEFAULT_CONTROL_CONFIG: ControlConfig = {
  gain: 0.5,
  deadband: 0.02,
  maxStep: 0.25,
  backlogScale: 50,
  conflictScale: 20,
  lagScale: 3600, // 1h 中位延迟视为满压
  falseQuarantineLoosen: 1,
}

/** 全乐观基线策略（系统健康时的归宿：四旋钮归零，不收紧任何东西）。 */
export const BASELINE_POLICY: GovernancePolicy = {
  promotionGateLevel: 0,
  patrolFrequency: 0,
  ingestionThrottle: 0,
  arbiterPriority: 0,
}

/** 夹到 [0,1]。 */
function clamp01(x: number): number {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/** 饱和归一：x/scale 夹到 [0,1]（>scale 视为满压 1）。scale≤0 时退化为 0（无压力，silent-safe）。 */
function saturate(x: number, scale: number): number {
  if (!(scale > 0)) return 0
  return clamp01(x / scale)
}

/**
 * 从度量纯计算四旋钮的**目标值**（live derived 平衡点）。每个 target 都是对应指标的**单调饱和**映射，
 * 故「健康度下降→target 升→收紧」单调成立；patrol 额外减去 falseQuarantineRate 的反向项（闭环）。
 */
export function deriveTargets(
  metrics: GovernanceMetrics,
  config: ControlConfig = DEFAULT_CONTROL_CONFIG,
): GovernancePolicy {
  const ingestionThrottle = saturate(metrics.distillBacklog, config.backlogScale)
  const promotionGateLevel = clamp01(metrics.entailRejectRate)
  const arbiterPriority = saturate(metrics.conflictQueueDepth, config.conflictScale)
  // 闭环 counter-force：immuneLag 推高巡查，falseQuarantineRate（误隔离被人翻案）反向拉低——
  // 误隔离越多说明巡查太激进，放宽之。clamp01 保证 target 仍在 [0,1]。
  const patrolFrequency = clamp01(
    saturate(metrics.immuneLag, config.lagScale) -
      config.falseQuarantineLoosen * clamp01(metrics.falseQuarantineRate),
  )
  return { promotionGateLevel, patrolFrequency, ingestionThrottle, arbiterPriority }
}

/** 单旋钮一步：proportional + deadband + bounded step + clamp。收缩映射，单调逼近、不过冲。 */
function stepKnob(prev: number, target: number, config: ControlConfig): number {
  const error = target - prev
  if (Math.abs(error) <= config.deadband) return prev // 死区：贴近设定点不动（迟滞）
  const raw = config.gain * error
  const capped =
    raw > config.maxStep ? config.maxStep : raw < -config.maxStep ? -config.maxStep : raw
  return clamp01(prev + capped)
}

/** 控制器一步的产物：新策略 + 各旋钮目标 + 本步是否真的改了策略。 */
export interface ControlStep {
  policy: GovernancePolicy
  /** 各旋钮本步的目标值（审计/可解释；live derived 平衡点的快照）。 */
  targets: GovernancePolicy
  /** 本步策略是否相对上一步发生变化（任一旋钮越过死区动了）。 */
  changed: boolean
}

/**
 * 控制器**核心一步**（纯函数）：给定上一策略 + 度量 → 新策略。逐旋钮跑 stepKnob（同一收缩律）。
 * 确定性：同 (prev, metrics, config) 恒得同 policy。无副作用、无 IO。
 */
export function stepController(
  prev: GovernancePolicy,
  metrics: GovernanceMetrics,
  config: ControlConfig = DEFAULT_CONTROL_CONFIG,
): ControlStep {
  const targets = deriveTargets(metrics, config)
  const policy: GovernancePolicy = {
    promotionGateLevel: stepKnob(prev.promotionGateLevel, targets.promotionGateLevel, config),
    patrolFrequency: stepKnob(prev.patrolFrequency, targets.patrolFrequency, config),
    ingestionThrottle: stepKnob(prev.ingestionThrottle, targets.ingestionThrottle, config),
    arbiterPriority: stepKnob(prev.arbiterPriority, targets.arbiterPriority, config),
  }
  const changed =
    policy.promotionGateLevel !== prev.promotionGateLevel ||
    policy.patrolFrequency !== prev.patrolFrequency ||
    policy.ingestionThrottle !== prev.ingestionThrottle ||
    policy.arbiterPriority !== prev.arbiterPriority
  return { policy, targets, changed }
}

/** 旋钮名集合（审计/遍历用）。 */
export const POLICY_KNOBS = [
  'promotionGateLevel',
  'patrolFrequency',
  'ingestionThrottle',
  'arbiterPriority',
] as const
export type PolicyKnob = (typeof POLICY_KNOBS)[number]
