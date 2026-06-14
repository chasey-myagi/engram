/**
 * 共享的 usage_truth 取样口径（**单一真相源**，A.6 防 Goodhart）——
 * 校准两侧（拟合器 g 与 ECE 读数）都从这里取「独立身份门控」样本，避免两份漂移的门控实现。
 *
 * 取样口径（评测=消费，A3 红线在输入边界守）：
 *   - 只读 `claim_verification(kind='usage_truth')` 里 outcome∈{adopted,refuted} 且带 predictedConfidence 的行；
 *     结构上只读 (outcome, predictedConfidence[, taskId]) —— 任何 ELO/胜负率字段无入口（A3）。
 *   - **独立用户/不同 task 门控**：同一 `(byRole, taskId)` 身份反复上报只算**一票**，取其最新一次的结局 + 当次预测值——
 *     与 S19 usage-correct / fitter 同款反刷单口径。distinct 身份才进样本；同源刷单无法堆出重复样本扭曲读数。
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

/** 按 `(byRole, taskId)` 折叠成一票后的中间样本：身份 + 该身份最新一票的预测值与是否正确。 */
export interface GatedUsageSample {
  byRole: string
  taskId: string | null
  /** 召回瞬间快照的预测概率（predictedConfidence）。 */
  predicted: number
  /** 该次消费是否正确（adopted=true / refuted=false）。 */
  correct: boolean
}

/** 计票前的原始取样行：身份 (byRole, taskId) + 结局 + 预测值。 */
interface UsageSampleRow {
  byRole: string
  taskId: string | null
  correct: boolean
  predicted: number
}

/**
 * 把 usage_truth 行按**独立身份** `(byRole, taskId)` 去重（最新覆盖）→ 每个 distinct 身份产出**一条**样本。
 * 反刷单：同一身份多次上报折叠成一票（取其最新一次的结局 + 当次预测值）。行须按时间升序传入以保证确定性。
 */
function foldByIdentity(rows: UsageSampleRow[]): GatedUsageSample[] {
  const latestByIdentity = new Map<string, GatedUsageSample>()
  for (const r of rows) {
    const key = JSON.stringify([r.byRole, r.taskId ?? ''])
    // 后到覆盖先到 ⇒ 每个身份留下最新一票（结局 + 该次召回快照预测值）。
    latestByIdentity.set(key, {
      byRole: r.byRole,
      taskId: r.taskId,
      predicted: r.predicted,
      correct: r.correct,
    })
  }
  return [...latestByIdentity.values()]
}

/**
 * 从 usage_truth 真值流取**独立身份门控**的校准样本（distinct `(byRole, taskId)`，最新覆盖）。
 * 只取 outcome∈{adopted,refuted} 且 predictedConfidence 为数、且 calibrationVersion ∈ fromVersions 的行。
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
        sql`(${claimVerification.verdict} ->> 'outcome') in (${sql.join(
          CALIBRATION_OUTCOMES.map((o) => sql`${o}`),
          sql`, `,
        )})`,
        sql`(${claimVerification.verdict} ->> 'predictedConfidence') is not null`,
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
    // NaN 守卫纯防御：JSON 存不下 NaN、reportUsage 写时也已挡 NaN。
    if (typeof v.predictedConfidence !== 'number' || Number.isNaN(v.predictedConfidence)) continue
    sampleRows.push({
      byRole: r.byRole,
      taskId: typeof v.taskId === 'string' ? v.taskId : null,
      // SQL 已把 outcome 限定在 {adopted, refuted}；活下来的非 adopted 必是 refuted ⇒ correct=false。
      correct: v.outcome === CORRECT_OUTCOME,
      predicted: v.predictedConfidence,
    })
  }
  return foldByIdentity(sampleRows)
}
