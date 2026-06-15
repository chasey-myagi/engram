/**
 * 红队世代（冻结、版本化、append-only）+ 免疫力维度（append-only 评测埋点）的内核持久化（S29，A.9 stories 50/51）。
 *
 * 由来（P3「冻结红队代际」+ 命门红线 A3）：免疫力只有对**固定的敌手**纵向度量才有意义 —— 若敌手可被悄悄改弱，
 * 「免疫分上升」就退化成 Goodhart（系统学会让对手变弱而非自己更准）。故一个 generation = 一个具名、冻结、
 * 不可静默重写的对抗样本集（version UNIQUE）；新世代 = 新版本，旧世代原样保留（纵向比较的锚）。
 *
 * 沿 standards / governance_state / calibration_map 的版本化 append-only 式样，独立新表，零触碰冻结枚举（红线#4）。
 * 免疫分（detection rate）作为一个**被报告的维度**落 redteam_immunity_scores —— 离线聚合，**绝不**喂校准 g / 纵向趋势
 * （A3 红线#5 的结构性边界：拟合器 collectUsageCalibrationSamples 只读 usage_truth，从不读本两表）。
 */
import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { redteamGenerations, redteamImmunityScores } from '../db/schema.js'

/** 红队四类对抗样本（与四注入器对齐；纯文本标签，内核不解释其领域语义）。 */
export type RedTeamClass = 'false' | 'contradiction' | 'stale' | 'near_dup_poison'

export const REDTEAM_CLASSES: readonly RedTeamClass[] = [
  'false',
  'contradiction',
  'stale',
  'near_dup_poison',
]

const REDTEAM_CLASS_SET: ReadonlySet<string> = new Set(REDTEAM_CLASSES)

/** 运行时校验：x 是否四类红队之一（复用 REDTEAM_CLASSES 单一真相源，增减类别只改白名单一处）。 */
export function isRedTeamClass(x: unknown): x is RedTeamClass {
  return typeof x === 'string' && REDTEAM_CLASS_SET.has(x)
}

/**
 * 一条冻结的红队对抗样本（领域无关）。内核只存/取，不解释其语义——具体注入与免疫断言在 @engram/workers 的 eval 层。
 * claimText/subject/predicate/object/asOf 喂 append_claim 真路径注入；evidence 是该样本所附原文（供 entailment 验真）。
 */
export interface RedTeamItem {
  /** 本样本在世代内的稳定 id（冻结锚：纵向重打分按它对齐）。 */
  id: string
  /** 四类之一。 */
  redteamClass: RedTeamClass
  claimText: string
  subject?: string
  predicate?: string
  object?: string
  /** 该样本所附来源原文（供 Verifier entailment 验真；false 类的原文不蕴含 claim）。 */
  evidence: string
  /** 来源 kind（stale 类用半衰期短的 kind + 远古 asOf 触发时效衰减）。 */
  sourceKind: string
  /** 原文时点（stale 类设为远古；其余默认 now）。ISO 串，冻结存储。 */
  asOf?: string
  /** contradiction / near-dup-poison 类：与之对抗的「既有锚」断言（注入前先 seed 这条 active 锚）。 */
  anchor?: {
    claimText: string
    subject?: string
    predicate?: string
    object?: string
    evidence: string
    sourceKind: string
  }
}

/** redteam_generations 一行的读出形状。 */
export interface RedTeamGeneration {
  id: string
  version: string
  items: RedTeamItem[]
  reason: string
  createdBy: string
  createdAt: Date
}

/** redteam_immunity_scores 一行的读出形状（被报告的维度，不进任何计分）。 */
export interface ImmunityScore {
  id: string
  generationVersion: string
  redteamClass: RedTeamClass
  injected: number
  detected: number
  detectionRate: number
  payload: Record<string, unknown>
  createdBy: string
  createdAt: Date
}

/**
 * **冻结**一个新红队世代（append-only）。version UNIQUE：同名世代重复写直接抛（世代落定即不可静默重写）。
 * 新世代必须是新版本；旧世代行原样保留。items 是这一代固定下来的对抗样本集（纵向比较的锚）。
 */
export async function freezeRedTeamGeneration(
  db: DB,
  input: { version: string; items: RedTeamItem[]; reason: string; createdBy?: string },
): Promise<RedTeamGeneration> {
  if (!input.version || input.version.trim().length === 0) {
    throw new Error('freezeRedTeamGeneration: version must be a non-empty string')
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('freezeRedTeamGeneration: a generation must freeze >=1 adversarial item')
  }
  const id = randomUUID()
  // version UNIQUE 在 DB 层硬执行「世代不可重写」：撞名 INSERT 直接抛（不 onConflict 静默覆盖——那正是要禁的）。
  const rows = await db
    .insert(redteamGenerations)
    .values({
      id,
      version: input.version,
      items: input.items,
      reason: input.reason,
      createdBy: input.createdBy ?? 'eval:redteam',
    })
    .returning()
  return toGeneration(rows[0]!)
}

function toGeneration(r: typeof redteamGenerations.$inferSelect): RedTeamGeneration {
  return {
    id: r.id,
    version: r.version,
    items: r.items as RedTeamItem[],
    reason: r.reason,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }
}

/** 取某具名世代的冻结样本集（不存在 → null）。纵向重打分**总是**按此读回固定 items（绝不现造）。 */
export async function getRedTeamGeneration(
  db: DB,
  version: string,
): Promise<RedTeamGeneration | null> {
  const rows = await db
    .select()
    .from(redteamGenerations)
    .where(eq(redteamGenerations.version, version))
    .limit(1)
  return rows.length ? toGeneration(rows[0]!) : null
}

/** 全世代史（最新在前）。审计 / 列出可纵向比较的代际。 */
export async function getRedTeamGenerations(db: DB): Promise<RedTeamGeneration[]> {
  const rows = await db
    .select()
    .from(redteamGenerations)
    .orderBy(desc(redteamGenerations.createdAt), desc(redteamGenerations.id))
  return rows.map(toGeneration)
}

/**
 * 记一条免疫力**维度**（append-only）：某世代某类的 detected/injected → detectionRate。
 * 纯报告口径，**绝不**进任何在线计分/校准/纵向趋势（A3 红线#5）。generationVersion FK 保证只能挂在已冻结世代上。
 */
export async function recordImmunityScore(
  db: DB,
  input: {
    generationVersion: string
    redteamClass: RedTeamClass
    injected: number
    detected: number
    payload?: Record<string, unknown>
    createdBy?: string
  },
): Promise<ImmunityScore> {
  // 四类是免疫维度的语义不变量（写入侧 runtime guard，挡 `as any` / JS 调用方绕过 TS）。
  // 置于计数校验**之前**：未知 class 在 insert 前先 fail-loud，绝不留脏行。
  if (!isRedTeamClass(input.redteamClass)) {
    throw new Error(
      `recordImmunityScore: unknown redteamClass ${JSON.stringify(input.redteamClass)} ` +
        `(expected one of ${REDTEAM_CLASSES.join(', ')})`,
    )
  }
  if (input.injected < 0 || input.detected < 0 || input.detected > input.injected) {
    throw new Error(
      `recordImmunityScore: invalid counts (injected=${input.injected}, detected=${input.detected})`,
    )
  }
  const detectionRate = input.injected === 0 ? 0 : input.detected / input.injected
  const id = randomUUID()
  const rows = await db
    .insert(redteamImmunityScores)
    .values({
      id,
      generationVersion: input.generationVersion,
      redteamClass: input.redteamClass,
      injected: input.injected,
      detected: input.detected,
      detectionRate,
      payload: input.payload ?? {},
      createdBy: input.createdBy ?? 'eval:redteam',
    })
    .returning()
  return toScore(rows[0]!)
}

function toScore(r: typeof redteamImmunityScores.$inferSelect): ImmunityScore {
  return {
    id: r.id,
    generationVersion: r.generationVersion,
    redteamClass: r.redteamClass as RedTeamClass,
    injected: r.injected,
    detected: r.detected,
    detectionRate: r.detectionRate,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }
}

/** 取免疫力维度行（可按世代过滤），按时间升序。离线聚合 / 纵向比较取数口（不进任何计分）。 */
export async function getImmunityScores(
  db: DB,
  generationVersion?: string,
  redteamClass?: RedTeamClass,
): Promise<ImmunityScore[]> {
  const conds = []
  if (generationVersion !== undefined)
    conds.push(eq(redteamImmunityScores.generationVersion, generationVersion))
  if (redteamClass !== undefined) conds.push(eq(redteamImmunityScores.redteamClass, redteamClass))
  const rows = await db
    .select()
    .from(redteamImmunityScores)
    .where(conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds))
    .orderBy(asc(redteamImmunityScores.createdAt), asc(redteamImmunityScores.id))
  return rows.map(toScore)
}
