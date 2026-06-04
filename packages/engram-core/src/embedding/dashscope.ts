/**
 * 生产嵌入器：阿里 DashScope text-embedding-v3（1024 维）。读 DASHSCOPE_API_KEY（对齐官方 SDK 惯例）。
 * 经 Embedder 接口注入内核，**不在 CI/单测里跑**（联网 + 需 key）；本地有 key 时可跑 env-gated 冒烟测试。
 */
import { EMBEDDING_DIM, type EmbedKind, type Embedder } from './embedder.js'

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
    // 真模型语义空间的**召回候选**下界（远高于 fake 的 0.1）。注意 A.6 的 0.75/0.65 是 **lineage 同事实判定**
    // (S14) 的阈值、不是 recall 候选门；召回这里取 0.5 起步，consumer 可经 ctx.minSimilarity 再调。
    minSimilarity: 0.5,
    async embed(text: string, kind: EmbedKind = 'document'): Promise<number[]> {
      const res = await fetch(DASHSCOPE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: { texts: [text] },
          // text-embedding-v3 非对称：query/document 各自空间，必须按用途区分
          parameters: { dimension: EMBEDDING_DIM, text_type: kind },
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
