/**
 * f4 usageCorrect 生产者（命门 A.3 / 派生算法 A.6）—— 使用反馈 → confidence 的闭环统计。
 *
 * report_usage(S4) 把每次消费结局落成 claim_verification(kind='usage_truth')。本模块把这条**真值事件流**
 * 统计成 observed_correctness，再映射成 f4：
 *
 *   observed_correctness = adopted / (adopted + refuted)          （只数 adopted / refuted；corrected / partial 不入分母）
 *   f4 = clamp(observed·k − 0.5, 0, 1)                            （k 起步 = 2 ⇒ observed=0.75 → f4=1，observed=0.5 → f4=0.5）
 *   n<N 样本 → f4 向中性 0 压低（线性 damp = n/N），薄数据不能凭少数几次结局摇动 confidence。
 *
 * **独立用户/不同 task 门控（A.6 防 Goodhart / 反刷单）**：同一 (by_role, task) 反复上报只算**一票**——
 * 取该身份**最新**一次结局为其投票。distinct 身份才进 adopted/refuted 计数。这样同源/同任务刷单无法抬 f4。
 * usage_truth 没有独立的 user 列（A.1 schema FROZEN）：上报方身份就落在 by_role，task 落在 verdict.taskId。
 * 故「独立用户」≈ distinct by_role，「不同 task」≈ distinct taskId；二者拼成独立身份键。
 *
 * **A3 红线（严禁 ELO/胜负率进 f4/g 路径）**：本模块的统计输入**只有** adopted/refuted 两类消费结局
 * （UsageOutcome 的子集），结构上无法喂入任何 ELO / 胜负率 / 排名信号——计数入参里压根没有那种字段。
 *
 * 纯读、确定性。在因子装配处（computeConfidenceFromProvenances，单一标注点）与召回 live-override 各调一次，
 * 与 S17 的 f2 entailment 同款实时口径（不吃写时快照、反映最新 usage 真值）。Harvester 工种(S19)是它的触发外壳。
 */
import { and, asc, eq, inArray } from 'drizzle-orm'

import { NEUTRAL_FACTORS } from '../confidence/confidence.js'
import type { DB, Tx } from '../db/client.js'
import { claimVerification } from '../db/schema.js'

/** DB 或事务 Tx（recall 用前者、commit 合并重算用后者；drizzle select 链在两者上同形）。 */
type Queryable = DB | Tx

/** f4 映射斜率 k 的起步基线（A.6：observed·k − 0.5）。observed=0.75 → f4=1；observed=0.5 → f4=0.5；observed≤0.25 → f4=0。 */
export const USAGE_CORRECT_K = 2

/** 低样本阈值 N：distinct 独立身份数 < N 的 claim，f4 线性压低（n/N），薄数据不能摇动 confidence。 */
export const USAGE_CORRECT_MIN_SAMPLES = 3

/** f4 统计需要计票的两类结局（A.6：只数 adopted / refuted）。corrected/partial 是别的信号，不进 f4 分母。 */
const COUNTED_OUTCOMES = ['adopted', 'refuted'] as const
type CountedOutcome = (typeof COUNTED_OUTCOMES)[number]

function isCountedOutcome(x: unknown): x is CountedOutcome {
  return x === 'adopted' || x === 'refuted'
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/**
 * 一条 claim 的 f4 统计明细（可审计 / 可断言）。observed=null 表示**无任何可计票结局**（adopted+refuted=0），
 * 此时调用方退回中性 0（NEUTRAL_FACTORS.usageCorrect），与「从未被使用过」语义一致。
 */
export interface UsageCorrectStats {
  /** 独立 adopted 票数（distinct (by_role, task) 身份去重后）。 */
  adopted: number
  /** 独立 refuted 票数（同上去重）。 */
  refuted: number
  /** 计票身份总数 n = adopted + refuted（喂低样本 damp）。 */
  independentSamples: number
  /** observed_correctness = adopted/(adopted+refuted)；n=0 → null。 */
  observed: number | null
  /** 映射 + 低样本 damp 后的 f4 ∈ [0,1]。 */
  factor: number
}

/**
 * 把「独立 adopted/refuted 计数」映射成 f4（纯函数，A.6）。
 *   observed = adopted/(adopted+refuted)
 *   raw f4   = clamp(observed·k − 0.5, 0, 1)
 *   damp     = min(1, n/N)，f4 = rawF4·damp —— n<N 时按比例压向中性 0。
 * adopted+refuted=0（从未被计票）→ observed=null、f4=中性 0。
 *
 * 注意：入参刻意只有 adopted/refuted 两个计数 + 调参，**没有任何** ELO/胜负率/排名通道（A3 红线结构性保证）。
 */
export function usageCorrectStatsFromCounts(
  adopted: number,
  refuted: number,
  opts: { k?: number; minSamples?: number } = {},
): UsageCorrectStats {
  const k = opts.k ?? USAGE_CORRECT_K
  const minSamples = opts.minSamples ?? USAGE_CORRECT_MIN_SAMPLES
  const n = adopted + refuted
  if (n <= 0) {
    return {
      adopted,
      refuted,
      independentSamples: 0,
      observed: null,
      factor: NEUTRAL_FACTORS.usageCorrect, // 从未被使用 → 中性 0（与「印证=0」同语义：无信号不抬）
    }
  }
  const observed = adopted / n
  const mapped = clamp01(observed * k - 0.5)
  // 低样本 damp：n≥N 时 damp=1（不削）；n<N 时 damp=n/N，f4 按比例压向中性 0，薄数据不能摇动 confidence。
  const damp = minSamples > 0 ? Math.min(1, n / minSamples) : 1
  return {
    adopted,
    refuted,
    independentSamples: n,
    observed,
    factor: clamp01(mapped * damp),
  }
}

/** 计票所需的最小行形状：身份（by_role + taskId）+ 结局。 */
interface IdentityRow {
  byRole: string
  taskId: string | null
  outcome: unknown
}

/**
 * 把计票行按**独立身份** (by_role, taskId) 去重（最新覆盖）→ 统计 adopted/refuted → f4。
 * 反刷单核心：同一身份多次上报折叠成一票，取其最新结局（行需按 created_at/id 升序，后到覆盖先到）。
 */
function statsFromRows(rows: IdentityRow[]): UsageCorrectStats {
  const latestByIdentity = new Map<string, CountedOutcome | null>()
  for (const r of rows) {
    // 独立身份键：by_role ⊕ taskId。同 (by_role, task) 多次上报 = 同一票，后到者覆盖（取最新结局）。
    const key = JSON.stringify([r.byRole, r.taskId ?? ''])
    if (isCountedOutcome(r.outcome)) {
      latestByIdentity.set(key, r.outcome)
    } else {
      // corrected/partial/未知：占位为 null（该身份「投过票但不计 adopted/refuted」），仍覆盖此身份的旧结局，
      // 防同身份先 adopted 后 corrected 时旧 adopted 还被计入（最新结局才算数）。
      latestByIdentity.set(key, null)
    }
  }
  let adopted = 0
  let refuted = 0
  for (const o of latestByIdentity.values()) {
    if (o === 'adopted') adopted += 1
    else if (o === 'refuted') refuted += 1
  }
  return usageCorrectStatsFromCounts(adopted, refuted)
}

/** verdict JSONB 取 outcome/taskId（taskId 非字符串视为 null）。by_role 是列字段，单独取。 */
function toIdentityRow(byRole: string, verdict: unknown): IdentityRow {
  const v = verdict as { outcome?: unknown; taskId?: unknown } | null
  return {
    byRole,
    taskId: typeof v?.taskId === 'string' ? v.taskId : null,
    outcome: v?.outcome,
  }
}

/**
 * 读一条 claim 的全部 usage_truth 事件，按**独立身份**(by_role, taskId)去重计票，算出 f4 统计明细。
 * 反刷单：同一身份反复上报只算一票，取其**最新**一次结局。只有 adopted/refuted 进计数；corrected/partial 不入分母。
 *
 * A3 红线（结构性保证）：唯一读取的信号是 usage_truth 行里的 outcome（adopted/refuted），无任何 ELO/胜负率字段可被读入。
 */
export async function computeUsageCorrectStats(
  q: Queryable,
  claimId: string,
): Promise<UsageCorrectStats> {
  const rows = await q
    .select({
      id: claimVerification.id,
      byRole: claimVerification.byRole,
      verdict: claimVerification.verdict,
    })
    .from(claimVerification)
    .where(and(eq(claimVerification.kind, 'usage_truth'), eq(claimVerification.claimId, claimId)))
    // 升序：同一身份后到的结局覆盖先到的 ⇒ map 里留下的是该身份**最新**一票。
    .orderBy(asc(claimVerification.createdAt), asc(claimVerification.id))
  return statsFromRows(rows.map((r) => toIdentityRow(r.byRole, r.verdict)))
}

/**
 * 命门 f4 接线：读一条 claim 的 usage_truth → 独立门控统计 → f4 因子值。
 * 在因子装配处（computeConfidenceFromProvenances）与召回 live-override 各调一次（**与 S17 f2 同一单一标注点**）。
 * 没有 claimId（appendClaim 新建、claim 尚不存在、压根没有 usage）的场景由调用方退回 NEUTRAL_FACTORS.usageCorrect，不调本函数。
 */
export async function computeUsageCorrectFactor(q: Queryable, claimId: string): Promise<number> {
  const stats = await computeUsageCorrectStats(q, claimId)
  return stats.factor
}

/**
 * 批量读多条 claim 各自的 **f4 usageCorrect 因子值**（召回路径用：一次查回所有候选的 usage_truth，避免 N 次往返）。
 * 返回 Map<claimId, factor>；**只有有 usage_truth 行的 claim 入 Map**（无 usage → 不入，调用方沿用存档/中性，
 * 与 latestEntailmentFactors 同口径：无信号不覆盖）。计票口径与 computeUsageCorrectStats 逐字一致（独立身份去重 + 最新覆盖）。
 */
export async function latestUsageCorrectFactors(
  db: DB,
  claimIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (claimIds.length === 0) return out
  const rows = await db
    .select({
      id: claimVerification.id,
      claimId: claimVerification.claimId,
      byRole: claimVerification.byRole,
      verdict: claimVerification.verdict,
    })
    .from(claimVerification)
    .where(
      and(eq(claimVerification.kind, 'usage_truth'), inArray(claimVerification.claimId, claimIds)),
    )
    // 升序：同 claim 同身份后到覆盖先到（与单条口径一致）。
    .orderBy(asc(claimVerification.createdAt), asc(claimVerification.id))

  const byClaim = new Map<string, IdentityRow[]>()
  for (const r of rows) {
    const row = toIdentityRow(r.byRole, r.verdict)
    const list = byClaim.get(r.claimId)
    if (list) list.push(row)
    else byClaim.set(r.claimId, [row])
  }
  for (const [claimId, rs] of byClaim) {
    out.set(claimId, statsFromRows(rs).factor)
  }
  return out
}
