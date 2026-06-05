/**
 * 真 Qwen chat 运行时接线的 CI 守门(不联网):makeQwenChatModel 形状 / makeQwenRuntime env-gating /
 * makeHarnessPiRuntime 透传 llmOptions 向后兼容(不破 fake-model 路径)。真 Qwen 调用 env-gated、不进 CI。
 */
import { describe, expect, it } from 'vitest'

import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { makeQwenChatModel, makeQwenRuntime } from '../runtime/dashscope-runtime.js'
import { makeHarnessPiRuntime } from '../runtime/harness-pi.js'

describe('真 Qwen chat 运行时接线', () => {
  it('makeQwenChatModel:openai-completions + DashScope compatible-mode 端点 + 可换型号', () => {
    const m = makeQwenChatModel()
    expect(m.api).toBe('openai-completions')
    expect(m.baseUrl).toContain('dashscope.aliyuncs.com/compatible-mode')
    expect(m.id).toBe('qwen-plus')
    expect(m.input).toContain('text')
    expect(makeQwenChatModel({ model: 'qwen-max' }).id).toBe('qwen-max')
  })

  it('makeQwenRuntime:无 DASHSCOPE_API_KEY 抛错(env-gated);显式传 key 不抛', () => {
    const saved = process.env.DASHSCOPE_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    try {
      expect(() => makeQwenRuntime()).toThrow(/DASHSCOPE_API_KEY/)
    } finally {
      if (saved !== undefined) process.env.DASHSCOPE_API_KEY = saved
    }
    expect(() => makeQwenRuntime({ apiKey: 'sk-test-not-used-offline' })).not.toThrow()
  })

  it('makeHarnessPiRuntime 透传 llmOptions:不破 fake-model 路径(向后兼容)', async () => {
    let got: unknown = null
    const script: FakeAssistantResponse[] = [
      {
        content: [{ type: 'toolCall', id: 'tc1', name: 'echo', arguments: { text: 'hi' } }],
        stopReason: 'toolUse',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
    ]
    const rt = makeHarnessPiRuntime(createFakeModel(script), {
      llmOptions: { apiKey: 'ignored-by-fake' },
    })
    const res = await rt.run({
      systemPrompt: 'tool agent',
      prompt: 'call echo',
      maxTurns: 3,
      tools: [
        {
          name: 'echo',
          description: 'echo text',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
          execute: async (args: Record<string, unknown>) => {
            got = args.text
            return { text: `echoed ${String(args.text)}` }
          },
        },
      ],
    })
    expect(res.reason).toBeTruthy()
    expect(got).toBe('hi') // fake model 仍正常驱动工具调用,llmOptions 透传无副作用
  })
})
