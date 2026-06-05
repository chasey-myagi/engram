/**
 * 确定性 fake SourceReader（测试 / CI / 离线用，不联网）—— 与 makeFakeEmbedder / makeFakeSameFactJudge 同位。
 *
 * 按 kind 选读法，把 source.content 切成**带 locator 锚的块**。锚都从原文**结构**派生（行号 / 行列 / 轮次 / 段序…），
 * 因此「钻回」是真的：locator 唯一定位到原文某处。含图 kind（默认 formal_document，或 hasImages=true）走**fake VLM 通道**：
 * 把内容当「已转录的版面文本」按页/行重锚为 'pN:LM'，usedVision=true——证明视觉路径被选中，但零网络、确定性。
 *
 * 解析约定（领域无关、纯结构）：
 *   table（TSV：含 \t 且 ≥2 列）        → 'cell:R{r}C{c}'（r/c 从 1 起；含表头行）
 *   structured_spec（非表格的逐行）      → 'L{n}'
 *   conversation_log（'speaker: text'） → 'turn:{n}'
 *   human_qa（Q:/A: 配对，或逐行）       → 'qa:{n}'
 *   historical_artifact（空行分段）      → 'seg:{n}'
 *   agent_synthesis（'## 标题' 分节）    → 'sec:{n}'
 *   external_feed（逐行 / '---' 分条）   → 'item:{n}'
 *   formal_document / 含图（VLM）        → 'p{page}:L{line}'（'\f' 或 '--- PAGE n ---' 分页）
 */
import type { SourceKind } from '@engram/core'

import {
  defaultHasImages,
  type ReadRequest,
  type ReadResult,
  type ReadSegment,
  type SourceReader,
} from './source-reader.js'

export interface FakeSourceReaderOptions {
  version?: string
}

function nonEmptyLines(content: string): string[] {
  return content.split('\n').map((l) => l.replace(/\r$/, ''))
}

/** TSV 表格：'cell:R{r}C{c}'，每个非空单元格一块（含表头）。空单元格跳过。 */
function readTable(content: string): ReadSegment[] {
  const segments: ReadSegment[] = []
  const rows = nonEmptyLines(content).filter((l) => l.trim() !== '')
  rows.forEach((row, ri) => {
    row.split('\t').forEach((cell, ci) => {
      const text = cell.trim()
      if (text === '') return
      segments.push({ locator: `cell:R${ri + 1}C${ci + 1}`, text })
    })
  })
  return segments
}

/** 逐行 'L{n}'（行号按原文物理行算，跳过空行但行号不塌缩——锚=真实行号，钻回精确）。 */
function readLines(content: string): ReadSegment[] {
  const segments: ReadSegment[] = []
  nonEmptyLines(content).forEach((line, i) => {
    const text = line.trim()
    if (text === '') return
    segments.push({ locator: `L${i + 1}`, text })
  })
  return segments
}

/** 对话逐字稿：'turn:{n}'，每行一轮（'speaker: utterance'，原样留 speaker 前缀）。 */
function readTurns(content: string): ReadSegment[] {
  const segments: ReadSegment[] = []
  let turn = 0
  for (const line of nonEmptyLines(content)) {
    const text = line.trim()
    if (text === '') continue
    turn += 1
    segments.push({ locator: `turn:${turn}`, text })
  }
  return segments
}

/** 人类问答：'qa:{n}'。每个 'Q:' 起一对，后续行（含 'A:'）并入当前问答对；无显式 Q: 时退化为逐行一对。 */
function readQa(content: string): ReadSegment[] {
  const lines = nonEmptyLines(content).filter((l) => l.trim() !== '')
  const hasQ = lines.some((l) => /^q\s*:/i.test(l.trim()))
  if (!hasQ) return lines.map((l, i) => ({ locator: `qa:${i + 1}`, text: l.trim() }))
  const segments: ReadSegment[] = []
  let pair = 0
  let buf: string[] = []
  const flush = () => {
    if (buf.length) {
      segments.push({ locator: `qa:${pair}`, text: buf.join(' ') })
      buf = []
    }
  }
  for (const line of lines) {
    const t = line.trim()
    if (/^q\s*:/i.test(t)) {
      flush()
      pair += 1
    }
    buf.push(t)
  }
  flush()
  return segments
}

/** 历史制品：空行分段 → 'seg:{n}'。 */
function readSegments(content: string): ReadSegment[] {
  const blocks = content
    .split(/\n\s*\n/)
    .map((b) => b.trim().replace(/\s+/g, ' '))
    .filter((b) => b !== '')
  return blocks.map((b, i) => ({ locator: `seg:${i + 1}`, text: b }))
}

/** agent 综述：'## 标题' 分节 → 'sec:{n}'。无标题时退化为空行分段（仍记 sec:）。 */
function readSections(content: string): ReadSegment[] {
  const lines = nonEmptyLines(content)
  const hasHeadings = lines.some((l) => /^#{1,6}\s/.test(l.trim()))
  if (!hasHeadings) {
    return readSegments(content).map((s, i) => ({ locator: `sec:${i + 1}`, text: s.text }))
  }
  const segments: ReadSegment[] = []
  let sec = 0
  let buf: string[] = []
  const flush = () => {
    if (buf.length) {
      segments.push({ locator: `sec:${sec}`, text: buf.join(' ').trim() })
      buf = []
    }
  }
  for (const line of lines) {
    const t = line.trim()
    if (/^#{1,6}\s/.test(t)) {
      flush()
      sec += 1
    }
    if (t !== '') buf.push(t.replace(/^#{1,6}\s+/, ''))
  }
  flush()
  return segments
}

/** 外部流：'---' 分条或逐行 → 'item:{n}'。 */
function readItems(content: string): ReadSegment[] {
  const raw = content.includes('---') ? content.split(/^\s*---\s*$/m) : nonEmptyLines(content)
  const items = raw.map((b) => b.trim().replace(/\s+/g, ' ')).filter((b) => b !== '')
  return items.map((b, i) => ({ locator: `item:${i + 1}`, text: b }))
}

/**
 * fake VLM 通道：把含图源的内容当「已转录版面文本」，按页（'\f' 或 '--- PAGE n ---'）+ 行重锚为 'p{page}:L{line}'。
 * 真实现里这一步是把图像送 VLM 拿回带版面坐标的文本；fake 用文本结构确定性地模拟同形锚，证明视觉路径被选中。
 */
function readVision(content: string): ReadSegment[] {
  const pages = content.split(/\f|^\s*---\s*PAGE\s+\d+\s*---\s*$/im)
  const segments: ReadSegment[] = []
  pages.forEach((page, pi) => {
    nonEmptyLines(page).forEach((line, li) => {
      const text = line.trim()
      if (text === '') return
      segments.push({ locator: `p${pi + 1}:L${li + 1}`, text })
    })
  })
  return segments
}

interface Strategy {
  name: string
  hint: string
  parse: (content: string) => ReadSegment[]
}

function isTsv(content: string): boolean {
  const rows = nonEmptyLines(content).filter((l) => l.trim() !== '')
  return rows.length > 0 && rows.every((r) => r.includes('\t'))
}

/** 选策略：含图（VLM）优先；否则按 kind。structured_spec 据内容形态在 table / lines 间二选一。 */
function selectStrategy(req: ReadRequest): Strategy {
  const vision = req.hasImages ?? defaultHasImages(req.kind)
  if (vision) {
    return {
      name: 'vlm',
      hint: "image-bearing source transcribed via vision; cite the page+line of the transcribed text, e.g. 'p3:L12'.",
      parse: readVision,
    }
  }
  const byKind: Record<SourceKind, Strategy> = {
    formal_document: { name: 'layout', hint: "cite page+line, e.g. 'p3:L12'.", parse: readVision },
    structured_spec: isTsv(req.content)
      ? {
          name: 'table',
          hint: "tabular source; cite the cell as 'cell:R<row>C<col>' (1-based, header is row 1).",
          parse: readTable,
        }
      : { name: 'lines', hint: "cite the source line as 'L<n>'.", parse: readLines },
    human_qa: { name: 'qa', hint: "cite the Q/A pair as 'qa:<n>'.", parse: readQa },
    conversation_log: {
      name: 'turns',
      hint: "conversation transcript; cite the turn as 'turn:<n>' (1-based).",
      parse: readTurns,
    },
    historical_artifact: {
      name: 'segments',
      hint: "cite the paragraph as 'seg:<n>'.",
      parse: readSegments,
    },
    agent_synthesis: {
      name: 'sections',
      hint: "cite the section as 'sec:<n>'.",
      parse: readSections,
    },
    external_feed: { name: 'items', hint: "cite the feed item as 'item:<n>'.", parse: readItems },
  }
  // byKind 对 SourceKind 全集穷举 → req.kind 必有；noUncheckedIndexedAccess 下断言非空。
  return byKind[req.kind]!
}

export function makeFakeSourceReader(opts: FakeSourceReaderOptions = {}): SourceReader {
  return {
    version: opts.version ?? 'fake:reader-v1',
    read(req: ReadRequest): Promise<ReadResult> {
      const strat = selectStrategy(req)
      const segments = strat.parse(req.content)
      return Promise.resolve({
        strategy: strat.name,
        locatorHint: strat.hint,
        segments,
        usedVision: strat.name === 'vlm',
      })
    },
  }
}
