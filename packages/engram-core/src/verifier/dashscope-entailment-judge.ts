/**
 * 生产 entailment 判官：阿里 DashScope/Qwen（与 S9 嵌入、S14 same-fact 判官同供应商）。读 DASHSCOPE_API_KEY。
 * 经 EntailmentJudge 接口注入内核，**不在 CI/单测里跑**（联网 + 需 key）；本地有 key 时可跑 env-gated 冒烟。
 * 点状一次 LLM：claim 文本 + 全部出处 → 强制返回 {pass|fail|not_co_true} 之一；非法/异常 → 抛
 * （Verifier 据「失败跳过本轮、下轮重试」吞掉，不崩、不无限重试）。
 */
import type {
  EntailmentJudge,
  EntailmentQuery,
  EntailmentVerdict,
} from './entailment-judge.js'

const DASHSCOPE_CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

const VERDICTS: readonly EntailmentVerdict[] = ['pass', 'fail', 'not_co_true']

const SYSTEM_PROMPT =
  'You are an entailment checker for a knowledge base. Given a CLAIM and its cited EVIDENCE (the source ' +
  'passages it was extracted from), decide whether the claim is logically derivable from that evidence. ' +
  'Reply with EXACTLY ONE lowercase token, no punctuation: ' +
  '"pass" (the claim is supported / derivable from the evidence), ' +
  '"fail" (the claim is NOT derivable / contradicts the evidence — a likely hallucination), or ' +
  '"not_co_true" (the claim cannot be simultaneously true with another asserted fact). ' +
  'When in doubt between pass and fail, prefer "fail".'

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
}

function renderEvidence(query: EntailmentQuery): string {
  if (query.evidence.length === 0) return '(no evidence — treat as unsupported)'
  return query.evidence
    .map((e, i) => {
      const ex = e.excerpt ? `\n  excerpt: ${e.excerpt}` : ''
      return `[${i + 1}] (relevance=${e.relevance}, locator=${e.locator})\n  ${e.sourceContent}${ex}`
    })
    .join('\n')
}

export function makeDashScopeEntailmentJudge(
  opts: { apiKey?: string; model?: string } = {},
): EntailmentJudge {
  const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY
  const model = opts.model ?? 'qwen-plus'
  if (!apiKey) {
    throw new Error('makeDashScopeEntailmentJudge: DASHSCOPE_API_KEY is not set')
  }
  return {
    version: `dashscope:${model}`,
    async judge(query: EntailmentQuery): Promise<EntailmentVerdict> {
      const triple =
        query.subject != null || query.predicate != null || query.object != null
          ? `Structured triple: (${query.subject ?? '?'} | ${query.predicate ?? '?'} | ${query.object ?? '?'})\n`
          : ''
      const user =
        `CLAIM: ${query.claimText}\n` +
        triple +
        `EVIDENCE:\n${renderEvidence(query)}\n` +
        'Is the CLAIM derivable from the EVIDENCE? Answer with one token: pass | fail | not_co_true.'
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
        throw new Error(`DashScope entailment judge failed: ${res.status} ${await res.text()}`)
      }
      const json = (await res.json()) as ChatResponse
      const raw = json.choices?.[0]?.message?.content?.trim().toLowerCase()
      const verdict = VERDICTS.find((v) => raw === v)
      if (!verdict) {
        throw new Error(`DashScope entailment judge: unparseable verdict ${JSON.stringify(raw)}`)
      }
      return verdict
    },
  }
}
