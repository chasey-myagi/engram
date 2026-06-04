/**
 * 生产灰区判官：阿里 DashScope/Qwen（与 S9 嵌入同供应商）。读 DASHSCOPE_API_KEY。
 * 经 SameFactJudge 接口注入内核，**不在 CI/单测里跑**（联网 + 需 key）；本地有 key 时可跑 env-gated 冒烟。
 * 单条 input → 强制返回 {same|refines|contradicts|unrelated} 之一；非法/异常 → 抛（宁可拒判升级人，也不瞎合并）。
 */
import type { ClaimShape, SameFactJudge, SameFactVerdict } from './same-fact.js'

const DASHSCOPE_CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

const VERDICTS: readonly SameFactVerdict[] = ['same', 'refines', 'contradicts', 'unrelated']

const SYSTEM_PROMPT =
  'You judge whether two knowledge claims describe the SAME fact. ' +
  'Reply with EXACTLY ONE lowercase word, no punctuation: ' +
  '"same" (identical fact), "refines" (one is a more specific version of the other), ' +
  '"contradicts" (they assert incompatible things about the same subject), or "unrelated".'

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
}

export function makeDashScopeSameFactJudge(
  opts: { apiKey?: string; model?: string } = {},
): SameFactJudge {
  const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY
  const model = opts.model ?? 'qwen-plus'
  if (!apiKey) {
    throw new Error('makeDashScopeSameFactJudge: DASHSCOPE_API_KEY is not set')
  }
  return {
    version: `dashscope:${model}`,
    async judge(a: ClaimShape, b: ClaimShape): Promise<SameFactVerdict> {
      const user =
        `Claim A: ${a.claimText}\n` +
        `Claim B: ${b.claimText}\n` +
        'Do A and B describe the same fact? Answer with one word: same | refines | contradicts | unrelated.'
      const res = await fetch(DASHSCOPE_CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
          temperature: 0, // 判定要稳定可复现
        }),
      })
      if (!res.ok) {
        throw new Error(`DashScope judge failed: ${res.status} ${await res.text()}`)
      }
      const json = (await res.json()) as ChatResponse
      const raw = json.choices?.[0]?.message?.content?.trim().toLowerCase()
      const verdict = VERDICTS.find((v) => raw === v)
      if (!verdict) {
        throw new Error(`DashScope judge: unparseable verdict ${JSON.stringify(raw)}`)
      }
      return verdict
    },
  }
}
