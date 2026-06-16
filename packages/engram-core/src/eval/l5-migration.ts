/**
 * L5 → 归因脊柱迁移「长出了知识」（S31，A.9 story 49 + PRD A.9：
 * 「若某版本开始能答某 L5 题 → 移出 L5、进归因脊柱（证明长出了知识）」）。
 *
 * 一道**曾零召回**的 L5 缺口题（库本该不知道），当某 release 上它**变得可答**——
 *   ① recall(query) 现在 **≥1 越门 result**（库自养出了答案，经真 recall_claims 判，评测=消费、零专用路径），
 *   ② **且人确认**（confirmedBy 须 'human…'：知识真长出来是人的架构裁断，不让 agent 自报「我会了」冒充成长，防 Goodhart）——
 * 就把它**迁出 L5**、作为「长出了知识」的证据 **append-only** 记进 knowledge_grew_events（归因脊柱的成长半边）。
 *
 * **绝不删 L5 夹具**（L5_GAP_QUESTIONS 是冻结题集）：「迁出」是逻辑标注——knowledge_grew_events 存在该题的行 ⇔
 * 该题已不再算盲点、已进归因脊柱。l5_question_id UNIQUE ⇒ 同题至多迁一次（幂等）。isMigratedOutOfL5 给读侧判。
 *
 * 与 S10 runL5Suite 的关系：runGapQuestion 判「库该不知道时是否诚实交白卷」；本模块判「库该会了没有」——
 * 后者为真（recalled≥1 + 人确认）正是前者的反面信号，恰是「长出了知识」。两者同走 recall_claims 这条缝。
 */
import { eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import type { Embedder } from '../embedding/embedder.js'
import { knowledgeGrewEvents } from '../db/schema.js'
import { recallClaims, type RecallContext } from '../spi/recall-claims.js'
import { isHumanRole } from '../spi/reflux.js'
import { L5_GAP_QUESTIONS, runL5Suite, type L5Question, type L5SuiteReport } from './l5-gap.js'
import { randomUUID } from 'node:crypto'

/** knowledge_grew_events 一行的读出形状。 */
export interface KnowledgeGrewEvent {
  id: string
  l5QuestionId: string
  query: string
  releaseSnapshot: string
  recalledCount: number
  confirmedBy: string
  payload: Record<string, unknown>
  createdAt: Date
}

function toEvent(row: typeof knowledgeGrewEvents.$inferSelect): KnowledgeGrewEvent {
  return {
    id: row.id,
    l5QuestionId: row.l5QuestionId,
    query: row.query,
    releaseSnapshot: row.releaseSnapshot,
    recalledCount: row.recalledCount,
    confirmedBy: row.confirmedBy,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  }
}

export interface MigrateL5Options {
  /** 人确认者（须 'human…'：知识长出是人的架构裁断）。 */
  confirmedBy: string
  /** 变得可答的 release 标识（留作纵向归因锚）。 */
  releaseSnapshot: string
}

export interface MigrateL5Result {
  migrated: boolean
  /** 迁出时越门召回数（≥1 才迁）。 */
  recalledCount: boolean | number
  /** 迁出失败原因（人读，留审计）。 */
  reasons: string[]
  /** 成功时的 knowledge_grew_events.id。 */
  eventId?: string
}

/**
 * 把一道**变得可答**的 L5 缺口题迁出 L5、记「长出了知识」（append-only）。
 *
 * 判据（两条都过才迁，对齐 PRD A.9）：
 *   ① recall(query) **≥1 越门 result**（库自养出答案，经真 recall_claims；否则它仍是盲点、不该迁）；
 *   ② confirmedBy 是人（HITL 权威门：知识长出是人裁断）。
 * 非人确认 ⇒ **不迁**、记审计原因；recall 仍空 ⇒ **不迁**、记原因（题仍属 L5）。
 * 同题已迁过（l5_question_id UNIQUE 撞）⇒ 幂等 no-op（migrated=false，原因标已迁），不堆叠重复行。
 *
 * 题 id 必须在冻结 L5 题集内（防把任意字符串当 L5 题迁）。
 */
export async function migrateL5IfGrew(
  db: DB,
  embedder: Embedder,
  l5QuestionId: string,
  opts: MigrateL5Options,
): Promise<MigrateL5Result> {
  const reasons: string[] = []
  const question = L5_GAP_QUESTIONS.find((q) => q.id === l5QuestionId)
  if (!question) {
    throw new Error(
      `migrateL5IfGrew: '${l5QuestionId}' is not a frozen L5 gap question (id not in L5_GAP_QUESTIONS)`,
    )
  }

  // ① 库真会了吗：经真 recall_claims（评测=消费）。≥1 越门 result 才算可答。
  const hits = await recallClaims(db, embedder, question.query)
  const recalledCount = hits.length
  if (recalledCount === 0) {
    reasons.push('L5 question is still zero-recall (knowledge has not grown; remains a blind spot)')
  }

  // ② 人确认（HITL 权威门）。
  if (!isHumanRole(opts.confirmedBy)) {
    reasons.push(`not human-confirmed (by_role '${opts.confirmedBy}')`)
  }

  if (reasons.length > 0) {
    return { migrated: false, recalledCount, reasons }
  }

  // 已迁过 ⇒ 幂等 no-op（不重复入脊柱）。l5_question_id UNIQUE 是硬锚；这里先查一遍给清晰原因，
  // 撞 UNIQUE 仍由 onConflictDoNothing 兜底（并发安全）。
  const id = randomUUID()
  const ins = await db
    .insert(knowledgeGrewEvents)
    .values({
      id,
      l5QuestionId,
      query: question.query,
      releaseSnapshot: opts.releaseSnapshot,
      recalledCount,
      confirmedBy: opts.confirmedBy,
      payload: { recalledClaimIds: hits.map((h) => h.claim.id) },
    })
    .onConflictDoNothing({ target: knowledgeGrewEvents.l5QuestionId })
    .returning({ id: knowledgeGrewEvents.id })

  if (ins.length === 0) {
    reasons.push('already migrated out of L5 (knowledge-grew already recorded for this question)')
    return { migrated: false, recalledCount, reasons }
  }
  return { migrated: true, recalledCount, reasons, eventId: ins[0]!.id }
}

/** 读「长出了知识」迁移记录（可按 release 过滤），按时间升序。归因脊柱成长半边的读路径。 */
export async function getKnowledgeGrewEvents(
  db: DB,
  releaseSnapshot?: string,
): Promise<KnowledgeGrewEvent[]> {
  const rows = await db.select().from(knowledgeGrewEvents)
  const all = rows.map(toEvent)
  const filtered =
    releaseSnapshot === undefined ? all : all.filter((e) => e.releaseSnapshot === releaseSnapshot)
  // 确定性升序（created_at, id）。
  return filtered.sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime()
    return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** 一道 L5 题是否已迁出 L5（已记 knowledge-grew）⇒ 它不再算盲点。读侧判定（L5 计分应跳过已迁出的题）。 */
export async function isMigratedOutOfL5(db: DB, l5QuestionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: knowledgeGrewEvents.id })
    .from(knowledgeGrewEvents)
    .where(eq(knowledgeGrewEvents.l5QuestionId, l5QuestionId))
    .limit(1)
  return row !== undefined
}

/**
 * **活 L5 卷**：从冻结 L5 题集里剔掉已迁出（已长出知识）的题——剩下的才是当前真盲点。
 * L5 夹具仍冻结（不物理删），这只是给评测取「当前仍未答」的子集（append-only 迁移的读侧投影）。
 */
export async function liveL5Questions(
  db: DB,
  questions: readonly L5Question[] = L5_GAP_QUESTIONS,
): Promise<L5Question[]> {
  const migrated = new Set((await getKnowledgeGrewEvents(db)).map((e) => e.l5QuestionId))
  return questions.filter((q) => !migrated.has(q.id))
}

/**
 * **默认生产 L5 评分入口**（DB-aware）：先取**活 L5 卷**（剔除已迁出/已长出知识的题），再交给 runL5Suite 打分。
 * 这是 runL5Suite 的默认/生产包装——把「迁出投影」接进评分分母，兑现 liveL5Questions 的 docstring 不变量
 * 「L5 计分应跳过已迁出的题」。已迁出题不进分母 ⇒ 不会被库的正确召回误判成一次盲点失败（防指标反相关）。
 *
 * 显式题集入口仍走 runL5Suite(db, embedder, questions, ctx)（晋升管线/夹具测试用静态全集，不受影响）。
 */
export async function runLiveL5Suite(
  db: DB,
  embedder: Embedder,
  ctx: RecallContext = {},
): Promise<L5SuiteReport> {
  const questions = await liveL5Questions(db)
  return runL5Suite(db, embedder, questions, ctx)
}
