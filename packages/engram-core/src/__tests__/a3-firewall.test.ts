/**
 * A3 防火墙(永久 CI 门)—— 结构性钉死「trace / 决策 ops 信号**永不**进 g 校准或纵向趋势」(命门红线 A3,anti-Goodhart)。
 *
 * 可观测性(agent_run_trace)与 Plan A 决策计分(decision_eval)是**纯 ops/eval** 表。本测静态保证:
 *   ① import-graph:校准 / 纵向 / 在线召回-置信 的全部模块**永不**引用 trace/decision 表或其 SPI(子串扫,含注释也算 smell);
 *   ② 毒株负对照:对一段**故意引用**违禁符号的 fixture,扫描器必须**报出**(证明 ① 不是空过);
 *   ③ g 拟合器(fit-from-usage)只读 claim_verification kind='usage_truth',不碰 trace/decision;
 *   ④ RECOMPETE_DIMENSIONS 冻结 = {ece,coverage}(ELO/trace/决策维度物理写不进纵向);
 *   ⑤ 冻结枚举(verification_kind / metrics_event_kind)字节不变(防有人往里塞 trace kind 绕过独立表)。
 *
 * 这是 S1「防火墙先行」的承重交付:在任何采集/写入代码(S2+)落地**之前**就位,且每轮 CI 永久守护。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { metricsEventKind, verificationKind } from '../db/schema.js'
import { RECOMPETE_DIMENSIONS } from '../eval/longitudinal-recompete.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/** trace/决策世界**独有**的符号 / 表名 / 模块路径 / SPI 名(现有 + S2–S9 将引入的)。校准/判断侧出现任一即越界。 */
const FORBIDDEN_TOKENS = [
  'agentRunTrace',
  'decisionEval', // schema 表符号
  'agent_run_trace',
  'decision_eval', // 原始表名
  'agent-run-trace',
  'agent-trace', // 可能的模块文件名
  'decision-value', // 决策实验目录
  'recordAgentRun',
  'getAgentRunTrace', // trace SPI(S3)
  'recordDecisionEval',
  'getDecisionEval', // 决策计分 SPI(S8)
]

/** 返回文本中出现的违禁 token(子串扫:校准/判断模块里这些 token 根本不该出现,含注释亦是 smell)。 */
function scanForbidden(text: string): string[] {
  return FORBIDDEN_TOKENS.filter((tok) => text.includes(tok))
}

/**
 * **deny-by-default**:守护集 = 整个 core/src(递归)**减去** allowlist 与测试文件。新文件自动受护——
 * 不再维护会漂移的手挑白名单(上一版漏了真实 g 喂养面:eval/system-dimensions(纵向维度的真实产出者)、
 * spi/report-usage(usage_truth 写入处)、harvest/recompute 等)。allowlist = 唯一**允许**触碰 trace/decision 的文件:
 * db/schema.ts(定义这两张表本身)。S3 起 trace SPI 模块路径须**显式**加进 allowlist(= 一次经评审的裁断:
 * 该模块允许碰 trace、且本身不在 g/纵向/在线判据路径上)。其余任何 core 文件出现 trace/decision token = 越界。
 */
const ALLOWLIST = new Set<string>([
  'db/schema.ts', // 定义 agent_run_trace/decision_eval 表本身
  'observability/agent-trace.ts', // S3 trace sink SPI:唯一合法读写 agent_run_trace 的模块(只留痕、不进 g/纵向)
  'observability/decision-eval.ts', // S8 decision_eval sink SPI:唯一合法读写 decision_eval 的模块(只记决策实验、不读 usage_truth/不触 g——③b 钉死)
  'index.ts', // 公共 barrel:re-export trace/decision SPI 给外部消费方(workers S5/S8)。非 laundering 口子——任何 g 路径
  // 文件即便经 ../index.js 导入 SPI,其**自身文本**也会出现 recordAgentRun/recordDecisionEval 等 token → 仍被扫出。
])

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

describe('A3 防火墙:trace/决策 ops 信号永不进 g/纵向(结构性、永久 CI 门)', () => {
  it('① 整个 core/src(deny-by-default)无任何文件引用 trace/decision(import-graph 静态钉死)', () => {
    const files = guardedFiles()
    const violations: { file: string; tokens: string[] }[] = []
    for (const f of files) {
      const hits = scanForbidden(readFileSync(f, 'utf8'))
      if (hits.length > 0) violations.push({ file: relative(SRC, f), tokens: hits })
    }
    expect(violations).toEqual([])
    // 守护集 = 几乎整个 core/src(防 walk 失效导致空过):core 现有 ≥40 个非测试 .ts。
    expect(files.length).toBeGreaterThanOrEqual(40)
    // db/schema.ts 必须在 allowlist 外被排除(它合法定义这两张表)——否则①会因 schema 自身误红。
    expect(files.some((f) => relative(SRC, f) === 'db/schema.ts')).toBe(false)
  })

  it('② 毒株负对照:扫描器对引用**全部**违禁符号的 fixture 必报(证明①非空过、每个 token 都覆盖)', () => {
    const poison = [
      `import { agentRunTrace, decisionEval } from '../db/schema.js'`,
      `import { recordAgentRun, getAgentRunTrace } from '../observability/agent-trace.js'`,
      `import { recordDecisionEval, getDecisionEval } from '../eval/decision-value/decision-eval.js'`,
      `// raw refs: agent_run_trace decision_eval agent-run-trace decision-value`,
    ].join('\n')
    expect([...scanForbidden(poison)].sort()).toEqual([...FORBIDDEN_TOKENS].sort())
  })

  it('③ g 拟合器只读 usage_truth、不碰 trace/decision', () => {
    const fitter = readFileSync(join(SRC, 'calibration', 'fit-from-usage.ts'), 'utf8')
    expect(fitter).toContain('usage_truth') // 燃料只认真消费真值流
    expect(scanForbidden(fitter)).toEqual([]) // 且绝不引用 trace/decision
  })

  it('③b 对偶(S8):decision_eval sink 只记决策实验、**绝不**反向触 g-燃料(usage_truth / 拟合 / 取样)', () => {
    // ③ 守「g 不读决策」;③b 守反方向「决策不喂 g」——decision-eval.ts 不得出现任何 g-燃料符号,
    // 否则 Plan A 决策指标可能从这里渗回 g(Goodhart)。两条对偶断言夹死 A3 双向隔离。
    const sink = readFileSync(join(SRC, 'observability', 'decision-eval.ts'), 'utf8')
    for (const fuel of ['usage_truth', 'fitIsotonic', 'collectUsage', 'reportUsage', 'applyGMap']) {
      expect(sink.includes(fuel)).toBe(false)
    }
  })

  it('④ RECOMPETE_DIMENSIONS 冻结 = {ece, coverage}(纵向 Δ 物理上无路承载 trace/决策信号)', () => {
    expect([...RECOMPETE_DIMENSIONS].sort()).toEqual(['coverage', 'ece'])
  })

  it('⑤ 冻结枚举字节不变(无 trace kind 被塞进 verification_kind / metrics_event_kind)', () => {
    expect([...verificationKind.enumValues]).toEqual(['patrol', 'usage_truth', 'reembed_marker'])
    expect([...metricsEventKind.enumValues]).toEqual([
      'gap_recorded',
      'source_human_pending',
      'conflict_adjudicated',
      'ruling_refused',
      'human_overturn',
    ])
  })
})
