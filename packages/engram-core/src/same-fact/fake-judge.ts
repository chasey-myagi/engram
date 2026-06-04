/**
 * 确定性 fake same-fact 判官（测试/CI 用，不联网）。默认一律判 'unrelated'；可注入 verdictOf 定制。
 * 暴露 callCount() 以便断言「灰区恰调用一次 LLM」。
 */
import type { ClaimShape, SameFactJudge, SameFactVerdict } from './same-fact.js'

export interface FakeJudgeOptions {
  version?: string
  /** 自定义判定（缺省一律 'unrelated'）。 */
  verdictOf?: (a: ClaimShape, b: ClaimShape) => SameFactVerdict
}

export function makeFakeSameFactJudge(
  opts: FakeJudgeOptions = {},
): SameFactJudge & { callCount: () => number } {
  let calls = 0
  const verdictOf = opts.verdictOf ?? (() => 'unrelated' as SameFactVerdict)
  return {
    version: opts.version ?? 'fake:judge-v1',
    async judge(a: ClaimShape, b: ClaimShape): Promise<SameFactVerdict> {
      calls += 1
      return verdictOf(a, b)
    },
    callCount: () => calls,
  }
}
