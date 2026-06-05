/**
 * 校准映射 g' 的**版本化、append-only 持久化 + 原子激活 + 即时回退**（S27，A.3/A.8 命门）。
 *
 * 沿 standards / governance_state 的「append-only / 活动=createdAt 最新一行」式样，但管的是 **g（数值多准）**：
 *   - 每行 = (version, knots, evidence, reason, createdBy)。同一 version 可被多行引用（不强制全表唯一）。
 *   - **活动校准版本** = createdAt 最新一行的 version（平手按 id 倒序）；表空 → 内核 sentinel 'identity'（g=raw）。
 *   - 验收门是活动版本的**唯一写者**（能力≠权力，A.8）：commitCalibrationMap 在**一个 tx** 内原子完成
 *     「append 映射定义 + 把它设成活动版本」——要么都成、要么都不成，绝无半提交（其它 reader 看不到撕裂态）。
 *   - g=identity **即时回退**（Story 29 可逆性）= rollbackToIdentity：append 一行 version='identity'（knots=[]）
 *     的活动指针，瞬间让此后所有新召回的 value 退回 raw（单次原子 flag flip，毫秒级，不重写任何历史）。
 *
 * 读侧（recall / inbox）按候选 claim **各自钉的版本**解析 g'（loadCalibrationMaps）——老快照冻结在它当年的 g。
 * 本模块只认 calibration_map 表 + confidence 的纯类型/校验；零 LLM、零随机、零 A3 信号入口（领域无关、命门红线在拟合输入边界，不在此）。
 */
import { randomUUID } from 'node:crypto'

import { desc, inArray } from 'drizzle-orm'

import {
  CALIBRATION_IDENTITY,
  IDENTITY_MAP,
  assertCalibrationMap,
  type CalibrationKnot,
  type CalibrationMap,
} from '../confidence/confidence.js'
import type { DB, Tx } from '../db/client.js'
import { calibrationMap } from '../db/schema.js'

/** 落库一行校准映射的入参（验收门 / 回退 / 定义都走它）。 */
export interface CommitCalibrationInput {
  /** 要激活的校准映射（version + 升序非递减 knots）。写时强制 assertCalibrationMap。 */
  map: CalibrationMap
  /** 验证依据（A.8）：候选 g' 相对当时活动 g 的 ΔECE 等审计快照（离线，不进在线计分）。 */
  evidence?: Record<string, unknown>
  /** 本行来由（审计）。 */
  reason: string
  /** 写入者（'gate:advisor-accept' / 'human:rollback' …）。 */
  createdBy?: string
}

/** calibration_map 一行的读出形状。 */
export interface CalibrationMapRow {
  id: string
  version: string
  knots: CalibrationKnot[]
  evidence: Record<string, unknown>
  reason: string
  createdBy: string
  createdAt: Date
}

function toRow(r: typeof calibrationMap.$inferSelect): CalibrationMapRow {
  return {
    id: r.id,
    version: r.version,
    knots: r.knots as CalibrationKnot[],
    evidence: r.evidence as Record<string, unknown>,
    reason: r.reason,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }
}

/** 把一行还原成不可变 CalibrationMap 值对象（version + knots）。 */
function rowToMap(r: CalibrationMapRow): CalibrationMap {
  return { version: r.version, knots: r.knots }
}

/**
 * 在给定执行器（DB 或 Tx）上 append 一行校准映射，并把它设成**活动版本**（最新一行即活动，故 append 即激活）。
 * 写前 assertCalibrationMap（升序、非递减、[0,1]）——违反即抛、不写。返回落库行。
 * 抽出供 commitCalibrationMap（独立 tx）与验收门（在它自己的 tx 内调）复用同一原子写入口径。
 */
export async function appendCalibrationMapTx(
  exec: DB | Tx,
  input: CommitCalibrationInput,
): Promise<CalibrationMapRow> {
  assertCalibrationMap(input.map)
  const id = randomUUID()
  const rows = await exec
    .insert(calibrationMap)
    .values({
      id,
      version: input.map.version,
      knots: input.map.knots,
      evidence: input.evidence ?? {},
      reason: input.reason,
      createdBy: input.createdBy ?? 'gate:advisor-accept',
    })
    .returning()
  return toRow(rows[0]!)
}

/**
 * **原子提交并激活**一个校准映射（验收门的唯一写者，A.8）。包在一个 tx 里：append 定义行 = 即刻成活动版本。
 * 单行写本就原子；用显式 tx 锁住语义边界——若未来激活需多行（如同时记审计副本），扩展点已就位、不破契约。
 */
export async function commitCalibrationMap(
  db: DB,
  input: CommitCalibrationInput,
): Promise<CalibrationMapRow> {
  return db.transaction((tx) => appendCalibrationMapTx(tx, input))
}

/**
 * **g=identity 即时回退**（Story 29）：append 一行 version='identity'（knots=[]）的活动指针。
 * 单次原子写（毫秒级），瞬间让此后所有新召回 value 退回 raw。不物理改写任何历史行——回退本身也留痕、可再前滚。
 */
export async function rollbackToIdentity(
  db: DB,
  by = 'human:rollback',
): Promise<CalibrationMapRow> {
  return commitCalibrationMap(db, {
    map: IDENTITY_MAP,
    reason: 'rollback-identity: revert active calibration to bare raw',
    createdBy: by,
  })
}

/** 活动校准版本 = createdAt 最新一行的 version（平手按 id 倒序）；表空 → 'identity'。 */
export async function getActiveCalibrationVersion(db: DB): Promise<string> {
  const rows = await db
    .select({ version: calibrationMap.version })
    .from(calibrationMap)
    .orderBy(desc(calibrationMap.createdAt), desc(calibrationMap.id))
    .limit(1)
  return rows.length ? rows[0]!.version : CALIBRATION_IDENTITY
}

/**
 * 活动校准映射（version + knots）。表空 / 活动版本是 identity → IDENTITY_MAP（空 knots，g=raw）。
 * 接 DB | Tx：S28 FIX 1 的写路径在自己的事务内解析活动 g、把新 claim 钉到活动版本（与该 claim 写入同一原子边界，
 * 杜绝「读到活动版本 A、提交瞬间已换成 B」的 TOCTOU）；recalibrate 仍用 DB 实例调（事务外只读快照）。
 */
export async function getActiveCalibrationMap(exec: DB | Tx): Promise<CalibrationMap> {
  const rows = await exec
    .select()
    .from(calibrationMap)
    .orderBy(desc(calibrationMap.createdAt), desc(calibrationMap.id))
    .limit(1)
  if (rows.length === 0) return IDENTITY_MAP
  return rowToMap(toRow(rows[0]!))
}

/**
 * 批量解析一组版本 → Map<version, CalibrationMap>（recall/inbox 请求开头一次查回，热路径再同步 applyG）。
 * 只查**非 identity 且唯一**的版本（identity 不入表/不必解析）；未找到的版本不入返回 Map（applyG 会因缺 map 抛，
 * 但正常情况下 claim 钉的版本必有定义行——缺失说明数据被外力删，宁可显式失败也不静默用错 g）。
 *
 * S28 FIX 2：原来还有一个单版本解析器 getCalibrationMap，它在「未找到」时静默返回 identity 形状的 map，
 * 与本函数「未找到即丢、让 applyG 抛」的语义相反——两套「not found」语义会让同一缺失数据在两条路径上行为分裂。
 * getCalibrationMap 没有任何非测试调用者（YAGNI），已删除。全仓库只剩本函数一条版本解析口径（缺失 = fail-loud）。
 */
export async function loadCalibrationMaps(
  exec: DB | Tx,
  versions: string[],
): Promise<Map<string, CalibrationMap>> {
  const out = new Map<string, CalibrationMap>()
  const wanted = [...new Set(versions.filter((v) => v !== CALIBRATION_IDENTITY))]
  if (wanted.length === 0) return out
  const rows = await exec
    .select()
    .from(calibrationMap)
    .where(inArray(calibrationMap.version, wanted))
    .orderBy(desc(calibrationMap.createdAt), desc(calibrationMap.id))
  // 每个 version 取最新定义行（已按 createdAt 倒序，首见即最新）。
  for (const r of rows) {
    if (!out.has(r.version)) out.set(r.version, rowToMap(toRow(r)))
  }
  return out
}

/** 全版本史，最新在前（审计 / 回退选点用）。 */
export async function getCalibrationHistory(db: DB): Promise<CalibrationMapRow[]> {
  const rows = await db
    .select()
    .from(calibrationMap)
    .orderBy(desc(calibrationMap.createdAt), desc(calibrationMap.id))
  return rows.map(toRow)
}
