/**
 * 中环回灌的**控制面链路**（S27，A.8 + 命门 A.3）—— 把 Advisor（能力）→ 验收门（权力）→ 原子换 / fail-silent HOLD
 * 串成一条确定性、副作用受限的链路。这条函数是活动校准 g 的**唯一写入路径**（除即时回退），其余皆只读。
 *
 * evaluateAndMaybeSwap(db, samples, candidate, ...)：
 *   ① advise(only-read)：算 current/candidate 的 ECE + ΔECE，产 proposal（Advisor 从不自己换 g）；
 *   ② 读当前态（活动 g / 活动 consumeFloor / 恒温器 promotionGateLevel）喂验收门（纯函数）；
 *   ③ 5/5 approve → commitCalibrationMap **原子激活**候选（append 定义即成活动版本，一个 tx）；
 *      任一不过 reject → **不碰活动 g**（HOLD），只返回裁决 + 是哪项咬住（caller 落审计日志）。绝不抛进主干。
 *
 * 能力/权力分离在此硬兑现：approve 之外，没有任何路径能改活动 g；reject 时现状 g 原样不动（fail-silent）。
 */
import { getActiveStandards } from '../config/standards.js'
import type { DB } from '../db/client.js'
import { getActivePolicy } from '../governance/governance-state.js'
import { CALIBRATION_CODE_VERSION, type CalibrationMap } from '../confidence/confidence.js'
import { runAcceptanceGate, type GateInputs, type GateVerdict } from './acceptance-gate.js'
import {
  advise,
  type AdvisorOptions,
  type CalibrationProposal,
  type GoldenSample,
} from './advisor.js'
import {
  commitCalibrationMap,
  getActiveCalibrationMap,
  type CalibrationMapRow,
} from './calibration-store.js'

/** evaluateAndMaybeSwap 的结果。swapped=true → 候选已原子激活（committed 是落库行）；false → HOLD，活动 g 未动。 */
export interface SwapResult {
  /** 是否真换了活动 g（仅 5/5 approve 时 true）。 */
  swapped: boolean
  /** 验收门裁决（含 5 项明细 + 首个未过项）。 */
  verdict: GateVerdict
  /** Advisor 的建议（候选 + ΔECE 验证依据）。 */
  proposal: CalibrationProposal
  /** approve 时落库激活的行（审计/锚点）；reject 时 undefined。 */
  committed?: CalibrationMapRow
}

export interface EvaluateOptions extends AdvisorOptions {
  /** 写入者审计身份（approve 时落进 calibration_map.created_by）。默认 'gate:advisor-accept'。 */
  createdBy?: string
}

/**
 * 跑一次「诊断→验收→（过则原子换 / 否则 HOLD）」。candidate 由 caller 经 fitter 端口或直接给定（S27 不跑 isotonic）。
 * samples = golden 上的 (rawPredicted, correct)。返回结构化结果（caller 据此落审计；reject 不抛、不阻塞）。
 */
export async function evaluateAndMaybeSwap(
  db: DB,
  samples: GoldenSample[],
  candidate: CalibrationMap,
  opts: EvaluateOptions = {},
): Promise<SwapResult> {
  // 读当前态（只读）：活动 g、活动消费门、恒温器收紧档。
  const [current, std, policy] = await Promise.all([
    getActiveCalibrationMap(db),
    getActiveStandards(db),
    getActivePolicy(db),
  ])

  // ① Advisor 诊断（只读、绑定 ΔECE）。
  const proposal = advise(samples, current, candidate, opts)

  // ② 验收门（纯函数）。样本 raw 集供 ③④ 算越门翻转/净放松；reliability 供 ⑤ 查每桶样本数。
  const gateInputs: GateInputs = {
    candidate,
    current,
    consumeFloor: std.consumeFloor,
    promotionGateLevel: policy.promotionGateLevel,
    sampleRaws: samples.map((s) => s.rawPredicted),
    reliability: proposal.reliability,
  }
  const verdict = runAcceptanceGate(gateInputs)

  // ③ 5/5 → 原子激活；否则 HOLD（活动 g 不动）。
  if (!verdict.approved) {
    return { swapped: false, verdict, proposal }
  }
  const committed = await commitCalibrationMap(db, {
    map: candidate,
    evidence: {
      currentEce: proposal.currentEce,
      candidateEce: proposal.candidateEce,
      deltaEce: proposal.deltaEce,
      sampleCount: proposal.sampleCount,
      // code_version 锚（A.3 #3）：这版 g 是在哪一版 confidence 公式代码下拟合/激活的。公式代码变更后，
      // 跨此断点的历史 raw/conf 不可比——纵向趋势/ECE 比对须按 code_version 分段（不可混算）。
      codeVersion: CALIBRATION_CODE_VERSION,
    },
    reason: `advisor-accept: ΔECE ${proposal.deltaEce.toFixed(4)} (5/5 checks)`,
    createdBy: opts.createdBy ?? 'gate:advisor-accept',
  })
  return { swapped: true, verdict, proposal, committed }
}
