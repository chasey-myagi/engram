/**
 * 旁挂离线 Advisor（**只读 + 只产建议**，A.8 命门控制面）—— 能力（诊断）半边，绝无写权。
 *
 * Advisor 做三件事，**全程不碰活动 g**：
 *   ① 从 golden 集取校准真值样本 (rawPredicted, correct)；
 *   ② 接一个**候选 g'**（pluggable fitter port：S28 的 isotonic 回归从此口接入；S27 用注入的候选或简易确定性单调候选，
 *      **不在此实现 isotonic**——S27/S28 边界）；
 *   ③ 在同一 golden 集上算 **ΔECE**（候选 g' 的 ECE − 当前 g 的 ECE，经 S5 computeReliability），把候选**绑定**到这份验证依据，
 *      产出一个 CalibrationProposal（纯数据对象）后**就此打住**——它从不替换 g、不写库。是否采纳由验收门（权力）拍板。
 *
 * 这就是「能力/权力分离」在代码里的硬兑现：Advisor 的返回值进不了活动 g，除非 evaluateAndMaybeSwap 把它喂过验收门
 * 且 5/5 通过、再由 store 原子提交。Advisor 单测可断言它的返回值从不改变 getActiveCalibrationVersion。
 *
 * 领域无关；A3 红线（ELO/胜负率严禁进 g 的拟合）在**样本输入边界**守：样本只有 (rawPredicted, correct) 两字段，
 * 结构上无任何 ELO/胜负率入口（与 S5 computeCalibrationFromUsage 同源同口径）。
 */
import { applyGMap, type CalibrationMap } from '../confidence/confidence.js'
import { computeReliability, DEFAULT_BIN_COUNT, type ReliabilityReport } from './calibration.js'

/** golden 校准真值样本：raw 预测（g 应用前）+ 该次消费是否正确。与 S5 CalibrationSample 同结构，但 predicted 语义=raw。 */
export interface GoldenSample {
  /** 召回瞬间的 raw（g 应用前的连续证据聚合）。Advisor 在其上分别套 current/candidate g 再算 ECE。 */
  rawPredicted: number
  correct: boolean
}

/**
 * 拟合端口（S28 isotonic 从此接入）。给定 golden 样本，产出一个**候选** g'（version + 升序非递减 knots）。
 * S27 不实现任何拟合算法——只定义这个口 + 提供注入/简易确定性候选两条路，让验收门/原子换/回退/ΔECE 绑定被完整跑通。
 */
export type CalibrationFitter = (samples: GoldenSample[]) => CalibrationMap

/** Advisor 的建议（纯数据；**无写权**）：候选 g' + 它绑定的验证依据（current/candidate 的 ECE 与 ΔECE）。 */
export interface CalibrationProposal {
  /** 候选 g'（待验收门审，过了才由 store 原子激活）。 */
  candidate: CalibrationMap
  /** 当前活动 g 在 golden 上的 ECE（基线）。 */
  currentEce: number
  /** 候选 g' 在 golden 上的 ECE。 */
  candidateEce: number
  /** ΔECE = candidateEce − currentEce（<0 = 候选更准；A.8 要求候选必绑此依据）。 */
  deltaEce: number
  /** 候选 g' 在 golden 上的 reliability（验收门 ⑤ 查每桶样本数）。 */
  reliability: ReliabilityReport
  /** 本次诊断用到的 golden 样本数（审计）。 */
  sampleCount: number
}

/**
 * 在 golden 样本上，把一个 g' 套到每条 raw，得到 (predicted=g(raw), correct) 后算 reliability/ECE（复用 S5 纯函数）。
 * current 与 candidate 都走这一处口径，ΔECE 才是同卷可比。
 */
function reliabilityUnder(
  samples: GoldenSample[],
  map: CalibrationMap,
  binCount: number,
): ReliabilityReport {
  return computeReliability(
    samples.map((s) => ({ predicted: applyGMap(s.rawPredicted, map), correct: s.correct })),
    binCount,
  )
}

export interface AdvisorOptions {
  /** reliability/ECE 的桶数（默认 S5 DEFAULT_BIN_COUNT）。 */
  binCount?: number
}

/**
 * **诊断**：给定 golden 样本 + 当前活动 g + 候选 g'，产出 CalibrationProposal（绑定 ΔECE）。**只读、纯函数、无写权。**
 * 候选 g' 由 caller 经 fitter 端口或直接给定（S27 边界：不在此跑 isotonic）。current 起步通常是 identity。
 */
export function advise(
  samples: GoldenSample[],
  current: CalibrationMap,
  candidate: CalibrationMap,
  opts: AdvisorOptions = {},
): CalibrationProposal {
  const binCount = opts.binCount ?? DEFAULT_BIN_COUNT
  const currentReport = reliabilityUnder(samples, current, binCount)
  const candidateReport = reliabilityUnder(samples, candidate, binCount)
  return {
    candidate,
    currentEce: currentReport.ece,
    candidateEce: candidateReport.ece,
    deltaEce: candidateReport.ece - currentReport.ece,
    reliability: candidateReport,
    sampleCount: samples.length,
  }
}

/**
 * **简易确定性单调候选**（S27 占位 fitter，**非** S28 isotonic）：单段恒等线性 g'（两端点 (0,0)-(1,1)）
 * 但绑定一个具名 version，供把「换 g」全链路（验收门 → 原子换 → 回退 → ΔECE 绑定）跑通而不依赖 S28 算法。
 * 它在数值上与 identity 等价（ΔECE=0），故验收门的 ③④ 检查天然过（不改门人群）；用它专测 approve/swap/rollback 链路。
 */
export function identityLikeCandidate(version: string): CalibrationMap {
  return {
    version,
    knots: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  }
}
