/**
 * 生产嵌入器：阿里 DashScope text-embedding-v3（1024 维）。读 DASHSCOPE_API_KEY（对齐官方 SDK 惯例）。
 * 经 Embedder 接口注入内核，**不在 CI/单测里跑**（联网 + 需 key）；本地有 key 时可跑 env-gated 冒烟测试。
 */
import { EMBEDDING_DIM, type Embedder } from './embedder.js'

const DASHSCOPE_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding'

interface DashScopeResponse {
  output?: { embeddings?: { embedding: number[]; text_index: number }[] }
}

export function makeDashScopeEmbedder(opts: { apiKey?: string; model?: string } = {}): Embedder {
  const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY
  const model = opts.model ?? 'text-embedding-v3'
  if (!apiKey) {
    throw new Error('makeDashScopeEmbedder: DASHSCOPE_API_KEY is not set')
  }
  return {
    version: `dashscope:${model}`,
    dim: EMBEDDING_DIM,
    async embed(text: string): Promise<number[]> {
      const res = await fetch(DASHSCOPE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: { texts: [text] },
          parameters: { dimension: EMBEDDING_DIM, text_type: 'document' },
        }),
      })
      if (!res.ok) {
        throw new Error(`DashScope embed failed: ${res.status} ${await res.text()}`)
      }
      const json = (await res.json()) as DashScopeResponse
      const emb = json.output?.embeddings?.[0]?.embedding
      if (!emb || emb.length !== EMBEDDING_DIM) {
        throw new Error(`DashScope embed: unexpected response shape (dim ${emb?.length})`)
      }
      return emb
    },
  }
}
