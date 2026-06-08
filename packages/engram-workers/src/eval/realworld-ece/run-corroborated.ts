/**
 * Option C · 真实世界 ECE 曲线 · 可跑入口(env-gated:需 DASHSCOPE_API_KEY + 网络)。运行:
 *   docker compose up -d db
 *   pnpm -r build
 *   M3C_LIMIT=4 node packages/engram-workers/dist/eval/realworld-ece/run-corroborated.js   # 先微冒烟,核对接线
 *   node packages/engram-workers/dist/eval/realworld-ece/run-corroborated.js               # 全 48 条 → 真 ECE 曲线
 *
 * 真组件:**真 Qwen Distiller**(抽取)+ **真 DashScope entailment 判官**(Verifier 核验/晋升)+ **真 text-embedding-v3**
 * (recall)。同事实判官用 fake(本语料事实互异 ⇒ 正确裁决恒 'unrelated';避免 O(n²) 灰区 LLM,merge 路已在 core 单测覆盖)。
 *
 * **真跑发现(48 条实测,与合成设计相反、更重要)**:语料**注入了过自信**(给假 fact 也配高权威多源),但真 Qwen
 * entailment 判官对可世界核验的事实**会事实核查** —— 把假 claim 判 fail/not_co_true、挡在 active 之外(48 条只 19 条晋升,
 * 29 条假 claim 留 draft)。⇒ 可消费集**高精度(survivors ~100% 真)**,而出处置信只 ~0.55 ⇒ 系统对核验幸存者**欠自信**,
 * g 把它**上调**(~0.55→~0.92)、ECE 0.45→0.08。即:内核「核验把假货挡在消费门外」红线对真 LLM 判官**成立**,
 * 「过自信的可消费 claim」对可核验公共事实基本不存在。要量**过自信梯度**需判官**无法核查**的私域/新颖事实(= M3-B)。
 *
 * 这是 M2(seed claim 验 g 机器)→ M3-A(空集实证)→ Option C(真管线、真判官、真测量)的续证。校准**机器本身**(注入
 * 过自信 → g 在留出事实上压 ECE)由 CI(corroborated-ece.test.ts,pass-everything 判官替身)确定性守住。
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
      '[m3c] DASHSCOPE_API_KEY 未设置 —— 本运行需真 Qwen。先 export DASHSCOPE_API_KEY。',
    )
    process.exitCode = 1
    return
  }
  const limit = process.env.M3C_LIMIT ? Math.max(1, Number(process.env.M3C_LIMIT)) : undefined

  const dbName = `engram_m3c_${Math.abs(hashStr(DATABASE_URL)).toString(36)}_${process.pid}`
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
      embedder: makeDashScopeEmbedder(), // ★ 真 text-embedding-v3(recall 语义匹配)
      judge: makeFakeSameFactJudge(), // 互异事实恒 unrelated;免 O(n²) 灰区 LLM
      runtime: makeQwenRuntime(), // ★ 真 Qwen Distiller
      reader: makeFakeSourceReader(),
      entailmentJudge: makeDashScopeEntailmentJudge(), // ★ 真 Qwen entailment(Verifier)
    }
    console.log(
      `[m3c] 临时库 ${dbName} 已建 + 迁移。真 Qwen Distiller + 真 entailment + 真嵌入${limit ? `(微冒烟 ${limit} 条)` : '(全 48 条)'}。`,
    )

    const t0 = Date.now()
    const r = await runCorroboratedEce(deps, {
      binCount: 20,
      heldoutEvery: 3,
      ...(limit !== undefined ? { limit } : {}),
    })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)

    console.log('\n=== ① 抽取 + 印证 + 真 Verifier 晋升 ===')
    console.log(
      `  事实 ${r.facts};distill done ${r.distillDone};commit ${r.committedTotal};Verifier 巡查 ${r.verifierPatrolled} / 状态迁移 ${r.verifierTransitions}`,
    )
    console.log(`  晋升 active(可消费)${r.promoted}/${r.facts}`)

    console.log('\n=== ② 真 recall + usage(经 Consumer SPI) ===')
    console.log(
      `  recall 命中 ${r.usage.recallHits} / 漏 ${r.usage.recallMisses};usage_truth 行 ${r.usage.usageRows};SPI 读回样本 ${r.sampleCount}`,
    )
    console.log(
      `  召回置信(emergent):min ${pct(r.confSorted, 0)} / p50 ${pct(r.confSorted, 0.5)} / max ${pct(r.confSorted, 1)}(可消费窄带)`,
    )

    if (!r.measurement) {
      console.log('\n[m3c] 无可测样本(0 晋升或 0 召回)——接线/门槛需复查。')
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
      // 方向:留出集 平均预测 vs 平均观测正确率 —— 预测 < 观测=欠自信(g 上调);> =过自信(g 下压)。
      const wMean = (sel: (b: (typeof m.identity.bins)[number]) => number) => {
        const nz = m.identity.bins.filter((b) => b.count > 0)
        const n = nz.reduce((a, b) => a + b.count, 0)
        return n === 0 ? NaN : nz.reduce((a, b) => a + sel(b) * b.count, 0) / n
      }
      const meanPred = wMean((b) => b.meanPredicted)
      const meanObs = wMean((b) => b.observed)
      const dir =
        meanPred < meanObs ? '欠自信→g 上调' : meanPred > meanObs ? '过自信→g 下压' : '已校准'
      console.log(
        `\n  ★ ECE: identity ${m.identity.ece.toFixed(4)} → g ${m.calibrated.ece.toFixed(4)}  (降 ${m.eceDrop.toFixed(4)}, ${m.eceDrop > 0 ? '✓' : '✗'} ${dir};留出 平均预测 ${meanPred.toFixed(3)} vs 观测 ${meanObs.toFixed(3)})`,
      )
    }
    console.log(
      `\n[m3c] 用时 ${secs}s。真管线端到端跑通 ${r.measurement && r.measurement.eceDrop > 0 ? '✓' : ''}`,
    )
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
  console.error('[m3c] 运行失败:', err)
  process.exitCode = 1
})
