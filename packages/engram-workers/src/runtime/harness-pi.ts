/**
 * harness-pi adapter —— 把 AgentRuntime 端口落到 `@harness-pi/core` 的 AgentSession 上。
 * **本文件是整个 engram 里唯一 import `@harness-pi/core` 的地方**：换 agent loop 只改这一处。
 *
 * 用一个 pi-ai Model 构造运行时：测试注 `createFakeModel(...)`（脚本化 toolCall，零网络/CI 可跑），
 * 生产注真 DashScope/Qwen model（env-gated）。pi-ai 的校验器对 plain JSON Schema 有回退路径，
 * 故端口的 plain-object parameters 可直接透传，无需 TypeBox。
 */
import {
  AgentSession,
  type Api,
  type HarnessTool,
  type LlmOptions,
  type Model,
} from '@harness-pi/core'

import type { AgentRunRequest, AgentRunResult, AgentRuntime } from './port.js'

/**
 * harness-pi 运行时选项。llmOptions 透传给 pi-ai complete()（如真 model 的 `apiKey`)；signal 由 session 覆盖。
 * 0.2.1 起用 typed `LlmOptions`(闭 DX #39):`{apikey}` 这类 typo 编译期失败;provider 私有键走具名 `providerExtras`。
 */
export interface HarnessPiRuntimeOptions {
  llmOptions?: LlmOptions
}

export function makeHarnessPiRuntime(
  model: Model<Api>,
  opts: HarnessPiRuntimeOptions = {},
): AgentRuntime {
  return {
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      const tools: HarnessTool[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        // 端口的 plain JSON Schema 直接当 pi-ai Tool.parameters（其校验器走 JSON-Schema 回退分支）。
        parameters: t.parameters as unknown as HarnessTool['parameters'],
        async execute(args) {
          const r = await t.execute(args)
          return {
            content: [{ type: 'text' as const, text: r.text }],
            ...(r.isError !== undefined ? { isError: r.isError } : {}),
          }
        },
      }))
      const session = new AgentSession({
        model,
        tools,
        systemPrompt: req.systemPrompt,
        maxTurns: req.maxTurns,
        // 透传 provider options(真 model 的 apiKey 等);fake model 不读、无害。
        ...(opts.llmOptions !== undefined ? { llmOptions: opts.llmOptions } : {}),
      })
      const stream = session.runStreaming(req.prompt)
      // 把 loop 跑完（S15 暂不转发 live 事件 —— streaming sink 是后续 adapter 的事）。
      for await (const _event of stream) {
        // drain
      }
      const summary = await stream.finalSummary
      return { reason: summary.reason, turns: summary.turns }
    },
  }
}
