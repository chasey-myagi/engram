/**
 * A1/L5 盲点考卷（A.9，S10）—— 给知识库的「不知道」打分。评测=消费：每题只走 Consumer SPI 的 recall_claims，
 * **没有任何评测专用代码路径**。一题的金标准答案恰是 {recall 返回 [] 且落了一条 gap_recorded 事件}。
 *
 * 隔离命名空间：L5 题是冻结的评测夹具、**绝不**作为 claim 写进库，故 recall 结构上不可能召回它们
 * （命名空间隔离 = 题不在 claim 存储里）。题是「库该不知道」的问题；真有了越门答案，该题即从 gap 翻成正常召回
 * （活的考卷、非硬编码）—— 见 runGapQuestion。
 */
import type { Embedder } from '../embedding/embedder.js'
import type { DB } from '../db/client.js'
import { getGapEvents } from '../spi/metrics.js'
import { recallClaims, type RecallContext } from '../spi/recall-claims.js'

/** 评测题所在的隔离命名空间标识（题是夹具、永不进 claim 存储 ⇒ recall 永不召回）。 */
export const L5_GAP_NAMESPACE = 'eval:l5-gap' as const

export interface L5Question {
  readonly id: string
  readonly query: string
}

/**
 * 冻结的 L5 盲点题集（12 题）。领域无关的事实型提问；新库对它们一概没有越门答案。
 * 冻结（Object.freeze）防止运行期被改 —— 考卷一旦立就是固定毒株。
 */
export const L5_GAP_QUESTIONS: readonly L5Question[] = Object.freeze(
  [
    { id: 'l5-01', query: 'what is the maximum sustained throughput of connector model qx-7731' },
    {
      id: 'l5-02',
      query: 'which firmware revision first enabled dual-band failover on the mesh relay',
    },
    {
      id: 'l5-03',
      query: 'what is the documented mean time between failures for the cryo pump assembly',
    },
    {
      id: 'l5-04',
      query: 'how many concurrent tenants does the sharded ledger support before resharding',
    },
    {
      id: 'l5-05',
      query: 'what default retry budget does the upstream gateway apply to idempotent writes',
    },
    {
      id: 'l5-06',
      query: 'which calibration gas mixture is specified for the trace contaminant analyzer',
    },
    {
      id: 'l5-07',
      query: 'what is the rated duty cycle of the high-torque actuator under thermal load',
    },
    {
      id: 'l5-08',
      query: 'which compliance regime governs cross-border settlement for the clearing node',
    },
    {
      id: 'l5-09',
      query: 'what is the expected packet loss tolerance for the satellite uplink scheduler',
    },
    {
      id: 'l5-10',
      query: 'how does the orchestrator break ties between equally weighted placement candidates',
    },
    {
      id: 'l5-11',
      query: 'what is the warranty period stated for the field-replaceable photonics module',
    },
    {
      id: 'l5-12',
      query: 'which encoding does the legacy telemetry bus use for signed delta frames',
    },
  ].map((q) => Object.freeze(q)),
)

/** 单题观测：召回数 + 本次召回是否落了 gap 信号 + 是否答对（库正确地交白卷）。 */
export interface GapObservation {
  question: L5Question
  /** 本次 recall 返回的越门 claim 数。 */
  recalled: number
  /** 本次 recall **新增**了一条引用该 query 的 gap_recorded（前后计数增量判定）。 */
  gapRecorded: boolean
  /** 金标准：recalled===0 且 gapRecorded。库诚实地说了「不知道」即答对。 */
  correct: boolean
}

export interface L5SuiteReport {
  total: number
  /** 答对题数（正确交白卷）。 */
  correct: number
  /** 盲点得分 = correct / total ∈ [0,1]：库对自己盲点的诚实率。total=0 → 0。 */
  blindSpotScore: number
  results: GapObservation[]
}

/**
 * 跑一道题：只调 recall_claims（真 SPI、零专用路径），用「召回前后该 query 的 gap 计数增量」判定本次
 * 是否落了诚实信号。recalled===0 且 gapRecorded ⇒ 答对（库正确交白卷）。
 * 一旦库里有了越门答案，recalled≥1 且本次不再落 gap ⇒ 该题从 gap 翻成正常召回（AC5：活考卷）。
 */
export async function runGapQuestion(
  db: DB,
  embedder: Embedder,
  question: L5Question,
  ctx: RecallContext = {},
): Promise<GapObservation> {
  const before = (await getGapEvents(db, question.query)).length
  const hits = await recallClaims(db, embedder, question.query, ctx)
  const after = (await getGapEvents(db, question.query)).length
  const gapRecorded = after > before
  return {
    question,
    recalled: hits.length,
    gapRecorded,
    correct: hits.length === 0 && gapRecorded,
  }
}

/**
 * 跑整套 L5 盲点考卷，算盲点得分。顺序跑（每题写一条 gap、避免并发交错），聚合成可报告的 L5SuiteReport。
 */
export async function runL5Suite(
  db: DB,
  embedder: Embedder,
  questions: readonly L5Question[] = L5_GAP_QUESTIONS,
  ctx: RecallContext = {},
): Promise<L5SuiteReport> {
  const results: GapObservation[] = []
  for (const q of questions) {
    results.push(await runGapQuestion(db, embedder, q, ctx))
  }
  const total = results.length
  const correct = results.filter((r) => r.correct).length
  return { total, correct, blindSpotScore: total === 0 ? 0 : correct / total, results }
}
