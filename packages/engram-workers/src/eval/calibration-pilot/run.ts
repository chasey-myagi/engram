/**
 * M2 校准 pilot · 可跑入口(env-gated:需 DASHSCOPE_API_KEY + 网络)。运行:
 *   docker compose up -d db
 *   pnpm -r build
 *   node packages/engram-workers/dist/eval/calibration-pilot/run.js
 *
 * 自建一次性库 → 真 Qwen 嵌入(text-embedding-v3)seed 接地语料 → 真 recall 产 usage → isotonic 拟合 g →
 * 在留出集上打印**第一张真 reliability diagram + ECE(identity vs g)**,完后清库。
 *
 * 诚实范围见 corpus.ts:受控实验(真值已知、provenance 注入过自信),验校准闭环在真嵌入+真 usage 上闭合、g 压低 ECE。
 * 非真实世界 ECE 数字(那要 M3 真实未受控语料)。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

import { createDb, makeDashScopeEmbedder } from '@engram/core'

import { assertCalibrationPilotPass, renderReliability, runCalibrationPilot } from './pilot.js'

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

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  return xs[Math.round(p * (xs.length - 1))]!
}

async function main(): Promise<void> {
  if (!process.env.DASHSCOPE_API_KEY) {
    console.error(
      '[m2] DASHSCOPE_API_KEY 未设置 —— 本 pilot 需真 Qwen 嵌入。先 export DASHSCOPE_API_KEY。',
    )
    process.exitCode = 1
    return
  }
  const dbName = `engram_m2_${Math.abs(hashStr(new URL(import.meta.url).pathname + DATABASE_URL)).toString(36)}_${process.pid}`
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
    console.log(`[m2] 临时库 ${dbName} 已建 + 迁移。用真 DashScope text-embedding-v3。`)

    const embedder = makeDashScopeEmbedder()
    const { seed, usage, measurement, persistedSamples } = await runCalibrationPilot(
      db,
      embedder,
      {},
    )

    console.log('\n=== seed(接地语料) ===')
    console.log(
      `  事实 ${seed.total} 条;晋升 active ${seed.promoted} 条。raw 分布:min ${seed.rawSorted[0]?.toFixed(3)} / p50 ${pct(seed.rawSorted, 0.5).toFixed(3)} / max ${seed.rawSorted.at(-1)?.toFixed(3)}`,
    )
    console.log('\n=== usage(真 recall + 标签 oracle) ===')
    console.log(
      `  recall 命中 ${usage.recallHits} / 漏 ${usage.recallMisses};usage_truth 行 ${usage.usageRows};SPI 读回样本 ${persistedSamples}`,
    )
    console.log('\n=== 校准测量(按 fact 切分,留出=未见事实) ===')
    console.log(
      `  样本 ${measurement.totalSamples}(fit ${measurement.fitCount} / heldout ${measurement.heldoutCount});g 结点 ${measurement.fittedG.knots.length};事实跨边 ${measurement.factsInBothSides}(须 0)`,
    )
    console.log('\n  -- identity g(未校准:raw 当预测) --')
    console.log(renderReliability(measurement.identity))
    console.log('\n  -- isotonic g(校准后:g(raw) 当预测) --')
    console.log(renderReliability(measurement.calibrated))
    console.log(
      `\n  ★ ECE: identity ${measurement.identity.ece.toFixed(4)} → g ${measurement.calibrated.ece.toFixed(4)}  (降 ${measurement.eceDrop.toFixed(4)}, ${measurement.eceDrop > 0 ? '✓ g 把校准误差压下了' : '✗ 未改善'})`,
    )
    // 结果门(fail-loud):样本不足 / heldout 空 / ECE 未改善等诊断失败即 throw → 落到 main().catch → process.exitCode = 1。
    // 绝不在诊断失败时无条件打印"跑通 ✓"。
    assertCalibrationPilotPass(usage, measurement)
    console.log('\n[m2] 校准 pilot 跑通 ✓')
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
  console.error('[m2] pilot 失败:', err)
  process.exitCode = 1
})
