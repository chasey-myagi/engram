/**
 * 确定性 fake entailment 判官（测试/CI 用，不联网）。默认一律判 'pass'；可注入 verdictOf 定制
 * （如按 claimText 命中合成幻觉判 'fail'）。暴露 callCount() 以便断言「每条 claim 恰调用一次 LLM」。
 */
import type { EntailmentJudge, EntailmentQuery, EntailmentVerdict } from './entailment-judge.js'

export interface FakeEntailmentJudgeOptions {
  version?: string
  /** 自定义判定（缺省一律 'pass'）。 */
  verdictOf?: (query: EntailmentQuery) => EntailmentVerdict
}

export function makeFakeEntailmentJudge(
  opts: FakeEntailmentJudgeOptions = {},
): EntailmentJudge & { callCount: () => number } {
  let calls = 0
  const verdictOf = opts.verdictOf ?? (() => 'pass' as EntailmentVerdict)
  return {
    version: opts.version ?? 'fake:entailment-v1',
    async judge(query: EntailmentQuery): Promise<EntailmentVerdict> {
      calls += 1
      return verdictOf(query)
    },
    callCount: () => calls,
  }
}
