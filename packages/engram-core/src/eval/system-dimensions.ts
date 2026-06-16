/**
 * L3 系统维度（substrate-ready 七维，A.9 stories 44/47/52；设计稿 FIG 10/10a「八维」）——评测的度量脊柱（S30）。
 *
 * **评测=消费，零评测专用代码路径**：七维全经 Consumer SPI（recall_claims / usage_truth / S29 免疫子层）算出，
 * 与 prod 逐字节同构。维度落库走 append-only dimension_events（spi/dimension-events.ts），离线聚合**幂等**
 * （重跑同一 event log → 同维度值），raw 事件绝不可变。
 *
 * 七维（设计稿八维去掉两个**无生产者**的）：
 *   ①P@k / ①R@k —— recall_claims 对 golden Q→期望 claim 集打精确/召回率。
 *   ②grounding —— 每条召回 claim 钻回出处；**无出处的 claim 结构上不计入 grounded**（assert grounding 占比）。
 *   ★③ECE —— 取自 S5 computeReliability（over usage 真值），反映 S28 拟合的 g（不另起 ad-hoc 逻辑）。
 *   ④coverage —— golden 中库能在消费门上答出（≥1 召回）的占比。
 *   ⑤staleness —— 召回 claim 中越过其 kind 半衰期（staleDecay<0.5 ⇔ ageDays>halfLife）的占比。
 *   ★⑥immunity —— 取自 S29 redteam_immunity_scores 的检出率（**不重算**、不进任何计分；A3 边界同 S29）。
 *
 * ★⑧「纵向越用越好」**刻意不在本切片计算**（RELOCATED_TO_S31）：其生产者是 S31 的同卷复考（recompete），
 * 迁移到 S31 以避免「先落维度、后有生产者」。⑦「下游 A/B」无生产者切片、出 scope（无 producer slice）。
 *
 * **golden 隔离（防 KB 泄漏虚高）**：golden 是冻结夹具、**绝不**经写路径落成 claim，打分只读 recall_claims；
 * 故 recall（只读 claim 存储）结构上不可能召回 golden 本身——被测库必须靠**自养** claim 答题。
 */
import { computeCalibrationFromUsage, type ReliabilityReport } from '../calibration/calibration.js'
import type { DB } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import { getImmunityScores, isRedTeamClass } from '../spi/redteam-generation.js'
import { recallClaims, type RecallContext, type RecallResult } from '../spi/recall-claims.js'
import {
  DIMENSION,
  DIMENSION_NAMES,
  getDimensionEvents,
  isDimensionName,
  recordDimension,
  type DimensionEvent,
  type DimensionName,
} from '../spi/dimension-events.js'

/**
 * ★⑧纵向「越用越好」迁移说明（RELOCATED_TO_S31）：本切片**不计算**纵向维度。
 * 由来：纵向的生产者是 S31 的 frozen-golden 同卷复考（recompete，T0/T1/T2 重放求 ΔECE↓/Δcoverage↑/Δhallucination↓）。
 * 在该生产者存在前落「纵向」维度，等于先有度量后有产线——会落一个对不存在系统的幻觉数字（命门红线的精神）。
 * 故纵向显式迁到 S31；本切片只落七个**生产者已存在**的 substrate-ready 维度。⑦下游 A/B 同理（无生产者切片）出 scope。
 */
export const RELOCATED_TO_S31 = Object.freeze({
  dimension: 'longitudinal_better_with_use',
  reason:
    'producer is the S31 frozen-golden recompete; landing the metric before its producer would be a hallucinated number',
} as const)

/**
 * 一条**隔离 golden**：领域无关的事实型提问 + 其期望被召回的 claim 文本集（判 P/R@k 相关性的金标）。
 * 关键：golden **绝不**被写成 claim（与 L5 同款的「从不写入」隔离）；库要答对，必须靠它**自养**的 claim
 * 的 claimText 与 expectedClaimTexts 匹配——故 recall 结构上不可能召回 golden 本身（防 KB 泄漏虚高）。
 */
export interface SystemGoldenItem {
  readonly id: string
  readonly query: string
  /** 期望被召回命中的 claim 文本集（判相关性：召回 claim 的 claimText 含其一即算命中该期望）。 */
  readonly expectedClaimTexts: readonly string[]
}

/** 这批 L3 golden 夹具的命名空间标签（纯标注、不承重隔离；真正的隔离 = 它们从不被写成 claim ⇒ recall 永不召回）。 */
export const L3_GOLDEN_NAMESPACE = 'eval:l3-golden' as const

/**
 * 冻结的 L3 系统 golden 题集（领域无关）。每题给出期望命中的 claim 文本——被测库须靠自养 claim 答对。
 * 冻结（Object.freeze）防运行期被改：golden 一旦立即固定（同卷复考的锚）。
 *
 * **口径裁定（EGR-CR-016 / Part B-1）**：这是一个**行为 fixture（behavior fixture）**，**不是 A1 golden question**。
 * 它**不经过、也不要求** A1 晋升审计（`golden_questions` / `promotion_audit`），更不接 L5 的迁移/晋升投影
 * （`liveL5Questions` / `knowledge_grew_events`）。它的角色是「跨 release 同题、同维定义、可比」的纵向锚（S30/S31），
 * 不承担 A1「人确认 + append-only 授权」那套反 Goodhart 语义。`computeSystemDimensions` / `runRecompeteSnapshot`
 * 默认消费它是**有意的**：它们衡量的是系统维度（ECE/coverage）的纵向曲线，而非 A1 盲点诚实率。
 * 如将来需要让 L3 默认卷可追溯到 A1 audit，那是 Part B-2 的独立改动（DB-aware 默认卷），需另行裁决，不在本常量语义内。
 */
export const L3_GOLDEN: readonly SystemGoldenItem[] = Object.freeze(
  [
    {
      id: 'l3g-01',
      query: 'qx7731 connector rated voltage power input',
      expectedClaimTexts: ['connector qx7731 power input rated 48 volts'],
    },
    {
      id: 'l3g-02',
      query: 'zylo ledger cross-shard commit protocol',
      expectedClaimTexts: ['ledger zylo cross-shard commit uses two-phase'],
    },
    {
      id: 'l3g-03',
      query: 'kpex telemetry retention window raw frame',
      expectedClaimTexts: ['telemetry kpex raw frame retention seven days'],
    },
    {
      id: 'l3g-04',
      query: 'htqu actuator thermal cutoff temperature',
      expectedClaimTexts: ['actuator htqu thermal cutoff ninety celsius'],
    },
  ].map((g) => Object.freeze({ ...g, expectedClaimTexts: Object.freeze(g.expectedClaimTexts) })),
)

/**
 * L3 golden 默认召回相似度下界。golden 间共享通用词（"rated"/"thermal"/"commit"）会让交叉相似度抬到 ~0.18，
 * 而对角自相似 ≥0.55；取 0.4 既清掉交叉泄漏又稳过自命中。这是 consumer 侧的相似度门旋钮（不改任何内核语义、
 * 不碰安全不变量）。注意：相似度门**不是**内核强制下界（不像 confidenceFloor 有 Math.max 夹），recall 原样取
 * ctx.minSimilarity；本 eval 把它抬到 0.4 是**本评测自身**只调严的取数选择，并非内核保证调用方无法调低。调用方可经 ctx 覆盖。
 */
export const L3_GOLDEN_MIN_SIMILARITY = 0.4

/** 单题观测：召回结果 + 命中期望集 + 相关命中数（P/R 的中间量，可审计）。 */
export interface GoldenObservation {
  item: SystemGoldenItem
  /** 本次召回返回的全部结果（含每条出处，供 grounding/staleness 复用，不二次 recall）。 */
  recalled: RecallResult[]
  /** 召回结果中**相关**（命中某期望文本）的条数。 */
  relevantHits: number
  /** 被任一召回结果命中的**期望**数（去重）。 */
  expectedCovered: number
  /** 本题是否被库在消费门上答出（≥1 召回）——coverage 用。 */
  answered: boolean
}

/** 七维一次 run 的标量读数 + 各自诊断（value 全 ∈[0,1]）。 */
export interface SystemDimensions {
  precisionAtK: number
  recallAtK: number
  grounding: number
  /** ECE（来自 S5/S28 substrate；无 usage 样本时 0）。 */
  ece: number
  coverage: number
  /** 越过半衰期的召回 claim 占比（无召回时 0）。 */
  staleness: number
  /** 免疫检出率（来自 S29 substrate；无免疫分时 null = 未度量，区别于 0）。 */
  immunity: number | null
  /** 各维诊断（样本数 / k / 命中明细等），离线分析用，不进计分。 */
  diagnostics: {
    k: number
    goldenCount: number
    answeredCount: number
    recalledClaimCount: number
    groundedClaimCount: number
    staleClaimCount: number
    /** ECE 诊断：样本数 + bin 数 + **本次读数所用的 g 版本集合**（EGR-CR-029：让 sampleCount 重获解释力，混版不再静默）。 */
    ece: { sampleCount: number; binCount: number; fromVersions: string[] }
    immunity: { scoreRows: number; injected: number; detected: number } | null
  }
}

/** 大小写不敏感子串命中（确定性、领域无关；fake/真嵌入器无关）。 */
function textHits(claimText: string, expected: readonly string[]): boolean {
  const hay = claimText.toLowerCase()
  return expected.some((e) => hay.includes(e.toLowerCase()))
}

/**
 * 跑一道 golden 题：**只调 recall_claims**（真 SPI、零专用路径），算相关命中与期望覆盖。
 * relevantHits = 召回结果里命中某期望文本的条数；expectedCovered = 被任一召回命中的期望数（去重）。
 */
export async function runGoldenItem(
  db: DB,
  embedder: Embedder,
  item: SystemGoldenItem,
  k: number,
  ctx: RecallContext = {},
): Promise<GoldenObservation> {
  // k 经 ctx.limit 流进真 recall（评测=消费：@k 就是消费方的召回上限，不是评测旁路）。
  // minSimilarity 默认抬到 L3_GOLDEN_MIN_SIMILARITY（本评测调严以清交叉泄漏；只抬相似度门→只会减少召回，不会虚高任何维），ctx 显式给则用 ctx 的。
  const recalled = await recallClaims(db, embedder, item.query, {
    minSimilarity: L3_GOLDEN_MIN_SIMILARITY,
    ...ctx,
    limit: k,
  })
  let relevantHits = 0
  for (const r of recalled) {
    if (textHits(r.claim.claimText, item.expectedClaimTexts)) relevantHits += 1
  }
  let expectedCovered = 0
  for (const e of item.expectedClaimTexts) {
    if (recalled.some((r) => r.claim.claimText.toLowerCase().includes(e.toLowerCase()))) {
      expectedCovered += 1
    }
  }
  return { item, recalled, relevantHits, expectedCovered, answered: recalled.length > 0 }
}

export const DEFAULT_K = 5

export interface ComputeOptions {
  k?: number
  golden?: readonly SystemGoldenItem[]
  /** 免疫维度取自哪个冻结世代（S29）；不传则取全部世代的免疫分聚合。 */
  immunityGeneration?: string
  ctx?: RecallContext
  /**
   * ECE 取样的 g 版本集合（EGR-CR-029），透传给 computeCalibrationFromUsage。
   * 省略（默认）→ 底层取当前活动版本（表空 → identity），报表只反映「当前 g 下的校准质量」。
   */
  calibrationFromVersions?: string[]
}

/**
 * 计算七维（不落库）。全经 Consumer SPI：
 *   - P@k / R@k / grounding / coverage / staleness 经 recall_claims（每题召回一次，五维复用同一批结果，不重复 recall）；
 *   - ECE 经 computeCalibrationFromUsage（S5/S28 substrate，over usage 真值）；
 *   - immunity 经 getImmunityScores（S29 substrate，检出率，**不重算**）。
 *
 * 判据：
 *   - P@k = Σ相关命中 / Σ min(k, 召回数)（按返回结果数归一；无召回的题不进分母）。
 *   - R@k = Σ期望覆盖 / Σ期望集大小。
 *   - grounding = 带≥1出处的召回 claim 数 / 召回 claim 总数（recall 已 D1 兜底丢无出处；此处再 assert 占比）。
 *   - coverage = 被答出的题数 / golden 题数。
 *   - staleness = 越过半衰期的召回 claim 数 / 召回 claim 总数。
 *   - ece = computeCalibrationFromUsage().ece。
 *   - immunity = Σdetected / Σinjected（跨免疫分行；无行则 null）。
 */
export async function computeSystemDimensions(
  db: DB,
  embedder: Embedder,
  opts: ComputeOptions = {},
): Promise<SystemDimensions> {
  const k = opts.k ?? DEFAULT_K
  // 入口 fail-loud：k 必须是正整数。挡掉 0 / 负 / 0.5 / NaN / Infinity，在任何 recall / 计算 / 落库之前抛出，
  // 从根上消除「recall 对非正 limit 静默回退到 50 ↔ P@k 分母仍用原始 k」的脑裂，并保证 dimension_events 绝不半批写入。
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(
      `computeSystemDimensions: k must be a positive integer (got ${JSON.stringify(opts.k)})`,
    )
  }
  const golden = opts.golden ?? L3_GOLDEN
  const ctx = opts.ctx ?? {}

  // ── 召回一遍 golden（评测=消费），五维全从这批结果派生（不重复 recall）──
  const observations: GoldenObservation[] = []
  for (const item of golden) {
    observations.push(await runGoldenItem(db, embedder, item, k, ctx))
  }

  // P@k：分母 = Σ min(k, 实际返回数)（无召回的题不计入分母，避免拿白卷题压低精确率）。
  let relevantHitTotal = 0
  let retrievedTotal = 0
  // R@k：分母 = Σ 期望集大小。
  let expectedCoveredTotal = 0
  let expectedTotal = 0
  // grounding / staleness：扫所有召回结果的 claim。
  let recalledClaimCount = 0
  let groundedClaimCount = 0
  let staleClaimCount = 0
  let answeredCount = 0

  for (const o of observations) {
    relevantHitTotal += o.relevantHits
    retrievedTotal += Math.min(k, o.recalled.length)
    expectedCoveredTotal += o.expectedCovered
    expectedTotal += o.item.expectedClaimTexts.length
    if (o.answered) answeredCount += 1
    for (const r of o.recalled) {
      recalledClaimCount += 1
      // grounding：无出处的 claim **结构上不计入 grounded**（recall 已 D1 兜底丢它，这里 provenances.length 仍再 assert）。
      if (r.provenances.length >= 1) groundedClaimCount += 1
      // staleness：越过半衰期 ⇔ staleDecay<0.5。判的是召回快照里**透传的存档 staleDecay**（live-recompute 只实时重算
      // base/conflictDecay，staleDecay 取写入/上次重算时的存档值，非按当前时钟现算）。**偏差**：年龄随时间长、存档 decay 不变，
      // 故本维**结构上低估**当前真实陈旧度——它是「上次落库时的陈旧快照」而非「此刻新鲜度」。report-only（不进 g，A3 安全）。
      if (r.confidence.factors.staleDecay < 0.5) staleClaimCount += 1
    }
  }

  const precisionAtK = retrievedTotal === 0 ? 0 : relevantHitTotal / retrievedTotal
  const recallAtK = expectedTotal === 0 ? 0 : expectedCoveredTotal / expectedTotal
  const grounding = recalledClaimCount === 0 ? 1 : groundedClaimCount / recalledClaimCount
  const coverage = golden.length === 0 ? 0 : answeredCount / golden.length
  const staleness = recalledClaimCount === 0 ? 0 : staleClaimCount / recalledClaimCount

  // ★③ECE：S5/S28 substrate（over usage 真值），不另起 ad-hoc 逻辑。
  // EGR-CR-029：默认（省略 calibrationFromVersions）取当前活动 g 版本，换 g 后不再混版；调用方可显式放宽。
  const reliability: ReliabilityReport = await computeCalibrationFromUsage(
    db,
    opts.calibrationFromVersions !== undefined
      ? { fromVersions: opts.calibrationFromVersions }
      : {},
  )
  const ece = reliability.ece

  // ★⑥immunity：S29 substrate（检出率，不重算）。无免疫分行 → null（未度量，区别于检出率 0）。
  const scores = await getImmunityScores(db, opts.immunityGeneration)
  let injected = 0
  let detected = 0
  for (const s of scores) {
    // 纵深防御（兜底任何已落库的历史脏行）：四类是免疫维度的语义不变量，未知 class
    // 绝不静默累加进分子分母——fail-loud 暴露之，而非让看板「免疫力」口径被悄悄污染。
    if (!isRedTeamClass(s.redteamClass)) {
      throw new Error(
        `computeSystemDimensions: immunity row has unknown redteamClass ${JSON.stringify(s.redteamClass)}`,
      )
    }
    injected += s.injected
    detected += s.detected
  }
  const immunity = scores.length === 0 ? null : injected === 0 ? 0 : detected / injected

  return {
    precisionAtK,
    recallAtK,
    grounding,
    ece,
    coverage,
    staleness,
    immunity,
    diagnostics: {
      k,
      goldenCount: golden.length,
      answeredCount,
      recalledClaimCount,
      groundedClaimCount,
      staleClaimCount,
      ece: {
        sampleCount: reliability.sampleCount,
        binCount: reliability.binCount,
        fromVersions: reliability.fromVersions,
      },
      immunity: scores.length === 0 ? null : { scoreRows: scores.length, injected, detected },
    },
  }
}

export interface RunReport {
  runId: string
  dimensions: SystemDimensions
  /** 本 run 落库的维度事件（按维度，确定性顺序）。 */
  events: { dimension: DimensionName; value: number; eventId: string }[]
}

/**
 * 跑一次 run：计算七维 + **append-only 落库**（每维一行 dimension_events，确定性顺序）。
 * immunity 为 null（未度量）时**不落 immunity 行**（不拿 0 冒充「免疫力为零」——区别于真有分但检出率 0）。
 * 同一 runId 重跑会再落一批新行（append-only，不覆盖）——纵向是跨 run 的多批；本函数不做去重。
 */
export async function runSystemDimensions(
  db: DB,
  embedder: Embedder,
  runId: string,
  opts: ComputeOptions = {},
): Promise<RunReport> {
  const dimensions = await computeSystemDimensions(db, embedder, opts)
  const createdBy = `${L3_GOLDEN_NAMESPACE}:run`
  // 维度→标量的确定性列表（immunity 仅在已度量时入列）。
  const toRecord: { dimension: DimensionName; value: number; payload: Record<string, unknown> }[] =
    [
      {
        dimension: DIMENSION.precisionAtK,
        value: dimensions.precisionAtK,
        payload: { k: dimensions.diagnostics.k },
      },
      {
        dimension: DIMENSION.recallAtK,
        value: dimensions.recallAtK,
        payload: { k: dimensions.diagnostics.k },
      },
      {
        dimension: DIMENSION.grounding,
        value: dimensions.grounding,
        payload: {
          recalledClaimCount: dimensions.diagnostics.recalledClaimCount,
          groundedClaimCount: dimensions.diagnostics.groundedClaimCount,
        },
      },
      { dimension: DIMENSION.ece, value: dimensions.ece, payload: dimensions.diagnostics.ece },
      {
        dimension: DIMENSION.coverage,
        value: dimensions.coverage,
        payload: {
          goldenCount: dimensions.diagnostics.goldenCount,
          answeredCount: dimensions.diagnostics.answeredCount,
        },
      },
      {
        dimension: DIMENSION.staleness,
        value: dimensions.staleness,
        payload: {
          recalledClaimCount: dimensions.diagnostics.recalledClaimCount,
          staleClaimCount: dimensions.diagnostics.staleClaimCount,
        },
      },
    ]
  if (dimensions.immunity !== null) {
    toRecord.push({
      dimension: DIMENSION.immunity,
      value: dimensions.immunity,
      payload: dimensions.diagnostics.immunity ?? {},
    })
  }

  const events: RunReport['events'] = []
  for (const r of toRecord) {
    const { eventId } = await recordDimension(db, {
      runId,
      dimension: r.dimension,
      value: r.value,
      payload: r.payload,
      createdBy,
    })
    events.push({ dimension: r.dimension, value: r.value, eventId })
  }
  return { runId, dimensions, events }
}

/**
 * **幂等离线聚合**：从一批已落库的 dimension_events（**绝不重新 recall**）把每维**最新一次** run 的 value 聚出。
 * 给定同一 event log，输出确定性（同输入 → 同维度值）。这是「raw 事件不可变、聚合可重跑」的读侧证明点。
 * 取「最新」按 (createdAt, id) 升序的末元素（与 getDimensionEvents 同一确定性序）。
 */
export async function aggregateLatest(
  db: DB,
  filter: { runId?: string } = {},
): Promise<Partial<Record<DimensionName, number>>> {
  const events: DimensionEvent[] = await getDimensionEvents(
    db,
    filter.runId !== undefined ? { runId: filter.runId } : {},
  )
  const latest: Partial<Record<DimensionName, number>> = {}
  // events 已按 (createdAt,id) 升序；逐条覆盖 ⇒ 末值即该维最新。确定性：同 log 同序同结果。
  for (const e of events) {
    // 读侧 fail-loud：历史脏行或绕过写口的直接 DB 写一旦含非白名单维度，即报脊柱被污染（不再盲目强转）。
    if (!isDimensionName(e.dimension)) {
      throw new Error(
        `aggregateLatest: dimension_events contains non-whitelisted dimension ${JSON.stringify(e.dimension)} ` +
          `(eval spine corrupted; expected one of ${DIMENSION_NAMES.join(', ')})`,
      )
    }
    latest[e.dimension] = e.value
  }
  return latest
}
