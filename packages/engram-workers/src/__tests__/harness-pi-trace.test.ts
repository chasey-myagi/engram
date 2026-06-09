/**
 * S2 · harness-pi adapter 的 agent-loop 可观测采集(不再 drain)——CI 守门(fake model,零网络)。
 *
 * 验:adapter 把 AgentSession 的 RunSummary.usage + 工具调用 rollup 接进 AgentRunResult.{usage,trace}:
 *  ① 工具调用计数/名字 + token 用量被捕获(原 adapter 只回 {reason,turns});
 *  ② 工具出错(isError)计入 toolErrors;
 *  ③ token **不重复计数**(一次 run = 一个独立 session ⇒ summary.usage 即本轮量);
 *  ④ trace.toolNames 是深拷贝、且每次 run 计数独立(纯观测、决策不变)。
 */
import { describe, expect, it } from 'vitest'

import { createFakeModel, type FakeAssistantResponse } from '@harness-pi/core/testing'

import { makeHarnessPiRuntime } from '../runtime/harness-pi.js'
import type { AgentTool } from '../runtime/port.js'

const echoTool: AgentTool = {
  name: 'echo',
  description: 'echo text',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (args) => ({ text: `echoed ${String(args.text)}` }),
}
const boomTool: AgentTool = {
  name: 'boom',
  description: 'always errors',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ text: 'kaboom', isError: true }),
}
const throwTool: AgentTool = {
  name: 'kaboom',
  description: 'execute throws',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    throw new Error('kaboom thrown')
  },
}

function run(script: FakeAssistantResponse[], tools: AgentTool[]) {
  return makeHarnessPiRuntime(createFakeModel(script)).run({
    systemPrompt: 'tool agent',
    prompt: 'go',
    maxTurns: 5,
    tools,
  })
}

describe('S2 · harness-pi agent-loop 采集(usage + 工具 rollup)', () => {
  it('① 捕获工具 rollup + token 用量(不再丢弃 summary 数据)', async () => {
    const res = await run(
      [
        {
          content: [{ type: 'toolCall', id: '1', name: 'echo', arguments: { text: 'hi' } }],
          stopReason: 'toolUse',
          usage: { input: 10, output: 4 },
        },
        {
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
          usage: { input: 7, output: 3 },
        },
      ],
      [echoTool],
    )
    expect(res.reason).toBe('done')
    expect(res.trace).toBeDefined()
    expect(res.trace!.toolCalls).toBe(1)
    expect(res.trace!.toolErrors).toBe(0)
    expect(res.trace!.toolNames).toEqual(['echo'])
    expect(res.usage).toBeDefined()
    expect(res.usage!.totalTokens).toBeGreaterThan(0)
  })

  it('② 工具出错计入 toolErrors(isError)', async () => {
    const res = await run(
      [
        {
          content: [{ type: 'toolCall', id: '1', name: 'boom', arguments: {} }],
          stopReason: 'toolUse',
        },
        { content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' },
      ],
      [boomTool],
    )
    expect(res.trace!.toolCalls).toBe(1)
    expect(res.trace!.toolErrors).toBe(1)
    expect(res.trace!.toolNames).toEqual(['boom'])
  })

  it('③ token 不重复计数:summary.usage = 本轮(fresh session)累计,= 两条 response 之和', async () => {
    const res = await run(
      [
        {
          content: [{ type: 'toolCall', id: '1', name: 'echo', arguments: { text: 'a' } }],
          stopReason: 'toolUse',
          usage: { input: 10, output: 4 },
        },
        {
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
          usage: { input: 7, output: 3 },
        },
      ],
      [echoTool],
    )
    // 一次 run = 一个独立 session ⇒ 不会把上一 run 的量叠进来;两条 assistant usage 求和、各计一次。
    expect(res.usage!.inputTokens).toBe(17)
    expect(res.usage!.outputTokens).toBe(7)
    // totalTokens 独立从 summary.usage.totalTokens 接(非 alias inputTokens):(10+4)+(7+3)=24。
    expect(res.usage!.totalTokens).toBe(24)
  })

  it('⑤ 工具 execute **抛异常**:计入 toolErrors 且原样上抛(被上游转 isError、loop 续跑到 done)', async () => {
    const res = await run(
      [
        {
          content: [{ type: 'toolCall', id: '1', name: 'kaboom', arguments: {} }],
          stopReason: 'toolUse',
        },
        { content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' },
      ],
      [throwTool],
    )
    // 错误被原样上抛 → harness-pi 工具执行器转成 isError 回灌 → loop 没崩、续跑到 done(决策不变红线)。
    expect(res.reason).toBe('done')
    expect(res.trace!.toolCalls).toBe(1)
    expect(res.trace!.toolErrors).toBe(1) // catch 分支记了一笔(防回归:漏掉 +1 或不 re-throw 都会被本测抓住)
  })

  it('⑥ toolNames 去重 + 按首次出现序;toolCalls 计全部次数', async () => {
    const res = await run(
      [
        {
          content: [{ type: 'toolCall', id: '1', name: 'echo', arguments: { text: 'a' } }],
          stopReason: 'toolUse',
        },
        {
          content: [{ type: 'toolCall', id: '2', name: 'boom', arguments: {} }],
          stopReason: 'toolUse',
        },
        {
          content: [{ type: 'toolCall', id: '3', name: 'echo', arguments: { text: 'c' } }],
          stopReason: 'toolUse',
        },
        { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
      ],
      [echoTool, boomTool],
    )
    expect(res.trace!.toolCalls).toBe(3) // 全部调用次数
    expect(res.trace!.toolNames).toEqual(['echo', 'boom']) // 去重 + 首次出现序(echo 先于 boom)
  })

  it('④ 每次 run 计数独立 + 返回 trace 可安全改写(深拷贝、不串味)', async () => {
    // createFakeModel 的 script 单次消费,故每次 run 用全新 fake(否则第二次脚本耗尽)。
    const mk = () =>
      makeHarnessPiRuntime(
        createFakeModel([
          {
            content: [{ type: 'toolCall', id: '1', name: 'echo', arguments: { text: 'x' } }],
            stopReason: 'toolUse',
          },
          { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
        ]),
      )
    const req = { systemPrompt: 's', prompt: 'go', maxTurns: 5, tools: [echoTool] }
    const r1 = await mk().run(req)
    expect(r1.trace!.toolNames).toEqual(['echo'])
    r1.trace!.toolNames.push('MUTATED') // 改返回值(它是 [...toolNames] 深拷贝)
    const r2 = await mk().run(req) // 全新 run / 全新计数
    expect(r2.trace!.toolNames).toEqual(['echo']) // 不受 r1 改写影响 ⇒ per-run 独立 + 返回深拷贝
    expect(r2.trace!.toolCalls).toBe(1)
  })
})
