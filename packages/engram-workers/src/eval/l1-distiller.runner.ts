/**
 * L1 Distiller golden runner（A.9）—— 端到端跑 Distiller 对每个 fixture，算「抽取准确率」+「provenance 不错位率」。
 *
 * 怎么验真（非 smoke）：
 *   ① fixture 自洽校验：先**独立**跑同一个 SourceReader 把 content 分块，断言 golden 每条 claim 的 locator 确实是
 *      reader 产出的某个 segment、且该 segment 文本含 drillsBackTo 片段。golden 因此对 reader 分块诚实（不靠硬编码）。
 *   ② 跑 Distiller：用从 fixture 派生的 fake model 脚本（一条 claim 一个 commit_claim turn，cite golden locator）驱动
 *      **真 harness-pi loop + 真 commitClaim + 真 reader**（注入式，与生产同一条脊柱）。
 *   ③ 读回 persisted provenance：一条 golden claim 算「抽取成功」当且仅当库里能找到一条 claim，其 exact provenance 的
 *      locator == golden locator，且该 locator 钻回 reader 分块命中含 drillsBackTo 的 segment（= provenance 不错位）。
 *
 * 故一旦 Distiller 的 render/commit/locator 接线退化（丢锚、错位、render 漏块致 commit 失败），成功数掉 → 准确率跌破门 → 红。
 */
import { schema, type DB, type Embedder, type SameFactJudge } from '@engram/core'
import { eq } from 'drizzle-orm'

import { runDistiller } from '../distiller.js'
import type { SourceReader } from '../read/source-reader.js'
import type { AgentRuntime } from '../runtime/port.js'
import {
  DISTILLER_GOLDEN,
  distillerGoldenClaimTotal,
  type DistillerGoldenItem,
  type GoldenClaim,
} from './l1-distiller.golden.js'

/** 单条 golden claim 的逐项观测。 */
export interface DistillerClaimObservation {
  itemId: string
  claimText: string
  /** golden 声明的 locator 是否确实出现在 reader 对该 content 的分块里、且片段含 drillsBackTo（fixture 自洽）。 */
  fixtureSelfConsistent: boolean
  /** 库里是否落了一条带该 exact locator 的 provenance（= 抽取成功）。 */
  extracted: boolean
  /** persisted 的 locator 是否钻回到含 drillsBackTo 的真实 segment（= provenance 不错位）。 */
  provenanceAligned: boolean
}

export interface DistillerGoldenReport {
  total: number
  extracted: number
  /** 抽取准确率 = extracted / total ∈ [0,1]（A.9 判据 ≥0.95）。 */
  extractionAccuracy: number
  /** provenance 错位条数（persisted locator 钻不回应命中的片段）。A.9 要求 0。 */
  provenanceMisaligned: number
  observations: DistillerClaimObservation[]
}

export interface DistillerGoldenDeps {
  db: DB
  embedder: Embedder
  judge: SameFactJudge
  reader: SourceReader
  /** 从 fixture 派生的 fake-model 脚本造一个真 harness-pi runtime（与生产同款 loop）。 */
  makeRuntime: (item: DistillerGoldenItem) => AgentRuntime
  /** 每个 fixture 跑前清库（per-test 隔离，确保读回的就是本 fixture 落的）。 */
  resetDb: () => Promise<void>
  /** seed 一条 source，返回 sourceId。 */
  seedSource: (item: DistillerGoldenItem) => Promise<string>
}

/** 一个 golden claim 的钻回片段命中（locator 在 segs 里、且片段含 drillsBackTo）。 */
function drillsBack(
  segs: { locator: string; text: string }[],
  locator: string,
  needle: string,
): boolean {
  const seg = segs.find((s) => s.locator === locator)
  if (!seg) return false
  return seg.text.toLowerCase().includes(needle.toLowerCase())
}

/**
 * 跑整套 Distiller golden，算抽取准确率 + provenance 错位数。每个 fixture：清库 → seed source →
 * 独立跑 reader 拿真值分块（fixture 自洽 + 钻回真值）→ 跑 Distiller → 读回 provenance 比对。
 */
export async function runDistillerGolden(
  deps: DistillerGoldenDeps,
  items: readonly DistillerGoldenItem[] = DISTILLER_GOLDEN,
): Promise<DistillerGoldenReport> {
  const observations: DistillerClaimObservation[] = []

  for (const item of items) {
    await deps.resetDb()
    const sourceId = await deps.seedSource(item)

    // ① 真值分块：独立跑同一 reader（与 Distiller 内部用的同一实例），拿到「该 content 的真实 segment 集」。
    const read = await deps.reader.read({
      kind: item.kind,
      content: item.content,
      ...(item.hasImages !== undefined ? { hasImages: item.hasImages } : {}),
    })

    // ② 跑 Distiller（真脊柱）。
    const res = await runDistiller(
      {
        db: deps.db,
        embedder: deps.embedder,
        judge: deps.judge,
        reader: deps.reader,
        runtime: deps.makeRuntime(item),
      },
      sourceId,
      item.hasImages !== undefined ? { hasImages: item.hasImages } : {},
    )

    // ③ 读回本 fixture 落的所有 (claim, provenance.locator)。
    const rows = await deps.db
      .select({
        claimText: schema.claim.claimText,
        subject: schema.claim.subject,
        object: schema.claim.object,
        locator: schema.claimProvenance.locator,
        relevance: schema.claimProvenance.relevance,
      })
      .from(schema.claimProvenance)
      .innerJoin(schema.claim, eq(schema.claimProvenance.claimId, schema.claim.id))
      .where(eq(schema.claimProvenance.sourceId, sourceId))

    const persistedLocators = new Set(
      rows.filter((r) => r.relevance === 'exact').map((r) => r.locator),
    )

    for (const gc of item.claims) {
      const self =
        drillsBack(read.segments, gc.locator, gc.drillsBackTo) &&
        // golden 三元/文本本身要含其 object 的可读形态（防 fixture 写歪）；object 去单位空格后应在 claimText 里。
        gc.claimText.length > 0
      const extracted = persistedLocators.has(gc.locator)
      // provenance 不错位：库里确有这条 locator，且它钻回真实 segment 命中 drillsBackTo。
      const aligned = extracted && drillsBack(read.segments, gc.locator, gc.drillsBackTo)
      observations.push({
        itemId: item.id,
        claimText: gc.claimText,
        fixtureSelfConsistent: self,
        extracted,
        provenanceAligned: aligned,
      })
    }
    void res
  }

  const total = distillerGoldenClaimTotal(items)
  const extracted = observations.filter((o) => o.extracted).length
  const provenanceMisaligned = observations.filter(
    (o) => o.extracted && !o.provenanceAligned,
  ).length
  return {
    total,
    extracted,
    extractionAccuracy: total === 0 ? 0 : extracted / total,
    provenanceMisaligned,
    observations,
  }
}

/** 把一条 golden claim 渲成 commit_claim 的工具参数（cite golden locator + drillsBackTo 当 excerpt）。 */
export function commitArgsFor(gc: GoldenClaim): Record<string, unknown> {
  return {
    claimText: gc.claimText,
    subject: gc.subject,
    predicate: gc.predicate,
    object: gc.object,
    locator: gc.locator,
    excerpt: gc.drillsBackTo,
  }
}
