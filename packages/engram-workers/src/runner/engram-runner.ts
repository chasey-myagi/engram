/**
 * P4b · EngramRunner —— 把内核 + 五工种 + 控制面 + 红蓝对抗北极星接成一个**真能跑起来**的自闭环。
 *
 * 这是 S24 choreography 的**生产化**：S24 证明了「按声明触发的确定性级联 + 无中心编排 + 无单点失效」，
 * 但那只活在测试 wireDispatcher 里。本 runner 把同一接线搬上生产路径，并补齐此前各 gate 反复点名的「内核能力
 * 齐了但没被任何运行进程调起来」的缺口（Harvester 不调 fitAndMaybeRecalibrate / 恒温器没人 tick / dispatcher 没接线）：
 *
 *   ┌─ 数据面（live KB）：ingest(source) → EventDispatcher 按各工种**声明的触发**级联到收敛
 *   │     source.ingested → Distiller(有界 loop) → batch_appended/claim.draft/conflict.detected
 *   │       → Reconciler / Verifier / Arbiter（确定性路由，单点失效被吞不掀翻级联）
 *   │   usage 上报 → report_usage → Harvester（纯统计，闭合「使用→升信」f4）
 *   ├─ 控制面（live KB）：governanceTick = 恒温器一拍(S26 runGovernanceCycle，fail-silent)；
 *   │                     recalibrateTick = 首次校准一拍(S28 fitAndMaybeRecalibrate，≥200 才换 g，否则诚实 below_threshold)
 *   └─ 对抗面（**sandbox**，非 live）：adversarialRound = 红蓝一回合(P4a runRedBlueRound)，
 *         红队造题 → A1 题免疫 → 蓝队=消费者答题 → 判分 → 单环归因 → 漏检 escalate 成更难下一代。
 *
 * **KB 安全**：对抗面带 per-item resetWorkTables（毒株隔离），会清工作表 —— 故它跑在**调用方给的 sandbox 边界**上，
 *   绝不与数据面/控制面共用 live 连接同跑一拍。runClosedLoop 只编排数据面+控制面（live 安全）；红蓝回合单独调。
 *
 * **零新行为 / 零 bespoke mock**：runner 是薄编排，只调已合并的真件（runDistiller/verifyEnqueued/reconcileBatch/
 *   arbitrateConflicts/harvestBatch/runGovernanceCycle/fitAndMaybeRecalibrate/runRedBlueRound）。deps 全注入：
 *   测试注 fake 端口（fake model/embedder/judge），生产注真 model/DashScope —— 同一 runner 两路都跑得起来。
 */
import { eq } from 'drizzle-orm'

import {
  fitAndMaybeRecalibrate,
  runGovernanceCycle,
  schema,
  type DB,
  type Embedder,
  type FitFromUsageOptions,
  type FitResult,
  type RunCycleOptions,
  type RunCycleResult,
} from '@engram/core'

import { arbitrateConflicts, ARBITER_TRIGGER, type ArbiterDeps } from '../arbiter.js'
import { harvestBatch, HARVESTER_TRIGGER, type HarvesterDeps } from '../harvester.js'
import { reconcileBatch, RECONCILER_TRIGGER, type ReconcilerDeps } from '../reconciler.js'
import { verifyEnqueued, VERIFIER_TRIGGER, type VerifierDeps } from '../verifier.js'
import { runDistiller, type DistillerDeps } from '../distiller.js'
import {
  DISTILLER_TRIGGER,
  EventDispatcher,
  routeKeys,
  type EngramEvent,
  type RunToConvergenceResult,
} from '../runtime/dispatcher.js'
import type { AgentRuntime } from '../runtime/port.js'
import {
  runRedBlueRound,
  type RedBlueRoundOptions,
  type RoundResult,
} from '../eval/red-blue-round.js'

/**
 * runner 依赖（全注入，prod-or-fake 同构）。各工种 deps 直接复用工种自己的 Deps 类型（不另造端口）。
 * db/embedder 同时供控制面(governance/recalibrate)与对抗面(red-blue = {db,embedder})。
 */
export interface EngramRunnerDeps {
  db: DB
  embedder: Embedder
  distiller: DistillerDeps
  verifier: VerifierDeps
  reconciler: ReconcilerDeps
  harvester: HarvesterDeps
  /** Arbiter 有界 loop 的运行时工厂（按待裁对生成脚本 / 连真 model）。 */
  arbiterRuntimeFor: (pairs: Array<[string, string]>) => AgentRuntime
}

/** runClosedLoop 的输入：本拍要摄入哪些源、上报哪批使用真值。 */
export interface ClosedLoopInput {
  /** 本拍摄入的 source id（各驱动一次 source.ingested 级联）。 */
  sources?: readonly string[]
  /** 本拍上报使用的 claim id（驱动一次 report_usage → Harvester）。 */
  usage?: readonly string[]
  /** 恒温器参数（默认接真 SPI reader）。 */
  governance?: RunCycleOptions
  /** 首次校准参数（默认从 identity 版本取样、≥200 门）。 */
  recalibrate?: FitFromUsageOptions
}

/** 一个完整 live 闭环 cycle 的审计报告（数据面级联 + 控制面两拍）。 */
export interface ClosedLoopReport {
  ingests: { sourceId: string; result: RunToConvergenceResult }[]
  /** usage 上报 → Harvester 级联（无 usage 则 null）。 */
  usageHarvest: { claimIds: readonly string[]; result: RunToConvergenceResult } | null
  governance: RunCycleResult
  recalibrate: FitResult
}

export class EngramRunner {
  private readonly deps: EngramRunnerDeps
  private readonly dispatcher: EventDispatcher

  constructor(deps: EngramRunnerDeps) {
    this.deps = deps
    this.dispatcher = this.wire()
  }

  /** 路由表投影（断言/审计：哪些工种接进了总线）。 */
  registeredWorkers(): string[] {
    return this.dispatcher.registeredWorkers()
  }

  /** 数据面：一次 source 摄入 → 级联到收敛（Distiller → Reconciler/Verifier/Arbiter）。 */
  ingest(sourceId: string, opts: { maxEvents?: number } = {}): Promise<RunToConvergenceResult> {
    return this.dispatcher.runToConvergence(
      { type: 'source.ingested', payload: { sourceId } },
      opts,
    )
  }

  /** 数据面：使用上报 → Harvester 纯统计（闭合「使用→升信」f4）。 */
  harvestUsage(
    claimIds: readonly string[],
    opts: { maxEvents?: number } = {},
  ): Promise<RunToConvergenceResult> {
    // EGR-CR-037 (纵深防御 B)：空 batch 不 publish 空 report_usage —— 否则它会被派进 Harvester handler，再退化成
    // cron 全库重算（A 在 handler 内兜底，但这里在源头就拦掉，trace 干净、零无意义派发）。
    if (claimIds.length === 0) {
      return Promise.resolve({
        dispatched: 0,
        failures: 0,
        firedByWorker: {},
        traces: [],
        truncated: false,
      })
    }
    return this.dispatcher.runToConvergence(
      { type: 'report_usage', payload: { claimIds: [...claimIds] } },
      opts,
    )
  }

  /** 控制面：恒温器一拍（S26，fail-silent —— 抛错只让本拍 no-op，不传染主干）。 */
  governanceTick(opts: RunCycleOptions = {}): Promise<RunCycleResult> {
    return runGovernanceCycle(this.deps.db, opts)
  }

  /**
   * 控制面：首次校准一拍（S28）。<200 样本 ⇒ 不拟合、g 维持 identity（诚实 below_threshold）；
   * ≥200 ⇒ fit isotonic → 6 项验收门 → 过则原子换 g、否则 HOLD。永不抛进主干。
   */
  recalibrateTick(opts: FitFromUsageOptions = {}): Promise<FitResult> {
    return fitAndMaybeRecalibrate(this.deps.db, opts)
  }

  /**
   * 对抗面（北极星）：跑**一回合**红蓝对抗（P4a）。**跑在 sandbox 上** —— opts.resetWorkTables 是毒株隔离边界，
   * 会清工作表，故绝不能与 live 数据面同连接同拍跑。返回结构化回合结果（判分/breach/单环归因/下一代）。
   */
  adversarialRound(opts: RedBlueRoundOptions): Promise<RoundResult> {
    return runRedBlueRound({ db: this.deps.db, embedder: this.deps.embedder }, opts)
  }

  /**
   * 跑一个完整 **live** 闭环 cycle：摄入诸源（级联到收敛）→ 使用上报（Harvester）→ 恒温器一拍 → 首次校准一拍。
   * 四面里的「consume→核验→写回→再校准」一拍走完（对抗面单独调，见 adversarialRound 的 sandbox 说明）。
   *
   * **前提（单拍 / source 一次性）**：每个 source 只摄入一次。Distiller 抽完后 claimsForSource 查该 source 经
   * provenance 关联的**全部** claim 当 batch_appended；同一 source 二次 ingest 会把旧 claim 重新塞回级联、重复触发
   * Reconciler/Verifier（行为正确但浪费）。多拍调度（去重/水位线）属更外层定时器的事，非本 runner 一拍的职责。
   *
   * **不 fail-silent**：runClosedLoop 自身是裸 await —— 控制面两拍的「失效静音」保护落在被调函数内部
   * （runGovernanceCycle 整轮 try/catch、fitAndMaybeRecalibrate 纯读+受控写）；数据面级联的单点失效落在
   * EventDispatcher（吞处理器抛错、计 failures、不掀翻级联）。本方法不另加 guard，依赖这两层既有契约。
   */
  async runClosedLoop(input: ClosedLoopInput = {}): Promise<ClosedLoopReport> {
    const ingests: ClosedLoopReport['ingests'] = []
    for (const sourceId of input.sources ?? []) {
      ingests.push({ sourceId, result: await this.ingest(sourceId) })
    }

    let usageHarvest: ClosedLoopReport['usageHarvest'] = null
    if (input.usage && input.usage.length > 0) {
      usageHarvest = { claimIds: input.usage, result: await this.harvestUsage(input.usage) }
    }

    // 控制面两拍（都 fail-silent / 不抛主干）：恒温器读五指标走一步，校准取样≥200 才换 g。
    const governance = await this.governanceTick(input.governance ?? {})
    const recalibrate = await this.recalibrateTick(input.recalibrate ?? {})

    return { ingests, usageHarvest, governance, recalibrate }
  }

  // ── 数据面接线（S24 wireDispatcher 的生产化；路由键全解自各工种导出的 TRIGGER 常量）─────────────────
  private wire(): EventDispatcher {
    const { db } = this.deps
    const dispatcher = new EventDispatcher()

    // Distiller（有界 loop）— 触发 source.ingested。抽完 → 查本源 claim + 活跃 contradicts 对 →
    // 发 batch_appended + claim.draft（喂 Reconciler/Verifier）+ conflict.detected（喂 Arbiter）。
    dispatcher.register({
      name: 'distiller',
      triggers: routeKeys(DISTILLER_TRIGGER),
      handle: async (event: EngramEvent): Promise<EngramEvent[]> => {
        if (event.type !== 'source.ingested') return []
        await runDistiller(this.deps.distiller, event.payload.sourceId)
        const claimIds = await this.claimsForSource(event.payload.sourceId)
        const pairs = await this.allContradictsPairs()
        const out: EngramEvent[] = []
        if (claimIds.length > 0) {
          out.push({ type: 'batch_appended', payload: { claimIds } })
          out.push({ type: 'claim.draft', payload: { claimIds } })
        }
        if (pairs.length > 0) out.push({ type: 'conflict.detected', payload: { pairs } })
        return out
      },
    })

    // Reconciler（函数 + 灰区一次 LLM）— 触发 batch_appended。
    dispatcher.register({
      name: 'reconciler',
      triggers: routeKeys(RECONCILER_TRIGGER),
      handle: async (event: EngramEvent): Promise<void> => {
        if (event.type !== 'batch_appended') return
        await reconcileBatch(this.deps.reconciler, event.payload.claimIds, {})
      },
    })

    // Verifier（函数/统计 + 点状一次 LLM）— 触发 claim.draft / claim.flagged。
    dispatcher.register({
      name: 'verifier',
      triggers: routeKeys(VERIFIER_TRIGGER),
      handle: async (event: EngramEvent): Promise<void> => {
        if (event.type !== 'claim.draft' && event.type !== 'claim.flagged') return
        await verifyEnqueued(this.deps.verifier, event.payload.claimIds, {})
      },
    })

    // Arbiter（有界 loop）— 触发 conflict.detected。每对用注入工厂建运行时（脚本/真 model）。
    dispatcher.register({
      name: 'arbiter',
      triggers: routeKeys(ARBITER_TRIGGER),
      handle: async (event: EngramEvent): Promise<void> => {
        if (event.type !== 'conflict.detected') return
        const pairs = event.payload.pairs
        const arbiterDeps: ArbiterDeps = { db, runtime: this.deps.arbiterRuntimeFor(pairs) }
        await arbitrateConflicts(arbiterDeps, pairs, {})
      },
    })

    // Harvester（纯统计、无 LLM、无 loop）— 触发 report_usage。
    dispatcher.register({
      name: 'harvester',
      triggers: routeKeys(HARVESTER_TRIGGER),
      handle: async (event: EngramEvent): Promise<void> => {
        if (event.type !== 'report_usage') return
        await harvestBatch(this.deps.harvester, event.payload.claimIds)
      },
    })

    return dispatcher
  }

  /** 取某 source 经 provenance 关联出的全部 claim id（Distiller 本轮产出的）。 */
  private async claimsForSource(sourceId: string): Promise<string[]> {
    const rows = await this.deps.db
      .selectDistinct({ claimId: schema.claimProvenance.claimId })
      .from(schema.claimProvenance)
      .where(eq(schema.claimProvenance.sourceId, sourceId))
    return rows.map((r) => r.claimId)
  }

  /**
   * 取**全库** contradicts 无序对（去重；不按状态过滤——故名 all 非 active）。Arbiter 据此把 conflict.detected
   * 路由到机判阶梯，**active↔active 的过滤由 Arbiter 内部负责**（draft/非活跃对它忠实跳过、不机判不升级）。
   *
   * TODO(吞吐, 多拍调度落地时)：每次 ingest 都全表重扫 relation 并重发所有 contradicts 对——大库下是 O(全部边)/拍。
   * Arbiter 的 selectPairs 已去重已裁对（幂等、不会错判），故现在只是浪费不是错。增量触发（watermark / Distiller
   * 直接回报本轮新写的 contradicts 边）属外层定时器/多拍调度的事，见 runClosedLoop 的「单拍 / source 一次性」前提。
   */
  private async allContradictsPairs(): Promise<Array<[string, string]>> {
    const edges = await this.deps.db
      .select({ from: schema.relation.fromClaim, to: schema.relation.toClaim })
      .from(schema.relation)
      .where(eq(schema.relation.type, 'contradicts'))
    const pairs: Array<[string, string]> = []
    const seen = new Set<string>()
    for (const e of edges) {
      if (e.to == null) continue
      const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push([e.from, e.to])
    }
    return pairs
  }
}
