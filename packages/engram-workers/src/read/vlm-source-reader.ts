/**
 * 生产视觉 SourceReader：阿里 DashScope/Qwen-VL（与 S9 嵌入、S14 灰区判官同供应商）。读 DASHSCOPE_API_KEY。
 * 经 SourceReader 接口注入工种，**不在 CI/单测里跑**（联网 + 需 key + 需图）；本地有 key 时可跑 env-gated 冒烟。
 *
 * 职责同 fake：把含图/复杂版面的源转录成**带 page+line locator 锚**的纯文本块（'p{page}:L{line}'），交抽取 loop。
 * 它**只感知、不抽 claim**——抽取/去重/冲突/commit 仍是 S15 脊柱的活。VLM 这种模型相关脏活隔在本实现里，
 * 工种只认 SourceReader 端口；换转录后端 = 换本文件，Distiller 一行不动（与 dashscope-judge.ts 同位）。
 *
 * 输入形态：ReadRequest.content 约定承载图像引用（如逐行 data-URI / URL，由领域适配器在 ingest 时填）。
 * 真实现把这些图送多模态模型，要求**逐页逐行**返回转录文本；解析失败 → 抛（宁可降级人工，也不吐错位 locator）。
 */
import {
  type ReadRequest,
  type ReadResult,
  type ReadSegment,
  type SourceReader,
} from './source-reader.js'

const DASHSCOPE_CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

const SYSTEM_PROMPT =
  'You transcribe an image-bearing document into plain text WITH layout anchors. ' +
  'For every line of visible text, output exactly one line prefixed by its anchor `p<page>:L<line>` then a TAB then the text, ' +
  'pages and lines both 1-based, in reading order. Output nothing else — no commentary, no markdown.'

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
}

/** 把模型返回的 'p1:L2\t文本' 逐行解析成 ReadSegment。无合法行 → 抛（不返空、不瞎造锚）。 */
function parseAnchoredLines(raw: string): ReadSegment[] {
  const segments: ReadSegment[] = []
  for (const line of raw.split('\n')) {
    const m = /^\s*(p\d+:L\d+)\t(.*)$/.exec(line.replace(/\r$/, ''))
    if (!m) continue
    const text = m[2]!.trim()
    if (text === '') continue
    segments.push({ locator: m[1]!, text })
  }
  if (segments.length === 0) {
    throw new Error('VLM reader: model returned no parseable `p<page>:L<line>\\t<text>` lines')
  }
  return segments
}

export function makeVlmSourceReader(opts: { apiKey?: string; model?: string } = {}): SourceReader {
  const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY
  const model = opts.model ?? 'qwen-vl-plus'
  if (!apiKey) {
    throw new Error('makeVlmSourceReader: DASHSCOPE_API_KEY is not set')
  }
  return {
    version: `vlm:${model}`,
    async read(req: ReadRequest): Promise<ReadResult> {
      const res = await fetch(DASHSCOPE_CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: req.content },
          ],
          temperature: 0, // 转录要稳定可复现
        }),
      })
      if (!res.ok) {
        throw new Error(`VLM reader failed: ${res.status} ${await res.text()}`)
      }
      const json = (await res.json()) as ChatResponse
      const raw = json.choices?.[0]?.message?.content ?? ''
      return {
        strategy: 'vlm',
        locatorHint:
          "image-bearing source transcribed via vision; cite the page+line, e.g. 'p3:L12'.",
        segments: parseAnchoredLines(raw),
        usedVision: true,
      }
    },
  }
}
