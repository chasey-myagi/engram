/**
 * L2 控制面仿真谐波（S26，PRD 用户故事 46 / 测试决策 §5）—— 给恒温器喂健康度时序，
 * 跑纯控制律（control-law.ts，零 DB / 零 LLM），产出策略轨迹 + **收敛诊断**，让「收敛不振荡」可被断言咬死。
 *
 * 诊断量（逐旋钮 + 聚合）：
 *   - trajectory：每步四旋钮值（确定性序列）。
 *   - totalVariation：Σ|x_{t}−x_{t-1}|（控制信号的总变差）。收敛序列其有界且趋稳；振荡序列其会膨胀。
 *   - signFlips：相邻步增量的**符号翻转**次数（去掉零增量后看正负交替）。收敛=0（单调逼近）；振荡(ringing)>0。
 *   - settledAtStep：序列落入「与终值之差 ≤ tol 且此后不再越界」的首个步号（有限步落定）。
 *   - converged：在 metrics 末段恒定的前提下，settledAtStep 存在且 signFlips=0 → 判定收敛不振荡。
 *
 * 这些诊断**纯由轨迹算**，不依赖控制器内部实现——测的是外部行为（控制信号收不收敛），不是实现细节。
 */
import {
  stepController,
  BASELINE_POLICY,
  DEFAULT_CONTROL_CONFIG,
  POLICY_KNOBS,
  type ControlConfig,
  type GovernanceMetrics,
  type GovernancePolicy,
  type PolicyKnob,
} from './control-law.js'

/** 逐旋钮的收敛诊断。 */
export interface KnobConvergence {
  /** 该旋钮逐步值序列（含起点 prev）。 */
  series: number[]
  /** 总变差 Σ|Δ|。 */
  totalVariation: number
  /** 相邻增量的符号翻转次数（>0 = 有 ringing/振荡）。 */
  signFlips: number
  /** 落定步号（与终值差 ≤ tol 且此后不越界的首个 step；未落定 = null）。 */
  settledAtStep: number | null
  /** 终值（序列最后一项）。 */
  finalValue: number
}

/** 整轮仿真结果。 */
export interface L2SimResult {
  /** 逐步策略轨迹（每步四旋钮）。trajectory[0] = 初始策略（未步进）。 */
  trajectory: GovernancePolicy[]
  /** 逐旋钮收敛诊断。 */
  perKnob: Record<PolicyKnob, KnobConvergence>
  /** 任一旋钮是否出现符号翻转（true = 有振荡迹象）。 */
  anySignFlip: boolean
  /** 全部旋钮在末段恒定指标下都落定（settledAtStep 非 null）。 */
  allSettled: boolean
  /** 落定 + 零符号翻转 → 判定收敛不振荡（P2 门要的结论）。 */
  convergedWithoutOscillation: boolean
}

export interface L2SimOptions {
  /** 初始策略（默认全乐观基线）。 */
  initial?: GovernancePolicy
  /** 控制律参数（默认 DEFAULT_CONTROL_CONFIG）。 */
  config?: ControlConfig
  /** 落定容差（与终值之差 ≤ 此值视为落定）。默认 deadband + 微小裕度。 */
  settleTol?: number
}

function sign(x: number): -1 | 0 | 1 {
  if (x > 0) return 1
  if (x < 0) return -1
  return 0
}

/** 由单旋钮序列算诊断（总变差 / 符号翻转 / 落定步）。 */
function analyzeKnob(series: number[], tol: number): KnobConvergence {
  const finalValue = series[series.length - 1]!
  let totalVariation = 0
  let signFlips = 0
  let prevSign: -1 | 0 | 1 = 0
  for (let i = 1; i < series.length; i++) {
    const delta = series[i]! - series[i - 1]!
    totalVariation += Math.abs(delta)
    const s = sign(delta)
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) signFlips += 1
      prevSign = s
    }
  }
  // 落定步：从该步起到末尾都 |x−final|≤tol 的最早步。
  let settledAtStep: number | null = null
  for (let i = 0; i < series.length; i++) {
    let ok = true
    for (let j = i; j < series.length; j++) {
      if (Math.abs(series[j]! - finalValue) > tol) {
        ok = false
        break
      }
    }
    if (ok) {
      settledAtStep = i
      break
    }
  }
  return { series, totalVariation, signFlips, settledAtStep, finalValue }
}

/**
 * 跑一段健康度时序：每步用 series[t] 的度量步进控制器，记录策略轨迹，再逐旋钮算收敛诊断。
 * series 末段若恒定，收敛律保证轨迹几何收敛到对应 target、单调无过冲（见 control-law 证明）。
 */
export function simulate(series: GovernanceMetrics[], opts: L2SimOptions = {}): L2SimResult {
  const config = opts.config ?? DEFAULT_CONTROL_CONFIG
  const tol = opts.settleTol ?? config.deadband + 1e-9
  let policy = opts.initial ?? BASELINE_POLICY
  const trajectory: GovernancePolicy[] = [policy]
  for (const metrics of series) {
    policy = stepController(policy, metrics, config).policy
    trajectory.push(policy)
  }
  const perKnob = {} as Record<PolicyKnob, KnobConvergence>
  for (const knob of POLICY_KNOBS) {
    perKnob[knob] = analyzeKnob(
      trajectory.map((p) => p[knob]),
      tol,
    )
  }
  const anySignFlip = POLICY_KNOBS.some((k) => perKnob[k].signFlips > 0)
  const allSettled = POLICY_KNOBS.every((k) => perKnob[k].settledAtStep !== null)
  return {
    trajectory,
    perKnob,
    anySignFlip,
    allSettled,
    convergedWithoutOscillation: allSettled && !anySignFlip,
  }
}

/** 便利构造：把一个恒定的度量重复 n 步（用于「恒定输入下收敛」断言）。 */
export function constantSeries(metrics: GovernanceMetrics, steps: number): GovernanceMetrics[] {
  return Array.from({ length: steps }, () => metrics)
}
