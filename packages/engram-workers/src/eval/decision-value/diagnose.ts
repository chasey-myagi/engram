/**
 * S9 · 诊断 join(Track O × Track A 的 capstone)—— 把**错误决策**(被答出却为假的 claim)沿 S5 盖下的 producing_run_id
 * join 回**产出它的 agent run trace**,并按 (raw, g, τ) 把失败归三类,告诉人「该改 g、改 raw 因子、还是这就是真误校准」。
 *
 * 归类(raw=confidence_raw、g=confidence=g(raw)、τ=业务门;前置:被 fitted 答出 ⇒ g≥τ):
 *   - **g_overcorrection**:raw<τ ⇒ raw 本会弃答,是 g 把次门 raw 抬过门才答错 ⇒ **校准在该 raw 区过度修正**(该收 g)。
 *   - **raw_too_weak**:raw≥τ 且 g≤raw ⇒ raw 自身就把假 claim 抬过门、g 没火上浇油(甚至压了点)⇒ **raw 因子流水线判别力弱**(该加证据/因子)。
 *   - **genuine_miscalibration**:raw≥τ 且 g>raw ⇒ g 把已高估的 raw **进一步放大** ⇒ **校准本身在高置信区就是错的**(g 该在该区压而非抬)。
 * trace 是 join 出来的**生产侧上下文**(产该 claim 的 run 跑了几轮、几次工具报错、为何收尾),正交于 category:
 *   producingRunDegenerate(reason≠done 或 toolErrors>0)提示「这条错可能根在抽取本身退化」,供人优先排查,但**不**改 category。
 *
 * **只读**:本模块只 select(claim + agent_run_trace),零写入——诊断绝不回灌 claim/g/校准(测试快照行数前后不变)。
 * **A3 邻接红线**:诊断是**读侧**消费,绝不能反向喂 g/recall(否则「按诊断改 g 去压低被诊断的错」就是 Goodhart)。
 * 故本模块住在 workers(core 的 recall/confidence/fit-from-usage 物理 import 不到它);它引用 trace SPI(getAgentRunTrace)
 * ⇒ 在 workers a3-firewall allowlist 内;g 驱动者(Harvester/EngramRunner)对它不可达(测试钉死)。
 */
import { getAgentRunTrace, schema, type AgentRunTraceRecord, type DB } from '@engram/core'
import { inArray } from 'drizzle-orm'

export type FailureCategory = 'g_overcorrection' | 'raw_too_weak' | 'genuine_miscalibration'

/**
 * 纯函数三分(前置:该决策被 fitted 答出 ⇒ g≥τ;调用方保证)。仅凭 (raw, g, τ) 定位失败归属:
 * raw<τ → g 抬过门(g_overcorrection);raw≥τ 且 g≤raw → raw 自身高估(raw_too_weak);raw≥τ 且 g>raw → g 放大高置信错(genuine_miscalibration)。
 */
export function categorizeFailure(raw: number, gValue: number, tau: number): FailureCategory {
  if (raw < tau) return 'g_overcorrection'
  if (gValue <= raw) return 'raw_too_weak'
  return 'genuine_miscalibration'
}

export interface DecisionDiagnosis {
  claimId: string
  /** confidence_raw(g 前的连续证据聚合)。 */
  raw: number
  /** confidence(= g(raw),召回快照值)。 */
  gValue: number
  tau: number
  category: FailureCategory
  /** S5 盖下的相关键;null = 该 claim 没记产出 run(老数据 / 非 loop 工种)。 */
  producingRunId: string | null
  /** 沿 producing_run_id join 到的产出 run 留痕;null = 无 run 键或查无此 trace。 */
  trace: AgentRunTraceRecord | null
  /** 生产侧线索:产出 run 退化(截断 / 工具报错)。正交于 category,提示优先排查抽取本身。 */
  producingRunDegenerate: boolean
  rationale: string
}

function rationaleFor(d: {
  category: FailureCategory
  raw: number
  gValue: number
  tau: number
  trace: AgentRunTraceRecord | null
  degenerate: boolean
}): string {
  const head =
    d.category === 'g_overcorrection'
      ? `raw ${d.raw.toFixed(3)}<τ ${d.tau}:identity 本会弃答,是 g(=${d.gValue.toFixed(3)})把次门 raw 抬过门 ⇒ 该区校准过度修正`
      : d.category === 'raw_too_weak'
        ? `raw ${d.raw.toFixed(3)}≥τ ${d.tau} 且 g(=${d.gValue.toFixed(3)})≤raw:raw 因子自身把假 claim 抬过门、g 未加码 ⇒ raw 判别力弱`
        : `raw ${d.raw.toFixed(3)}≥τ ${d.tau} 且 g(=${d.gValue.toFixed(3)})>raw:g 进一步放大已高估的 raw ⇒ 高置信区真误校准`
  if (!d.trace) return `${head};(无 producing run trace)`
  const tail = d.degenerate
    ? `;⚠ 产出 run 退化(reason=${d.trace.reason}, toolErrors=${d.trace.toolErrors}, turns=${d.trace.turns})—— 优先排查抽取本身`
    : `;产出 run 正常(reason=${d.trace.reason}, turns=${d.trace.turns})`
  return head + tail
}

/**
 * 诊断一批**错误决策**(被答出却为假的 claimId):读 claim 的 raw/g/producing_run_id → join agent_run_trace → 归类。
 * **纯只读**(零写)。空入参 → 空出。查不到的 claimId 直接跳过(不抛——诊断是尽力而为的事后分析)。
 */
export async function diagnoseWrongDecisions(
  db: DB,
  wrongClaimIds: string[],
  tau: number,
): Promise<DecisionDiagnosis[]> {
  if (wrongClaimIds.length === 0) return []
  const claims = await db
    .select({
      id: schema.claim.id,
      confidence: schema.claim.confidence,
      confidenceRaw: schema.claim.confidenceRaw,
      producingRunId: schema.claim.producingRunId,
    })
    .from(schema.claim)
    .where(inArray(schema.claim.id, wrongClaimIds))

  const out: DecisionDiagnosis[] = []
  for (const c of claims) {
    let trace: AgentRunTraceRecord | null = null
    if (c.producingRunId) {
      const rows = await getAgentRunTrace(db, { runId: c.producingRunId, limit: 1 })
      trace = rows[0] ?? null
    }
    const raw = c.confidenceRaw
    const gValue = c.confidence
    const category = categorizeFailure(raw, gValue, tau)
    const degenerate = trace !== null && (trace.reason !== 'done' || trace.toolErrors > 0)
    out.push({
      claimId: c.id,
      raw,
      gValue,
      tau,
      category,
      producingRunId: c.producingRunId,
      trace,
      producingRunDegenerate: degenerate,
      rationale: rationaleFor({ category, raw, gValue, tau, trace, degenerate }),
    })
  }
  return out
}

export interface DiagnosisSummary {
  total: number
  byCategory: Record<FailureCategory, number>
  /** 其中产出 run 退化的条数(跨 category;生产侧需优先排查的数量)。 */
  degenerateRuns: number
  /** 其中 join 不到 trace 的条数(老数据 / 无 run 键)。 */
  missingTrace: number
}

/** 把诊断聚合成报告口径的计数(S10 ASCII 报告用)。 */
export function summarizeDiagnoses(diagnoses: DecisionDiagnosis[]): DiagnosisSummary {
  const byCategory: Record<FailureCategory, number> = {
    g_overcorrection: 0,
    raw_too_weak: 0,
    genuine_miscalibration: 0,
  }
  let degenerateRuns = 0
  let missingTrace = 0
  for (const d of diagnoses) {
    byCategory[d.category] += 1
    if (d.producingRunDegenerate) degenerateRuns += 1
    if (d.trace === null) missingTrace += 1
  }
  return { total: diagnoses.length, byCategory, degenerateRuns, missingTrace }
}
