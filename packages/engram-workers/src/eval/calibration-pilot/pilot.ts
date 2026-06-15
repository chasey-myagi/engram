/**
 * M2 校准 pilot 的可测逻辑 —— 与端口(embedder)解耦:测试注 fake、run.ts 注真 DashScope。
 *
 * seedCorpus → generateUsage(真 recall + 标签 oracle 写 usage_truth) → collectFactSamples(读回真 usage 燃料,带 factId)
 * → measureFromSamples(**按 fact 切分** → fit isotonic g → 留出**事实**上比 identity vs g 的 ECE)。
 *
 * 泛化的单元是「事实」:每档很多事实凑出可测正确率,g 用该档**训练事实**学到的比率,去预测该档**留出(未见)事实**
 * ⇒ 真泛化(非查表)。切分按 fact 整组进 fit 或 heldout,故无一事实跨两边(factsInBothSides=0 钉死)。
 */
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import {
  addSource,
  applyGMap,
  CALIBRATION_IDENTITY,
  collectUsageCalibrationSamples,
  computeReliability,
  fitIsotonic,
  recallClaims,
  reportUsage,
  schema,
  type CalibrationMap,
  type CalibrationSample,
  type DB,
  type Embedder,
  type ReliabilityReport,
} from '@engram/core'

import { buildCorpus, type CorpusFact } from './corpus.js'

/** 因子权重:此处**仅需 Σw=1**(5 因子都设到 rawTarget ⇒ base=Σwᵢ·rawTarget=rawTarget,与具体权重分配无关;非"对齐内核默认")。 */
const WEIGHTS = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}

/** 一条带事实归属的校准样本(从真 usage_truth 读回 + factId,用于按 fact 切分)。 */
export interface FactSample {
  factId: string
  rawPredicted: number
  correct: boolean
}

export interface SeedStats {
  total: number
  promoted: number
  claimIdByFact: Map<string, string>
  /** 已 seed claim 的 rawTarget 分布(排序),人读 sanity-check raw 跨度。 */
  rawSorted: number[]
}

/**
 * 直接 seed 一条 **active、可召回、带 1 条 exact 出处(满足 D1)** 的 claim,5 因子全设到 fact.rawTarget
 * ⇒ recall 现算 raw≈rawTarget(asOf=now ⇒ staleDecay≈1;subject 唯一 ⇒ 无矛盾、conflictDecay=1)。
 * **模拟该 claim 的成熟度横截面**(见 corpus.ts:真实 raw 跨度来自累积核验/使用/人审,非新鲜出处)。
 */
export async function seedCorpus(
  db: DB,
  embedder: Embedder,
  facts: CorpusFact[],
): Promise<SeedStats> {
  const claimIdByFact = new Map<string, string>()
  const rawSorted: number[] = []
  const now = new Date()
  for (const f of facts) {
    const v = f.rawTarget
    const src = await addSource(db, {
      content: `source attesting: ${f.statement}`,
      contentHash: randomUUID(),
      kind: 'formal_document',
      authorityScore: v,
    })
    const claimId = randomUUID()
    await db.insert(schema.claim).values({
      id: claimId,
      claimText: f.statement,
      subject: f.subject,
      predicate: f.predicate,
      object: f.object,
      status: 'active',
      confidence: v,
      confidenceRaw: v,
      confidenceFactors: {
        factors: {
          authority: v,
          humanReview: v,
          entailment: v,
          indepSupport: v,
          usageCorrect: v,
          ageDays: 0,
          activeContradicts: 0,
          staleDecay: 1,
          conflictDecay: 1,
        },
        weights: WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      lineageId: randomUUID(),
      asOf: now,
      createdBy: 'agent:distiller',
      embedding: await embedder.embed(f.statement, 'document'),
      embeddingVersion: embedder.version,
    })
    await db.insert(schema.claimProvenance).values({
      id: randomUUID(),
      claimId,
      sourceId: src.sourceId,
      locator: `cal:${f.id}`,
      relevance: 'exact',
    })
    claimIdByFact.set(f.id, claimId)
    rawSorted.push(v)
  }
  rawSorted.sort((a, b) => a - b)
  return { total: facts.length, promoted: claimIdByFact.size, claimIdByFact, rawSorted }
}

export interface UsageStats {
  recallHits: number
  recallMisses: number
  usageRows: number
}

/**
 * 生成 usage_truth:逐 fact 用 query 真 recall;命中本 fact 的 claim ⇒ **一条**使用上报
 * (predictedConfidence=召回快照 value;outcome 由**标签 oracle** 定:fact.isTrue→adopted 否则 refuted)。
 * 每 fact 一条(claim 真值固定 ⇒ 多消费者同结局、对校准无新信息,故不重复)——一 fact = 一校准数据点。
 */
export async function generateUsage(
  db: DB,
  embedder: Embedder,
  facts: CorpusFact[],
  claimIdByFact: Map<string, string>,
): Promise<UsageStats> {
  let recallHits = 0
  let recallMisses = 0
  let usageRows = 0
  for (const f of facts) {
    const claimId = claimIdByFact.get(f.id)
    if (!claimId) continue
    const hits = await recallClaims(db, embedder, f.query)
    const mine = hits.find((h) => h.claim.id === claimId)
    if (!mine) {
      recallMisses += 1
      continue
    }
    recallHits += 1
    await reportUsage(db, claimId, f.isTrue ? 'adopted' : 'refuted', {
      taskId: f.id,
      byRole: 'agent:eval-consumer',
      confidenceAtRecall: mine.confidence.value, // identity g 下 = raw 快照
    })
    usageRows += 1
  }
  return { recallHits, recallMisses, usageRows }
}

/** 从真 usage_truth 读回校准燃料,带 factId(taskId):评测=消费,只读 outcome+predictedConfidence(A3:无胜负率通道)。 */
export async function collectFactSamples(db: DB): Promise<FactSample[]> {
  const rows = await db
    .select({ verdict: schema.claimVerification.verdict })
    .from(schema.claimVerification)
    .where(eq(schema.claimVerification.kind, 'usage_truth'))
  const out: FactSample[] = []
  for (const r of rows) {
    const v = r.verdict as { outcome?: unknown; taskId?: unknown; predictedConfidence?: unknown }
    if (typeof v.predictedConfidence !== 'number' || Number.isNaN(v.predictedConfidence)) continue
    if (v.outcome !== 'adopted' && v.outcome !== 'refuted') continue
    out.push({
      factId: typeof v.taskId === 'string' ? v.taskId : '',
      rawPredicted: v.predictedConfidence,
      correct: v.outcome === 'adopted',
    })
  }
  return out
}

export interface CalibrationMeasurement {
  totalSamples: number
  fitCount: number
  heldoutCount: number
  fittedG: CalibrationMap
  /** 留出**事实**上,把存档 raw 当预测(identity g)算的可靠性。 */
  identity: ReliabilityReport
  /** 留出**事实**上,把 g(raw) 当预测算的可靠性。 */
  calibrated: ReliabilityReport
  /** ECE 改善 = identity.ece - calibrated.ece(>0 ⇒ g 把校准误差压下了)。 */
  eceDrop: number
  /**
   * **结构性 sanity**:同一 factId 跨 fit/heldout 的事实数。本语料一 fact 一 usage ⇒ 一 factId 一样本 ⇒ 恒为 0
   * (不是硬泛化证据,只防"按样本切把同一 fact 拆两边"那类回归)。**真泛化的实证**是 calibrated.ece<identity.ece:
   * fit/heldout 共享置信档但**事实不同**,g 用某档训练事实学到的正确率去预测该档**未见**事实仍压低 ECE。
   */
  factsInBothSides: number
}

/**
 * **按 factId 切分**(整事实进 fit 或 heldout)。fit/heldout **共享置信档**(同档不同事实)——这正是校准泛化的方式:
 * 用某档训练事实学到的正确率,去预测该档**未见**事实。绝不让同一事实跨两边(factsInBothSides 钉死 =0)。
 */
export function splitByFact(
  samples: FactSample[],
  heldoutEvery = 3,
): { fit: FactSample[]; heldout: FactSample[] } {
  const factIds = [...new Set(samples.map((s) => s.factId))].sort()
  const heldoutFacts = new Set(factIds.filter((_id, i) => i % heldoutEvery === 0))
  const fit: FactSample[] = []
  const heldout: FactSample[] = []
  for (const s of samples) (heldoutFacts.has(s.factId) ? heldout : fit).push(s)
  return { fit, heldout }
}

function toCalSamples(samples: FactSample[], g?: CalibrationMap): CalibrationSample[] {
  return samples.map((s) => ({
    predicted: g ? applyGMap(s.rawPredicted, g) : s.rawPredicted,
    correct: s.correct,
  }))
}

/** 纯函数:按 fact 切分 → fit isotonic g → 留出事实上比 identity vs g 的 ECE(+ 无泄漏自检)。无 DB,供负对照直测。 */
export function measureFromSamples(
  samples: FactSample[],
  opts: { binCount?: number; heldoutEvery?: number } = {},
): CalibrationMeasurement {
  const { fit, heldout } = splitByFact(samples, opts.heldoutEvery ?? 3)
  const fittedG = fitIsotonic(
    fit.map((s) => ({ rawPredicted: s.rawPredicted, correct: s.correct })),
    `cal-pilot-${fit.length}`,
  )
  const identity = computeReliability(toCalSamples(heldout), opts.binCount ?? 10)
  const calibrated = computeReliability(toCalSamples(heldout, fittedG), opts.binCount ?? 10)
  const fitFacts = new Set(fit.map((s) => s.factId))
  const factsInBothSides = new Set(
    heldout.filter((s) => fitFacts.has(s.factId)).map((s) => s.factId),
  ).size
  return {
    totalSamples: samples.length,
    fitCount: fit.length,
    heldoutCount: heldout.length,
    fittedG,
    identity,
    calibrated,
    eceDrop: identity.ece - calibrated.ece,
    factsInBothSides,
  }
}

/**
 * pilot 通过门的最低阈值(起步基线;与生产 acceptance-gate 解耦,仅约束本受控实验的"闭环成立"判据)。
 * 受控语料 ~100 事实、5 档、heldoutEvery=3 ⇒ heldout 约占 1/3,正常应远超下限。
 */
export const PILOT_MIN_SAMPLES = 30
export const PILOT_MIN_HELDOUT = 5
export const PILOT_MIN_ECE_DROP = 0

export interface PilotGateResult {
  passed: boolean
  /** 人类可读的未过项(每项一句,便于 CLI 打印 + 测试断言)。 */
  failures: string[]
}

/**
 * pilot 通过判据(单一真相源,A.6 防 Goodhart)——纯函数、零 DB/IO,逐项检查并收集 failures。
 * 守 #117 真正要防的退化:recall 全漏 / 样本不足 / heldout 空 / 无可校误差 / g 未改善 / 事实跨边泄漏。
 *
 * **刻意不**断言「promoted==usageRows==totalSamples==persisted 四者恒等」——
 * collectFactSamples(产 totalSamples)按原始行读回、不按身份去重,而 collectUsageCalibrationSamples(产 persisted)
 * 按 (byRole,taskId) 去重(EGR-CR-030 后还会被 corrected/partial 折叠覆盖)。两条口径不同 ⇒ 在健康数据上本就可能不相等,
 * 钉死等式会在正常闭环上误伤。覆盖完整性由「recall 全命中 + usageRows 无缺口」(见 runCalibrationPilot 内的硬门)单独守。
 */
export function checkCalibrationPilotPass(
  usage: UsageStats,
  m: CalibrationMeasurement,
): PilotGateResult {
  const failures: string[] = []
  if (usage.recallHits <= 0) {
    failures.push(`recall 全漏(recallHits=${usage.recallHits}):无 usage 燃料,闭环不成立。`)
  }
  if (m.totalSamples < PILOT_MIN_SAMPLES) {
    failures.push(`样本不足:totalSamples=${m.totalSamples} < ${PILOT_MIN_SAMPLES}。`)
  }
  if (m.heldoutCount < PILOT_MIN_HELDOUT) {
    failures.push(`heldout 空/过小:heldoutCount=${m.heldoutCount} < ${PILOT_MIN_HELDOUT}。`)
  }
  if (m.factsInBothSides !== 0) {
    failures.push(`事实跨 fit/heldout 泄漏:factsInBothSides=${m.factsInBothSides}(须 0)。`)
  }
  if (!(m.identity.ece > 0)) {
    failures.push(`语料无可校误差:identity.ece=${m.identity.ece}(须 > 0),无东西可校、闭环无意义。`)
  }
  if (!(m.eceDrop > PILOT_MIN_ECE_DROP)) {
    failures.push(
      `g 未改善 ECE:eceDrop=${m.eceDrop}(须 > ${PILOT_MIN_ECE_DROP});identity ${m.identity.ece} → g ${m.calibrated.ece}。`,
    )
  }
  return { passed: failures.length === 0, failures }
}

/** fail-loud 包装:不过即 throw(CLI 入口用,确保非零退出)。 */
export function assertCalibrationPilotPass(usage: UsageStats, m: CalibrationMeasurement): void {
  const r = checkCalibrationPilotPass(usage, m)
  if (!r.passed) {
    throw new Error(`[m2] 校准 pilot 未通过:\n  - ${r.failures.join('\n  - ')}`)
  }
}

/** 读回真 usage 燃料 → measureFromSamples(按 fact 切分,真·样本外事实)。 */
export async function fitAndMeasure(
  db: DB,
  opts: { binCount?: number; heldoutEvery?: number } = {},
): Promise<CalibrationMeasurement> {
  const samples = await collectFactSamples(db)
  return measureFromSamples(samples, opts)
}

/** 把一份 reliability 报告画成 ASCII reliability diagram(每非空 bin 一行:预测均值 vs 观测正确率)。 */
export function renderReliability(r: ReliabilityReport): string {
  const lines = [`  bins(非空) | predicted → observed | n`]
  for (const b of r.bins) {
    if (b.count === 0) continue
    const bar = '█'.repeat(Math.round(b.observed * 20))
    lines.push(
      `  [${b.lo.toFixed(1)},${b.hi.toFixed(1)}) | ${b.meanPredicted.toFixed(3)} → ${b.observed.toFixed(3)} | n=${b.count}  ${bar}`,
    )
  }
  lines.push(`  ECE=${r.ece.toFixed(4)}  N=${r.sampleCount}`)
  return lines.join('\n')
}

/** 端到端跑一次 pilot(seed→usage→读回→按 fact 切分→fit→measure)。供 run.ts(真端口)与测试(fake 端口)复用。 */
export async function runCalibrationPilot(
  db: DB,
  embedder: Embedder,
  opts: { binCount?: number; heldoutEvery?: number } = {},
): Promise<{
  seed: SeedStats
  usage: UsageStats
  measurement: CalibrationMeasurement
  /** 真 usage_truth 持久行数(经 SPI 读回的独立样本数;= measurement.totalSamples 时证明读回口径一致)。 */
  persistedSamples: number
}> {
  const facts = buildCorpus()
  const seed = await seedCorpus(db, embedder, facts)
  const usage = await generateUsage(db, embedder, facts, seed.claimIdByFact)

  // fail-loud 硬门:真回路必须覆盖全部 promoted facts,否则是在幸存子集上证明闭环。
  // recall miss ⇒ 该 fact 不进 usage_truth、不进测量集,g 只在剩下的命中子集上拟合并"证明" ECE 下降 ⇒ 结论失真。
  if (usage.recallMisses !== 0) {
    throw new Error(
      `[calibration-pilot] recall 未覆盖全部 promoted facts:` +
        `命中 ${usage.recallHits} / 漏 ${usage.recallMisses}(promoted ${seed.promoted})。` +
        `recall miss ⇒ 只能在幸存样本上拟合 g,pilot 闭环结论失真。`,
    )
  }
  if (usage.usageRows !== usage.recallHits) {
    throw new Error(
      `[calibration-pilot] usage 行数 ${usage.usageRows} ≠ recall 命中 ${usage.recallHits}:reportUsage 写入有缺口。`,
    )
  }

  const measurement = await fitAndMeasure(db, opts)
  // round-trip sanity:核准 collectUsageCalibrationSamples(生产校准取样口径,按身份去重)读回。
  const persisted = await collectUsageCalibrationSamples(db, [CALIBRATION_IDENTITY])

  // 覆盖一致性:本 pilot 每 fact 一条 usage、每条 (byRole,taskId) 唯一 ⇒ 生产取样器去重后应仍等于 usageRows。
  // 这条 tie 的是「丢弃之前」的覆盖完整性(无 miss、无写入缺口),与上面 recall 硬门互补。
  // **不**再断言 totalSamples(collectFactSamples 原始行读回、不去重)等于 persisted——两者口径不同,
  // EGR-CR-030 后最新 corrected/partial 会让 persisted 折叠缩水,钉死等式在健康数据上会误伤(见 checkCalibrationPilotPass 注释)。
  if (persisted.length !== usage.usageRows) {
    throw new Error(
      `[calibration-pilot] 生产取样器读回 ${persisted.length} ≠ usage 行 ${usage.usageRows}:` +
        `身份门控样本数与写入不一致(promoted ${seed.promoted})。`,
    )
  }

  // 诊断门(fail-loud):样本不足 / heldout 空 / 无可校误差 / g 未改善 / 事实跨边 ⇒ 整条 throw,绝不伪装"跑通"。
  assertCalibrationPilotPass(usage, measurement)

  return { seed, usage, measurement, persistedSamples: persisted.length }
}
