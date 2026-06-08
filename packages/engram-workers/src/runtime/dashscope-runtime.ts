/**
 * 生产 agent loop 运行时:阿里 DashScope Qwen chat(OpenAI 兼容端点),经 pi-ai 的 `openai-completions` provider。
 * 给 Distiller/Arbiter 等有界 loop 用(测试注 createFakeModel,生产注本工厂)。读 DASHSCOPE_API_KEY(对齐官方 SDK 惯例)。
 *
 * apiKey 经 AgentSession.llmOptions 透传给 pi-ai complete()(`options.apiKey` 优先于 env);compat 由 baseUrl 自动探测
 * (DashScope compatible-mode = OpenAI chat/completions 兼容)。**不在 CI/单测里跑**(联网 + 需 key)。
 */
import { makeOpenAICompatibleModel, type Model } from '@harness-pi/core'

import type { AgentRuntime } from './port.js'
import { makeHarnessPiRuntime } from './harness-pi.js'

const DASHSCOPE_COMPAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/**
 * 造一个指向 DashScope compatible-mode 的 Qwen chat Model。harness-pi 0.2.1 的 makeOpenAICompatibleModel
 * 帮手(闭 DX #38):返回具体 `Model<'openai-completions'>`、零 `as Model` cast、reasoning/input/cost 用默认
 * (cost 默认 {0,0,0,0}——自定义 model 无官方 USD 价;compat 省略交 pi-ai 按 baseUrl 自动探测)。
 */
export function makeQwenChatModel(opts: { model?: string } = {}): Model<'openai-completions'> {
  return makeOpenAICompatibleModel({
    id: opts.model ?? 'qwen-plus',
    baseUrl: DASHSCOPE_COMPAT_URL,
    provider: 'dashscope', // 仅作标签:apiKey 经 llmOptions 显式给,不走 getEnvApiKey(provider)
    contextWindow: 131072,
    maxTokens: 8192,
  })
}

/** 真 Qwen chat 运行时(env-gated)。默认 qwen-plus;apiKey 取 DASHSCOPE_API_KEY 或显式传入。 */
export function makeQwenRuntime(opts: { apiKey?: string; model?: string } = {}): AgentRuntime {
  const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY
  if (!apiKey) {
    throw new Error('makeQwenRuntime: DASHSCOPE_API_KEY is not set')
  }
  // makeOpenAICompatibleModel 的 Model<'openai-completions'> 隐式 widen 到 makeHarnessPiRuntime 要的 Model<Api>。
  const model = makeQwenChatModel(opts.model !== undefined ? { model: opts.model } : {})
  return makeHarnessPiRuntime(model, { llmOptions: { apiKey } })
}
