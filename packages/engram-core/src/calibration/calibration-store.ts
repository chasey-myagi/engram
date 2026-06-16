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
import { createHash, randomUUID } from 'node:crypto'

import { desc, eq, inArray, sql } from 'drizzle-orm'

import {
  CALIBRATION_IDENTITY,
  IDENTITY_MAP,
  assertCalibrationMap,
  type CalibrationKnot,
  type CalibrationMap,
} from '../confidence/confidence.js'
import type { DB, Tx } from '../db/client.js'
import { calibrationMap } from '../db/schema.js'

/**
 * 校准换图 CAS 落败（EGR-CR-044）：提交方相对一份**过期活动 g** 过了验收门，
 * 但落库时同一 tx 内重读到的当前活动行 id 与提交方记下的 expected 锚不符——
 * 后提交者的验收已失效，拒写并抛此具名错（携带 expected / actual，供上层转 HOLD/retry）。
 */
export class StaleActiveCalibrationError extends Error {
  constructor(
    readonly expectedActiveId: string | null,
    readonly actualActiveId: string | null,
  ) {
    super(
      `stale active calibration: expected active row ${expectedActiveId ?? '<empty>'}, ` +
        `but current active row is ${actualActiveId ?? '<empty>'} (concurrent swap won the CAS)`,
    )
    this.name = 'StaleActiveCalibrationError'
  }
}

/**
 * 同名重定义被拒（EGR-CR-009）：某 version 已有定义行，且其 knots 与本次写入的 knots **不一致**。
 * version→knots 是不可变函数（claim 钉 version 来复现当年的 g），同名只能复用同内容；同名异内容是
 * 「静默回溯改写历史概率」的入口，故 fail-loud 拒写（携带 version 供上层定位/裁决）。
 */
export class CalibrationVersionRedefineError extends Error {
  constructor(readonly version: string) {
    super(
      `calibration: refuse to redefine version "${version}" with different knots ` +
        `(same version must map to immutable knots — version→knots is a frozen function, EGR-CR-009)`,
    )
    this.name = 'CalibrationVersionRedefineError'
  }
}

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
  /**
   * 乐观并发控制锚（EGR-CR-044）：提交方相对哪一行活动 g 过的验收。
   * 传入时在同一 tx 内 `FOR UPDATE` 重读当前活动行 id 与之比对，不符则抛 StaleActiveCalibrationError、不写；
   * 表空/identity 态用 `null` 哨兵。省略（undefined）= 不做 CAS，保持旧行为（回退等无需并发控制的写者）。
   */
  expectedActiveId?: string | null
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
 * knots 的稳定内容指纹（EGR-CR-009）：把有序结点逐元素规范化为 `x:y` 逗号分隔序列再 md5，
 * 不依赖 JSON 字段顺序/空白。同 knots ⇒ 同 hash（应用层幂等门的比对锚 + DB 触发器的比对列）。
 * 用 md5（非 sha256）是为了让 migration 0021 的回填能用 Postgres 内核自带的 `md5(text)` 复算出**逐字节相同**
 * 的指纹（无需 pgcrypto 扩展）——回填行与此后 store 新写行的同名同内容指纹一致，触发器才不会误拒合法再激活。
 * identity（空 knots）→ canonical 为空串 → 固定指纹。这是内容相等指纹（非安全 hash），md5 足矣。
 */
function knotsHash(knots: CalibrationKnot[]): string {
  const canonical = knots.map((k) => `${k.x}:${k.y}`).join(',')
  return createHash('md5').update(canonical).digest('hex')
}

/**
 * 校准换图 CAS 的事务级 advisory lock key（EGR-CR-044）。任意稳定常量即可——
 * 所有带 expectedActiveId 的提交都在同一 tx 内先取此锁，把「重读活动行 + 比对 + append」整段串行化，
 * 故连「起始表空（无行可 FOR UPDATE）」的并发也能正确分出唯一赢家，而非 FOR UPDATE 锁不到行各自写一行。
 */
const CALIBRATION_ACTIVE_LOCK_KEY = 0x6361_6c69 // 'cali'

/** 当前活动行 id（最新一行，平手按 id 倒序）；表空 → null。用作 CAS 的 expected 锚点。 */
async function activeCalibrationRowId(exec: DB | Tx): Promise<string | null> {
  const rows = await exec
    .select({ id: calibrationMap.id })
    .from(calibrationMap)
    .orderBy(desc(calibrationMap.createdAt), desc(calibrationMap.id))
    .limit(1)
  return rows.length ? rows[0]!.id : null
}

/**
 * 在给定执行器（DB 或 Tx）上 append 一行校准映射，并把它设成**活动版本**（最新一行即活动，故 append 即激活）。
 * 写前 assertCalibrationMap（升序、非递减、[0,1]）——违反即抛、不写。返回落库行。
 * 抽出供 commitCalibrationMap（独立 tx）与验收门（在它自己的 tx 内调）复用同一原子写入口径。
 *
 * **乐观并发控制（EGR-CR-044）：** 当 input.expectedActiveId !== undefined（即 caller 显式带了 expected 锚），
 * 在 append **之前**、于**同一 tx** 内先取事务级 advisory lock 串行化并重读当前活动行 id，与 expected 比对：
 *   - 相等（含「都为表空 / null」）→ 继续 append；
 *   - 不等 → 抛 StaleActiveCalibrationError、不写（提交方相对的活动 g 已被并发换掉，验收失效）。
 * expectedActiveId 省略（undefined）→ 不做 CAS，保持旧行为（rollbackToIdentity 等无需并发控制的写者）。
 */
export async function appendCalibrationMapTx(
  exec: DB | Tx,
  input: CommitCalibrationInput,
): Promise<CalibrationMapRow> {
  assertCalibrationMap(input.map)
  const hash = knotsHash(input.map.knots)
  if (input.expectedActiveId !== undefined) {
    // 取事务级 advisory lock：把「重读活动行 + 比对 + append」整段对所有带锚提交串行化。
    // 这一步串行化即便在「起始表空（无行可锁）」时也成立——故并发起拍仍能分出唯一 CAS 赢家。
    await exec.execute(sql`SELECT pg_advisory_xact_lock(${CALIBRATION_ACTIVE_LOCK_KEY})`)
    const actualActiveId = await activeCalibrationRowId(exec)
    if (actualActiveId !== input.expectedActiveId) {
      throw new StaleActiveCalibrationError(input.expectedActiveId, actualActiveId)
    }
  }
  // version→knots 不可变门（EGR-CR-009，首要防线）：同 version 若已有定义行且其 knots 与本次**不一致**，
  // 拒写（fail-loud）。同名同内容 ⇒ 允许（活动指针 / 回退行复用同名定义再 append 即激活，幂等合法）。
  // 取同一 tx 级 advisory lock 串行化「查同名 hash + 比对 + insert」，与并发同名写者互斥（应用层防 TOCTOU；
  // migration 0021 的 BEFORE INSERT 触发器再兜底「绕过本 store 的直写」）。
  await exec.execute(sql`SELECT pg_advisory_xact_lock(${CALIBRATION_ACTIVE_LOCK_KEY})`)
  const existing = await exec
    .select({ knotsHash: calibrationMap.knotsHash })
    .from(calibrationMap)
    .where(eq(calibrationMap.version, input.map.version))
    .limit(1)
  if (existing.length > 0 && existing[0]!.knotsHash !== hash) {
    throw new CalibrationVersionRedefineError(input.map.version)
  }
  const id = randomUUID()
  const rows = await exec
    .insert(calibrationMap)
    .values({
      id,
      version: input.map.version,
      knots: input.map.knots,
      knotsHash: hash,
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
 * 活动校准的**带锚点**读法（EGR-CR-044）：返回当前活动行（含 id / createdAt），表空 → null。
 * recalibrate 用它在评估开始时钉下「我相对哪一行过的门」（expected active 锚），提交时连同 expectedActiveId
 * 下传给 commitCalibrationMap 做 CAS——过期验收便无从覆盖一份已被并发换上的、更新的活动 g。
 */
export async function getActiveCalibrationRow(exec: DB | Tx): Promise<CalibrationMapRow | null> {
  const rows = await exec
    .select()
    .from(calibrationMap)
    .orderBy(desc(calibrationMap.createdAt), desc(calibrationMap.id))
    .limit(1)
  return rows.length ? toRow(rows[0]!) : null
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
