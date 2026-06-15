/**
 * 共享的 usage_truth 取样口径（**单一真相源**，A.6 防 Goodhart）——
 * 校准两侧（拟合器 g 与 ECE 读数）都从这里取「独立身份门控」样本，避免两份漂移的门控实现。
 *
 * 取样口径（评测=消费，A3 红线在输入边界守）：
 *   - 只读 `claim_verification(kind='usage_truth')` 里 outcome∈{adopted,refuted} 且带 predictedConfidence 的行；
 *     结构上只读 (outcome, predictedConfidence[, taskId]) —— 任何 ELO/胜负率字段无入口（A3）。
 *   - **独立用户/不同 task 门控**：同一 `(byRole, taskId)` 身份反复上报只算**一票**，取其最新一次的结局 + 当次预测值——
 *     与 S19 usage-correct / fitter 同款反刷单口径。distinct 身份才进样本；同源刷单无法堆出重复样本扭曲读数。
 *   - **先去重取最新、再按 outcome 判样本（EGR-CR-030）**：读**全量**结局（含 corrected/partial），latest-by-identity 折叠时
 *     非计数结局（corrected/partial/缺预测值）也覆盖该身份的旧票——只有折叠后**最新一票仍是 adopted/refuted 且带预测值**的身份才成样本。
 *     这样同身份「先 adopted 后 corrected」时，最新 corrected 把旧 adopted 顶成「不计样本」，与 f4 usage-correct 口径逐字对齐
 *     （否则在 SQL 层先按 outcome 过滤会把 corrected 整行丢弃、旧 adopted 残留成幽灵样本污染 g）。
 *
 * 折叠确定性：行按 `createdAt asc, id asc` 升序入，后到覆盖先到 ⇒ 每个身份留下最新一票。
 * 返回**中间形状** `GatedUsageSample[]`，让 fitter 与 ECE 读数各自 map 到自己的样本类型（字段语义差异由 caller 处置）。
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { CALIBRATION_IDENTITY } from '../confidence/confidence.js'
import type { DB } from '../db/client.js'
import { claimVerification } from '../db/schema.js'

/** 校准只认这两类干净结局：adopted=正确(1)、refuted=错误(0)（与 S5/S19 一致；corrected/partial 不入）。 */
const CORRECT_OUTCOME = 'adopted'
const CALIBRATION_OUTCOMES = ['adopted', 'refuted'] as const

/** 最新一票是否为可成样本的干净结局（adopted/refuted）——EGR-CR-030：判定移到去重之后。 */
function isCalibrationOutcome(x: unknown): x is (typeof CALIBRATION_OUTCOMES)[number] {
  return CALIBRATION_OUTCOMES.includes(x as (typeof CALIBRATION_OUTCOMES)[number])
}

/** 按 `(byRole, taskId)` 折叠成一票后的中间样本：身份 + 该身份最新一票的预测值与是否正确。 */
export interface GatedUsageSample {
  byRole: string
  taskId: string | null
  /** 召回瞬间快照的预测概率（predictedConfidence）。 */
  predicted: number
  /** 该次消费是否正确（adopted=true / refuted=false）。 */
  correct: boolean
}

/** 计票前的原始取样行：身份 (byRole, taskId) + 原始四态结局 + 预测值（corrected/partial 行可能无预测值）。 */
interface UsageSampleRow {
  byRole: string
  taskId: string | null
  /** 原始 outcome（adopted/refuted/corrected/partial/未知）——**不在去重前折叠成布尔**，以便非计数结局也能覆盖旧票。 */
  outcome: unknown
  /** 召回瞬间快照预测值；corrected/partial 行或旧行可能为 null。 */
  predicted: number | null
}

/**
 * 把 usage_truth 行按**独立身份** `(byRole, taskId)` 去重（最新覆盖）→ 每个 distinct 身份产出**至多一条**样本。
 * 反刷单：同一身份多次上报折叠成一票，取其**最新一次**的结局 + 当次预测值。行须按时间升序传入以保证确定性。
 *
 * EGR-CR-030：先去重取最新、**再**按 outcome 判是否成样本——只有最新一票仍是 adopted/refuted 且带有效预测值的身份才入样本；
 * 最新为 corrected/partial（或缺预测值）的身份直接跳过，但它**已在折叠中覆盖了该身份的旧 adopted/refuted**（与 f4 同口径）。
 */
function foldByIdentity(rows: UsageSampleRow[]): GatedUsageSample[] {
  const latestByIdentity = new Map<string, UsageSampleRow>()
  for (const r of rows) {
    const key = JSON.stringify([r.byRole, r.taskId ?? ''])
    // 后到覆盖先到 ⇒ 每个身份留下最新一票（含 corrected/partial：旧的正确票就此作废）。
    latestByIdentity.set(key, r)
  }
  const out: GatedUsageSample[] = []
  for (const r of latestByIdentity.values()) {
    // 只有「最新结局」是 adopted/refuted 且带有效预测值的身份才成样本。
    if (
      isCalibrationOutcome(r.outcome) &&
      typeof r.predicted === 'number' &&
      !Number.isNaN(r.predicted)
    ) {
      out.push({
        byRole: r.byRole,
        taskId: r.taskId,
        predicted: r.predicted,
        correct: r.outcome === CORRECT_OUTCOME,
      })
    }
  }
  return out
}

/**
 * 从 usage_truth 真值流取**独立身份门控**的校准样本（distinct `(byRole, taskId)`，最新覆盖）。
 * 读**全量**结局（含 corrected/partial）+ calibrationVersion ∈ fromVersions 的行 → latest-by-identity 折叠（最新覆盖，
 * 含非计数结局也覆盖旧票）→ 只有最新一票仍是 outcome∈{adopted,refuted} 且 predictedConfidence 为数的身份才成样本（EGR-CR-030）。
 * A3：只读 outcome + predictedConfidence + taskId（身份），无任何 ELO/胜负率通道。
 *
 * @param fromVersions 接受的预测来源 g 版本集合。默认只取 identity（predictedConfidence==raw）——拟合器用。
 *   传 `null` 时不按版本过滤（评测所有活动快照下的预测）——ECE 读数用。
 */
export async function collectGatedUsageSamples(
  db: DB,
  fromVersions: readonly string[] | null = [CALIBRATION_IDENTITY],
): Promise<GatedUsageSample[]> {
  const rows = await db
    .select({
      byRole: claimVerification.byRole,
      verdict: claimVerification.verdict,
    })
    .from(claimVerification)
    .where(
      and(
        eq(claimVerification.kind, 'usage_truth'),
        // EGR-CR-030：**不**在 SQL 层按 outcome 预过滤——读全量结局（含 corrected/partial），让最新非计数结局能在
        // latest-by-identity 折叠时覆盖同身份旧 adopted/refuted（与 f4 usage-correct 同口径）。是否成样本在折叠后判。
        // predictedConfidence 同理下放：缺预测值的最新 corrected 仍须能顶掉旧票（折叠后该身份因无有效预测值跳过）。
        // fromVersions=null → 不按版本过滤（ECE 读数评测所有活动快照）；否则只取 calibrationVersion ∈ fromVersions。
        ...(fromVersions === null
          ? []
          : [
              inArray(
                sql`coalesce(${claimVerification.verdict} ->> 'calibrationVersion', ${CALIBRATION_IDENTITY})`,
                [...fromVersions],
              ),
            ]),
      ),
    )
    // 升序：同身份后到覆盖先到（与 S19 反刷单口径一致）。
    .orderBy(asc(claimVerification.createdAt), asc(claimVerification.id))

  const sampleRows: UsageSampleRow[] = []
  for (const r of rows) {
    const v = r.verdict as { outcome?: unknown; taskId?: unknown; predictedConfidence?: unknown }
    // 保留原始 outcome + 预测值（可能为 null）；是否成样本推迟到 foldByIdentity 去重之后判（latest-by-identity）。
    sampleRows.push({
      byRole: r.byRole,
      taskId: typeof v.taskId === 'string' ? v.taskId : null,
      outcome: v.outcome,
      predicted:
        typeof v.predictedConfidence === 'number' && !Number.isNaN(v.predictedConfidence)
          ? v.predictedConfidence
          : null,
    })
  }
  return foldByIdentity(sampleRows)
}
