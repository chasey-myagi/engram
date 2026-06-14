/**
 * 极简确定性事件总线（S24）—— choreography 的**数据面路由器**，不是在线 meta-orchestrator。
 *
 * 它做且只做一件事：把一个 `EngramEvent` 派给「**声明**了该事件类型为触发」的工种处理器，按注册序确定性执行。
 * 路由表完全由各工种**导出的 TRIGGER 常量**（VERIFIER_TRIGGER.enqueueOn / RECONCILER_TRIGGER.on /
 * HARVESTER_TRIGGER.batchOn / ARBITER_TRIGGER.event / Distiller 的 `source.ingested`）解出 —— 见 routeKeys()。
 * 没有任何模型/LLM/启发式参与「下一步该跑谁」：给定同一组已注册触发 + 同一串入队事件，路由是恒定的、可回归的。
 *
 * 工种处理器跑完可**返回后继事件**（如 Distiller 抽完一批 claim → 返回 `batch_appended` + `conflict.detected`），
 * 由总线压回队列继续派发，驱动级联到收敛（队列空）。队列有界（maxEvents 防环），不无限重试。
 *
 * 「无中心编排」的物理证明：本文件零 import 任何 model / runtime / AgentRuntime（连工种实现都不 import——
 * 只认 TRIGGER 常量 + 调用方注册的处理器）。它无从「决定该信谁/该跑谁」，只能按声明的触发把事件转出去。
 * 单点失效的物理证明：某工种处理器抛错被本总线吞掉（计入 failures、附原因，由 runner 层落 durable dead-letter
 * 审计，EGR-CR-039），**绝不**让一个工种的失败掀翻整条级联或污染读写主干——其余声明了同/后继事件的工种照常被派发。
 */

import { HARVESTER_TRIGGER } from '../harvester.js'
import { RECONCILER_TRIGGER } from '../reconciler.js'
import { VERIFIER_TRIGGER } from '../verifier.js'
import { ARBITER_TRIGGER } from '../arbiter.js'

/** Distiller 的触发（A.7：`source.ingested`）。Distiller 自身不导出 TRIGGER 常量，在此对齐声明一处常量。 */
export const DISTILLER_TRIGGER = {
  event: 'source.ingested',
} as const

/**
 * 编排里流转的事件。`type` 是路由键（与各工种 TRIGGER 声明的字符串对齐）；`payload` 携带本事件的载荷。
 * 这是一个**封闭的数据面词汇表**，不是模型可扩的指令集——新事件类型只能由代码显式加，绝非运行时由 LLM 造。
 */
export type EngramEvent =
  | { type: 'source.ingested'; payload: { sourceId: string } }
  | { type: 'batch_appended'; payload: { claimIds: string[] } }
  | { type: 'conflict.detected'; payload: { pairs: Array<[string, string]> } }
  | { type: 'report_usage'; payload: { claimIds: string[] } }
  // Verifier 的入队触发：draft / flagged claim 写入或被收紧。
  | { type: 'claim.draft'; payload: { claimIds: string[] } }
  | { type: 'claim.flagged'; payload: { claimIds: string[] } }

export type EngramEventType = EngramEvent['type']

/**
 * EGR-CR-037：「空 batch 是 no-op」的纵深防御。带 `claimIds: string[]` 的 batch 类事件
 * （report_usage / batch_appended / claim.draft / claim.flagged）若 `claimIds` 为空 = 没有任何 claim 要处理 = 应被当作
 * 不存在的事件 —— 既不派发给工种、也不计入 dispatched。否则空 batch 会被路由进工种 handler，再被 handler 内的工种入口
 * 守卫（harvestBatch([]) / verifyEnqueued([])）接住：能挡住但留了一次无意义派发、污染 trace。在总线源头短路掉，trace 干净。
 */
function isEmptyBatchEvent(event: EngramEvent): boolean {
  switch (event.type) {
    case 'report_usage':
    case 'batch_appended':
    case 'claim.draft':
    case 'claim.flagged':
      return event.payload.claimIds.length === 0
    default:
      return false
  }
}

/**
 * 工种处理器：吃一个本工种**声明触发**的事件，跑自己的活，可返回 0..n 个后继事件（驱动级联）。
 * 处理器内部自带 deps（db/judge/runtime/reader…），总线不关心——总线只管路由，不管工种怎么干活。
 */
export type WorkerHandler = (event: EngramEvent) => Promise<EngramEvent[] | void>

/** 一个已注册工种：名字（审计/断言用）+ 它声明触发的事件类型集 + 处理器。 */
export interface RegisteredWorker {
  /** 工种名（'distiller' | 'verifier' | …），用于审计/断言路由命中。 */
  name: string
  /** 本工种声明触发的事件类型（从其 TRIGGER 常量解出，见 routeKeys）。 */
  triggers: readonly EngramEventType[]
  handle: WorkerHandler
}

/**
 * 把一个工种导出的 TRIGGER 常量**翻译**成它声明触发的事件类型集（纯结构解析，零启发式）。
 * 这是「路由按声明的触发、而非模型」的核心：路由键直接读自工种自己导出的常量。
 *  - Distiller: `source.ingested`
 *  - Verifier:  enqueueOn ['draft','flagged'] → claim.draft / claim.flagged（cron 不进事件总线，由外层定时器单独调）
 *  - Reconciler: on 'batch_appended'
 *  - Arbiter:   event 'conflict.detected'（cron 同上）
 *  - Harvester: batchOn 'report_usage'（cron 同上）
 */
export function routeKeys(
  trigger:
    | typeof DISTILLER_TRIGGER
    | typeof VERIFIER_TRIGGER
    | typeof RECONCILER_TRIGGER
    | typeof ARBITER_TRIGGER
    | typeof HARVESTER_TRIGGER,
): EngramEventType[] {
  const keys: EngramEventType[] = []
  if ('event' in trigger) keys.push(trigger.event as EngramEventType)
  if ('on' in trigger) keys.push(trigger.on as EngramEventType)
  if ('batchOn' in trigger) keys.push(trigger.batchOn as EngramEventType)
  if ('enqueueOn' in trigger) {
    for (const s of trigger.enqueueOn) keys.push(`claim.${s}` as EngramEventType)
  }
  // 'cron' 不是事件总线的路由键——它是外层定时器的事，编排级联不靠 cron。
  return keys
}

/** 单个工种处理器一次被派发的留痕（可审计：谁因什么事件被触发、是否成功、抛了什么）。 */
export interface DispatchTrace {
  workerName: string
  eventType: EngramEventType
  ok: boolean
  /** 处理器抛错时的原因（被总线吞掉、不掀翻级联）。 */
  error?: string
  /** 本次处理器返回、被压回队列的后继事件类型。 */
  emitted: EngramEventType[]
}

export interface RunToConvergenceResult {
  /**
   * 总共派发了多少次（事件 × 命中的工种）。单位 = **一次 worker dispatch**（同一事件命中 N 个工种计 N 次）。
   * `maxEvents` 是对本计数的**硬上限**：`dispatched <= maxEvents` 恒成立（含「同事件多工种命中」时整批不越界）。
   */
  dispatched: number
  /** 因处理器抛错被吞掉的次数（单点失效的计数证明：>0 时级联仍跑完）。 */
  failures: number
  /** 每个工种被触发的次数（按工种名聚合，断言「谁被级联触达」用）。 */
  firedByWorker: Record<string, number>
  /** 全程逐次派发留痕（确定性顺序）。 */
  traces: DispatchTrace[]
  /**
   * 是否因 `maxEvents` 硬上限被截断（有界证明）。**当且仅当**因触上界提前停止时为 true——
   * 即截断点上当前事件剩余 worker、队列剩余事件都未派发；正常跑到队列空（含 `dispatched === maxEvents`
   * 但队列恰好已清空）时为 false。
   */
  truncated: boolean
}

/**
 * 极简确定性事件总线。注册工种（带它声明的触发），再 publish 一个种子事件，跑到队列空（或触上界）。
 * 无 LLM、无调度智能——纯按声明触发路由 + 把后继事件压回队列。线性单线程，确定性。
 */
export class EventDispatcher {
  private readonly workers: RegisteredWorker[] = []

  /** 注册一个工种（声明它触发的事件类型 + 处理器）。注册序 = 同一事件多工种命中时的派发序（确定性）。 */
  register(worker: RegisteredWorker): this {
    this.workers.push(worker)
    return this
  }

  /** 当前注册的工种名（断言路由表用）。 */
  registeredWorkers(): string[] {
    return this.workers.map((w) => w.name)
  }

  /** 解出某事件类型会命中哪些工种（纯按声明触发，不跑处理器）——「路由off声明触发」的可断言投影。 */
  resolve(eventType: EngramEventType): string[] {
    return this.workers.filter((w) => w.triggers.includes(eventType)).map((w) => w.name)
  }

  /**
   * 从一个种子事件跑到收敛（队列空）。BFS：取队首 → 派给所有声明了该事件的工种（注册序）→ 把它们返回的
   * 后继事件入队尾 → 直到队列空或派发次数触 maxEvents 上界（有界，防环/失控）。
   * 处理器抛错被吞（计 failures），级联不中断（单点失效证明）。
   *
   * `maxEvents` 的单位是 **worker dispatch 次数**（事件 × 命中工种，每个 worker 派发计 1），且为**硬上限**：
   * 上限检查与计数同在 per-worker 粒度、检查在自增之前——`result.dispatched <= maxEvents` 恒成立，
   * 「同事件多工种命中」也不会整批越界。触上界即停（硬，不派完当前事件剩余 worker），`truncated` 同步置 true。
   */
  async runToConvergence(
    seed: EngramEvent,
    opts: { maxEvents?: number } = {},
  ): Promise<RunToConvergenceResult> {
    const maxEvents = opts.maxEvents ?? 1000
    const queue: EngramEvent[] = [seed]
    const result: RunToConvergenceResult = {
      dispatched: 0,
      failures: 0,
      firedByWorker: {},
      traces: [],
      truncated: false,
    }

    while (queue.length > 0) {
      const event = queue.shift()!
      // EGR-CR-037：空 batch 事件（claimIds 为空）= no-op，源头丢弃，不派发任何工种、不计入 dispatched（trace 干净）。
      if (isEmptyBatchEvent(event)) continue
      const hits = this.workers.filter((w) => w.triggers.includes(event.type))
      for (const w of hits) {
        // 上限检查下沉到 per-worker 粒度，与计数单位（result.dispatched 每 worker 自增 1）对齐：
        // 触界即停（硬上限），当前事件剩余 worker 与队列剩余事件都不再派发，truncated 同步置 true。
        // 这是唯一计数+置位点（单一事实源），保证 dispatched <= maxEvents 恒成立。
        if (result.dispatched >= maxEvents) {
          result.truncated = true
          return result
        }
        result.dispatched += 1
        result.firedByWorker[w.name] = (result.firedByWorker[w.name] ?? 0) + 1
        try {
          const emitted = (await w.handle(event)) ?? []
          for (const e of emitted) queue.push(e)
          result.traces.push({
            workerName: w.name,
            eventType: event.type,
            ok: true,
            emitted: emitted.map((e) => e.type),
          })
        } catch (err) {
          // 单点失效：吞掉这个工种的失败，级联与读写主干都不受影响；其余工种照常被派发。
          result.failures += 1
          result.traces.push({
            workerName: w.name,
            eventType: event.type,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            emitted: [],
          })
        }
      }
    }
    return result
  }
}
