/**
 * 恒温器 promotionGateLevel → D2 消费门收紧的**纯映射**（S26，PRD A.8「抬 draft→active 晋升门」）。
 *
 * 红线#2 + S7 不变量在此硬执行：配置态**只能抬严，绝不放松**。本映射把 [0,1] 的 promotionGateLevel
 * 单调映射成 consumeFloor / mustVerifyThreshold 的**抬升量**，且**永远叠加在内核硬下界之上**（≥0.4 / ≥0.6），
 * 落库前再走 setStandards 的 assertThresholds 二次护栏（双保险）。gateLevel=0 → 退回内核基线（不抬门）。
 *
 * 故意只**抬门、不动权重**：权重是主编的内容性判断（A.3 factor_weights），恒温器无权改；它只调治理门限。
 * 收紧后历史快照冻结（recall 已返回的值拷贝不回溯漂移）——这由 standards 的快照式样天然保证（见 standards.ts）。
 */
import {
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
  type FactorWeights,
} from '../confidence/confidence.js'
import type { Standards, StandardsInput } from '../config/standards.js'
import type { GovernancePolicy } from './control-law.js'

/** 满档（gateLevel=1）时 consumeFloor 相对内核 0.4 的最大抬升量。0.4 + 0.55 = 0.95，仍 <1。 */
export const MAX_CONSUME_FLOOR_RAISE = 0.55
/** 满档时 mustVerifyThreshold 相对内核 0.6 的最大抬升量。0.6 + 0.4 = 1.0（封顶 1）。 */
export const MAX_MUST_VERIFY_RAISE = 0.4

/** 夹到 [0,1]。 */
function clamp01(x: number): number {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * 由 promotionGateLevel 算**目标**消费门（纯函数、单调、绝不低于内核下界）：
 *   consumeFloor      = 0.4 + level · MAX_CONSUME_FLOOR_RAISE
 *   mustVerifyThreshold = max(consumeFloor, 0.6 + level · MAX_MUST_VERIFY_RAISE)，封顶 1
 * level=0 → (0.4, 0.6) 内核基线；level=1 → (0.95, 1.0)。consumeFloor ≤ mustVerify ≤ 1 恒成立。
 */
export function gateThresholdsFor(level: number): {
  consumeFloor: number
  mustVerifyThreshold: number
} {
  const l = clamp01(level)
  const consumeFloor = KERNEL_CONFIDENCE_FLOOR + l * MAX_CONSUME_FLOOR_RAISE
  const mustVerifyThreshold = Math.min(
    1,
    Math.max(consumeFloor, MUST_VERIFY_THRESHOLD + l * MAX_MUST_VERIFY_RAISE),
  )
  return { consumeFloor, mustVerifyThreshold }
}

/**
 * 把控制器派生策略 + 当前活动权重，组装成一份 setStandards 入参（**只抬门、复用现权重**）。
 * createdBy 标明是恒温器写的。落库走 setStandards（assertThresholds 二次护栏，违反内核门即抛）。
 */
export function standardsInputFromPolicy(
  policy: GovernancePolicy,
  activeWeights: FactorWeights,
  createdBy = 'controller:governance',
): StandardsInput {
  const { consumeFloor, mustVerifyThreshold } = gateThresholdsFor(policy.promotionGateLevel)
  return {
    factorWeights: activeWeights,
    consumeFloor,
    mustVerifyThreshold,
    createdBy,
  }
}

/**
 * 本策略相对当前活动规范是否**确实抬门**（避免无谓地追写同值 standards 行）。
 * 仅当目标门限**严格高于**当前活动门限时才需要落新 standards 版本。
 */
export function gateWouldTighten(policy: GovernancePolicy, active: Standards): boolean {
  const { consumeFloor, mustVerifyThreshold } = gateThresholdsFor(policy.promotionGateLevel)
  return consumeFloor > active.consumeFloor || mustVerifyThreshold > active.mustVerifyThreshold
}
