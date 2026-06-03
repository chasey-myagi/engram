/**
 * Engram 内核 — agent 原生可生长知识库。
 * 一条 claim = 一个 engram。不是 RAG。
 *
 * 当前为地基骨架（实现 ≈ 0）。要建什么见 docs/PRD.md（附录 A = build-from 契约）。
 * 内核领域无关：只认 source / claim / relation / provenance / confidence。
 */
export const ENGRAM_VERSION = '0.0.0' as const
