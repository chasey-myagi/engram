/**
 * L1 Verifier golden runner（A.9）—— 端到端跑 Verifier 对 ~50 条 golden，算 flag 决策的 precision / recall。
 *
 * 验真而非 smoke：
 *   ① faithful entailment oracle（goldenEntailmentOracle）：从 claim 文本 + 出处原文**实算** entailment
 *      （数值下界对比；无可比数值时退关键词包含）。它**不**硬编码 verdict，故 Verifier 的收紧逻辑被它的真实裁决驱动。
 *   ② 跑真 runVerifier（真 transitionClaim / 真时效巡查 / 真 patrol 写入），逐条 seed 进 per-test DB（fixture 不进 KB）。
 *   ③ 决策 = 「该 claim 巡查后是否被收紧到更紧状态」（active→flagged / flagged→quarantined / 时效 flag）。
 *      正类 = should_flag。对齐人工标签算 TP/FP/FN → P/R。
 *
 * 故 Verifier 若漏检幻觉（不收紧 unentailed）→ FN↑ recall↓；若误伤 sound/draft（错误收紧）→ FP↑ precision↓ —— 都把分拉下阈。
 */
import type { EntailmentJudge, EntailmentQuery, EntailmentVerdict } from '@engram/core'

import { runVerifier } from '../verifier.js'
import { VERIFIER_GOLDEN, type VerifierGoldenItem } from './l1-verifier.golden.js'

/** 从一段文本里取第一个数值（下界/标称值）。无数值 → NaN。 */
function firstNumber(s: string): number {
  const m = s.match(/(\d+(?:\.\d+)?)/)
  return m ? parseFloat(m[1]!) : NaN
}

/**
 * Faithful entailment oracle（领域无关、确定性、可计数）：claim 能否从其出处原文推出。
 *   - 两侧都有可比数值：|claim 值 - 出处值| 在 1% 容差内 → pass，否则 → fail（claim 改了数）。
 *   - 无可比数值：claim 的关键词是否在出处里出现 → pass / fail（退化的词面蕴含）。
 * 这是真算，不是硬编码：喂一条「值被夸大 10×」的 claim 它会判 fail，喂「值一致」判 pass。
 */
export function goldenEntailmentOracle(): EntailmentJudge & { callCount: () => number } {
  let calls = 0
  return {
    version: 'fake:l1-verifier-oracle',
    async judge(q: EntailmentQuery): Promise<EntailmentVerdict> {
      calls += 1
      const evidence = q.evidence.map((e) => e.sourceContent).join(' ')
      const claimNum = firstNumber(q.claimText)
      const evidNum = firstNumber(evidence)
      if (!Number.isNaN(claimNum) && !Number.isNaN(evidNum)) {
        const tol = Math.max(1e-9, Math.abs(evidNum) * 0.01)
        return Math.abs(claimNum - evidNum) <= tol ? 'pass' : 'fail'
      }
      // 退化词面蕴含：claim 的主/谓/宾词都出现在出处 → pass。
      const ev = evidence.toLowerCase()
      const tokens = [q.subject, q.predicate, q.object].filter((t): t is string => !!t)
      const allPresent = tokens.every((t) => ev.includes(t.toLowerCase()))
      return allPresent ? 'pass' : 'fail'
    },
    callCount: () => calls,
  }
}

/** 巡查后该 claim 的最终状态 + 是否被收紧（相对 seed 状态变紧）。 */
const TIGHTER: Record<string, number> = {
  draft: 0,
  active: 1,
  flagged: 2,
  quarantined: 3,
  superseded: 4,
}

export interface VerifierClaimObservation {
  id: string
  seedStatus: string
  finalStatus: string
  /** 巡查后是否被收紧到更紧状态（flag/quarantine/时效）。draft→active 是晋升不算收紧。 */
  tightened: boolean
  label: 'should_flag' | 'should_keep'
  /** 决策是否与人工标签一致。 */
  correct: boolean
}

export interface VerifierGoldenReport {
  total: number
  tp: number
  fp: number
  fn: number
  tn: number
  /** flag 决策精确率 TP/(TP+FP)（无正预测 → 1）。 */
  precision: number
  /** flag 决策召回率 TP/(TP+FN)（无正真值 → 1）。 */
  recall: number
  /** 整体决策准确率（含 keep）。 */
  accuracy: number
  /** entailment oracle 被调次数（应 = 被巡查 claim 数，点状一次 LLM/claim）。 */
  judgeCalls: number
  observations: VerifierClaimObservation[]
}

export interface VerifierGoldenDeps {
  /** seed 一条 golden claim 进 DB，返回它的 claimId（其出处源年龄按 ageDays 设置）。 */
  seedClaim: (item: VerifierGoldenItem) => Promise<string>
  /** 跑前清库（fixture 不进 KB；用完即弃）。 */
  resetDb: () => Promise<void>
  /** 读一条 claim 当前状态。 */
  statusOf: (claimId: string) => Promise<string>
  /** 注入 db + judge，跑真 runVerifier。 */
  runVerifierWith: (judge: EntailmentJudge) => ReturnType<typeof runVerifier>
}

/**
 * 跑整套 Verifier golden：清库 → seed 全部 50 条 → 跑一轮真 runVerifier（faithful oracle）→ 逐条比对
 * 「是否被收紧」与人工标签 → 算 P/R/accuracy。所有 claim 一轮巡查（cron 模式），每条点状一次 oracle。
 */
export async function runVerifierGolden(
  deps: VerifierGoldenDeps,
  items: readonly VerifierGoldenItem[] = VERIFIER_GOLDEN,
): Promise<VerifierGoldenReport> {
  await deps.resetDb()
  const seedStatusById = new Map<string, { item: VerifierGoldenItem; claimId: string }>()
  for (const item of items) {
    const claimId = await deps.seedClaim(item)
    seedStatusById.set(claimId, { item, claimId })
  }

  const judge = goldenEntailmentOracle()
  // maxClaims 放宽到全集；不带 claimIds → cron 模式扫全部 draft/active/flagged。
  await deps.runVerifierWith(judge)

  const observations: VerifierClaimObservation[] = []
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  for (const { item, claimId } of seedStatusById.values()) {
    const finalStatus = await deps.statusOf(claimId)
    const tightened = (TIGHTER[finalStatus] ?? 0) > (TIGHTER[item.status] ?? 0) && finalStatus !== 'active'
    // 注：draft→active（晋升）TIGHTER 也 +1，但那是晋升不是收紧 → 用 finalStatus!=='active' 排除晋升被误判为收紧。
    // active→flagged / flagged→quarantined 的 finalStatus 分别是 flagged/quarantined（非 active）→ 正确计为收紧。
    const predictedFlag = tightened
    const labelFlag = item.label === 'should_flag'
    if (predictedFlag && labelFlag) tp += 1
    else if (predictedFlag && !labelFlag) fp += 1
    else if (!predictedFlag && labelFlag) fn += 1
    else tn += 1
    observations.push({
      id: item.id,
      seedStatus: item.status,
      finalStatus,
      tightened,
      label: item.label,
      correct: predictedFlag === labelFlag,
    })
  }

  const total = observations.length
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  const accuracy = total === 0 ? 0 : (tp + tn) / total
  return {
    total,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    accuracy,
    judgeCalls: judge.callCount(),
    observations,
  }
}
