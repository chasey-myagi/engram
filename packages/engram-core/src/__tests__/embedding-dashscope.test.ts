import { afterEach, describe, expect, it, vi } from 'vitest'

import { EMBEDDING_DIM } from '../embedding/embedder.js'
import { makeDashScopeEmbedder } from '../embedding/dashscope.js'

// Unit tests for the shipped DashScope embedder's pure guard paths — no network (fetch stubbed),
// no real key. The happy path against the live API is exercised only manually (env-gated, out of CI).

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('makeDashScopeEmbedder — guard paths (offline)', () => {
  it('throws when no API key is provided (empty apiKey, env ignored)', () => {
    expect(() => makeDashScopeEmbedder({ apiKey: '' })).toThrow(/DASHSCOPE_API_KEY/)
  })

  it('embeds query vs document with the correct asymmetric text_type', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).parameters.text_type)
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            output: {
              embeddings: [{ embedding: new Array(EMBEDDING_DIM).fill(0.01), text_index: 0 }],
            },
          }),
      })
    })
    const e = makeDashScopeEmbedder({ apiKey: 'k' })
    await e.embed('q', 'query')
    await e.embed('d', 'document')
    await e.embed('default') // defaults to document
    expect(seen).toEqual(['query', 'document', 'document'])
  })

  it('throws on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('upstream down') }),
    )
    const e = makeDashScopeEmbedder({ apiKey: 'k' })
    await expect(e.embed('x')).rejects.toThrow(/DashScope embed failed: 503/)
  })

  it('throws on an unexpected response shape (missing embeddings)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }))
    const e = makeDashScopeEmbedder({ apiKey: 'k' })
    await expect(e.embed('x')).rejects.toThrow(/unexpected response shape/)
  })

  it('throws when the returned vector has the wrong dimension', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            output: { embeddings: [{ embedding: [0.1, 0.2, 0.3], text_index: 0 }] },
          }),
      }),
    )
    const e = makeDashScopeEmbedder({ apiKey: 'k' })
    await expect(e.embed('x')).rejects.toThrow(/unexpected response shape/)
  })

  it('reports its version + dim + recall similarity floor for the dense semantic space', () => {
    const e = makeDashScopeEmbedder({ apiKey: 'k', model: 'text-embedding-v3' })
    expect(e.version).toBe('dashscope:text-embedding-v3')
    expect(e.dim).toBe(EMBEDDING_DIM)
    expect(e.minSimilarity).toBe(0.5)
  })
})
