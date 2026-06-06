/**
 * M3-A(lean)真实世界校准测量骨架 —— 与端口解耦(测试注 fake、run.ts 注真 DashScope)。
 *
 * 管线:每条 fact = 一份(或多份)真实源文档 → 真 Distiller 抽 claim(raw **emergent**,经真因子流水线从 provenance 算)
 *   → 尝试晋升(走真状态机 A.4 门:conf≥0.5 ∧ entailment-pass)→ 召回(active)→ oracle 按源真假记 usage → 复用 M2
 *   measureFromSamples 算 identity vs g 的 ECE。
 *
 * **诚实边界(实证、非臆测,见 corpus.ts + 本文件 promoteEligible)**:新鲜抽取的 claim 物理上**进不了**可消费态——
 *   单源 raw 封顶 0.375(验真也只 0.45),晋升门 0.5 拦死。要 active 必须**多源印证 + Verifier 过 entailment**。
 *   这本身是内核「置信靠挣不靠声称」红线的实证:extraction-only 的 ECE 测的是空集。
 */
import { eq } from 'drizzle-orm'

import {
  addSource,
  recallClaims,
  reportUsage,
  schema,
  transitionClaim,
  type DB,
  type Embedder,
  type SameFactJudge,
} from '@engram/core'

import { LOOP_SEGMENTS_MARKER, runDistiller, type DistillerDeps } from '../../distiller.js'
import type { SourceReader } from '../../read/source-reader.js'
import type { AgentRunRequest, AgentRunResult, AgentRuntime } from '../../runtime/port.js'
import {
  collectFactSamples,
  measureFromSamples,
  type CalibrationMeasurement,
} from '../calibration-pilot/pilot.js'
import { buildRealWorldCorpus, type RealWorldFact } from './corpus.js'

export interface RealWorldDeps {
  db: DB
  embedder: Embedder
  judge: SameFactJudge
  runtime: AgentRuntime
  reader: SourceReader
}

export interface RealWorldOptions {
  /** 每条 fact 的独立印证源数(确定性,**与真假无关**)。1=仅抽取(实证空集);≥2 才可能过 indepSupport。默认 1(lean)。 */
  sourcesPerFact?: number
  /** 晋升时是否声称 entailment-pass(模拟 Verifier 过)。lean 无真 Verifier ⇒ 仍受 conf≥0.5 拦。默认 true。 */
  entailmentPass?: boolean
  binCount?: number
  heldoutEvery?: number
}

export interface IngestStats {
  facts: number
  sourcesIngested: number
  distillDone: number
  distillHumanPending: number
  /** 跨所有源 commit_claim 成功次数之和(冒烟时看真 Qwen 是否「一文档恰一条」:不漏抽、不裂成多条)。 */
  committedTotal: number
  /** factId → 该 fact 源文档抽出的 claim id(s)(经 provenance.sourceId 反查;同事实合并 ⇒ 通常 1 条)。 */
  claimsByFact: Map<string, string[]>
}

/** 逐 fact 把源文档(可多份印证)喂真 Distiller 抽取。claim 落 draft(commitClaim 恒 draft),raw 由真流水线算。 */
export async function ingestCorpus(
  deps: RealWorldDeps,
  facts: RealWorldFact[],
  opts: RealWorldOptions = {},
): Promise<IngestStats> {
  const sourcesPerFact = Math.max(1, opts.sourcesPerFact ?? 1)
  const distillerDeps: DistillerDeps = {
    db: deps.db,
    embedder: deps.embedder,
    judge: deps.judge,
    runtime: deps.runtime,
    reader: deps.reader,
  }
  const claimsByFact = new Map<string, string[]>()
  let sourcesIngested = 0
  let distillDone = 0
  let distillHumanPending = 0
  let committedTotal = 0

  for (const f of facts) {
    const sourceIds: string[] = []
    for (let k = 0; k < sourcesPerFact; k++) {
      // 多份「独立」源同述一事实:不同 contentHash(否则 countIndependentSupports 按 hash 去重折成 1)。
      const src = await addSource(deps.db, {
        content: f.docText,
        contentHash: `rw:${f.id}:s${k}`,
        kind: 'historical_artifact', // 散文陈述,seg:n,无 VLM
        authorityScore: f.sourceAuthority,
      })
      sourceIds.push(src.sourceId)
      sourcesIngested += 1
      const res = await runDistiller(distillerDeps, src.sourceId, { hasImages: false })
      committedTotal += res.committed
      if (res.status === 'done') distillDone += 1
      else distillHumanPending += 1
    }
    // 该 fact 的 claim = 任一源 provenance 指向的 claim(同事实合并 ⇒ 多源汇到一条)。
    const claimIds = new Set<string>()
    for (const sid of sourceIds) {
      const rows = await deps.db
        .select({ claimId: schema.claimProvenance.claimId })
        .from(schema.claimProvenance)
        .where(eq(schema.claimProvenance.sourceId, sid))
      for (const r of rows) claimIds.add(r.claimId)
    }
    claimsByFact.set(f.id, [...claimIds])
  }
  return {
    facts: facts.length,
    sourcesIngested,
    distillDone,
    distillHumanPending,
    committedTotal,
    claimsByFact,
  }
}

export interface PromotionOutcome {
  factId: string
  claimId: string | null
  /** 抽取后 claim 的存档 raw(emergent)。无 claim 时 null。 */
  raw: number | null
  promoted: boolean
  /** 'promoted' | 'no_claim' | 'blocked:<门错误信息>'。 */
  reason: string
}

export interface PromotionStats {
  outcomes: PromotionOutcome[]
  promoted: number
  blocked: number
  noClaim: number
  /** 抽取后各 claim 的 emergent raw(升序),人读 sanity:看离 0.5 门多远。 */
  rawSorted: number[]
}

/**
 * 对每条 fact 的 draft claim 走**真状态机 A.4 门**尝试晋升(蓝边 agent:distiller,声称 entailmentPass)。
 * 门 = conf≥0.5 ∧ entailment-pass;**新鲜抽取 claim 因 raw<0.5 必被拦**(实证内核红线),拦错原样收集不吞。
 */
export async function promoteEligible(
  deps: RealWorldDeps,
  facts: RealWorldFact[],
  claimsByFact: Map<string, string[]>,
  opts: RealWorldOptions = {},
): Promise<PromotionStats> {
  const entailmentPass = opts.entailmentPass ?? true
  const outcomes: PromotionOutcome[] = []
  const rawSorted: number[] = []
  let promoted = 0
  let blocked = 0
  let noClaim = 0

  for (const f of facts) {
    const claimId = claimsByFact.get(f.id)?.[0] ?? null
    if (!claimId) {
      noClaim += 1
      outcomes.push({ factId: f.id, claimId: null, raw: null, promoted: false, reason: 'no_claim' })
      continue
    }
    const [row] = await deps.db
      .select({ raw: schema.claim.confidenceRaw, status: schema.claim.status })
      .from(schema.claim)
      .where(eq(schema.claim.id, claimId))
    const raw = row ? Number(row.raw) : null
    if (raw !== null) rawSorted.push(raw)
    try {
      await transitionClaim(deps.db, claimId, 'active', {
        by: 'agent:distiller',
        entailmentPass,
      })
      promoted += 1
      outcomes.push({ factId: f.id, claimId, raw, promoted: true, reason: 'promoted' })
    } catch (err) {
      blocked += 1
      const msg = err instanceof Error ? err.message : String(err)
      outcomes.push({ factId: f.id, claimId, raw, promoted: false, reason: `blocked:${msg}` })
    }
  }
  rawSorted.sort((a, b) => a - b)
  return { outcomes, promoted, blocked, noClaim, rawSorted }
}

export interface UsageStats {
  recallHits: number
  recallMisses: number
  usageRows: number
}

/**
 * 逐 fact 真 recall(只命中 active);命中本 fact 的 claim ⇒ 一条 usage 上报。
 * **oracle**:correct = 源文档客观真假(Distiller 忠实抽取 ⇒ claim 真值 = 源真值);adopted/refuted 由此定。
 */
export async function generateUsage(
  deps: RealWorldDeps,
  facts: RealWorldFact[],
  claimsByFact: Map<string, string[]>,
): Promise<UsageStats> {
  let recallHits = 0
  let recallMisses = 0
  let usageRows = 0
  for (const f of facts) {
    const mineIds = new Set(claimsByFact.get(f.id) ?? [])
    if (mineIds.size === 0) {
      recallMisses += 1
      continue
    }
    const hits = await recallClaims(deps.db, deps.embedder, f.query)
    const mine = hits.find((h) => mineIds.has(h.claim.id))
    if (!mine) {
      recallMisses += 1
      continue
    }
    recallHits += 1
    await reportUsage(deps.db, mine.claim.id, f.isTrue ? 'adopted' : 'refuted', {
      taskId: f.id,
      byRole: 'agent:eval-consumer',
      confidenceAtRecall: mine.confidence.value,
    })
    usageRows += 1
  }
  return { recallHits, recallMisses, usageRows }
}

export interface RealWorldResult {
  ingest: IngestStats
  promotion: PromotionStats
  usage: UsageStats
  /** 真 usage_truth 读回的样本数(经 SPI,= 可测数据点)。 */
  sampleCount: number
  /** 有样本时的校准测量(identity vs g 的 ECE);样本不足(空集)时 null —— 这正是 lean extraction-only 的实证结局。 */
  measurement: CalibrationMeasurement | null
}

/** 端到端跑一次 M3-A(ingest → 尝试晋升 → usage → 测量)。供 run.ts(真端口)与测试(fake 端口)复用。 */
export async function runRealWorldEce(
  deps: RealWorldDeps,
  opts: RealWorldOptions = {},
): Promise<RealWorldResult> {
  const facts = buildRealWorldCorpus()
  const ingest = await ingestCorpus(deps, facts, opts)
  const promotion = await promoteEligible(deps, facts, ingest.claimsByFact, opts)
  const usage = await generateUsage(deps, facts, ingest.claimsByFact)
  const samples = await collectFactSamples(deps.db)
  const measurement =
    samples.length > 0
      ? measureFromSamples(samples, {
          ...(opts.binCount !== undefined ? { binCount: opts.binCount } : {}),
          ...(opts.heldoutEvery !== undefined ? { heldoutEvery: opts.heldoutEvery } : {}),
        })
      : null
  return { ingest, promotion, usage, sampleCount: samples.length, measurement }
}

/**
 * 确定性「忠实抽取」fake 运行时(离线/CI 用,零网络)—— 实现 AgentRuntime 端口,解析 Distiller 渲染进 prompt 的
 * `<locator>\t<text>` 行,逐行 commit_claim(claimText=该行文本、locator=该行锚),再 finish。无需 createFakeModel
 * 脚本(那是固定脚本、不随 prompt 变),故能在多源/多 fact 下逐源忠实抽取。模拟一个**忠实的真 Distiller LLM**。
 *
 * 分块标记复用 Distiller 导出的 {@link LOOP_SEGMENTS_MARKER}(单一真相源,不重抄);若渲染契约漂移导致标记缺失,
 * **大声失败**(reason='error',让 runDistiller 走降级路径)而非静默抽 0 条——别让契约漂移伪装成「源里没事实」。
 */
export function makeExtractingFakeRuntime(): AgentRuntime {
  return {
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      const commit = req.tools.find((t) => t.name === 'commit_claim')
      const finish = req.tools.find((t) => t.name === 'finish')
      if (!commit) return { reason: 'error', turns: 0 }
      const idx = req.prompt.indexOf(LOOP_SEGMENTS_MARKER)
      if (idx < 0) return { reason: 'error', turns: 0 } // 渲染契约漂移 → 大声失败,不静默抽 0 条
      const body = req.prompt.slice(idx + LOOP_SEGMENTS_MARKER.length)
      let turns = 0
      for (const line of body.split('\n')) {
        const tab = line.indexOf('\t')
        if (tab < 0) continue
        const locator = line.slice(0, tab).trim()
        const text = line.slice(tab + 1).trim()
        if (!locator || !text) continue
        // 朴素三元组切分(" is " 分主谓宾);切不出也无妨——claimText 已忠实,recall 走 claimText 嵌入。
        const m = /^(.*?)\s+(is|are|was|were|has|have)\s+(.*)$/.exec(text)
        await commit.execute(
          m
            ? { claimText: text, subject: m[1], predicate: m[2], object: m[3], locator }
            : { claimText: text, locator },
        )
        turns += 1
      }
      if (finish) {
        await finish.execute({})
        turns += 1
      }
      return { reason: 'done', turns }
    },
  }
}
