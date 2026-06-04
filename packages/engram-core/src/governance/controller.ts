/**
 * GovernanceController 恒温器**生产编排**（S26，PRD A.7/A.8）—— 周期性把五指标 → D2 收紧（闭环、确定性）。
 *
 * 一轮 runGovernanceCycle：
 *   ① readMetrics（逐指标独立降级；falseQuarantineRate 由真 S22 human_overturn 喂）
 *   ② stepController（纯收缩律，从活动策略走一步——确定性、收敛不振荡，见 control-law.ts）
 *   ③ writeGovernanceState（append-only 持久化新策略 + 触发指标快照 + reason，审计 + 可逆）
 *   ④ 若 gate 确实抬严 → setStandards 抬 consumeFloor/mustVerify（只抬、遵 S7 不变量；历史快照冻结）
 *
 * **失效静音退回三层主干**：整轮包在一个 try/catch 里——任何环节抛错（DB 抖、reader 全挂、standards 写失败）
 * 只让本轮成为 no-op（返回 ran=false + reason），**绝不**抛进调用方、绝不阻塞 append/recall 主干、零编排单点。
 * 这是「零 orchestration single point；失效静音退回三层主干」红线在控制器入口的兜底。
 */
import { getActiveStandards, setStandards, type Standards } from '../config/standards.js'
import type { DB } from '../db/client.js'
import {
  stepController,
  type ControlConfig,
  type GovernanceMetrics,
  type GovernancePolicy,
  DEFAULT_CONTROL_CONFIG,
} from './control-law.js'
import { gateWouldTighten, standardsInputFromPolicy } from './gate-policy.js'
import {
  getActivePolicy,
  writeGovernanceState,
  type GovernanceStateRow,
} from './governance-state.js'
import { defaultMetricReaders, readMetrics, type MetricReaders } from './metric-readers.js'

export interface RunCycleOptions {
  /** 控制律参数（默认 DEFAULT_CONTROL_CONFIG）。 */
  config?: ControlConfig
  /** 指标读取器 bundle（默认接真 SPI；测试可注入合成/会抛的 reader 验证降级）。 */
  readers?: MetricReaders
  /** 写入者审计身份（默认 controller:governance）。 */
  createdBy?: string
}

export interface RunCycleResult {
  /** 本轮是否真的跑完（false = 失效静音降级，主干不受影响）。 */
  ran: boolean
  /** 本轮读到的五指标（degraded 指标已退中性值）。降级时仍给出，便于审计。 */
  metrics?: GovernanceMetrics
  /** 本轮降级（reader 抛错）的指标名。非空 = 部分降级仍跑完。 */
  degraded?: (keyof GovernanceMetrics)[]
  /** 控制器走一步后的新策略（已持久化）。 */
  policy?: GovernancePolicy
  /** 持久化的新策略版本行（审计/可逆锚点）。 */
  stateRow?: GovernanceStateRow
  /** 本步是否相对上一步改了策略。 */
  changed?: boolean
  /** 是否据此抬了 D2 消费门（落了新 standards 版本）。 */
  raisedGate?: boolean
  /** 抬门后的活动消费门（审计）。 */
  standardsAfter?: Standards
  /** 降级/no-op 原因（ran=false 时给出）。 */
  reason?: string
}

/**
 * 跑一轮恒温器（生产路径）。**整轮 fail-silent**：抛错只让本轮 no-op，不传染主干。
 * 返回审计用结果（ran/metrics/policy/raisedGate…）。
 */
export async function runGovernanceCycle(
  db: DB,
  opts: RunCycleOptions = {},
): Promise<RunCycleResult> {
  const config = opts.config ?? DEFAULT_CONTROL_CONFIG
  const readers = opts.readers ?? defaultMetricReaders
  const createdBy = opts.createdBy ?? 'controller:governance'
  try {
    const { metrics, degraded } = await readMetrics(db, readers)
    const prev = await getActivePolicy(db)
    const { policy, targets, changed } = stepController(prev, metrics, config)

    const reason = changed
      ? `cycle: stepped policy${degraded.length ? ` (degraded: ${degraded.join(',')})` : ''}`
      : `cycle: held policy (within deadband)${degraded.length ? ` (degraded: ${degraded.join(',')})` : ''}`
    const stateRow = await writeGovernanceState(db, {
      policy,
      metrics: { ...metrics, targets },
      reason,
      createdBy,
    })

    // ④ 若 gate 确实抬严，落一行新 standards（只抬、遵 S7 不变量；setStandards 内 assertThresholds 二次护栏）。
    let raisedGate = false
    let standardsAfter: Standards | undefined
    const active = await getActiveStandards(db)
    if (gateWouldTighten(policy, active)) {
      await setStandards(db, standardsInputFromPolicy(policy, active.factorWeights, createdBy))
      raisedGate = true
      standardsAfter = await getActiveStandards(db)
    }

    return {
      ran: true,
      metrics,
      degraded,
      policy,
      stateRow,
      changed,
      raisedGate,
      ...(standardsAfter ? { standardsAfter } : {}),
    }
  } catch (err) {
    // 失效静音：本轮 no-op，主干（append/recall）照常服务，绝不把控制器故障抛出去。
    return {
      ran: false,
      reason: `governance cycle degraded silently: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
