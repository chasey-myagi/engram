import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeDashScopeSameFactJudge } from '../same-fact/dashscope-judge.js'

// Offline guard-path tests for the shipped DashScope/Qwen gray-zone judge — no network (fetch stubbed),
// no real key. The live API is exercised only manually (env-gated, out of CI).

afterEach(() => {
  vi.unstubAllGlobals()
})

const shape = (claimText: string) => ({ subject: null, predicate: null, object: null, claimText })

describe('makeDashScopeSameFactJudge — guard paths (offline)', () => {
  it('throws when no API key is provided', () => {
    expect(() => makeDashScopeSameFactJudge({ apiKey: '' })).toThrow(/DASHSCOPE_API_KEY/)
  })

  it('parses a valid one-word verdict from the chat completion', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'same\n' } }] }),
      }),
    )
    const j = makeDashScopeSameFactJudge({ apiKey: 'k' })
    expect(await j.judge(shape('a'), shape('b'))).toBe('same')
  })

  it('throws on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('upstream down') }),
    )
    const j = makeDashScopeSameFactJudge({ apiKey: 'k' })
    await expect(j.judge(shape('a'), shape('b'))).rejects.toThrow(/DashScope judge failed: 503/)
  })

  it('throws on an unparseable verdict (model went off-script)', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'well, it depends...' } }] }),
      }),
    )
    const j = makeDashScopeSameFactJudge({ apiKey: 'k' })
    await expect(j.judge(shape('a'), shape('b'))).rejects.toThrow(/unparseable verdict/)
  })

  it('reports a dashscope:<model> version', () => {
    expect(makeDashScopeSameFactJudge({ apiKey: 'k', model: 'qwen-plus' }).version).toBe(
      'dashscope:qwen-plus',
    )
  })
})
