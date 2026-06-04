/**
 * 嵌入器接口（A.6）。内核只依赖这个接口，对具体模型零认知：
 *   - 生产 = DashScope text-embedding-v3（embedding/dashscope.ts，env-gated，不进 CI）。
 *   - 测试 = 注入的确定性 fake（embedding/fake-embedder.ts），不联网、可复现。
 * version 即 embedding_version 锚：模型/版本变了 version 就变，据此识别需要重嵌的历史向量（S9 reembed_marker）。
 */
import { EMBEDDING_DIM } from '../db/schema.js'

export { EMBEDDING_DIM }

/** 嵌入用途。非对称模型（DashScope text-embedding-v3）query/document 各自空间；对称/fake 忽略。 */
export type EmbedKind = 'query' | 'document'

export interface Embedder {
  /** 版本锚，写进 claim.embedding_version；变更触发 reembed。 */
  readonly version: string
  /** 向量维度（必须等于 schema 的 EMBEDDING_DIM）。 */
  readonly dim: number
  /** 本嵌入空间推荐的召回相似度下界（可选）；recall 取 ctx.minSimilarity ?? 这个 ?? DEFAULT。 */
  readonly minSimilarity?: number
  /** kind 默认 'document'（写入 claim 用）；recall 给 query 算向量时传 'query'。 */
  embed(text: string, kind?: EmbedKind): Promise<number[]>
}

/** 召回 HNSW 近邻取的候选数（A.6 top-k=50）。 */
export const DEFAULT_RECALL_TOPK = 50

/**
 * 召回候选的 cosine 相似度下界（默认）。低于此的近邻视为不相关、不进候选（避免小库下 top-k 把无关项也吐出）。
 * 取值依赖嵌入空间：fake 子串空间里相关项 sim≫0.1、无关项=0；真模型(DashScope)语义空间应调高(~0.5)。
 */
export const DEFAULT_RECALL_MIN_SIMILARITY = 0.1
