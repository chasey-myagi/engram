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
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import {
  addSource,
  agentActor,
  computeConfidenceFromProvenances,
  PROMOTE_CONFIDENCE_FLOOR,
  recallClaims,
  reportUsage,
  schema,
  transitionClaim,
  type DB,
  type Embedder,
  type EntailmentJudge,
  type SameFactJudge,
} from '@engram/core'

import { LOOP_SEGMENTS_MARKER, runDistiller, type DistillerDeps } from '../../distiller.js'
import type { SourceReader } from '../../read/source-reader.js'
import type { AgentRunRequest, AgentRunResult, AgentRuntime } from '../../runtime/port.js'
import { runVerifier } from '../../verifier.js'
import {
  collectFactSamples,
  measureFromSamples,
  type CalibrationMeasurement,
} from '../calibration-pilot/pilot.js'
import {
  buildCorroboratedCorpus,
  buildRealWorldCorpus,
  type CorroboratedFact,
  type RealWorldFact,
} from './corpus.js'

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
      // 多份「独立」源同述一事实:content 须字节级不同,否则内核自算 hash 相同 → countIndependentSupports
      // 按 hash 去重折成 1（EGR-CR-012：独立性靠真实 content 差异，不再靠不同随机 hash 抄近路）。
      const src = await addSource(deps.db, {
        content: `${f.docText}\n[rw:${f.id}:s${k}]`,
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

/**
 * 结构化的晋升结局判别。分类在数据结构层落定,下游(CLI/测试/未来调用方)不再 substring 匹配自由文本:
 *   - 'promoted'          晋升成功;
 *   - 'no_claim'          该 fact 抽不出 claim;
 *   - 'expected_blocked'  **预期**的 A.4 晋升门拦截(conf<0.5 或 entailment 未过)—— M3-A lean 唯一该出现的 blocked;
 *   - 'unexpected_error'  非门的 transition 故障(claim not found / no-op / 非法迁移 / calibration / DB …)—— 接线故障,fail-loud。
 */
export type PromotionKind = 'promoted' | 'no_claim' | 'expected_blocked' | 'unexpected_error'

export interface PromotionOutcome {
  factId: string
  claimId: string | null
  /** 抽取后 claim 的存档 raw(emergent)。无 claim 时 null。 */
  raw: number | null
  promoted: boolean
  /** 结构化判别字段(分类靠它,不靠 detail 文案)。 */
  kind: PromotionKind
  /** 仅供人读的原始错误/门信息(不再用于分类)。 */
  detail: string
}

export interface PromotionStats {
  outcomes: PromotionOutcome[]
  promoted: number
  /** 仅 conf<0.5(或 entailment 未过)这类**预期**门拦截。 */
  expectedBlocked: number
  /** 非门错误(claim not found / no-op / illegal / calibration / DB …)。>0 即接线故障。 */
  unexpectedError: number
  noClaim: number
  /** 抽取后各 claim 的 emergent raw(升序),人读 sanity:看离 0.5 门多远。 */
  rawSorted: number[]
}

// 与 packages/engram-core/src/spi/transition.ts 的晋升门抛文案耦合(143/148 行)。
// 仅这两类是 M3-A lean 预期的 blocked;其余 transition 抛错(claim not found / no-op / 非法迁移 /
// calibration / DB …)都是接线故障,必须 fail-loud,绝不能伪装成「设计使然的 0 晋升」。
const EXPECTED_GATE_MARKERS = [
  `< ${PROMOTE_CONFIDENCE_FLOOR}`, // transition.ts:143 conf 不达标
  'entailment did not pass', // transition.ts:148 entailment 门
] as const

/** 错误信息是否命中**预期**的 A.4 晋升门(conf<0.5 或 entailment 未过)。其余一律视作非预期接线故障。 */
function isExpectedGateBlock(msg: string): boolean {
  return EXPECTED_GATE_MARKERS.some((m) => msg.includes(m))
}

/**
 * 对每条 fact 的 draft claim 走**真状态机 A.4 门**尝试晋升(蓝边 agent:distiller,声称 entailmentPass)。
 * 门 = conf≥0.5 ∧ entailment-pass;**新鲜抽取 claim 因 raw<0.5 必被拦**(实证内核红线)。
 *
 * **fail-loud 边界**:catch 只把命中门文案白名单的拦截归为 `expected_blocked`;非门 transition 故障
 *   (claim not found / no-op / 非法迁移 / calibration / DB …)**rethrow**——这是「测量仪器」,遇接线故障
 *   就该立即停、不该继续产出可疑数据,更不该把它静默吞成「预期 blocked」让坏接线在绿伪装下溜过。
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
  let expectedBlocked = 0
  let noClaim = 0

  for (const f of facts) {
    const claimId = claimsByFact.get(f.id)?.[0] ?? null
    if (!claimId) {
      noClaim += 1
      outcomes.push({
        factId: f.id,
        claimId: null,
        raw: null,
        promoted: false,
        kind: 'no_claim',
        detail: 'no_claim',
      })
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
        actor: agentActor('agent:distiller'),
        entailmentPass,
      })
      promoted += 1
      outcomes.push({
        factId: f.id,
        claimId,
        raw,
        promoted: true,
        kind: 'promoted',
        detail: 'promoted',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isExpectedGateBlock(msg)) {
        expectedBlocked += 1
        outcomes.push({
          factId: f.id,
          claimId,
          raw,
          promoted: false,
          kind: 'expected_blocked',
          detail: msg,
        })
      } else {
        // 非门错误:不吞。让冒烟 fail-loud(rethrow),不能伪装成「设计使然的 0 晋升」。
        throw new Error(
          `promoteEligible: unexpected transition failure for claim ${claimId} (fact ${f.id}): ${msg}`,
          { cause: err },
        )
      }
    }
  }
  rawSorted.sort((a, b) => a - b)
  return { outcomes, promoted, expectedBlocked, unexpectedError: 0, noClaim, rawSorted }
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
  facts: { id: string; query: string; isTrue: boolean }[],
  claimsByFact: Map<string, string[]>,
  evalRunId?: string,
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
      // EGR-CR-060：给本次 run 写入的 usage_truth 打隔离标签，读端据此只收本次样本。
      ...(evalRunId !== undefined ? { evalRunId } : {}),
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
  // EGR-CR-060：本次 run 唯一标识。写端给 usage_truth 打标、读端按标过滤 ⇒ 测量集 = 本次 run 产出，
  // 不依赖「deps.db 是空库」这个未声明的隐含前提，复用进非空库 / 串跑多评测也正确。
  const evalRunId = randomUUID()
  const facts = buildRealWorldCorpus()
  const ingest = await ingestCorpus(deps, facts, opts)
  const promotion = await promoteEligible(deps, facts, ingest.claimsByFact, opts)
  const usage = await generateUsage(deps, facts, ingest.claimsByFact, evalRunId)
  const samples = await collectFactSamples(deps.db, { evalRunId })
  // 不变量护栏（fail-loud）：本次读回样本数必须 == 本次写入 usage 行数。不等即污染/漏读 ⇒ 显式失败而非静默坏曲线。
  if (samples.length !== usage.usageRows) {
    throw new Error(
      `runRealWorldEce: sample/usage mismatch — collected ${samples.length} samples but wrote ${usage.usageRows} usage rows (evalRunId=${evalRunId}). ` +
        `测量集被污染或漏读，拒绝产出可疑校准曲线。`,
    )
  }
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

// ───────────────────────── Option C：多源印证 + 真 Verifier → 真 ECE 曲线 ─────────────────────────

/** Option C 依赖:比 lean 多一个真 entailment 判官(给真 Verifier 巡查/晋升用)。 */
export interface CorroboratedDeps extends RealWorldDeps {
  /** entailment 判官(端口)。CI 注 makeFakeEntailmentJudge(默认 pass);run 注 makeDashScopeEntailmentJudge。 */
  entailmentJudge: EntailmentJudge
}

/**
 * 给一条已抽取的 claim **直接挂** (count−1) 条独立印证出处(distinct contentHash、relevance='exact')+ 按全量出处
 * **重算** confidence 写回 stored factors(recall 读 stored indepSupport)。确定性、零 LLM —— corroboration 的「计数」
 * 是 provenance 图属性,不必逐源再过 Distiller/同事实判官(那条 merge 路已在 core 单测覆盖;这里只要 indep 计数对)。
 * entailment 此刻仍中性 0.5(Verifier 未跑);recall 时按最新 patrol 实时覆盖到 1.0。
 */
async function addCorroboration(
  db: DB,
  claimId: string,
  factId: string,
  content: string,
  count: number,
  authority: number,
): Promise<void> {
  for (let k = 1; k < count; k++) {
    const src = await addSource(db, {
      // 同一事实由另一独立源复述：content 须字节级不同（EGR-CR-012 内核自算 hash ⇒ 同 content 会折叠成 1）。
      content: `${content}\n[co:${factId}:c${k}]`,
      kind: 'historical_artifact',
      authorityScore: authority,
    })
    await db.insert(schema.claimProvenance).values({
      id: randomUUID(),
      claimId,
      sourceId: src.sourceId,
      locator: `corrob:${factId}:${k}`,
      relevance: 'exact',
    })
  }
  await db.transaction(async (tx) => {
    const provs = await tx
      .select({
        sourceId: schema.claimProvenance.sourceId,
        relevance: schema.claimProvenance.relevance,
      })
      .from(schema.claimProvenance)
      .where(eq(schema.claimProvenance.claimId, claimId))
    // staleDecay 钉为**恰好 1**:asOf 取未来时点 → 内核 Math.max(0, now−asOf)=0 → 0.5^0=1(字面量,无墙钟抖动)。
    // 语义正当(刚抽取的 claim 本就不 stale);更关键是消除「同 tier 置信仅差 ~1e-9 抖动 → aggregateByX 视作互异点
    // → PAVA 受 collectFactSamples 无序行序影响 → g 非确定」这条隐链,让真 ECE 测量可复现。本评测不测时效衰减。
    const freshAsOf = new Date(Date.now() + 86_400_000)
    const conf = await computeConfidenceFromProvenances(
      tx,
      provs.map((p) => ({ sourceId: p.sourceId, relevance: p.relevance })),
      freshAsOf,
      { claimId },
    )
    await tx
      .update(schema.claim)
      .set({
        confidence: conf.confidence,
        confidenceRaw: conf.confidenceRaw,
        confidenceFactors: {
          factors: conf.factors,
          weights: conf.weights,
          calibrationVersion: conf.calibrationVersion,
        },
      })
      .where(eq(schema.claim.id, claimId))
  })
}

export interface CorroboratedResult {
  facts: number
  distillDone: number
  committedTotal: number
  /** 真 Verifier 巡查后晋升 active 的 claim 数(= 可消费集大小)。 */
  promoted: number
  verifierPatrolled: number
  verifierTransitions: number
  usage: UsageStats
  /** 真 usage_truth 读回样本数(经 SPI)。 */
  sampleCount: number
  /** 样本 recall 置信分布(升序),人读 sanity 看落在哪个窄带。 */
  confSorted: number[]
  /** 校准测量(identity vs g 的 ECE);无样本时 null。 */
  measurement: CalibrationMeasurement | null
}

/**
 * 端到端跑 Option C:真 Distiller 抽取(单源)→ 直接挂多源印证(n=4)→ **真 Verifier**(entailment pass → 内核
 * 把过 0.5 门的晋升 active)→ 真 recall → oracle usage → 复用 measureFromSamples 算真 ECE。供 run(真端口)+ CI(fake)复用。
 */
export async function runCorroboratedEce(
  deps: CorroboratedDeps,
  opts: {
    facts?: CorroboratedFact[]
    binCount?: number
    heldoutEvery?: number
    limit?: number
  } = {},
): Promise<CorroboratedResult> {
  // EGR-CR-060：本次 run 唯一标识(与 runRealWorldEce 同口径)。
  const evalRunId = randomUUID()
  // facts 可注入(Option C=buildCorroboratedCorpus 公共事实;M3-B=buildPrivateCorpus 私域事实)。缺省公共。
  const allFacts = opts.facts ?? buildCorroboratedCorpus()
  // limit 仅供真 Qwen 微冒烟核对接线(切片会破坏 tier 平衡/真值率,测量无意义、只验「真模型下确实晋升」)。
  const facts = opts.limit ? allFacts.slice(0, Math.max(1, opts.limit)) : allFacts
  const distillerDeps: DistillerDeps = {
    db: deps.db,
    embedder: deps.embedder,
    judge: deps.judge,
    runtime: deps.runtime,
    reader: deps.reader,
  }
  const claimsByFact = new Map<string, string[]>()
  let distillDone = 0
  let committedTotal = 0

  for (const f of facts) {
    const src = await addSource(deps.db, {
      content: f.docText, // 主源 c0；corroboration（addCorroboration, k≥1）各加唯一后缀 → 全部字节级不同（EGR-CR-012）
      kind: 'historical_artifact',
      authorityScore: f.sourceAuthority,
    })
    const res = await runDistiller(distillerDeps, src.sourceId, { hasImages: false })
    committedTotal += res.committed
    if (res.status === 'done') distillDone += 1
    const rows = await deps.db
      .select({ claimId: schema.claimProvenance.claimId })
      .from(schema.claimProvenance)
      .where(eq(schema.claimProvenance.sourceId, src.sourceId))
    const cid = rows[0]?.claimId
    if (cid) {
      claimsByFact.set(f.id, [cid])
      await addCorroboration(deps.db, cid, f.id, f.docText, f.corroborationCount, f.sourceAuthority)
    } else {
      claimsByFact.set(f.id, [])
    }
  }

  // 真 Verifier:巡查全部 draft → 点状一次 entailment → pass 且 conf≥0.5 → 内核晋升 active(蓝边收紧,放松仍仅人)。
  const vres = await runVerifier(
    { db: deps.db, judge: deps.entailmentJudge },
    { byRole: 'agent:verifier', maxClaims: facts.length + 16 },
  )

  // 数晋升:本批 claim 里 status=active 的。
  const ids = [...claimsByFact.values()].flat()
  let promoted = 0
  if (ids.length > 0) {
    const actives = await deps.db
      .select({ id: schema.claim.id })
      .from(schema.claim)
      .where(eq(schema.claim.status, 'active'))
    const activeSet = new Set(actives.map((a) => a.id))
    promoted = ids.filter((id) => activeSet.has(id)).length
  }

  const usage = await generateUsage(deps, facts, claimsByFact, evalRunId)
  const samples = await collectFactSamples(deps.db, { evalRunId })
  // 不变量护栏（fail-loud，与 runRealWorldEce 对称）：本次读回样本数必须 == 本次写入 usage 行数。
  if (samples.length !== usage.usageRows) {
    throw new Error(
      `runCorroboratedEce: sample/usage mismatch — collected ${samples.length} samples but wrote ${usage.usageRows} usage rows (evalRunId=${evalRunId}). ` +
        `测量集被污染或漏读，拒绝产出可疑校准曲线。`,
    )
  }
  const confSorted = samples.map((s) => s.rawPredicted).sort((a, b) => a - b)
  const measurement =
    samples.length > 0
      ? measureFromSamples(samples, {
          ...(opts.binCount !== undefined ? { binCount: opts.binCount } : {}),
          ...(opts.heldoutEvery !== undefined ? { heldoutEvery: opts.heldoutEvery } : {}),
        })
      : null

  return {
    facts: facts.length,
    distillDone,
    committedTotal,
    promoted,
    verifierPatrolled: vres.patrolled,
    verifierTransitions: vres.transitions,
    usage,
    sampleCount: samples.length,
    confSorted,
    measurement,
  }
}
