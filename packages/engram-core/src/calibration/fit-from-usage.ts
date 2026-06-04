/**
 * 「首次校准」触发外壳（S28，命门 A.3 #2「积累 ≥200 条 usage_truth 真值后拟合 isotonic」）——
 * Harvester 工种的校准半边：从 usage_truth 真值流取校准样本 → ≥200 门 → fit isotonic g' → 经 S27 验收门原子换。
 *
 * 取样口径（**评测=消费**，A3 红线在输入边界守）：
 *   - 只读 `claim_verification(kind='usage_truth')` 里 outcome∈{adopted,refuted} 且带 predictedConfidence 的行；
 *     GoldenSample = { rawPredicted: predictedConfidence, correct: outcome==='adopted' }。
 *   - **predictedConfidence 是召回瞬间快照的 value=g(raw)。首次校准发生在 g=identity 下**（value==raw），
 *     故首拟合的 X 即 raw（与 A.3「X=raw」一致）。默认只取 calibrationVersion='identity'（或缺省/null）的样本，
 *     不混入已被某个非 identity g 压过的预测（那些 X 已不是 raw，混进去会污染拟合）。caller 可放宽（fromVersions）。
 *   - **独立用户/不同 task 门控（A.6 防 Goodhart）**：同一 (by_role, taskId) 身份反复上报只算**一票**，取最新结局——
 *     与 S19 usage-correct 同款反刷单口径。distinct 身份才进样本；这样同源刷单无法堆出 200 条假样本来强拟一个 g。
 *   - **结构上无 ELO/胜负率入口**：样本只有 (predictedConfidence, outcome) 两字段，与 S5/S19 同源同口径。
 *
 * 流程：取样 → 若 distinct 独立样本 < MIN_FIT_SAMPLES（200）：**不拟合、g 维持 identity**（返回 reason='below_threshold'）；
 * 否则 fit isotonic → 交 evaluateAndMaybeSwap（advise 绑 ΔECE → 5/6 验收门 → 5/5 才原子换；否则 fail-silent HOLD）。
 * 纯读取样 + 确定性拟合 + 受控副作用（仅 approve 才写活动 g）。Harvester 失败降级 = 无 g 更新、维持现状（A.7）。
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { CALIBRATION_IDENTITY } from '../confidence/confidence.js'
import type { DB } from '../db/client.js'
import { claimVerification } from '../db/schema.js'
import type { GoldenSample } from './advisor.js'
import { fitIsotonic } from './isotonic.js'
import { evaluateAndMaybeSwap, type EvaluateOptions, type SwapResult } from './recalibrate.js'

/** 命门 A.3：积累 ≥200 条 usage_truth 真值后才首次拟合 g'。低于此 g 维持 identity（不拟合）。 */
export const MIN_FIT_SAMPLES = 200

/** 校准只认这两类干净结局：adopted=正确(1)、refuted=错误(0)（与 S5/S19 一致；corrected/partial 不入）。 */
const CORRECT_OUTCOME = 'adopted'
const CALIBRATION_OUTCOMES = ['adopted', 'refuted'] as const

export interface FitFromUsageOptions extends EvaluateOptions {
  /** 拟合出的 g' 的具名版本（落 calibration_map.version）。默认按样本数 + 时间戳生成确定性可读名。 */
  version?: string
  /**
   * 取样时接受的预测来源 g 版本集合。默认只取 identity（首次校准：predictedConfidence==raw）。
   * 显式给非 identity 版本时由 caller 自负其语义（分段校准是后续工作；本切片只交付首次校准）。
   */
  fromVersions?: string[]
}

/** fitAndMaybeRecalibrate 的结果：要么因样本不足未拟合，要么走完验收门（swap=swapped）。 */
export type FitResult =
  | {
      /** 样本不足（< MIN_FIT_SAMPLES）→ 未拟合，g 维持 identity。 */
      fitted: false
      reason: 'below_threshold'
      /** 取到的 distinct 独立样本数（审计）。 */
      sampleCount: number
    }
  | {
      /** 拟合并跑完验收门（swap 看 swapResult.swapped）。 */
      fitted: true
      sampleCount: number
      swapResult: SwapResult
    }

/** 计票行的最小形状：身份 (by_role, taskId) + 结局 + 预测值（召回快照 value）。 */
interface SampleRow {
  byRole: string
  taskId: string | null
  outcome: 'adopted' | 'refuted'
  predicted: number
}

/**
 * 把 usage_truth 行按**独立身份** (by_role, taskId) 去重（最新覆盖）→ 每个 distinct 身份产出**一条** GoldenSample。
 * 反刷单：同一身份多次上报折叠成一票（取其最新一次的 outcome + 当次 predictedConfidence）。确定性（行按时间升序入）。
 */
function gatedSamples(rows: SampleRow[]): GoldenSample[] {
  const latestByIdentity = new Map<string, { correct: boolean; predicted: number }>()
  for (const r of rows) {
    const key = JSON.stringify([r.byRole, r.taskId ?? ''])
    // 后到覆盖先到 ⇒ 每个身份留下最新一票（结局 + 该次召回快照预测值）。
    latestByIdentity.set(key, {
      correct: r.outcome === CORRECT_OUTCOME,
      predicted: r.predicted,
    })
  }
  return [...latestByIdentity.values()].map((v) => ({
    rawPredicted: v.predicted,
    correct: v.correct,
  }))
}

/**
 * 从 usage_truth 真值流取**独立门控**的校准样本（distinct (by_role, taskId)，最新覆盖）。
 * 只取 outcome∈{adopted,refuted} 且 predictedConfidence 为数、且 calibrationVersion ∈ fromVersions 的行。
 * A3：只读 outcome + predictedConfidence 两字段，无任何 ELO/胜负率通道。
 */
export async function collectUsageCalibrationSamples(
  db: DB,
  fromVersions: string[] = [CALIBRATION_IDENTITY],
): Promise<GoldenSample[]> {
  const rows = await db
    .select({
      byRole: claimVerification.byRole,
      verdict: claimVerification.verdict,
    })
    .from(claimVerification)
    .where(
      and(
        eq(claimVerification.kind, 'usage_truth'),
        sql`(${claimVerification.verdict} ->> 'outcome') in (${sql.join(
          CALIBRATION_OUTCOMES.map((o) => sql`${o}`),
          sql`, `,
        )})`,
        sql`(${claimVerification.verdict} ->> 'predictedConfidence') is not null`,
        // 默认只取 identity 下产生的预测（predictedConfidence==raw）。fromVersions 可放宽。
        inArray(
          sql`coalesce(${claimVerification.verdict} ->> 'calibrationVersion', ${CALIBRATION_IDENTITY})`,
          fromVersions,
        ),
      ),
    )
    // 升序：同身份后到覆盖先到（与 S19 反刷单口径一致）。
    .orderBy(asc(claimVerification.createdAt), asc(claimVerification.id))

  const sampleRows: SampleRow[] = []
  for (const r of rows) {
    const v = r.verdict as { outcome?: unknown; taskId?: unknown; predictedConfidence?: unknown }
    if (typeof v.predictedConfidence !== 'number' || Number.isNaN(v.predictedConfidence)) continue
    // SQL 已把 outcome 限定在 {adopted, refuted}；活下来的非 adopted 必是 refuted。
    const outcome = v.outcome === CORRECT_OUTCOME ? 'adopted' : 'refuted'
    sampleRows.push({
      byRole: r.byRole,
      taskId: typeof v.taskId === 'string' ? v.taskId : null,
      outcome,
      predicted: v.predictedConfidence,
    })
  }
  return gatedSamples(sampleRows)
}

/**
 * 「首次校准」一次跑：取独立门控样本 → ≥200 门 → fit isotonic g' → 经 S27 验收门原子换（或 HOLD）。
 *
 * <200：不拟合、返回 reason='below_threshold'（g 维持 identity，连 advise 都不跑——A.3「积累≥200 后才拟合」）。
 * ≥200：fitIsotonic（确定性、单调）→ evaluateAndMaybeSwap（advise 绑 ΔECE → 6 项验收门 → 5/5? 原子换 : HOLD）。
 * 永不抛进 Harvester 主干（取样/拟合是纯读 + 纯计算；写只在验收门 approve 时由 store 原子完成）。
 */
export async function fitAndMaybeRecalibrate(
  db: DB,
  opts: FitFromUsageOptions = {},
): Promise<FitResult> {
  const samples = await collectUsageCalibrationSamples(
    db,
    opts.fromVersions ?? [CALIBRATION_IDENTITY],
  )
  if (samples.length < MIN_FIT_SAMPLES) {
    return { fitted: false, reason: 'below_threshold', sampleCount: samples.length }
  }
  const version = opts.version ?? `cal-iso-${samples.length}-${Date.now()}`
  const candidate = fitIsotonic(samples, version)
  const { version: _v, fromVersions: _f, ...evalOpts } = opts
  const swapResult = await evaluateAndMaybeSwap(db, samples, candidate, evalOpts)
  return { fitted: true, sampleCount: samples.length, swapResult }
}
