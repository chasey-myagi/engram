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

import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunTrace,
  AgentRunUsage,
  AgentRuntime,
} from './port.js'

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
      // 工具调用 run-level rollup:在 execute 包装里**纯观测**计数(不改执行/顺序/结果 ⇒ 决策不变)。S2 可观测第三层。
      let toolCalls = 0
      let toolErrors = 0
      const toolNames: string[] = []
      const tools: HarnessTool[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        // 端口的 plain JSON Schema 直接当 pi-ai Tool.parameters（其校验器走 JSON-Schema 回退分支）。
        parameters: t.parameters as unknown as HarnessTool['parameters'],
        async execute(args) {
          toolCalls += 1
          if (!toolNames.includes(t.name)) toolNames.push(t.name)
          try {
            const r = await t.execute(args)
            if (r.isError) toolErrors += 1
            return {
              content: [{ type: 'text' as const, text: r.text }],
              ...(r.isError !== undefined ? { isError: r.isError } : {}),
            }
          } catch (err) {
            toolErrors += 1
            throw err // 原样上抛(harness-pi 工具执行器转 isError 回灌)——只先记一笔,行为不变
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
      // 仍把 loop 跑完(events 驱动 loop 推进);不再丢弃 summary 数据——下面把 usage + 工具 rollup 接出去(S2)。
      for await (const _event of stream) {
        // drive the loop
      }
      const summary = await stream.finalSummary
      // 一次 run = 一个独立 session ⇒ summary.usage(session 累计)即本轮量,无跨 run 重复(内核总填充,零 LLM 为零值)。
      // 深拷贝标量(不 alias summary 内部对象);reasoning token pi-ai Usage 暂无,缺则省略。
      const u = summary.usage
      const usage: AgentRunUsage | undefined = u
        ? { inputTokens: u.input, outputTokens: u.output, totalTokens: u.totalTokens }
        : undefined
      const trace: AgentRunTrace = { toolCalls, toolErrors, toolNames: [...toolNames] }
      return {
        reason: summary.reason,
        turns: summary.turns,
        ...(usage !== undefined ? { usage } : {}),
        trace,
      }
    },
  }
}
