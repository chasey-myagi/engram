/**
 * M3-B · 私域事实真过自信 ECE · 可跑入口(env-gated:需 DASHSCOPE_API_KEY + 网络)。运行:
 *   docker compose up -d db
 *   pnpm -r build
 *   M3B_LIMIT=4 node packages/engram-workers/dist/eval/realworld-ece/run-private.js   # 先微冒烟,核对接线
 *   node packages/engram-workers/dist/eval/realworld-ece/run-private.js               # 全 48 条 → 真过自信 ECE
 *
 * 与 Option C(run-corroborated.ts)同一管线,只换语料:**判官无法世界核查的虚构事实**(actuator VX-210 力矩、alloy
 * KX-330 频率…)。Option C 真跑发现:公共事实上真 Qwen entailment 判官会**事实核查**、把假 claim 挡在 active 外 ⇒ 量不到
 * 过自信。M3-B 改用 LLM 无先验的私域事实 + **注入错源**(把真值记成 真值+17,claim 忠实抄错):判官查不出 ⇒ 假货能进
 * 消费门 ⇒ 可消费集**真带过自信**(置信 ~0.55 但其中含错) ⇒ g 该把置信**向下**修正。这才是真实世界过自信 ECE。
 *
 * 真组件:真 Qwen Distiller(抽取)+ 真 DashScope entailment 判官(核验)+ 真 text-embedding-v3(recall)。同事实判官用
 * fake(虚构 subject 互异 ⇒ 正确裁决恒 unrelated)。诚实预期:可消费集真值率 < 置信(g 下压);若判官对私域事实仍偏
 * 保守(prefer fail)把它们也挡了,则会复现「Verifier 宁可错杀」——也是一个有效结论,届时如实报告。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

import {
  createDb,
  makeDashScopeEmbedder,
  makeDashScopeEntailmentJudge,
  makeFakeSameFactJudge,
} from '@engram/core'

import { makeFakeSourceReader } from '../../read/fake-source-reader.js'
import { makeQwenRuntime } from '../../runtime/dashscope-runtime.js'
import { renderReliability } from '../calibration-pilot/pilot.js'
import { buildPrivateCorpus } from './corpus.js'
import { runCorroboratedEce, type CorroboratedDeps } from './harness.js'

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

function pct(xs: number[], p: number): string {
  if (xs.length === 0) return 'n/a'
  return xs[Math.round(p * (xs.length - 1))]!.toFixed(3)
}

async function main(): Promise<void> {
  if (!process.env.DASHSCOPE_API_KEY) {
    console.error(
      '[m3b] DASHSCOPE_API_KEY 未设置 —— 本运行需真 Qwen。先 export DASHSCOPE_API_KEY。',
    )
    process.exitCode = 1
    return
  }
  const limit = process.env.M3B_LIMIT ? Math.max(1, Number(process.env.M3B_LIMIT)) : undefined
  const corpus = buildPrivateCorpus()

  const dbName = `engram_m3b_${Math.abs(hashStr(DATABASE_URL)).toString(36)}_${process.pid}`
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  admin.on('error', () => {})
  let pool: pg.Pool | undefined
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${dbName}`)
    const url = new URL(DATABASE_URL)
    url.pathname = `/${dbName}`
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
    pool.on('error', () => {})
    const db = createDb(pool)
    await migrate(db, { migrationsFolder })

    const deps: CorroboratedDeps = {
      db,
      embedder: makeDashScopeEmbedder(), // ★ 真 text-embedding-v3
      judge: makeFakeSameFactJudge(), // 虚构事实互异 ⇒ unrelated;免 O(n²) 灰区 LLM
      runtime: makeQwenRuntime(), // ★ 真 Qwen Distiller
      reader: makeFakeSourceReader(),
      entailmentJudge: makeDashScopeEntailmentJudge(), // ★ 真 Qwen entailment(对私域事实无先验、无法核查)
    }
    console.log(
      `[m3b] 临时库 ${dbName} 已建 + 迁移。真 Qwen + 私域虚构事实${limit ? `(微冒烟 ${limit} 条)` : '(全 48 条)'}。`,
    )

    const t0 = Date.now()
    const r = await runCorroboratedEce(deps, {
      facts: corpus,
      binCount: 20,
      heldoutEvery: 3,
      ...(limit !== undefined ? { limit } : {}),
    })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)

    console.log('\n=== ① 抽取 + 印证 + 真 Verifier(私域事实判官无法核查) ===')
    console.log(
      `  事实 ${r.facts};distill done ${r.distillDone};commit ${r.committedTotal};Verifier 巡查 ${r.verifierPatrolled} / 状态迁移 ${r.verifierTransitions}`,
    )
    console.log(`  晋升 active(可消费)${r.promoted}/${r.facts} —— 假 claim 是否被放进消费门由此见`)

    console.log('\n=== ② 真 recall + usage(经 Consumer SPI) ===')
    console.log(
      `  recall 命中 ${r.usage.recallHits} / 漏 ${r.usage.recallMisses};usage_truth 行 ${r.usage.usageRows};SPI 读回样本 ${r.sampleCount}`,
    )
    console.log(
      `  召回置信(emergent):min ${pct(r.confSorted, 0)} / p50 ${pct(r.confSorted, 0.5)} / max ${pct(r.confSorted, 1)}(可消费窄带)`,
    )

    if (!r.measurement) {
      console.log(
        '\n[m3b] 无可测样本(0 晋升或 0 召回)。若 0 晋升 = 判官对私域事实仍保守拒判(Verifier 宁可错杀),亦是结论。',
      )
    } else {
      const m = r.measurement
      console.log('\n=== ③ 校准测量(按 fact 切分,留出=未见事实) ===')
      console.log(
        `  样本 ${m.totalSamples}(fit ${m.fitCount} / heldout ${m.heldoutCount});g 结点 ${m.fittedG.knots.length};事实跨边 ${m.factsInBothSides}(须 0)`,
      )
      console.log('\n  -- identity g(未校准:emergent 置信当预测) --')
      console.log(renderReliability(m.identity))
      console.log('\n  -- isotonic g(校准后) --')
      console.log(renderReliability(m.calibrated))
      const wMean = (sel: (b: (typeof m.identity.bins)[number]) => number) => {
        const nz = m.identity.bins.filter((b) => b.count > 0)
        const n = nz.reduce((a, b) => a + b.count, 0)
        return n === 0 ? NaN : nz.reduce((a, b) => a + sel(b) * b.count, 0) / n
      }
      const meanPred = wMean((b) => b.meanPredicted)
      const meanObs = wMean((b) => b.observed)
      const dir =
        meanPred > meanObs ? '过自信→g 下压' : meanPred < meanObs ? '欠自信→g 上调' : '已校准'
      console.log(
        `\n  ★ ECE: identity ${m.identity.ece.toFixed(4)} → g ${m.calibrated.ece.toFixed(4)}  (降 ${m.eceDrop.toFixed(4)}, ${m.eceDrop > 0 ? '✓' : '✗'} ${dir};留出 平均预测 ${meanPred.toFixed(3)} vs 观测 ${meanObs.toFixed(3)})`,
      )
    }
    console.log(`\n[m3b] 用时 ${secs}s。私域真过自信 ECE 跑通。`)
  } finally {
    if (pool) await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  }
}

/** 确定性哈希(避开 Math.random,库名稳定可复跑)。 */
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h | 0
}

main().catch((err: unknown) => {
  console.error('[m3b] 运行失败:', err)
  process.exitCode = 1
})
