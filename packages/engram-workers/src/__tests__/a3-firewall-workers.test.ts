/**
 * A3 防火墙 · workers 侧(永久 CI 门)—— 闭合 S1 gate 指出的「core-only 覆盖缺口」:g-fit 的**驱动者**(Harvester
 * 工种 + EngramRunner 的 recalibrate/recompute tick)住在 @engram/workers,core 的 firewall 扫不到它们。
 *
 * 同 core 的 **deny-by-default** 模型:扫**整个 workers/src**(去 .test.ts + allowlist)⇒ 任何文件出现 trace/decision
 * 符号即越界。allowlist = **合法触碰 trace/decision 的非 g 路径文件**:
 *   - S5 起:distiller.ts / arbiter.ts(它们 emit trace、产 claim,不 fit g)显式加入;
 *   - S8 起:eval/decision-value/*(决策实验,落 decision_eval)显式加入。
 * Harvester / EngramRunner 永不进 allowlist ⇒ g 驱动路径永远被守。今日(S3)无 worker 引用 trace,allowlist 为空。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/** trace/决策世界**独有**的符号 / 表名 / 模块路径 / SPI 名。注意大小写敏感:port 的类型 `AgentRunTrace`(大写 A)
 * 不是表符号 `agentRunTrace`(小写 a),不在此列——故 harness-pi/index 用 port 类型不会误报。 */
const FORBIDDEN_TOKENS = [
  'agentRunTrace',
  'decisionEval',
  'agent_run_trace',
  'decision_eval',
  'agent-run-trace',
  'recordAgentRun',
  'getAgentRunTrace',
  'recordDecisionEval',
  'getDecisionEval',
]

/** 允许触碰 trace/decision 的非 g 路径文件(相对 workers/src)。S5/S8 显式扩;Harvester/Runner 永不入此集。 */
const ALLOWLIST = new Set<string>([
  'distiller.ts', // S5:产 claim + emit run trace(recordAgentRun),非 g-fit 路径
  'arbiter.ts', // S5:裁冲突 + emit run trace,非 g-fit 路径
])

function scanForbidden(text: string): string[] {
  return FORBIDDEN_TOKENS.filter((tok) => text.includes(tok))
}

function guardedFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        if (!ALLOWLIST.has(relative(SRC, p))) out.push(p)
      }
    }
  }
  walk(SRC)
  return out
}

describe('A3 防火墙 · workers 侧(g 驱动者 Harvester/Runner 永不触 trace/decision)', () => {
  it('① 整个 workers/src(deny-by-default)无文件引用 trace/decision', () => {
    const files = guardedFiles()
    const violations: { file: string; tokens: string[] }[] = []
    for (const f of files) {
      const hits = scanForbidden(readFileSync(f, 'utf8'))
      if (hits.length > 0) violations.push({ file: relative(SRC, f), tokens: hits })
    }
    expect(violations).toEqual([])
    expect(files.length).toBeGreaterThanOrEqual(15) // 守护集 = 几乎整个 workers/src(防 walk 失效空过)
    // Harvester 与 Runner(g 驱动者)必在守护集内(绝不被 allowlist 排除)。
    const guarded = new Set(files.map((f) => relative(SRC, f)))
    expect(guarded.has('harvester.ts')).toBe(true)
    expect(guarded.has('runner/engram-runner.ts')).toBe(true)
  })

  it('② 毒株负对照:扫描器对引用违禁符号的 fixture 必报', () => {
    const poison = [
      `import { recordAgentRun } from '@engram/core'`,
      `import { decisionEval, agentRunTrace } from '@engram/core'`,
      `const _ = recordDecisionEval`,
    ].join('\n')
    const hits = scanForbidden(poison)
    expect(hits).toContain('recordAgentRun')
    expect(hits).toContain('decisionEval')
    expect(hits).toContain('agentRunTrace')
    expect(hits).toContain('recordDecisionEval')
  })
})
