/**
 * M3-A(lean)真抽取冒烟 · 可跑入口(env-gated:需 DASHSCOPE_API_KEY + 网络)。运行:
 *   docker compose up -d db
 *   pnpm -r build
 *   M3A_LIMIT=3 node packages/engram-workers/dist/eval/realworld-ece/run.js   # 先 3 条微冒烟,核对接线 + 数真调用
 *   node packages/engram-workers/dist/eval/realworld-ece/run.js               # 全 36 条
 *
 * **唯一真花费 = 真 Qwen Distiller 的 loop**(embedder/judge/reader 全用确定性 fake:它们不是本冒烟要验的东西,
 * 也不烧额度)。验三件事:① 真 Qwen 把散文文档**忠实抽取**成 claim(一文档恰一条、不漏不裂);② 产出的
 * emergent raw 符合公式 0.3·auth+0.075(单源 indep=0、entail 中性);③ 这些新鲜 claim **0 晋升**(全卡 conf<0.5 门)。
 * ⇒ 实证「光抽取测空集是设计使然」在**真模型**下也成立。真 ECE 曲线需多源印证+Verifier(见 AskUserQuestion 的 Option C)。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

import { createDb, makeFakeEmbedder, makeFakeSameFactJudge } from '@engram/core'

import { makeFakeSourceReader } from '../../read/fake-source-reader.js'
import { makeQwenRuntime } from '../../runtime/dashscope-runtime.js'
import { buildRealWorldCorpus } from './corpus.js'
import { ingestCorpus, promoteEligible, type RealWorldDeps } from './harness.js'

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
      '[m3a] DASHSCOPE_API_KEY 未设置 —— 本冒烟需真 Qwen。先 export DASHSCOPE_API_KEY。',
    )
    process.exitCode = 1
    return
  }
  const limit = process.env.M3A_LIMIT ? Math.max(1, Number(process.env.M3A_LIMIT)) : undefined
  const allFacts = buildRealWorldCorpus()
  const facts = limit ? allFacts.slice(0, limit) : allFacts

  const dbName = `engram_m3a_${Math.abs(hashStr(DATABASE_URL)).toString(36)}_${process.pid}`
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

    const deps: RealWorldDeps = {
      db,
      embedder: makeFakeEmbedder(), // 不烧额度;raw 不依赖嵌入、本冒烟不 recall
      judge: makeFakeSameFactJudge(), // 不烧额度;不同事实不并、合并逻辑已在 core 单测覆盖
      runtime: makeQwenRuntime(), // ★ 唯一真花费:真 Qwen Distiller
      reader: makeFakeSourceReader(), // 确定性散文分块,无 VLM
    }
    console.log(
      `[m3a] 临时库 ${dbName} 已建 + 迁移。真 Qwen Distiller × ${facts.length} 文档(单源)。embedder/judge/reader=fake。`,
    )

    const t0 = Date.now()
    const ingest = await ingestCorpus(deps, facts, { sourcesPerFact: 1 })
    const promo = await promoteEligible(deps, facts, ingest.claimsByFact, { entailmentPass: true })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)

    const claimsPerFact = facts.map((f) => ingest.claimsByFact.get(f.id)?.length ?? 0)
    const faithful = claimsPerFact.filter((c) => c === 1).length

    console.log('\n=== ① 忠实抽取(真 Qwen) ===')
    console.log(
      `  文档 ${facts.length};distill done ${ingest.distillDone} / human_pending ${ingest.distillHumanPending};commit 总数 ${ingest.committedTotal}`,
    )
    console.log(
      `  恰一条 claim 的文档:${faithful}/${facts.length}(漏抽=0 条的 / 裂成 ≥2 条的 = ${facts.length - faithful} 个偏差)`,
    )

    console.log('\n=== ② emergent raw 分布(应 ≈ 0.3·auth+0.075,单源) ===')
    console.log(
      `  raw:min ${pct(promo.rawSorted, 0)} / p50 ${pct(promo.rawSorted, 0.5)} / max ${pct(promo.rawSorted, 1)}(晋升门 0.5)`,
    )
    // 抽样核对公式(前 5 条)。
    const byFact = new Map(facts.map((f) => [f.id, f]))
    for (const o of promo.outcomes.slice(0, 5)) {
      const f = byFact.get(o.factId)!
      const expected = (0.3 * f.sourceAuthority + 0.075).toFixed(3)
      console.log(
        `    ${o.factId} auth=${f.sourceAuthority} → raw=${o.raw?.toFixed(3) ?? 'n/a'}(公式 ${expected})  "${f.docText}"`,
      )
    }

    console.log('\n=== ③ 晋升门 ===')
    console.log(
      `  晋升 ${promo.promoted} / 被拦 ${promo.blocked} / 无 claim ${promo.noClaim};距门最近的 raw=${pct(promo.rawSorted, 1)}(差 ${(0.5 - Number(pct(promo.rawSorted, 1))).toFixed(3)})`,
    )
    const sampleBlock = promo.outcomes.find((o) => !o.promoted && o.reason.startsWith('blocked'))
    if (sampleBlock) console.log(`  拦截原因样例:${sampleBlock.reason}`)

    const verdict =
      faithful === facts.length && promo.promoted === 0
        ? '✓ 真 Qwen 忠实抽取 + 0 晋升 —— 实证「extraction-only 测空集」在真模型下成立'
        : '⚠ 出现偏差(见上),需人看:真 Qwen 抽取非「一文档一条」或有意外晋升'
    console.log(`\n[m3a] 用时 ${secs}s。${verdict}`)
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
  console.error('[m3a] 冒烟失败:', err)
  process.exitCode = 1
})
