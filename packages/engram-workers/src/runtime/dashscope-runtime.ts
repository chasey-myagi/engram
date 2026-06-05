/**
 * 生产 agent loop 运行时:阿里 DashScope Qwen chat(OpenAI 兼容端点),经 pi-ai 的 `openai-completions` provider。
 * 给 Distiller/Arbiter 等有界 loop 用(测试注 createFakeModel,生产注本工厂)。读 DASHSCOPE_API_KEY(对齐官方 SDK 惯例)。
 *
 * apiKey 经 AgentSession.llmOptions 透传给 pi-ai complete()(`options.apiKey` 优先于 env);compat 由 baseUrl 自动探测
 * (DashScope compatible-mode = OpenAI chat/completions 兼容)。**不在 CI/单测里跑**(联网 + 需 key)。
 */
import type { Api, Model } from '@harness-pi/core'

import type { AgentRuntime } from './port.js'
import { makeHarnessPiRuntime } from './harness-pi.js'

const DASHSCOPE_COMPAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** 造一个指向 DashScope compatible-mode 的 Qwen chat Model(pi-ai openai-completions)。 */
export function makeQwenChatModel(opts: { model?: string } = {}): Model<'openai-completions'> {
  const id = opts.model ?? 'qwen-plus'
  return {
    id,
    name: `Qwen (${id}, DashScope)`,
    api: 'openai-completions',
    provider: 'dashscope', // 仅作标签:apiKey 经 llmOptions 显式给,不走 getEnvApiKey(provider)。
    baseUrl: DASHSCOPE_COMPAT_URL,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  }
}

/** 真 Qwen chat 运行时(env-gated)。默认 qwen-plus;apiKey 取 DASHSCOPE_API_KEY 或显式传入。 */
export function makeQwenRuntime(opts: { apiKey?: string; model?: string } = {}): AgentRuntime {
  const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY
  if (!apiKey) {
    throw new Error('makeQwenRuntime: DASHSCOPE_API_KEY is not set')
  }
  const model = makeQwenChatModel(
    opts.model !== undefined ? { model: opts.model } : {},
  ) as Model<Api>
  return makeHarnessPiRuntime(model, { llmOptions: { apiKey } })
}
