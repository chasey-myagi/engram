/**
 * EGR-CR-009 回归测试（DB 集成）：calibration_map 的 **version → knots 不可变** 不变量。
 *
 * 背景：`calibration_map.version` 既是 g' 的内容标识（claim 钉它来复现当年的 g），又是活动指针
 * （最新一行 = 活动版本）。表故意允许「同 version 多行」（定义行 + 活动指针行，`rollbackToIdentity`
 * 复用 'identity'）。缺口在于：同一非 identity version 可被第二次写入一组 **不同的 knots**，而读侧
 * `loadCalibrationMaps` 只取每个 version 的最新行——于是一条早已写定、钉死某 version 的历史 claim，
 * 会在该 version 被同名重定义后，于下次 recall 时静默拿到新的 g 映射（概率快照被回溯改写、审计无感）。
 *
 * 根治（方案 A）目标不变量：对任意 version，所有以该 version 落库的行其 knots 必须 byte-for-byte 一致，
 * 即「version → knots」是不可变函数。活动指针的「同 version 多行」仍允许，但那些行的 knots 必须相同。
 *
 * 四条断言（对齐 issue「验收测试」）：
 *   1) 同 version 不同 knots 被写路径拒（fail-loud），且拒写未污染表。
 *   2) 同 version 同 knots 幂等放行（指针行/回退行复用同名同内容的合法路径不被误伤）。
 *   3) 端到端冻结（承重）：旧 claim 的 recall value 不被同名重定义改写。
 *   4) DB 兜底：绕过 store 直写同 version 不同 knots，被 (version, knots_hash) 不可变触发器拒。
 *
 * harness 对齐 `calibration-isotonic.test.ts`：pg + drizzle migrate + beforeAll/beforeEach 建库迁移、afterAll 清理。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, type CalibrationKnot } from '../index.js'
import {
  commitCalibrationMap,
  getActiveCalibrationVersion,
  getCalibrationHistory,
  loadCalibrationMaps,
  rollbackToIdentity,
} from '../calibration/calibration-store.js'
import { createDb, type DB } from '../db/client.js'
import { calibrationMap } from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource, appendClaim } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { transitionClaim } from '../spi/transition.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const embedder = makeFakeEmbedder()

// 两组合法（x 严格升序、y 非递减、∈[0,1]）但**彼此不同**的 knots。
// 二者都把召回 claim 的 raw（≈0.49）映到 ≥0.4（保持可召回），但 value 明显不同（A 压低、B 抬高）。
const KNOTS_A: CalibrationKnot[] = [
  { x: 0, y: 0.4 },
  { x: 0.5, y: 0.45 },
  { x: 1, y: 0.5 },
]
const KNOTS_B: CalibrationKnot[] = [
  { x: 0, y: 0.7 },
  { x: 0.5, y: 0.85 },
  { x: 1, y: 0.95 },
]

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL })
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
  pool.on('error', () => {})
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

beforeEach(async () => {
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, standards, governance_state, calibration_map CASCADE',
  )
})

/** 从召回结果里按 claimText 精确定位唯一目标（fake embedder 子串近邻可能带出别的 claim）。 */
function pick(
  results: Awaited<ReturnType<typeof recallClaims>>,
  text: string,
): Awaited<ReturnType<typeof recallClaims>>[number] {
  const hit = results.find((r) => r.claim.claimText === text)
  if (!hit)
    throw new Error(`pick: recall returned no claim with text "${text}" (got ${results.length})`)
  return hit
}

/**
 * 经真实写路径建一条会被召回的 active claim（对齐 isotonic 测试的 mkRecallableClaim）：
 * 3 条满权威独立 source ⇒ base ≈ 0.49 ≥ floor 0.4，经上面两组 g′ 后仍 ≥0.4 可召回。
 * appendClaim ⇒ 钉**写时的活动校准版本**（FIX 1 路径），再 promote 到 active。
 */
async function mkRecallableClaim(text: string): Promise<string> {
  const provs = []
  for (let i = 0; i < 3; i++) {
    const { sourceId } = await addSource(db, {
      content: `recallable-${randomUUID()}`,
      kind: 'structured_spec',
      authorityScore: 1,
    })
    provs.push({ sourceId, locator: `p${i}`, relevance: 'exact' as const })
  }
  const { claimId } = await appendClaim(db, embedder, { claimText: text, createdBy: 'test' }, provs)
  await transitionClaim(db, claimId, 'active', { by: 'human:editor' })
  return claimId
}

describe('EGR-CR-009 calibration version→knots 不可变（DB 集成）', () => {
  it('测试 1：同 version 不同 knots 被写路径拒（fail-loud），拒写未污染表', async () => {
    await commitCalibrationMap(db, {
      map: { version: 'cal-x', knots: KNOTS_A },
      reason: 'define',
      createdBy: 'test',
    })

    await expect(
      commitCalibrationMap(db, {
        map: { version: 'cal-x', knots: KNOTS_B },
        reason: 'silent-redefine',
        createdBy: 'test',
      }),
    ).rejects.toThrow(/same version.*different knots|不可重定义|immutab/i)

    // 拒写未污染表：cal-x 仍只有 1 行，knots 还是 A。
    const history = await getCalibrationHistory(db)
    const calX = history.filter((r) => r.version === 'cal-x')
    expect(calX).toHaveLength(1)
    expect(calX[0]!.knots).toEqual(KNOTS_A)
    const resolved = await loadCalibrationMaps(db, ['cal-x'])
    expect(resolved.get('cal-x')!.knots).toEqual(KNOTS_A)
  })

  it('测试 2：同 version 同 knots 幂等放行；rollbackToIdentity 可重复', async () => {
    await commitCalibrationMap(db, {
      map: { version: 'cal-y', knots: KNOTS_A },
      reason: 'define',
      createdBy: 'test',
    })
    // 第二次写**完全相同**的 (version, knots) 不抛（指针行/回退行复用同名同内容的合法路径）。
    await expect(
      commitCalibrationMap(db, {
        map: { version: 'cal-y', knots: KNOTS_A },
        reason: 're-activate',
        createdBy: 'test',
      }),
    ).resolves.toBeDefined()

    expect(await getActiveCalibrationVersion(db)).toBe('cal-y')
    expect(loadResolvedKnots(await loadCalibrationMaps(db, ['cal-y']), 'cal-y')).toEqual(KNOTS_A)

    // 回退专项：连续两次 rollbackToIdentity 不抛，活动版本为 identity（复用 'identity' 这个 version 名再 append）。
    await expect(rollbackToIdentity(db)).resolves.toBeDefined()
    await expect(rollbackToIdentity(db)).resolves.toBeDefined()
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
  })

  it('测试 2b（再激活护栏）：forward swap 后回退到已存在的 identity 行仍能重新激活', async () => {
    // 这是「同 version 多行同内容」最关键的合法路径：identity 行先入表（首次回退），再 forward swap 到别的版本，
    // 然后再次回退到 identity——必须 append 一条新的 identity 行让它重新成为「最新=活动」。
    // 朴素的 (version,knots_hash) UNIQUE + onConflictDoNothing 会把第二条 identity 行吞掉、令回退失效；
    // 本 fix 用「触发器只拦同名异内容、允许同名同内容多行」守住此路径。
    await rollbackToIdentity(db) // identity 行入表，活动=identity
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
    await commitCalibrationMap(db, {
      map: { version: 'cal-fwd', knots: KNOTS_A },
      reason: 'forward-swap',
      createdBy: 'test',
    })
    expect(await getActiveCalibrationVersion(db)).toBe('cal-fwd')
    // 再次回退：必须重新激活 identity（append 新 identity 行，不被任何唯一约束吞掉）。
    await rollbackToIdentity(db)
    expect(await getActiveCalibrationVersion(db)).toBe(CALIBRATION_IDENTITY)
  })

  it('测试 3（承重）：旧 claim 的 recall value 不被同名重定义改写', async () => {
    // 先换上 cal-z = KNOTS_A 作活动 g'，再建一条钉到 cal-z 的可召回 claim。
    await commitCalibrationMap(db, {
      map: { version: 'cal-z', knots: KNOTS_A },
      reason: 'define',
      createdBy: 'test',
    })
    expect(await getActiveCalibrationVersion(db)).toBe('cal-z')

    await mkRecallableClaim('frozen redefine claim')
    const before = pick(
      await recallClaims(db, embedder, 'frozen redefine claim'),
      'frozen redefine claim',
    )
    expect(before.confidence.calibrationVersion).toBe('cal-z')
    const valueA = before.confidence.value

    // 尝试用 cal-z = KNOTS_B（会给出不同 value）重定义 → 被拒。
    await expect(
      commitCalibrationMap(db, {
        map: { version: 'cal-z', knots: KNOTS_B },
        reason: 'silent-redefine',
        createdBy: 'test',
      }),
    ).rejects.toThrow(/same version.*different knots|不可重定义|immutab/i)

    // 再召回同一 claim：value 不变、版本锚仍 cal-z（历史快照未被回溯改写）。
    const after = pick(
      await recallClaims(db, embedder, 'frozen redefine claim'),
      'frozen redefine claim',
    )
    expect(after.confidence.value).toBeCloseTo(valueA, 6)
    expect(after.confidence.calibrationVersion).toBe('cal-z')
  })

  it('测试 4：绕过 store 直插同 version 不同 knots → DB 不可变触发器拒', async () => {
    await commitCalibrationMap(db, {
      map: { version: 'cal-w', knots: KNOTS_A },
      reason: 'define',
      createdBy: 'test',
    })

    // 底层 drizzle 直插，绕过 store 的应用层门：同 version、不同 knots、不同 knots_hash。
    // 若仅有应用门、无 DB 兜底，此直插会成功（TOCTOU / 脏直写）；有不可变触发器则被 DB 拒。
    await expect(
      db.insert(calibrationMap).values({
        id: randomUUID(),
        version: 'cal-w',
        knots: KNOTS_B,
        knotsHash: 'bypass-distinct-hash',
        evidence: {},
        reason: 'raw-bypass',
        createdBy: 'test',
      }),
    ).rejects.toThrow()
  })
})

/** 从 loadCalibrationMaps 结果取某 version 的 knots（断言辅助）。 */
function loadResolvedKnots(
  maps: Awaited<ReturnType<typeof loadCalibrationMaps>>,
  version: string,
): CalibrationKnot[] {
  const m = maps.get(version)
  if (!m) throw new Error(`loadResolvedKnots: version ${version} not resolved`)
  return m.knots
}
