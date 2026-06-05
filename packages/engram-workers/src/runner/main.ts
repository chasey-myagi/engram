/**
 * P4b · 可跑 demo 入口（北极星「能跑起来」）。运行：
 *   docker compose up -d db   # pgvector :5433
 *   pnpm -r build
 *   node packages/engram-workers/dist/runner/main.js
 *
 * 自包含：自建一次性库、迁移、用 EngramRunner 跑一拍 **live 闭环**（一源摄入 → 五工种声明触发级联到收敛 →
 * 恒温器一步 → 首次校准一拍）+ 一回合 **红蓝对抗北极星**（sandbox：红队造题 → A1 题免疫 → 蓝队=消费者答题 →
 * 判分 → 单环归因 → 漏检 escalate 下一代），把遥测打印出来，最后清库。
 *
 * 离线自洽：distiller/arbiter 的有界 loop 注入**脚本化 fake model**（@harness-pi/core/testing），embedder/judge/reader
 * 都用 fake 端口 —— 整条管线在本机零外部依赖跑起来。换生产：把 distiller.runtime 换 harness-pi+真 model、embedder
 * 换 makeDashScopeEmbedder、judge 换 DashScope 端口即可（EngramRunner 与 deps 解耦，同一 runner 两路都跑）。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import {
  addSource,
  createDb,
  makeFakeEmbedder,
  makeFakeEntailmentJudge,
  makeFakeSameFactJudge,
  type RedTeamItem,
} from '@engram/core'

import { makeFakeSourceReader } from '../read/fake-source-reader.js'
import { makeHarnessPiRuntime } from '../runtime/harness-pi.js'
import { REDTEAM_GENERATION_ITEMS } from '../eval/redteam.gen.js'
import { EngramRunner } from './engram-runner.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'engram-core',
  'drizzle',
)

let tc = 0
const commit = (args: Record<string, unknown>): FakeAssistantResponse => ({
  content: [{ type: 'toolCall', id: `tc${++tc}`, name: 'commit_claim', arguments: args }],
  stopReason: 'toolUse',
})
const adjudicate = (a: string, b: string): FakeAssistantResponse => ({
  content: [
    {
      type: 'toolCall',
      id: `tc${++tc}`,
      name: 'adjudicate_conflict',
      arguments: { claimA: a, claimB: b },
    },
  ],
  stopReason: 'toolUse',
})
const finish = (): FakeAssistantResponse => ({
  content: [{ type: 'toolCall', id: `tc${++tc}`, name: 'finish', arguments: {} }],
  stopReason: 'toolUse',
})
const stop: FakeAssistantResponse = {
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'stop',
}

function oneOfEachClass(): RedTeamItem[] {
  const classes = ['false', 'contradiction', 'stale', 'near_dup_poison'] as const
  return classes.map((c) => REDTEAM_GENERATION_ITEMS.find((i) => i.redteamClass === c)!)
}

async function main(): Promise<void> {
  const dbName = `engram_demo_${randomUUID().replace(/-/g, '')}`
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  await admin.query(`CREATE DATABASE ${dbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${dbName}`
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  const db = createDb(pool)

  try {
    await migrate(db, { migrationsFolder })
    console.log(`[engram] 临时库 ${dbName} 已建 + 迁移完成。`)

    const embedder = makeFakeEmbedder()
    const entailment = makeFakeEntailmentJudge({ verdictOf: () => 'pass' })
    const runner = new EngramRunner({
      db,
      embedder,
      distiller: {
        db,
        embedder,
        judge: makeFakeSameFactJudge(),
        runtime: makeHarnessPiRuntime(
          createFakeModel([
            commit({
              claimText: 'widget-7 max load 50kg',
              subject: 'widget-7',
              predicate: 'max-load',
              object: '50kg',
              locator: 'L1',
            }),
            finish(),
            stop,
          ]),
        ),
        reader: makeFakeSourceReader(),
      },
      verifier: { db, judge: entailment },
      reconciler: { db, judge: entailment },
      harvester: { db },
      arbiterRuntimeFor: (pairs) =>
        makeHarnessPiRuntime(
          createFakeModel([...pairs.map(([a, b]) => adjudicate(a, b)), finish(), stop]),
        ),
    })
    console.log(`[engram] 工种接线：${runner.registeredWorkers().join(' · ')}`)

    // ── live 闭环一拍：摄入一源 → 级联 → 恒温器 → 校准。 ──
    const { sourceId } = await addSource(db, {
      content: 'spec sheet: widget-7 max load 50kg',
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.9,
    })
    const loop = await runner.runClosedLoop({ sources: [sourceId] })
    const cascade = loop.ingests[0]!.result
    console.log('\n=== live 闭环一拍 ===')
    console.log(
      `  级联触达工种：${JSON.stringify(cascade.firedByWorker)}（失效=${cascade.failures}，截断=${cascade.truncated}）`,
    )
    console.log(
      `  恒温器：ran=${loop.governance.ran} changed=${loop.governance.changed ?? false} raisedGate=${loop.governance.raisedGate ?? false}`,
    )
    console.log(
      `  首次校准：${loop.recalibrate.fitted ? `fitted(samples=${loop.recalibrate.sampleCount}, swapped=${loop.recalibrate.swapResult.swapped})` : `未拟合(${loop.recalibrate.reason}, samples=${loop.recalibrate.sampleCount}) — g 维持 identity（诚实）`}`,
    )

    // ── 红蓝对抗北极星一回合（sandbox）。 ──
    const resetWorkTables = async (): Promise<void> => {
      await pool.query(
        'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, l5_candidates, golden_questions, promotion_audit CASCADE',
      )
    }
    const round = await runner.adversarialRound({
      generationVersion: `demo-gen-${randomUUID().slice(0, 8)}`,
      items: oneOfEachClass(),
      resetWorkTables,
    })
    console.log('\n=== 红蓝对抗北极星一回合 ===')
    console.log(
      `  A1 题免疫：进被计分 ${round.scoredItemIds.length} / BLOCK ${round.blockedItemIds.length}`,
    )
    for (const s of round.classScores) {
      console.log(
        `  [${s.redteamClass}] 检出 ${s.detected}/${s.injected}（detectionRate=${s.detectionRate}）`,
      )
    }
    console.log(`  breach(漏检+单环归因)：${round.breaches.length}`)
    console.log(
      `  下一代更难题：${round.nextGeneration.items.length} 条（冻结=${round.nextGeneration.frozen}）`,
    )
    console.log('\n[engram] 北极星闭环 demo 跑通 ✓')
  } finally {
    await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  }
}

main().catch((err: unknown) => {
  console.error('[engram] demo 失败：', err)
  process.exitCode = 1
})
