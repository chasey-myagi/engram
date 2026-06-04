/**
 * SourceReader 端口（S16 · read_source 「① 读懂」阶段）—— Distiller 五阶段脊柱的**感知层**抽象。
 *
 * 职责单一：把一条**异构 source**（结构化文本 / 表格 / 对话逐字稿 / 含图文档 …）归一成一段**带 locator 锚的纯文本渲染**，
 * 连同「本 kind 该用什么 locator 形状」一起交给抽取 loop（stage ②）。它**不抽 claim、不碰 DB**——抽取/去重/冲突/commit
 * 仍由 S15 的有界 loop + commitClaim 原样承担（NO 第二条管线）。只有「按 kind 选哪个读法」这件事在 S16 长出来。
 *
 * 为什么要端口：含图 kind 需要 VLM、复杂版式可能需要真模型转录——这些**模型/供应商相关**的脏活必须隔在注入式端口后，
 * 内核/工种保持领域无关、零硬编码 VLM/LLM 调用。与 Embedder / SameFactJudge 完全同一套式样：
 *   - 测试 / CI = 注入**确定性 fake**（read/fake-source-reader.ts），不联网、可复现。
 *   - 生产含图 kind = 注入 **env-gated 真 VLM reader**（read/vlm-source-reader.ts），不进 CI。
 * 工种逻辑只依赖本接口；换 VLM/转录后端 = 换一个 reader 实现，Distiller 一行不动。
 *
 * locator 形状按 kind（A.1 `claim_provenance.locator` 是 text 列，锚就是字符串，可点击钻回）：
 *   formal_document     → 页/行          'p3:L12'      （含版式/图 → 默认走 VLM 转录）
 *   structured_spec     → 行/cell        'L7' / 'cell:R4C2'（表格化时退化为 cell）
 *   conversation_log    → 轮次            'turn:7'
 *   human_qa            → 问答对          'qa:3'
 *   historical_artifact → 段落            'seg:5'
 *   agent_synthesis     → 节              'sec:2'
 *   external_feed       → 条目            'item:9'
 *   含图任意 kind        → VLM 区域        'vlm:p1#r2'（由 reader 决定，落进同一 locator 列）
 */
import type { SourceKind } from '@engram/core'

/** 一条规范化后的「可定位文本块」：locator 锚 + 该块文本（抽取 loop 据此 cite）。 */
export interface ReadSegment {
  /** 该块在原文中的 locator 锚（页/行/cell/turn…），原样进 claim_provenance.locator。 */
  locator: string
  /** 该块的纯文本内容（VLM 转录 / 表格单元格值 / 对话单轮 …）。 */
  text: string
}

/** read_source 的产物：归一渲染 + 给抽取 loop 的 locator 形状提示 + 是否走了视觉通道。 */
export interface ReadResult {
  /** 选中的策略名（layout/table/turns/qa/segments/sections/items/vlm）。供可观测/断言。 */
  strategy: string
  /** 本 kind 的 locator 形状说明（注进 system prompt，告诉 LLM 该 cite 成什么样）。 */
  locatorHint: string
  /** 带锚的分块。抽取 loop 读这些块、按块的 locator cite。 */
  segments: ReadSegment[]
  /** 本次 read 是否动用了视觉通道（VLM）。纯文本路径 = false。 */
  usedVision: boolean
}

/** read 的输入（工种从 getSource 拿到的最小投影 + 可选已知是否含图）。 */
export interface ReadRequest {
  kind: SourceKind
  content: string
  /** 领域适配器可显式标注「此源含图、应走视觉通道」（缺省按 kind 默认判定）。 */
  hasImages?: boolean
}

/**
 * SourceReader 端口。一次 read = 把一条 source 归一成带 locator 锚的分块。
 * 模型无关：含图/复杂版式的真转录经实现注入，工种只认本接口。
 */
export interface SourceReader {
  /** 版本锚（fake / vlm:<model>…），供可观测与回归对照。 */
  readonly version: string
  read(req: ReadRequest): Promise<ReadResult>
}

/**
 * S16 起 Distiller 能读的全部 7 个 source_kind（A.1 枚举全集）。S15 只有 structured_spec / human_qa；
 * 其余五类的读法在 S16 长齐。**不在此集合内 = reader 不认 = 降级人工**（沿用 S15 的 markSourceHumanPending，不新开降级路径）。
 */
export const READABLE_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>([
  'formal_document',
  'structured_spec',
  'human_qa',
  'conversation_log',
  'historical_artifact',
  'agent_synthesis',
  'external_feed',
])

/** 按 kind 默认是否含图（含图 → 走 VLM 视觉通道）。formal_document 默认含版式/图，可被 ReadRequest.hasImages 覆盖。 */
export function defaultHasImages(kind: SourceKind): boolean {
  return kind === 'formal_document'
}
