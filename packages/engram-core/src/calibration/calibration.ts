/**
 * 校准度量（**P0 GATE**，附录 A.3/A.9）：把召回瞬间拍下的 ConfidenceSnapshot.value（预测概率）
 * 与 usage_truth 的观测结局按可靠性 bin 聚合，算 Expected Calibration Error。
 *
 * 判据（冻结）：
 *   - 预测 = conf.value（召回瞬间快照，**绝不查询时重算**）；
 *   - 观测正确率 = adopted / (adopted + refuted)  per bin（corrected/partial 不进这个比率——非干净的对/错信号）；
 *   - ECE = Σ_bin (n_bin / N) · |meanPredicted_bin − observed_bin|，N = Σ 有标注样本数；
 *   - 空 bin 不除零（权重 0）；空输入 ECE=0（非 NaN）；
 *   - 只吃 (predicted, correct) —— 结构上无 ELO/胜负率入口（A3 红线在输入边界）。
 *
 * 纯函数 computeReliability 是被单测钉死的核心；computeCalibrationFromUsage 只是从 SPI 落地数据读出样本
 * 喂给它（评测=消费）。g=identity 下 predicted=raw，ECE 可算且非平凡。
 */
import { and, eq, sql } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { claimVerification } from '../db/schema.js'
import { collectGatedUsageSamples } from './usage-samples.js'

export const DEFAULT_BIN_COUNT = 10

/** 一条校准样本：召回瞬间预测概率 + 该次消费是否正确（adopted=true / refuted=false）。 */
export interface CalibrationSample {
  predicted: number
  correct: boolean
}

/** 单个可靠性 bin（可直接画 reliability diagram）。 */
export interface ReliabilityBin {
  /** bin 区间 [lo, hi)（末 bin 含 1.0）。 */
  lo: number
  hi: number
  /** 该 bin 的有标注样本数（adopted + refuted）。 */
  count: number
  /** 预测概率均值（count=0 → 0）。 */
  meanPredicted: number
  /** 观测正确率 = adopted/(adopted+refuted)（count=0 → 0，权重也为 0 不进 ECE）。 */
  observed: number
}

export interface ReliabilityReport {
  bins: ReliabilityBin[]
  /** 单标量：Expected Calibration Error ∈ [0,1]。 */
  ece: number
  /** 有标注样本总数 N。 */
  sampleCount: number
  binCount: number
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/**
 * 纯函数：把 (predicted, correct) 样本分 bin，算每 bin 的 (meanPredicted, observed, count) 与整体 ECE。
 * binCount 必须是正整数。空 bin 不除零；空输入 ECE=0（非 NaN）。
 */
export function computeReliability(
  samples: CalibrationSample[],
  binCount: number = DEFAULT_BIN_COUNT,
): ReliabilityReport {
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new Error(`calibration: binCount must be a positive integer (got ${binCount})`)
  }
  const width = 1 / binCount
  const counts = new Array<number>(binCount).fill(0)
  const sumPredicted = new Array<number>(binCount).fill(0)
  const sumCorrect = new Array<number>(binCount).fill(0)

  for (const s of samples) {
    const p = clamp01(s.predicted)
    const idx = Math.min(binCount - 1, Math.floor(p * binCount)) // predicted=1 → 末 bin
    counts[idx]! += 1
    sumPredicted[idx]! += p
    if (s.correct) sumCorrect[idx]! += 1
  }

  const sampleCount = samples.length // 所有样本都落入某个 bin ⇒ Σcounts = N
  const bins: ReliabilityBin[] = []
  let ece = 0
  for (let i = 0; i < binCount; i++) {
    const n = counts[i]!
    const meanPredicted = n > 0 ? sumPredicted[i]! / n : 0
    const observed = n > 0 ? sumCorrect[i]! / n : 0
    bins.push({ lo: i * width, hi: (i + 1) * width, count: n, meanPredicted, observed })
    if (n > 0) ece += (n / sampleCount) * Math.abs(meanPredicted - observed) // n>0 ⇒ N>0，不除零
  }
  return { bins, ece, sampleCount, binCount }
}

/** 校准只认这两类干净结局：adopted = 正确(1)、refuted = 错误(0)。corrected/partial 不进比率。 */
const CORRECT_OUTCOME = 'adopted'
const CALIBRATION_OUTCOMES = ['adopted', 'refuted'] as const

/**
 * ECE 取样口径：
 *   - `independent-identities`（**默认**，A.6 防 Goodhart）：按 `(byRole, taskId)` 折叠成一票（最新覆盖），
 *     与拟合器 g / S19 同口径——同一身份反复上报 usage_truth 不能改变 reliability 分布、刷低 ECE/ΔECE。
 *   - `raw-events`：逐行 raw 计数（旧行为）。**仅供诊断**，绝不作为 L3/纵向读数的 gate 值。
 */
export type CalibrationSampleMode = 'independent-identities' | 'raw-events'

/**
 * 评测=消费：只从 SPI 落地的 usage_truth 事件读校准样本——
 *   outcome ∈ {adopted, refuted} 且带 predictedConfidence（召回瞬间快照值）。
 * A3 红线在此输入边界：结构上只读 kind='usage_truth' 的 outcome + predictedConfidence（+ 身份用于门控），
 * 任何 ELO/胜负率信号都无字段、无 kind 可进。绝不查询时重算 confidence——只读快照里持久化的预测值。
 *
 * 默认 `independent-identities`：与拟合器 g 共用同一套独立身份门控（`collectGatedUsageSamples`），
 * 关掉「同一 consumer 对同一 claim/task 反复刷 adopted/refuted 改变 ECE」这条 Goodhart 通道（EGR-CR-027）。
 * `system-dimensions`（L3 八维 ece）与 `longitudinal-recompete`（纵向 ΔECE）经无参调用默认即受门控保护。
 */
export async function computeCalibrationFromUsage(
  db: DB,
  binCount: number = DEFAULT_BIN_COUNT,
  mode: CalibrationSampleMode = 'independent-identities',
): Promise<ReliabilityReport> {
  if (mode === 'independent-identities') {
    // 共享门控：按 (byRole, taskId) 折叠成一票（最新覆盖），不按 g 版本过滤（评测所有活动快照下的预测）。
    const gated = await collectGatedUsageSamples(db, null)
    const samples: CalibrationSample[] = gated.map((g) => ({
      predicted: g.predicted,
      correct: g.correct,
    }))
    return computeReliability(samples, binCount)
  }

  // raw-events：逐行 raw 计数（诊断模式）。每条 usage_truth 行 = 一个独立可靠性样本（无身份门控）。
  const rows = await db
    .select({ verdict: claimVerification.verdict })
    .from(claimVerification)
    .where(
      and(
        eq(claimVerification.kind, 'usage_truth'),
        sql`(${claimVerification.verdict} ->> 'outcome') in (${sql.join(
          CALIBRATION_OUTCOMES.map((o) => sql`${o}`),
          sql`, `,
        )})`,
        sql`(${claimVerification.verdict} ->> 'predictedConfidence') is not null`,
      ),
    )

  const samples: CalibrationSample[] = []
  for (const r of rows) {
    // 只读 outcome + predictedConfidence 两个字段——verdict 里任何 winRate/elo 等都被结构性忽略（A3）。
    const v = r.verdict as { outcome?: unknown; predictedConfidence?: unknown }
    // NaN 守卫纯防御：JSON 存不下 NaN（JSON.stringify(NaN)='null'）、reportUsage 写时也已挡 NaN。
    if (typeof v.predictedConfidence !== 'number' || Number.isNaN(v.predictedConfidence)) continue
    // SQL 已把 outcome 限定在 {adopted, refuted}；活下来的非 adopted 必是 refuted ⇒ correct=false。
    samples.push({ predicted: v.predictedConfidence, correct: v.outcome === CORRECT_OUTCOME })
  }
  return computeReliability(samples, binCount)
}
