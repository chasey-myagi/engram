/**
 * L1 golden 隔离不变量（A.9 + 红线 #4）—— **无 DB、hermetic**。锁住三件不可破的事：
 *   ① A1-distinct：L1 是 per-agent 行为 golden（盯工种危险错），不是 A1「考卷=毒株」golden-question；
 *      它从不被写成 claim、不带 reward、不参与晋升。本测试断言 L1 fixture 形状里**没有** reward/answer 字段。
 *   ② 领域无关（A.9）：所有 fixture 文本不含 bidding 词面（SKU / 投标 / 标书 / tender / bid…），且不 import bidding golden。
 *   ③ 命名空间标签存在且非空（可观测）。
 *
 * 隔离的承重在**结构**（fixture 只临时 seed 进 per-test DB、随 DROP 消失、绝不经生产写路径落持久 claim ⇒ recall 永不
 * 召回，见各 runner + l1-namespace.ts），本测试守的是「fixture 本身不带晋升/reward 形状、不沾领域」这条静态红线。
 */
import { describe, expect, it } from 'vitest'

import { DISTILLER_GOLDEN } from '../l1-distiller.golden.js'
import { VERIFIER_GOLDEN } from '../l1-verifier.golden.js'
import { RECONCILER_INDEP_GOLDEN, RECONCILER_PAIR_GOLDEN } from '../l1-reconciler.golden.js'
import { ARBITER_GOLDEN } from '../l1-arbiter.golden.js'
import { L1_GOLDEN_NAMESPACE } from '../l1-namespace.js'

/** 全部 L1 golden 的可读文本面（用于领域无关词面扫描）。 */
function allGoldenText(): string {
  const parts: string[] = []
  for (const it of DISTILLER_GOLDEN) {
    parts.push(it.content)
    for (const c of it.claims) parts.push(c.claimText, c.drillsBackTo)
  }
  for (const it of VERIFIER_GOLDEN) parts.push(it.claimText, it.evidence, it.rationale)
  for (const it of RECONCILER_PAIR_GOLDEN) parts.push(it.anchorText, it.candidateText)
  for (const it of RECONCILER_INDEP_GOLDEN) parts.push(it.claimText)
  for (const it of ARBITER_GOLDEN) parts.push(it.query, it.rationale)
  return parts.join('\n').toLowerCase()
}

describe('S25 · L1 golden isolation invariants (hermetic) — A.9 + 红线#4', () => {
  it('domain-agnostic: no bidding/tender domain terms leak into any L1 fixture', () => {
    const text = allGoldenText()
    // bidding 领域词面（中英）—— L1 内核 golden 绝不沾领域；命中即说明有人混入了 bidding 数据。
    const forbidden = ['sku', 'tender', 'bid', 'bidding', '标书', '投标', '招标']
    for (const term of forbidden) {
      expect(text.includes(term), `forbidden domain term leaked into L1 golden: '${term}'`).toBe(
        false,
      )
    }
  })

  it('A1-distinct: L1 fixtures carry NO reward/answer/promotion shape (behavioral golden, not exam golden-questions)', () => {
    // 行为 golden 的 fixture 形状只描述「工种该怎么处置」（label/expect*/locator…），不含 reward/answer/golden-question
    // 这类「带奖赏的造题」字段（红线#4：那是 A1 考卷，须先过免疫流水线才晋升，刻意与 L1 分开）。
    const samples: Record<string, unknown>[] = [
      ...DISTILLER_GOLDEN.map((x) => x as unknown as Record<string, unknown>),
      ...VERIFIER_GOLDEN.map((x) => x as unknown as Record<string, unknown>),
      ...RECONCILER_PAIR_GOLDEN.map((x) => x as unknown as Record<string, unknown>),
      ...ARBITER_GOLDEN.map((x) => x as unknown as Record<string, unknown>),
    ]
    const examOnlyKeys = ['reward', 'answer', 'goldenQuestion', 'promote', 'isGolden']
    for (const s of samples) {
      for (const k of examOnlyKeys) {
        expect(
          Object.prototype.hasOwnProperty.call(s, k),
          `L1 fixture must not have exam key '${k}'`,
        ).toBe(false)
      }
    }
  })

  it('namespace label exists and is a non-empty observability tag (not load-bearing for isolation)', () => {
    expect(typeof L1_GOLDEN_NAMESPACE).toBe('string')
    expect(L1_GOLDEN_NAMESPACE.length).toBeGreaterThan(0)
  })
})
