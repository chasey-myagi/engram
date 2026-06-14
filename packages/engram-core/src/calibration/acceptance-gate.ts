/**
 * Advisor 验收门（**确定性函数**，A.8 + 命门 A.3）—— 守住「否决在线 meta-orchestrator / 能力≠权力」红线。
 *
 * Advisor 只**诊断**（产候选 g' + ΔECE 验证依据，只读、零写权）；验收门是唯一**拍板者**（权力），且是**纯函数**：
 * 给定（候选 g' + ΔECE 依据 + 当前活动 g + 当前消费门 + 恒温器当前策略 + 校准样本/桶），恒返同一裁决。
 *
 * 6 项全过才 approve（任一不过 → reject + 记是哪项 + fail-silent 维持现状，绝不阻塞主干）：
 *   ① g' 单调（非递减）？           —— 复用 assertCalibrationMap 的单调判据（升序 x + 非递减 y）。
 *   ② 值域 ⊆ [0,1]？                —— 复用 assertCalibrationMap 的值域判据。
 *   ③ 消费门翻转受控（不剧烈）？     —— 在样本 raw 集上，old/new 两版 g 关于 consumeFloor 的「越门集合」变化比例
 *                                       ≤ MAX_GATE_FLIP_FRACTION。一刀切大改门后人群 → 拒（防一次换 g 把库洗一遍）。
 *   ④ 不与恒温器当前动作冲突？       —— 若恒温器正收紧（promotionGateLevel>0），候选 g' 不得**净放松**有效置信
 *                                       （越过门的样本数不得比当前 g 更多）；恒温器收门时 g 不许偷偷开门（反向用力）。
 *   ⑤ 每个校准桶样本足？             —— 每个**非空** reliability bin 的样本数 ≥ MIN_SAMPLES_PER_BIN（欠采样不可信、拒）。
 *   ⑥ g′ 排序分辨力不退化？（S28 FIX 3）—— g′ 须 ≥2 个**不同** knot 且输出 spread（max y − min y）≥ MIN_OUTPUT_SPREAD。
 *                                       单 knot / 常值 g（把每条 claim 的 value 压成同一个数）会抹平全部排序语义、
 *                                       让消费门要么全开要么全关——结构性退化，拒。放在末位（⑥），不抢前序检查的咬合项。
 *
 * 确定性来源：全部判据是纯算术/集合比较，零随机、零 LLM、零时钟。reject 路径只记日志（caller 落审计），现状 g 不动。
 */
import { applyGMap, type CalibrationMap } from '../confidence/confidence.js'
import type { ReliabilityReport } from './calibration.js'

/** ③ 消费门「越门集合」允许的最大翻转比例（样本占比）。超过即「剧烈」、拒。可调起步基线。 */
export const MAX_GATE_FLIP_FRACTION = 0.2
/** ⑤ 每个非空校准桶要求的最小样本数（欠此则该桶 observed 不可信，拒）。可调起步基线。 */
export const MIN_SAMPLES_PER_BIN = 5
/**
 * ⑥（S28 FIX 3）g′ 输出最小 spread（max knot.y − min knot.y）。低于此即视为退化常值/无分辨力 g，拒。
 * 取一个很小的正阈值：只拦**结构性退化**（单 knot / 全程同 y），不误伤数据本身较平的合法 g。可调起步基线。
 */
export const MIN_OUTPUT_SPREAD = 0.01

/** 各检查项的稳定标识（reject 时报是哪项咬住；审计/测试按它断言对应拒绝路径）。 */
export type GateCheckId =
  | 'monotonic'
  | 'range'
  | 'consumption_flip'
  | 'thermostat_conflict'
  | 'bin_samples'
  | 'output_spread'

/**
 * 验收门全部检查项 id（运行时唯一真值源；新增/删除 check 必须同步此清单 + runAcceptanceGate 的 checks 数组）。
 * 顺序 = runAcceptanceGate 的 checks 顺序（故 failedCheck 与「对应拒绝路径」一一咬合）。注释/文档只引用「全项」即可，永不漂移。
 */
export const GATE_CHECK_IDS = [
  'monotonic',
  'range',
  'consumption_flip',
  'thermostat_conflict',
  'bin_samples',
  'output_spread',
] as const satisfies readonly GateCheckId[]

/** 单项检查结果。 */
export interface GateCheck {
  id: GateCheckId
  passed: boolean
  /** 人类可读的判据细节（审计；不进任何计分）。 */
  detail: string
}

/** 验收门裁决（确定性）。approved=6/6 全过；否则给出**首个**未过项（failedCheck）+ 全项明细。 */
export interface GateVerdict {
  approved: boolean
  checks: GateCheck[]
  /** 第一个未过的检查 id（approved=true 时为 undefined）。 */
  failedCheck?: GateCheckId
}

/** 验收门入参（全部由 caller 从当前库态读出后传入——保持门本身是纯函数）。 */
export interface GateInputs {
  /** 候选 g'（Advisor 产出，绑定下面的 ΔECE 依据）。 */
  candidate: CalibrationMap
  /** 当前活动 g（用于 ③④ 的 before/after 对比；起步通常是 identity）。 */
  current: CalibrationMap
  /** 消费门下界（A.2，③④ 用它判越门）。来自当前活动 standards.consumeFloor。 */
  consumeFloor: number
  /** 恒温器当前晋升门收紧档 ∈[0,1]（>0 = 正在收紧；④ 用它判是否冲突）。来自 getActivePolicy().promotionGateLevel。 */
  promotionGateLevel: number
  /**
   * 校准样本的 raw 值集合（③④ 在它上算越门翻转/净放松；⑤ 的桶来自下面的 reliability）。
   * 用真实样本的 raw 而非合成网格：门要管的是**真实人群**过门的变化，不是抽象函数性质。
   */
  sampleRaws: number[]
  /** 候选 g' 在 golden 上的 reliability（⑤ 查每桶样本数；其 ece 也是 Advisor 绑定的验证依据来源）。 */
  reliability: ReliabilityReport
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** ①② 复用 assertCalibrationMap 的判据，但**不抛**——把违反转成检查项（门要冷静拒、不崩）。 */
function checkMonotonicAndRange(map: CalibrationMap): { monotonic: GateCheck; range: GateCheck } {
  let rangeOk = true
  let rangeDetail = 'all knots x,y ∈ [0,1]'
  let monoOk = true
  let monoDetail = 'g′ x strictly ascending & y non-decreasing'
  const ks = map.knots
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i]!
    if (!(k.x >= 0 && k.x <= 1 && k.y >= 0 && k.y <= 1)) {
      rangeOk = false
      rangeDetail = `knot #${i} out of [0,1]: (${k.x},${k.y})`
    }
    if (i > 0) {
      const prev = ks[i - 1]!
      if (!(k.x > prev.x)) {
        monoOk = false
        monoDetail = `x not strictly ascending: ${prev.x} → ${k.x}`
      }
      if (!(k.y >= prev.y)) {
        monoOk = false
        monoDetail = `g′ not non-decreasing: y ${prev.y} → ${k.y}`
      }
    }
  }
  return {
    monotonic: { id: 'monotonic', passed: monoOk, detail: monoDetail },
    range: { id: 'range', passed: rangeOk, detail: rangeDetail },
  }
}

/**
 * 在样本 raw 集上算「越门集合」翻转比例：old/new 两版 g 关于 consumeFloor 的越门布尔不同的样本占比。
 * 空样本 → 0（无人可翻、视为不剧烈）。门用此防「一次换 g 把召回人群洗一遍」。
 */
function gateFlipFraction(
  sampleRaws: number[],
  oldMap: CalibrationMap,
  newMap: CalibrationMap,
  floor: number,
): number {
  if (sampleRaws.length === 0) return 0
  let flipped = 0
  for (const raw of sampleRaws) {
    const wasIn = applyGMap(raw, oldMap) >= floor
    const isIn = applyGMap(raw, newMap) >= floor
    if (wasIn !== isIn) flipped++
  }
  return flipped / sampleRaws.length
}

/** 越门样本数（value ≥ floor）。④ 比 new 是否比 old **更多**（净放松）。 */
function aboveFloorCount(sampleRaws: number[], map: CalibrationMap, floor: number): number {
  let n = 0
  for (const raw of sampleRaws) if (applyGMap(raw, map) >= floor) n++
  return n
}

/**
 * ⑥（S28 FIX 3）g′ 排序分辨力：须 ≥2 个**不同 x** 的 knot，且输出 spread（max y − min y）≥ MIN_OUTPUT_SPREAD。
 * identity（空 knots）天然有分辨力（直通 raw、保序），spread 视为 1（不触发拒）。单 knot / 常值 g → spread=0、拒。
 */
function checkOutputSpread(map: CalibrationMap): GateCheck {
  const ks = map.knots
  if (ks.length === 0) {
    // identity：g=raw，逐点保序、分辨力满格，不退化。
    return {
      id: 'output_spread',
      passed: true,
      detail: 'identity g (passthrough raw): full ordering resolution',
    }
  }
  const distinctX = new Set(ks.map((k) => k.x)).size
  let minY = ks[0]!.y
  let maxY = ks[0]!.y
  for (const k of ks) {
    if (k.y < minY) minY = k.y
    if (k.y > maxY) maxY = k.y
  }
  const spread = maxY - minY
  const passed = distinctX >= 2 && spread >= MIN_OUTPUT_SPREAD
  return {
    id: 'output_spread',
    passed,
    detail: passed
      ? `g′ has ${distinctX} distinct-x knots, output spread ${spread.toFixed(4)} (≥ ${MIN_OUTPUT_SPREAD})`
      : `degenerate g′: ${distinctX} distinct-x knot(s), output spread ${spread.toFixed(4)} (< ${MIN_OUTPUT_SPREAD}) — would flatten every claim's value`,
  }
}

/**
 * 跑验收门（**纯函数**）。6 项全过 → approved。任一不过 → reject + failedCheck=首个未过项。
 * 顺序固定（①→⑥），故 failedCheck 与测试的「对应拒绝路径」一一咬合、可复现。
 */
export function runAcceptanceGate(inputs: GateInputs): GateVerdict {
  const floor = clamp01(inputs.consumeFloor)
  const { monotonic, range } = checkMonotonicAndRange(inputs.candidate)

  // ③ 消费门翻转受控
  const flip = gateFlipFraction(inputs.sampleRaws, inputs.current, inputs.candidate, floor)
  const flipCheck: GateCheck = {
    id: 'consumption_flip',
    passed: flip <= MAX_GATE_FLIP_FRACTION,
    detail: `gate-flip fraction ${flip.toFixed(4)} (max ${MAX_GATE_FLIP_FRACTION})`,
  }

  // ④ 不与恒温器收紧冲突：恒温器收门（level>0）时，候选 g' 不得让更多样本越过门（净放松）。
  const tightening = inputs.promotionGateLevel > 0
  let thermostatPassed = true
  let thermostatDetail = 'thermostat not tightening (level=0); no constraint'
  if (tightening) {
    const before = aboveFloorCount(inputs.sampleRaws, inputs.current, floor)
    const after = aboveFloorCount(inputs.sampleRaws, inputs.candidate, floor)
    thermostatPassed = after <= before
    thermostatDetail = `thermostat tightening (level=${inputs.promotionGateLevel.toFixed(2)}): above-floor ${before} → ${after}${
      thermostatPassed ? ' (no net loosening)' : ' (would loosen — conflict)'
    }`
  }
  const thermostatCheck: GateCheck = {
    id: 'thermostat_conflict',
    passed: thermostatPassed,
    detail: thermostatDetail,
  }

  // ⑤ 每个非空桶样本足
  const underfilled = inputs.reliability.bins.filter(
    (b) => b.count > 0 && b.count < MIN_SAMPLES_PER_BIN,
  )
  const binCheck: GateCheck = {
    id: 'bin_samples',
    passed: underfilled.length === 0,
    detail:
      underfilled.length === 0
        ? `every non-empty bin has ≥ ${MIN_SAMPLES_PER_BIN} samples`
        : `${underfilled.length} bin(s) under ${MIN_SAMPLES_PER_BIN} samples (e.g. [${underfilled[0]!.lo.toFixed(
            2,
          )},${underfilled[0]!.hi.toFixed(2)}) has ${underfilled[0]!.count})`,
  }

  // ⑥ g′ 排序分辨力（FIX 3）：放在末位，不抢前序检查的咬合项（既有测试的 failedCheck 不变）。
  const spreadCheck = checkOutputSpread(inputs.candidate)

  const checks: GateCheck[] = [monotonic, range, flipCheck, thermostatCheck, binCheck, spreadCheck]
  const failed = checks.find((c) => !c.passed)
  return failed ? { approved: false, checks, failedCheck: failed.id } : { approved: true, checks }
}
