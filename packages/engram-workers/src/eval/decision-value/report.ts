/**
 * S10 · Plan A 决策价值 ASCII 报告 + 打印前的 fail-closed A3 复检(纯函数,零 DB)。
 *
 * 报告三段:① 固定 τ baseline 表(identity / fitted / oracle 的 coverage/realizedAcc/shortfall/regret + decisionLift+CI + tunedCoverageLift);
 * ② R1→R2 series(in-sample vs held-out lift + roundDelta,看校准价值是否迁得到未见事实);③ 错答下钻(diagnose join → agent trace 的归类计数 + 逐条)。
 *
 * **fail-closed A3 复检**(assertA3Frozen):打报告**之前**先复跑 A3 的可导入冻结不变量——纵向维度恒 {ece,coverage}、
 * verification_kind / metrics_event_kind 字节冻结。任一漂移 ⇒ **抛、不打印**(宁可无报告,也不发一份可能被 ops 信号污染了 g 的数字)。
 * 完整 import-graph 静态防火墙是 CI 门(a3-firewall.test.ts);本复检是运行时、可导入侧的兜底闸。
 */
import { RECOMPETE_DIMENSIONS, schema } from '@engram/core'

import type { BaselineResult } from './baselines.js'
import type { DecisionDiagnosis, DiagnosisSummary } from './diagnose.js'
import type { LearningLoopResult } from './learning-loop.js'

/** A3 冻结不变量(可注入,供负对照直测):纵向维度必 {ece,coverage};两枚举字节不变。漂移即抛。 */
export function assertLongitudinalAndEnumsFrozen(
  dims: readonly string[],
  verificationKinds: readonly string[],
  metricsKinds: readonly string[],
): void {
  const sortedDims = [...dims].sort().join(',')
  if (sortedDims !== 'coverage,ece') {
    throw new Error(
      `A3 fail-closed:纵向维度漂移(期望 {coverage,ece},实得 {${sortedDims}})—— 拒绝打印决策报告`,
    )
  }
  if (verificationKinds.join(',') !== 'patrol,usage_truth,reembed_marker') {
    throw new Error(
      `A3 fail-closed:verification_kind 枚举漂移(实得 [${verificationKinds.join(',')}])—— 拒绝打印`,
    )
  }
  if (
    metricsKinds.join(',') !==
    'gap_recorded,source_human_pending,conflict_adjudicated,ruling_refused,human_overturn'
  ) {
    throw new Error(
      `A3 fail-closed:metrics_event_kind 枚举漂移(实得 [${metricsKinds.join(',')}])—— 拒绝打印`,
    )
  }
}

/** 打报告前的 fail-closed A3 复检:复跑可导入的冻结不变量,漂移即抛(不打印)。 */
export function assertA3Frozen(): void {
  assertLongitudinalAndEnumsFrozen(
    RECOMPETE_DIMENSIONS,
    schema.verificationKind.enumValues,
    schema.metricsEventKind.enumValues,
  )
}

export interface ReportInput {
  tau: number
  r1Size: number
  r2Size: number
  /** 语料来源:fake(合成、CI 确定性)或 qwen(真 Qwen 蒸馏)。 */
  source: 'fake' | 'qwen'
  loop: LearningLoopResult
  diagnoses: DecisionDiagnosis[]
  summary: DiagnosisSummary
}

function f3(x: number): string {
  return Number.isNaN(x) ? ' n/a ' : x.toFixed(3)
}

function ci(b: BaselineResult): string {
  return `[${f3(b.ci.lo)}, ${f3(b.ci.hi)}]`
}

function variantRow(
  name: string,
  b: BaselineResult,
  which: 'identity' | 'fitted' | 'oracle',
): string {
  const p = b[which]
  return `  ${name.padEnd(10)} ${f3(p.coverage)}      ${f3(p.realizedAccuracy)}       ${f3(p.promiseError)}      ${f3(p.regret)}`
}

/** 把一份决策价值结果渲染成 ASCII 报告(确定性字符串)。 */
export function renderDecisionValueReport(input: ReportInput): string {
  const { tau, loop, diagnoses, summary } = input
  const r2 = loop.r2
  const lines: string[] = []
  lines.push('═══ Engram · Plan A 决策价值报告 ═══')
  lines.push(
    `语料来源=${input.source}  R1 ${input.r1Size} facts / R2 ${input.r2Size} facts(held-out)  τ=${tau.toFixed(2)}  g1 拟自 R1`,
  )
  lines.push('')

  lines.push(`── ① Baseline @ τ=${tau.toFixed(2)}(R2 held-out)──`)
  lines.push('  variant    coverage  realizedAcc  shortfall  regret')
  lines.push(variantRow('identity', r2, 'identity'))
  lines.push(variantRow('fitted', r2, 'fitted'))
  lines.push(variantRow('oracle', r2, 'oracle'))
  const sig = r2.ci.lo > 0 ? '排除 0 ⇒ 显著' : 'CI 跨 0 ⇒ 不显著'
  lines.push(`  decisionLift = ${f3(r2.decisionLift)}  95%CI ${ci(r2)}  (${sig})`)
  lines.push(
    `  tunedCoverageLift = ${f3(r2.tunedCoverageLift)}  (≈0 ⇒ 校准不帮 ranking,价值在固定 τ 守诺)`,
  )
  lines.push('')

  lines.push('── ② R1 → R2 series(校准价值能否迁到未见事实)──')
  lines.push('  round           decisionLift   95%CI')
  lines.push(`  R1(in-sample)   ${f3(loop.r1.decisionLift)}          ${ci(loop.r1)}`)
  lines.push(`  R2(held-out)    ${f3(loop.r2.decisionLift)}          ${ci(loop.r2)}`)
  const gen = Math.abs(loop.roundDelta) < 0.1 ? '≈0 ⇒ 迁得动、非过拟合' : '偏大 ⇒ 迁移有损'
  lines.push(`  roundDelta = ${f3(loop.roundDelta)}  (${gen})`)
  lines.push('')

  lines.push('── ③ 错答下钻(diagnose join → agent trace)──')
  lines.push(
    `  共 ${summary.total} 条错答  归类:g_overcorrection ${summary.byCategory.g_overcorrection} / raw_too_weak ${summary.byCategory.raw_too_weak} / genuine_miscalibration ${summary.byCategory.genuine_miscalibration}  退化 run ${summary.degenerateRuns}  无 trace ${summary.missingTrace}`,
  )
  if (diagnoses.length === 0) {
    lines.push('  (本轮 R2 无错答 —— fitted 在 τ 上零违诺)')
  }
  const SHOW = 5
  diagnoses.slice(0, SHOW).forEach((d, i) => {
    const id8 = d.claimId.slice(0, 8)
    lines.push(`  #${i + 1} claim ${id8}  raw ${f3(d.raw)} g ${f3(d.gValue)} → ${d.category}`)
    if (d.trace) {
      const flag = d.producingRunDegenerate ? '  ⚠ 退化' : ''
      lines.push(
        `       producing run ${d.producingRunId?.slice(0, 8)}  reason=${d.trace.reason} turns=${d.trace.turns} toolErrors=${d.trace.toolErrors}${flag}`,
      )
    } else {
      lines.push(`       (无 producing run trace)`)
    }
    lines.push(`       ${d.rationale}`)
  })
  if (diagnoses.length > SHOW) lines.push(`  … 另 ${diagnoses.length - SHOW} 条(略)`)
  lines.push('')
  // 措辞如实:真正的 fail-closed 是 runDecisionValueReport 在调本渲染器**之前** assertA3Frozen() 抛异常拦下;
  // 渲染层不可能在未通过时被调到,故此 footer 是"已通过"的陈述、非渲染层自己复检的结果。
  lines.push('(打印前已通过 A3 fail-closed 复检 —— 复跑可导入冻结不变量,漂移则拒印)')
  return lines.join('\n')
}
