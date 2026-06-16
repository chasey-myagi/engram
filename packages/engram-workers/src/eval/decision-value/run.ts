/**
 * S10 · Plan A 决策价值**单命令**端到端 + ASCII 报告。
 *
 * CI 路径(确定性、零网络):runDecisionValueReport 在合成过自信语料上跑完 loop(S8)+ baselines(S7)+ 把**真实**的错答 claim
 * 连 trace 落库再 diagnose(S9)→ 渲染报告(report.ts)。打报告前先 fail-closed 复检 A3 冻结(report.assertA3Frozen)。
 *
 * 真 Qwen 路径(env-gated:DASHSCOPE_API_KEY + 网络):main() 跑一次**真** Distiller(S5 会盖 producing_run_id + 落真 agent_run_trace),
 * 把真蒸馏出的 claim 注入错答下钻 ⇒ 报告里的 trace 是真 agent run。统计量仍用合成语料(校准 lift 需受控的过自信分布,小批真蒸馏挣不出)。
 * 先 DVR_LIMIT=1 微冒烟核对接线 + 数真调用,再全跑。
 *
 *   docker compose up -d db && pnpm -r build
 *   DVR_LIMIT=1 node packages/engram-workers/dist/eval/decision-value/run.js   # 微冒烟
 *   node packages/engram-workers/dist/eval/decision-value/run.js               # 全跑
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  addSource,
  applyGMap,
  createDb,
  makeFakeEmbedder,
  makeFakeSameFactJudge,
  recordAgentRun,
  schema,
  type CalibrationMap,
  type DB,
  type Embedder,
} from '@engram/core'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

import { runLearningLoop } from './learning-loop.js'
import { diagnoseWrongDecisions, summarizeDiagnoses } from './diagnose.js'
import { assertA3Frozen, renderDecisionValueReport, type ReportInput } from './report.js'
import type { LabeledSample } from './split-and-tune.js'

const PHI = 0.6180339887498949
const TAU = 0.8

interface RunStory {
  reason: string
  turns: number
  toolErrors: number
}
export interface DecisionFact {
  factId: string
  raw: number
  correct: boolean
  /** 该 claim 的产出 run 故事(落 agent_run_trace,供错答下钻)。 */
  run: RunStory
}

/** 造一轮过自信语料(golden-ratio 指派 correctness;每 5 条一条退化 run、跨档铺开供下钻展示)。 */
function buildRound(prefix: string, nPerTier: number, phase: number): DecisionFact[] {
  const tiers = [
    { raw: 0.9, acc: 0.85 },
    { raw: 0.82, acc: 0.3 },
    { raw: 0.5, acc: 0.4 },
  ]
  const out: DecisionFact[] = []
  let idx = 0
  for (let k = 0; k < nPerTier; k++) {
    for (const t of tiers) {
      // 每 5 条一条退化 run(5 与档数 3 互质 ⇒ 跨档铺开,能落到被答出的 genuine 档、供下钻展示生产侧线索)。
      const degenerate = idx % 5 === 0
      out.push({
        factId: `${prefix}-${String(idx).padStart(4, '0')}`,
        raw: t.raw,
        correct: (k + phase) * PHI - Math.floor((k + phase) * PHI) < t.acc,
        run: degenerate
          ? { reason: 'max_turns', turns: 12, toolErrors: 2 }
          : { reason: 'done', turns: 3, toolErrors: 0 },
      })
      idx++
    }
  }
  return out
}

/** 合成语料:R1 90 + R2 90(factId 前缀不相交)= 180 facts(~150–200 档)。 */
export function buildSyntheticCorpus(): { r1: DecisionFact[]; r2: DecisionFact[] } {
  return { r1: buildRound('r1', 30, 0), r2: buildRound('r2', 30, 17) }
}

function toLabeled(facts: DecisionFact[]): LabeledSample[] {
  return facts.map((f) => ({ factId: f.factId, rawPredicted: f.raw, correct: f.correct }))
}

/** 把一条 fact 落成 active claim(confidenceRaw=raw、confidence=g(raw))+ 其产出 run 的 agent_run_trace,返回 claimId。 */
async function seedWrongAnswerClaim(
  db: DB,
  embedder: Embedder,
  fact: DecisionFact,
  gMap: CalibrationMap,
): Promise<string> {
  const runId = randomUUID()
  await recordAgentRun(db, {
    runId,
    workerName: 'agent:distiller',
    byRole: 'agent:distiller',
    reason: fact.run.reason,
    turns: fact.run.turns,
    toolErrors: fact.run.toolErrors,
  })
  const src = await addSource(db, {
    content: `s-${fact.factId}`,
    kind: 'formal_document',
    authorityScore: fact.raw,
  })
  const claimId = randomUUID()
  await db.insert(schema.claim).values({
    id: claimId,
    claimText: `c-${fact.factId}`,
    subject: 's',
    predicate: 'p',
    object: 'o',
    status: 'active',
    confidence: applyGMap(fact.raw, gMap), // g(raw) = 召回快照值
    confidenceRaw: fact.raw,
    confidenceFactors: { factors: {}, weights: {}, calibrationVersion: gMap.version },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'agent:distiller',
    producingRunId: runId,
    embedding: await embedder.embed('c', 'document'),
    embeddingVersion: embedder.version,
  })
  await db.insert(schema.claimProvenance).values({
    id: randomUUID(),
    claimId,
    sourceId: src.sourceId,
    locator: 'loc',
    relevance: 'exact',
  })
  return claimId
}

export interface DecisionValueReportResult {
  report: string
  loop: ReturnType<typeof runLearningLoop>
  wrongAnswerClaimIds: string[]
}

/**
 * 端到端跑一次决策价值报告:fail-closed A3 复检 → loop(R1→g1→R2)→ 把 R2 的**错答**(g(raw)≥τ 且 false)连 trace 落库 → diagnose → 渲染。
 * extraWrongClaimIds:env-gated 真 Qwen 路径注入的**真蒸馏 claim**,一并进下钻(报告里出现真 agent trace)。纯确定性(合成路径)。
 */
export async function runDecisionValueReport(
  db: DB,
  opts: {
    corpus: { r1: DecisionFact[]; r2: DecisionFact[] }
    tau?: number
    seed?: number
    embedder?: Embedder
    source?: 'fake' | 'qwen'
    extraWrongClaimIds?: string[]
  },
): Promise<DecisionValueReportResult> {
  // ① 打报告前 fail-closed:A3 冻结不变量必须完好,否则拒绝出数(宁可无报告,不发可能被污染的 g 跑出的数)。
  assertA3Frozen()

  const tau = opts.tau ?? TAU
  const seed = opts.seed ?? 1
  const embedder = opts.embedder ?? makeFakeEmbedder()
  const { r1, r2 } = opts.corpus

  // ② loop:g1 拟在 R1、量在未见 R2。
  const loop = runLearningLoop({ r1: toLabeled(r1), r2: toLabeled(r2), tau, seed })

  // ③ R2 的错答 = fitted 答出(g(raw)≥τ)却为假;连 trace 落库供下钻。
  const wrongFacts = r2.filter((f) => applyGMap(f.raw, loop.r2.gMap) >= tau && !f.correct)
  const seededIds: string[] = []
  for (const f of wrongFacts)
    seededIds.push(await seedWrongAnswerClaim(db, embedder, f, loop.r2.gMap))
  const wrongAnswerClaimIds = [...seededIds, ...(opts.extraWrongClaimIds ?? [])]

  // ④ diagnose join → 报告。
  const diagnoses = await diagnoseWrongDecisions(db, wrongAnswerClaimIds, tau)
  const summary = summarizeDiagnoses(diagnoses)
  const reportInput: ReportInput = {
    tau,
    r1Size: r1.length,
    r2Size: r2.length,
    source: opts.source ?? 'fake',
    loop,
    diagnoses,
    summary,
  }
  return { report: renderDecisionValueReport(reportInput), loop, wrongAnswerClaimIds }
}

// ───────────────────────────── env-gated 真 Qwen 入口 ─────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'engram-core',
  'drizzle',
)

/** 跑一次真 Qwen Distiller(S5 盖 producing_run_id + 落真 trace),返回它产出的 claimId(供报告下钻展示真 agent run)。 */
async function realQwenDistilledClaimIds(
  db: DB,
  embedder: Embedder,
  limit: number,
): Promise<string[]> {
  const { makeQwenRuntime } = await import('../../runtime/dashscope-runtime.js')
  const { runDistiller } = await import('../../distiller.js')
  const { makeFakeSourceReader } = await import('../../read/fake-source-reader.js')
  const runtime = makeQwenRuntime()
  const reader = makeFakeSourceReader()
  const judge = makeFakeSameFactJudge()
  const out: string[] = []
  for (let i = 0; i < limit; i++) {
    const src = await addSource(db, {
      content: `France's capital is Paris. (fact ${i})`,
      kind: 'formal_document',
      authorityScore: 0.9,
    })
    const result = await runDistiller({ db, embedder, judge, runtime, reader }, src.sourceId)
    const claims = await db
      .select({ id: schema.claim.id })
      .from(schema.claim)
      .where(eq(schema.claim.producingRunId, result.runId))
    for (const c of claims) out.push(c.id)
    console.log(
      `[dvr] 真 Qwen Distiller #${i}: status=${result.status} committed=${result.committed} runId=${result.runId.slice(0, 8)} → ${claims.length} claim`,
    )
  }
  return out
}

async function main(): Promise<void> {
  if (!process.env.DASHSCOPE_API_KEY) {
    console.error(
      '[dvr] DASHSCOPE_API_KEY 未设置 —— 真 Qwen 端到端需它。先 export DASHSCOPE_API_KEY(CI 走 run.test.ts 的合成路径)。',
    )
    process.exitCode = 1
    return
  }
  const limit = process.env.DVR_LIMIT ? Math.max(1, Number(process.env.DVR_LIMIT)) : 2
  const testDbName = `engram_dvr_${randomUUID().replace(/-/g, '')}`
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  const db = createDb(pool)
  try {
    await migrate(db, { migrationsFolder })
    const embedder = makeFakeEmbedder()
    console.log(
      `[dvr] 真 Qwen Distiller 冒烟(limit=${limit})——验 producing_run_id + 真 agent_run_trace 接线…`,
    )
    const realIds = await realQwenDistilledClaimIds(db, embedder, limit)
    const { report } = await runDecisionValueReport(db, {
      corpus: buildSyntheticCorpus(),
      embedder,
      source: 'qwen',
      extraWrongClaimIds: realIds, // 真蒸馏 claim 进下钻 ⇒ 报告含真 agent trace
    })
    console.log('\n' + report)
  } finally {
    await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
    await admin.end()
  }
}

// 仅作为脚本直接运行时执行 main(import 进来当库时不跑)。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
