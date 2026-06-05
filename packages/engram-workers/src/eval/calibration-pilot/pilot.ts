/**
 * M2 校准 pilot 的可测逻辑 —— 与端口(embedder)解耦:测试注 fake、run.ts 注真 DashScope。
 *
 * seedCorpus → generateUsage(真 recall + 标签 oracle) → collectAndSplit → fitAndMeasure。
 * 头条产物:留出集上 **ECE(identity) vs ECE(g)** + reliability diagram。证明校准闭环在真嵌入+真 usage 上闭合、g 把 ECE 压下。
 */
import { randomUUID } from 'node:crypto'

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
  type GoldenSample,
  type ReliabilityReport,
} from '@engram/core'

import { buildCorpus, type CorpusFact } from './corpus.js'

/** 因子权重(Σ=1):5 因子都设到 rawTarget ⇒ base=Σwᵢ·rawTarget=rawTarget(与内核默认权重对齐)。 */
const WEIGHTS = {
  authority: 0.3,
  humanReview: 0.3,
  entailment: 0.15,
  indepSupport: 0.15,
  usageCorrect: 0.1,
}

export interface SeedStats {
  total: number
  promoted: number
  /** 各 fact 的 claimId(仅已晋升 active 的)。 */
  claimIdByFact: Map<string, string>
  /** 已晋升 claim 的 raw 分布(排序),用于人读 sanity-check raw 是否落在消费门以上、有区分度。 */
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
    // 1 条 exact 出处(D1 强制:无出处的 claim 物理写不进)。
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
    await db
      .insert(schema.claimProvenance)
      .values({
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
 * 生成 usage_truth:逐 fact 用 query 真 recall;命中本 fact 的 claim ⇒ C 个独立消费者各报一次使用
 * (predictedConfidence = 召回快照 value;outcome 由**标签 oracle** 决定:fact.isTrue→adopted 否则 refuted)。
 */
export async function generateUsage(
  db: DB,
  embedder: Embedder,
  facts: CorpusFact[],
  claimIdByFact: Map<string, string>,
  opts: { consumers?: number } = {},
): Promise<UsageStats> {
  const consumers = opts.consumers ?? 6
  let recallHits = 0
  let recallMisses = 0
  let usageRows = 0
  for (const f of facts) {
    const claimId = claimIdByFact.get(f.id)
    if (!claimId) continue // 未晋升 → 不可召回
    const hits = await recallClaims(db, embedder, f.query)
    const mine = hits.find((h) => h.claim.id === claimId)
    if (!mine) {
      recallMisses += 1
      continue
    }
    recallHits += 1
    const predicted = mine.confidence.value // identity g 下 = raw 快照
    for (let c = 0; c < consumers; c++) {
      await reportUsage(db, claimId, f.isTrue ? 'adopted' : 'refuted', {
        taskId: f.id,
        byRole: `agent:eval-consumer-${c}`,
        confidenceAtRecall: predicted,
      })
      usageRows += 1
    }
  }
  return { recallHits, recallMisses, usageRows }
}

export interface CalibrationMeasurement {
  totalSamples: number
  fitCount: number
  heldoutCount: number
  fittedG: CalibrationMap
  /** 留出集上,把存档 raw 当预测(identity g)算的可靠性。 */
  identity: ReliabilityReport
  /** 留出集上,把 g(raw) 当预测算的可靠性。 */
  calibrated: ReliabilityReport
  /** ECE 改善 = identity.ece - calibrated.ece(>0 ⇒ g 把校准误差压下了)。 */
  eceDrop: number
}

/** 确定性切分(按 rawPredicted 排序后交错),保证 fit/heldout 两侧的 raw 覆盖相近。 */
export function splitSamples(
  samples: GoldenSample[],
  heldoutEvery = 3,
): { fit: GoldenSample[]; heldout: GoldenSample[] } {
  const sorted = [...samples].sort((a, b) => a.rawPredicted - b.rawPredicted)
  const fit: GoldenSample[] = []
  const heldout: GoldenSample[] = []
  sorted.forEach((s, i) => (i % heldoutEvery === 0 ? heldout : fit).push(s))
  return { fit, heldout }
}

function toCalSamples(samples: GoldenSample[], g?: CalibrationMap): CalibrationSample[] {
  return samples.map((s) => ({
    predicted: g ? applyGMap(s.rawPredicted, g) : s.rawPredicted,
    correct: s.correct,
  }))
}

/** 取真值样本 → 切分 → fit isotonic g → 留出集上比 identity vs g 的 ECE。 */
export async function fitAndMeasure(
  db: DB,
  opts: { binCount?: number; heldoutEvery?: number } = {},
): Promise<CalibrationMeasurement> {
  const samples = await collectUsageCalibrationSamples(db, [CALIBRATION_IDENTITY])
  const { fit, heldout } = splitSamples(samples, opts.heldoutEvery ?? 3)
  const fittedG = fitIsotonic(fit, `cal-pilot-${fit.length}`)
  const identity = computeReliability(toCalSamples(heldout), opts.binCount ?? 10)
  const calibrated = computeReliability(toCalSamples(heldout, fittedG), opts.binCount ?? 10)
  return {
    totalSamples: samples.length,
    fitCount: fit.length,
    heldoutCount: heldout.length,
    fittedG,
    identity,
    calibrated,
    eceDrop: identity.ece - calibrated.ece,
  }
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

/** 端到端跑一次 pilot(seed→usage→fit→measure)。供 run.ts(真端口)与测试(fake 端口)复用。 */
export async function runCalibrationPilot(
  db: DB,
  embedder: Embedder,
  opts: { consumers?: number; binCount?: number; heldoutEvery?: number } = {},
): Promise<{ seed: SeedStats; usage: UsageStats; measurement: CalibrationMeasurement }> {
  const facts = buildCorpus()
  const seed = await seedCorpus(db, embedder, facts)
  const usage = await generateUsage(db, embedder, facts, seed.claimIdByFact, {
    ...(opts.consumers !== undefined ? { consumers: opts.consumers } : {}),
  })
  const measurement = await fitAndMeasure(db, {
    ...(opts.binCount !== undefined ? { binCount: opts.binCount } : {}),
    ...(opts.heldoutEvery !== undefined ? { heldoutEvery: opts.heldoutEvery } : {}),
  })
  return { seed, usage, measurement }
}
