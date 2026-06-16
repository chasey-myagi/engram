/**
 * M2 校准 pilot 的可测逻辑 —— 与端口(embedder)解耦:测试注 fake、run.ts 注真 DashScope。
 *
 * seedCorpus → generateUsage(真 recall + 标签 oracle 写 usage_truth) → collectFactSamples(读回真 usage 燃料,带 factId)
 * → measureFromSamples(**按 fact 切分** → fit isotonic g → 留出**事实**上比 identity vs g 的 ECE)。
 *
 * 泛化的单元是「事实」:每档很多事实凑出可测正确率,g 用该档**训练事实**学到的比率,去预测该档**留出(未见)事实**
 * ⇒ 真泛化(非查表)。切分按 fact 整组进 fit 或 heldout,故无一事实跨两边(factsInBothSides=0 钉死)。
 */
import { eq } from 'drizzle-orm'

import {
  addSource,
  agentActor,
  appendClaim,
  applyGMap,
  CALIBRATION_IDENTITY,
  collectUsageCalibrationSamples,
  computeReliability,
  fitIsotonic,
  recallClaims,
  reportUsage,
  schema,
  transitionClaim,
  type CalibrationMap,
  type CalibrationSample,
  type DB,
  type Embedder,
  type ProvenanceInput,
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

/**
 * seed 写入者身份(**诚实标注**,EGR-CR-041):eval 自己 seed 的接地语料,不冒用 `agent:distiller`
 * (后者是真 Distiller 工种的产物身份)。这条 claim 确实经 appendClaim+transitionClaim 真写路径产生,
 * 但它是 pilot 的受控 fixture,不是真 distiller 抽取的——身份如实写明,杜绝"伪造 distiller 产物"。
 */
export const SEED_CREATED_BY = 'agent:eval-seed'

/**
 * seed 经过的真写 SPI(EGR-CR-041:不再裸 db.insert)。默认接真 appendClaim/transitionClaim;
 * 测试可注入 spy 适配器,断言"seed 真走正式写半边 + 晋升门"(T1/T3)。
 */
export interface SeedSpi {
  appendClaim: typeof appendClaim
  transitionClaim: typeof transitionClaim
}

const DEFAULT_SEED_SPI: SeedSpi = { appendClaim, transitionClaim }

/**
 * seed 用足量高权威独立 exact 源,让 appendClaim 算出的 raw 过 PROMOTE_CONFIDENCE_FLOOR(0.5)、能真晋升。
 * 沿用 red-blue-round.test.ts 已验证可用的范式(4 条 authority=1.0 独立 exact 源 ⇒ base≥0.5)。
 * **每条 content 须字节级不同**(EGR-CR-012:内核据 content 自算 hash,同 content 折成 1 源 ⇒ indepSupport 退化)。
 */
const SEED_SOURCE_COUNT = 4

/**
 * **显式、命名诚实的 test-only 成熟度构造**(EGR-CR-041 方案 1b)。
 *
 * 背景张力(见 corpus.ts):新鲜单源 claim 经 appendClaim 算出的 raw 天然又窄又低(~0.5 封顶),无法复现
 * reliability diagram 需要的 0.5–0.88 rawTarget **跨度**——真实跨度来自 claim 成熟度(累积核验/使用/人审)。
 *
 * 本 helper 在 claim **已真正经过** D1 + appendClaim 事务 + transitionClaim 晋升门**之后**,把它的
 * confidenceFactors/confidenceRaw 覆写到目标 rawTarget,模拟"不同成熟度 claim 的横截面"。诚实点:
 *   - 这是一个**独立、可见、命名为 synthetic** 的 fixture 步骤,而非藏在 seedCorpus 里裸写 active;
 *   - claim 的真实性(过晋升门、有事务保护的出处、非冒充 distiller)已在覆写**之前**成立;
 *   - 覆写只动校准半边要测的 raw 跨度,不碰状态/出处/身份。
 *
 * recall 召回时按存档 confidenceFactors **现算** raw(rawFromStoredFactors,见 recall-claims.ts),故把 5 因子
 * 全设到 v ⇒ base=Σwᵢ·v=v、staleDecay=conflictDecay=1 ⇒ recall 重算 raw≈v=rawTarget。
 */
export async function applySyntheticMaturity(
  db: DB,
  claimId: string,
  rawTarget: number,
): Promise<void> {
  const v = rawTarget
  await db
    .update(schema.claim)
    .set({
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
    })
    .where(eq(schema.claim.id, claimId))
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
 * seed 一条 **active、可召回** 的 claim —— **真走正式写半边 + 晋升门**(EGR-CR-041 根治):
 *   1. addSource ×N(足量高权威独立 exact 源)+ appendClaim ⇒ 经 D1 硬门 + **单事务**写 claim+出处
 *      (子问题 B:provenance 失败整事务回滚,绝不留 active orphan);算出连续 confidence(命门写半边)。
 *   2. transitionClaim → active(蓝边晋升门:conf≥0.5 ∧ entailmentPass)⇒ 证明**晋升门**真被走过,非裸写 active。
 *   3. applySyntheticMaturity(claimId, rawTarget):**显式、命名诚实**的 test-only 成熟度覆写,把 5 因子抬到
 *      rawTarget,模拟成熟度横截面(见该 helper 与 corpus.ts:真实 raw 跨度来自累积核验/使用/人审)。
 *
 * createdBy 用诚实身份 SEED_CREATED_BY('agent:eval-seed'),不冒用 distiller。
 * recall 现算 raw≈rawTarget(asOf=now ⇒ staleDecay≈1;subject 唯一 ⇒ 无矛盾、conflictDecay=1)。
 */
export async function seedCorpus(
  db: DB,
  embedder: Embedder,
  facts: CorpusFact[],
  spi: SeedSpi = DEFAULT_SEED_SPI,
): Promise<SeedStats> {
  const claimIdByFact = new Map<string, string>()
  const rawSorted: number[] = []
  const now = new Date()
  for (const f of facts) {
    const v = f.rawTarget
    // N 条独立高权威 exact 源 ⇒ appendClaim 算出的 raw 过 0.5 晋升门(content 字节级不同,避免 hash 折叠)。
    const provenances: ProvenanceInput[] = []
    for (let i = 0; i < SEED_SOURCE_COUNT; i++) {
      const src = await addSource(db, {
        content: `source ${i} attesting: ${f.statement} [${f.id}]`,
        kind: 'formal_document',
        authorityScore: 1.0,
      })
      provenances.push({ sourceId: src.sourceId, locator: `cal:${f.id}:${i}`, relevance: 'exact' })
    }
    // 真写半边:appendClaim 单事务(D1 + confidence)写 draft;transitionClaim 过晋升门翻 active。
    const { claimId } = await spi.appendClaim(
      db,
      embedder,
      {
        claimText: f.statement,
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        asOf: now,
        createdBy: SEED_CREATED_BY,
      },
      provenances,
    )
    await spi.transitionClaim(db, claimId, 'active', {
      actor: agentActor(SEED_CREATED_BY),
      entailmentPass: true,
    })
    // 显式命名的成熟度构造(覆写发生在过门之后,不冒充真实成熟度计算)。
    await applySyntheticMaturity(db, claimId, v)
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
  opts: { binCount?: number; heldoutEvery?: number; spi?: SeedSpi } = {},
): Promise<{
  seed: SeedStats
  usage: UsageStats
  measurement: CalibrationMeasurement
  /** 真 usage_truth 持久行数(经 SPI 读回的独立样本数;= measurement.totalSamples 时证明读回口径一致)。 */
  persistedSamples: number
}> {
  const facts = buildCorpus()
  const seed = await seedCorpus(db, embedder, facts, opts.spi ?? DEFAULT_SEED_SPI)
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
