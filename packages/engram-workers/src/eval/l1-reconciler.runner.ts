/**
 * L1 Reconciler golden runner（A.9）—— 端到端跑 Reconciler 对每对 golden，比对三层裁决（L1a/L1b/L1c）+ 独立印证审计。
 *
 * 验真而非 smoke：
 *   ① faithful ≥-bound oracle（boundEntailmentOracle）：实算 A⊢B（A 的数值下界 ≥ B 的 ⟺ 更严的 A 蕴含更松的 B），
 *      把 refines（A 更窄 ⊢ B）/ poison（A 被改小 ⊬ B）的**方向**钉死。若 Reconciler 把被审/锚判反，refines↔poison 互换。
 *   ② 跑真 reconcileBatch（真 transitionClaim 蓝边收紧 / 真 escalation 写入 / 真 findAnchors 召回 / 真 reconcilePair）。
 *   ③ 逐对读回：是否 flag（状态变 flagged）、是否记 escalation（带对端 id）、是否记 refines 边 —— 对齐人工真值。
 *   ④ 独立印证：跑 Reconciler 后读 indepAudits，比对 hasNonIndependentPair 与人工真值。
 *
 * 故 Reconciler 误并/误判（如把投毒当 refines、漏记 escalation、漏 flag）会让本层准确率 <1 → 红。
 */
import type { EntailmentJudge, EntailmentQuery, EntailmentVerdict } from '@engram/core'

import { reconcileBatch, runReconciler } from '../reconciler.js'
import {
  RECONCILER_INDEP_GOLDEN,
  RECONCILER_PAIR_GOLDEN,
  type IndepGoldenItem,
  type ReconcilerPairItem,
} from './l1-reconciler.golden.js'

function lowerBound(s: string): number {
  const m = s.match(/(\d+(?:\.\d+)?)/)
  return m ? parseFloat(m[1]!) : NaN
}

/**
 * Faithful ≥-bound entailment oracle（与 reconciler 单测同款，实算非硬编码）：pass ⟺ evidence 的下界 ≥ claim 的下界
 * （更严蕴含更松）。objectSubsetViaEntailment 把命题=B(锚)、出处=A(被审)，故 pass ⟺ A 的下界 ≥ B 的下界 ⟺ A⊆B ⟺ refines。
 */
export function boundEntailmentOracle(): EntailmentJudge & { callCount: () => number } {
  let calls = 0
  return {
    version: 'fake:l1-bound-oracle',
    async judge(q: EntailmentQuery): Promise<EntailmentVerdict> {
      calls += 1
      const claimBound = lowerBound(q.claimText) // B（锚/命题）
      const evidBound = lowerBound(q.evidence[0]?.sourceContent ?? '') // A（被审/出处）
      if (Number.isNaN(claimBound) || Number.isNaN(evidBound)) return 'fail'
      return evidBound >= claimBound ? 'pass' : 'fail'
    },
    callCount: () => calls,
  }
}

export interface ReconcilerPairObservation {
  id: string
  tier: string
  flagged: boolean
  escalated: boolean
  refines: boolean
  /** 三项裁决是否全部匹配人工真值。 */
  correct: boolean
}

export interface IndepObservation {
  id: string
  hasNonIndependentPair: boolean
  correct: boolean
}

export interface ReconcilerGoldenReport {
  /** pair 层 */
  pairTotal: number
  pairCorrect: number
  pairAccuracy: number
  pairObservations: ReconcilerPairObservation[]
  /** 独立印证层 */
  indepTotal: number
  indepCorrect: number
  indepAccuracy: number
  indepObservations: IndepObservation[]
}

export interface SeededPair {
  anchorId: string
  candidateId: string
}

export interface ReconcilerGoldenDeps {
  resetDb: () => Promise<void>
  /** seed 一对 (anchor B, candidate A)，返回两者 id。 */
  seedPair: (item: ReconcilerPairItem) => Promise<SeededPair>
  /** seed 一条带额外 supports 源的 claim（独立印证审计用），返回 claimId。 */
  seedIndep: (item: IndepGoldenItem) => Promise<string>
  /** 跑真 reconcileBatch（注入 judge）对本批 candidate id。 */
  reconcileWith: (
    judge: EntailmentJudge,
    candidateIds: string[],
  ) => ReturnType<typeof reconcileBatch>
  /** 跑真 runReconciler 对一批 claimId（独立印证审计用）。 */
  runReconcilerWith: (
    judge: EntailmentJudge,
    claimIds: string[],
  ) => ReturnType<typeof runReconciler>
  /** 读一条 claim 当前状态。 */
  statusOf: (claimId: string) => Promise<string>
  /** 读一条 claim 的 escalation 列表（带 conflictsWith）。 */
  escalationsOf: (claimId: string) => Promise<{ conflictsWith: string | null }[]>
  /** 读一条 claim 出向的 refines 边目标集。 */
  refinesTargetsOf: (claimId: string) => Promise<string[]>
}

/**
 * 跑整套 Reconciler golden。pair 层：每对独立清库 + seed + reconcileBatch（仅审 candidate），读回三项裁决比对。
 * 独立印证层：清库 + seed 全部 indep claim + 一轮 runReconciler，读 indepAudits 比对。
 */
export async function runReconcilerGolden(
  deps: ReconcilerGoldenDeps,
  pairs: readonly ReconcilerPairItem[] = RECONCILER_PAIR_GOLDEN,
  indeps: readonly IndepGoldenItem[] = RECONCILER_INDEP_GOLDEN,
): Promise<ReconcilerGoldenReport> {
  const pairObservations: ReconcilerPairObservation[] = []
  for (const item of pairs) {
    await deps.resetDb()
    const { anchorId, candidateId } = await deps.seedPair(item)
    const judge = boundEntailmentOracle()
    await deps.reconcileWith(judge, [candidateId])

    const status = await deps.statusOf(candidateId)
    const flagged = status === 'flagged'
    const esc = await deps.escalationsOf(candidateId)
    const escalated = esc.length > 0 && esc.some((e) => e.conflictsWith === anchorId)
    const refinesTargets = await deps.refinesTargetsOf(candidateId)
    const refines = refinesTargets.includes(anchorId)

    const correct =
      flagged === item.expectFlagged &&
      escalated === item.expectEscalated &&
      refines === item.expectRefines
    pairObservations.push({ id: item.id, tier: item.tier, flagged, escalated, refines, correct })
  }

  const indepObservations: IndepObservation[] = []
  await deps.resetDb()
  const indepIds: { item: IndepGoldenItem; claimId: string }[] = []
  for (const item of indeps) {
    indepIds.push({ item, claimId: await deps.seedIndep(item) })
  }
  const indepJudge = boundEntailmentOracle()
  const res = await deps.runReconcilerWith(
    indepJudge,
    indepIds.map((x) => x.claimId),
  )
  for (const { item, claimId } of indepIds) {
    const audit = res.indepAudits.find((a) => a.claimId === claimId)
    const has = audit?.hasNonIndependentPair ?? false
    indepObservations.push({
      id: item.id,
      hasNonIndependentPair: has,
      correct: has === item.expectNonIndependent,
    })
  }

  const pairCorrect = pairObservations.filter((o) => o.correct).length
  const indepCorrect = indepObservations.filter((o) => o.correct).length
  return {
    pairTotal: pairObservations.length,
    pairCorrect,
    pairAccuracy: pairObservations.length === 0 ? 0 : pairCorrect / pairObservations.length,
    pairObservations,
    indepTotal: indepObservations.length,
    indepCorrect,
    indepAccuracy: indepObservations.length === 0 ? 0 : indepCorrect / indepObservations.length,
    indepObservations,
  }
}
