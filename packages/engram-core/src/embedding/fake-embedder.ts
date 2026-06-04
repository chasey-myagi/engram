/**
 * 确定性 fake 嵌入器（测试/离线用，不联网）。默认实现 = 小写字符三元组袋（bag-of-trigrams）哈希到 dim 维、L2 归一：
 * 共享子串 → 共享三元组 → cosine>0（近似「子串/大小写不敏感」匹配）；无交集 → 0。
 * 语义测试可经 opts.vectorOf 手工指定哪些文本相近（三元组袋做不出同义词）。
 */
import { EMBEDDING_DIM, type Embedder } from './embedder.js'

function trigramVector(text: string, dim: number): number[] {
  const s = ` ${text.toLowerCase().trim()} ` // 边界空格让首尾也成三元组
  const v = new Array<number>(dim).fill(0)
  for (let i = 0; i + 3 <= s.length; i++) {
    const g = s.slice(i, i + 3)
    let h = 2166136261 // FNV-1a，确定性哈希到 dim 维
    for (let j = 0; j < g.length; j++) {
      h ^= g.charCodeAt(j)
      h = Math.imul(h, 16777619)
    }
    v[(h >>> 0) % dim]! += 1
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

export interface FakeEmbedderOptions {
  version?: string
  /** 覆盖向量映射（语义测试用：手工指定相近文本）。缺省 = 字符三元组袋。 */
  vectorOf?: (text: string) => number[]
}

export function makeFakeEmbedder(opts: FakeEmbedderOptions = {}): Embedder {
  const version = opts.version ?? 'fake:trigram-v1'
  const vectorOf = opts.vectorOf ?? ((t: string) => trigramVector(t, EMBEDDING_DIM))
  return {
    version,
    dim: EMBEDDING_DIM,
    // 对称 fake：忽略 kind（query/document 同一映射），用 DEFAULT_RECALL_MIN_SIMILARITY。
    embed: (text: string) => Promise.resolve(vectorOf(text)),
  }
}
