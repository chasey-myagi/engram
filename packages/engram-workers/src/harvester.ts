/**
 * Harvester 工种（S19）—— 闭合「使用 → 升信」的纯统计回路（A.6/A.7）。
 *
 * 形态 = **纯统计，无 agent loop**（A.7：Harvester 触发 = report_usage batch + 每日；形态=纯统计；失败=无 g 更新、维持现状）。
 * 不用 AgentRuntime/harness-pi、不调任何 LLM —— 只读 report_usage(S4) 落下的 claim_verification(kind='usage_truth')，
 * 按**独立用户/不同 task** 门控统计 observed_correctness → f4，再经内核 recomputeClaimConfidence 把 f4 重算进
 * 每条 claim 的存档 confidence 快照（命门 A.3）。f4 的所有产出逻辑都在 @engram/core（领域无关的 confidence 管线）；
 * 本工种只声明触发 + 编排批量重算（workers→core 单向依赖）。
 *
 * judge≠athlete（红线）：Harvester 是纯统计，不写 by_role 背书、不产出 claim，故无「给自己背书」之虞；它有自己的工种
 * 角色（HarvesterOptions.byRole，默认 'agent:harvester'）仅作编排/审计标识与独立 DB 角色锚点（与 Verifier 的 by_role 同范式）。
 *
 * 红线 #2（只人能放松，agent 只能收紧）：Harvester **绝不碰 status**——recomputeClaimConfidence 只重算 confidence、
 * 不触状态机。f4 升降只改 confidence 数值，不放松任何被隔离/收紧的 claim。
 *
 * A3 红线（ELO/胜负率严禁进 f4/g 路径）：统计输入只有 usage_truth 的 adopted/refuted 结局（见 core/harvest），
 * 结构上无 ELO/胜负率通道；且本工种**不更新 g**（A.7：Harvester 无 g 更新），g 由 S28 Advisor 独立接管。
 *
 * 失败降级（A.7「无 g 更新，维持现状」）：单条 claim 的重算异常被吞（计入 skipped），不崩、不阻塞其它 claim；
 * 整轮选批失败（DB 抖动）则整轮跳过、维持现状（既有 confidence 一字不动）。下一轮 batch/cron 再来。
 */
import { recomputeClaimConfidence, schema, type DB, type RecomputeResult } from '@engram/core'
import { and, desc, eq, inArray, max } from 'drizzle-orm'

const DEFAULT_BY_ROLE = 'agent:harvester'
const DEFAULT_MAX_CLAIMS = 500

export interface HarvesterDeps {
  db: DB
}

export interface HarvesterOptions {
  /** 工种角色（独立 DB 角色 / 审计标识）。默认 'agent:harvester'。Harvester 不写 by_role 背书，仅作锚点。 */
  byRole?: string
  /** 本轮最多重算多少条 claim（防无界）。默认 500。 */
  maxClaims?: number
  /**
   * 限定只重算这些 claimId（report_usage-batch 触发：刚收到一批用量回报的 claim）。
   * 不给则扫**所有有 usage_truth 的 claim**（每日 cron）。给的 id 里没有 usage_truth 的会被自然过滤（无事可做）。
   */
  claimIds?: string[]
}

/** 单条 claim 重算后的处置（可审计）。 */
export interface HarvestOutcome {
  claimId: string
  /** 重算后存档的 f4 usageCorrect（实际写进快照的值）。 */
  usageCorrect: number
  /** 重算后的 confidence（= g(raw)）。 */
  confidence: number
  /** 跳过/异常原因（若有）。 */
  note?: string
}

export interface HarvesterResult {
  byRole: string
  /** 实际重算并写回快照的 claim 数。 */
  harvested: number
  /** 因异常被跳过、未改动的 claim 数（维持现状）。 */
  skipped: number
  outcomes: HarvestOutcome[]
}

/**
 * 跑一轮 Harvester：选有 usage 的 claim → 逐条按 usage_truth 独立门控统计重算 confidence（f4 落库）。
 * 纯统计、无 LLM、无 agent loop、不碰 status、不更新 g。单条异常吞掉（skipped、维持现状），整轮选批失败则整轮跳过。
 */
export async function runHarvester(
  deps: HarvesterDeps,
  opts: HarvesterOptions = {},
): Promise<HarvesterResult> {
  const byRole = opts.byRole ?? DEFAULT_BY_ROLE
  const maxClaims = opts.maxClaims ?? DEFAULT_MAX_CLAIMS
  const result: HarvesterResult = { byRole, harvested: 0, skipped: 0, outcomes: [] }

  let claimIds: string[]
  try {
    claimIds = await selectUsageClaims(deps.db, {
      ...(opts.claimIds !== undefined ? { claimIds: opts.claimIds } : {}),
      maxClaims,
    })
  } catch {
    // 连批都选不出（DB 抖动）→ 整轮跳过、维持现状（既有 confidence 不动）。下一轮再来。
    return result
  }

  for (const claimId of claimIds) {
    try {
      const r: RecomputeResult | null = await recomputeClaimConfidence(deps.db, claimId)
      if (!r) {
        // claim 不存在 / 无出处 → 无事可做（不计入 harvested，也不算异常）。
        continue
      }
      result.harvested += 1
      result.outcomes.push({
        claimId: r.claimId,
        usageCorrect: r.usageCorrect,
        confidence: r.confidence,
      })
    } catch (err) {
      // 单条重算失败（事务冲突 / DB 抖动）→ 跳过本条、维持其现状（不崩、不阻塞其它 claim）。下一轮重试。
      result.skipped += 1
      result.outcomes.push({
        claimId,
        usageCorrect: NaN,
        confidence: NaN,
        note: `recompute error: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return result
}

/**
 * 取本轮要重算的 claim id（有 usage_truth 事件的、去重）。限定 claimIds 或扫全部。
 * 只看 kind='usage_truth' 行——别的 kind（patrol/reembed_marker）不触发 f4 重算。
 */
async function selectUsageClaims(
  db: DB,
  opts: { claimIds?: string[]; maxClaims: number },
): Promise<string[]> {
  const cols = { claimId: schema.claimVerification.claimId }
  if (opts.claimIds && opts.claimIds.length > 0) {
    // 限定下推进 SQL：不能先 limit(maxClaims) 截断再内存过滤——>maxClaims 条 usage claim 时目标可能落在
    // 截断之外被静默漏算（且 selectDistinct 无序，命中靠运气）。inArray 在被投影列上无耦合问题。
    const rows = await db
      .selectDistinct(cols)
      .from(schema.claimVerification)
      .where(
        and(
          eq(schema.claimVerification.kind, 'usage_truth'),
          inArray(schema.claimVerification.claimId, opts.claimIds),
        ),
      )
    return rows.map((r) => r.claimId)
  }
  // cron: distinct usage-claims, most-recently-reported first (deterministic order; bounded — the tail is
  // picked up next round, not silently dropped by an unordered .limit). Mirrors the batch path's determinism.
  const rows = await db
    .select({ claimId: schema.claimVerification.claimId })
    .from(schema.claimVerification)
    .where(eq(schema.claimVerification.kind, 'usage_truth'))
    .groupBy(schema.claimVerification.claimId)
    .orderBy(desc(max(schema.claimVerification.createdAt)))
    .limit(opts.maxClaims)
  return rows.map((r) => r.claimId)
}

/**
 * Harvester 触发声明（A.7：report_usage batch + 每日）。choreography 无在线 meta-orchestrator：
 * 工种**声明**自己的触发，由外层调度器（事件总线 / cron）按此调 runHarvester。这里只声明，不内嵌定时器。
 *  - batchOn: 累积一批 report_usage 事件后触发（带这批 claimId 精准重算）。
 *  - cron: 每日定时，扫全部有 usage 的 claim（不带 claimIds）。
 */
export const HARVESTER_TRIGGER = {
  cron: 'daily',
  batchOn: 'report_usage' as const,
} as const

/**
 * 处理 report_usage-batch 事件：对刚收到回报的一批 claim 立即重算 f4。薄包装 runHarvester。
 *
 * EGR-CR-037 空 batch 守卫（根治点）：batch 入口语义是「我带了一批 id」。带了一批但批为空 = 没有任何 claim 要重算 = no-op。
 * 这里直接短路返回零结果，绝不调 runHarvester —— 否则空数组会被 runHarvester→selector 的 `length > 0` 误判成「未传 claimIds」
 * 而退化成 cron 全库扫描（对全库每条 usage_truth claim 重算 confidence）。runHarvester 的 `claimIds === undefined`（cron）路径不受影响。
 */
export async function harvestBatch(
  deps: HarvesterDeps,
  claimIds: string[],
  opts: Omit<HarvesterOptions, 'claimIds'> = {},
): Promise<HarvesterResult> {
  if (claimIds.length === 0) {
    return { byRole: opts.byRole ?? DEFAULT_BY_ROLE, harvested: 0, skipped: 0, outcomes: [] }
  }
  return runHarvester(deps, { ...opts, claimIds })
}
