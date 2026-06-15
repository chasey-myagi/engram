/**
 * EGR-CR-051 回归：freezeRedTeamGeneration() 在冻结前的 fail-loud 准入校验（validateRedTeamItems）。
 *
 * 背景：version UNIQUE + append-only ⇒ 一个 malformed 世代一旦冻结就**永久**留在 redteam_generations、
 * 不可修、只能另起版本绕开。本套测试钉死：重复 item id / 未知 class / 缺 claimText|evidence|sourceKind /
 * contradiction|near_dup_poison 缺 anchor / asOf 非法 —— 都在 `db.insert` 之前被拒，且 DB 里不留半冻结坏 version。
 *
 * 测试类型：integration(DB)，因为既要断言「拒」又要断言「拒后 DB 无残留」。harness 复用 system-dimensions.test.ts
 * 样板（pg.Pool + drizzle migrate + createDb，beforeEach TRUNCATE 清表）。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type DB } from '../db/client.js'
import {
  freezeRedTeamGeneration,
  getRedTeamGeneration,
  REDTEAM_CLASSES,
  type RedTeamClass,
  type RedTeamItem,
} from '../spi/redteam-generation.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

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
  pool.on('error', () => {}) // 吞 teardown 期 DROP ... WITH(FORCE) 杀连接的 57P01（测试已结束属预期）
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE redteam_immunity_scores, redteam_generations CASCADE')
})

/** 一条良构 item 工厂：默认四字段齐全、id 唯一；各用例按需破坏一个字段。 */
function goodItem(overrides: Partial<RedTeamItem> = {}): RedTeamItem {
  return {
    id: `item-${randomUUID()}`,
    redteamClass: 'false',
    claimText: 'Water boils at at least 300 degrees Celsius at sea level',
    subject: 'water',
    predicate: 'boilingPointC',
    object: 'at least 300',
    evidence: 'Water boils at at least 100 degrees Celsius at sea level.',
    sourceKind: 'structured_spec',
    ...overrides,
  }
}

/** 一条良构 contradiction/poison（带合法 anchor），用于 anchor 破坏用例的基底。 */
function goodAnchored(
  redteamClass: RedTeamClass,
  overrides: Partial<RedTeamItem> = {},
): RedTeamItem {
  return goodItem({
    redteamClass,
    claimText: 'The speed of light in vacuum is about 150000 km/s',
    subject: 'lightSpeed',
    predicate: 'vacuumKmPerSec',
    object: '150000',
    evidence: 'A disputed feed claims light travels about 150000 km/s in vacuum.',
    sourceKind: 'external_feed',
    anchor: {
      claimText: 'The speed of light in vacuum is about 299792 km/s',
      subject: 'lightSpeed',
      predicate: 'vacuumKmPerSec',
      object: '299792',
      evidence: 'The speed of light in vacuum is about 299792 km/s (CODATA).',
      sourceKind: 'formal_document',
    },
    ...overrides,
  })
}

/** 一条 contradiction/poison 类但**整体缺 anchor** 的 item（exactOptionalPropertyTypes 下不能写 anchor:undefined，只能不带该键）。 */
function anchorlessOfClass(redteamClass: RedTeamClass): RedTeamItem {
  return goodItem({
    redteamClass,
    claimText: 'The speed of light in vacuum is about 150000 km/s',
    subject: 'lightSpeed',
    predicate: 'vacuumKmPerSec',
    object: '150000',
    evidence: 'A disputed feed claims light travels about 150000 km/s in vacuum.',
    sourceKind: 'external_feed',
  })
}

const reason = 'EGR-CR-051 regression'

describe('freezeRedTeamGeneration: insert 前 fail-loud 准入校验（EGR-CR-051）', () => {
  // 1) 重复 id 被拒 + 无半冻结坏 version
  it('重复 item id → 拒，且该 version 不落库', async () => {
    const a = goodItem({ id: 'dup' })
    const aSameId = goodItem({ id: 'dup', claimText: 'A different but same-id item' })
    await expect(
      freezeRedTeamGeneration(db, { version: 'rt-dup-id', items: [a, aSameId], reason }),
    ).rejects.toThrow(/duplicate item id/i)
    expect(await getRedTeamGeneration(db, 'rt-dup-id')).toBeNull()
  })

  // 2) 未知 redteamClass 被拒（把晚爆点提前到冻结时）
  it('未知 redteamClass → 拒，且该 version 不落库', async () => {
    const bad = goodItem({ redteamClass: 'bogus' as RedTeamClass })
    await expect(
      freezeRedTeamGeneration(db, { version: 'rt-bad-class', items: [bad], reason }),
    ).rejects.toThrow(/unknown redteam class/i)
    expect(await getRedTeamGeneration(db, 'rt-bad-class')).toBeNull()
  })

  // 3) 缺 claimText 被拒
  it('claimText 为空 → 拒，且该 version 不落库', async () => {
    const bad = goodItem({ claimText: '' })
    await expect(
      freezeRedTeamGeneration(db, { version: 'rt-no-claim', items: [bad], reason }),
    ).rejects.toThrow()
    expect(await getRedTeamGeneration(db, 'rt-no-claim')).toBeNull()
  })

  // 4) 缺 evidence 被拒
  it('evidence 为空 → 拒，且该 version 不落库', async () => {
    const bad = goodItem({ evidence: '' })
    await expect(
      freezeRedTeamGeneration(db, { version: 'rt-no-evidence', items: [bad], reason }),
    ).rejects.toThrow()
    expect(await getRedTeamGeneration(db, 'rt-no-evidence')).toBeNull()
  })

  // 5) 缺 sourceKind 被拒
  it('sourceKind 为空 → 拒，且该 version 不落库', async () => {
    const bad = goodItem({ sourceKind: '' })
    await expect(
      freezeRedTeamGeneration(db, { version: 'rt-no-sourcekind', items: [bad], reason }),
    ).rejects.toThrow()
    expect(await getRedTeamGeneration(db, 'rt-no-sourcekind')).toBeNull()
  })

  // 6) contradiction 缺 anchor 被拒（anchor 整体缺失 / anchor.evidence 空）
  it('contradiction 缺 anchor → 拒，且该 version 不落库', async () => {
    const noAnchor = anchorlessOfClass('contradiction')
    await expect(
      freezeRedTeamGeneration(db, { version: 'rt-contra-no-anchor', items: [noAnchor], reason }),
    ).rejects.toThrow(/anchor/i)
    expect(await getRedTeamGeneration(db, 'rt-contra-no-anchor')).toBeNull()

    const badAnchorEvidence = goodAnchored('contradiction', {
      anchor: {
        claimText: 'The speed of light in vacuum is about 299792 km/s',
        evidence: '',
        sourceKind: 'formal_document',
      },
    })
    await expect(
      freezeRedTeamGeneration(db, {
        version: 'rt-contra-anchor-noevidence',
        items: [badAnchorEvidence],
        reason,
      }),
    ).rejects.toThrow(/anchor/i)
    expect(await getRedTeamGeneration(db, 'rt-contra-anchor-noevidence')).toBeNull()
  })

  // 7) near_dup_poison 缺 anchor 被拒
  it('near_dup_poison 缺 anchor → 拒，且该 version 不落库', async () => {
    const noAnchor = anchorlessOfClass('near_dup_poison')
    await expect(
      freezeRedTeamGeneration(db, { version: 'rt-poison-no-anchor', items: [noAnchor], reason }),
    ).rejects.toThrow(/anchor/i)
    expect(await getRedTeamGeneration(db, 'rt-poison-no-anchor')).toBeNull()
  })

  // 8) asOf 非法（无法解析 ISO）被拒
  it('asOf 非法 → 拒，且该 version 不落库', async () => {
    const bad = goodItem({ asOf: 'not-a-date' })
    await expect(
      freezeRedTeamGeneration(db, { version: 'rt-bad-asof', items: [bad], reason }),
    ).rejects.toThrow()
    expect(await getRedTeamGeneration(db, 'rt-bad-asof')).toBeNull()
  })

  // 9) 正向回归：全良构、四类齐全、id 唯一 → 冻结成功，读回 items 数量 / id 集合一致（validator 不误伤）
  it('良构世代（四类齐全、id 唯一）→ 冻结成功，读回一致', async () => {
    const items: RedTeamItem[] = [
      goodItem({ id: 'false-1' }),
      goodAnchored('contradiction', { id: 'contra-1' }),
      goodItem({ id: 'stale-1', redteamClass: 'stale', asOf: '1999-01-01T00:00:00.000Z' }),
      goodAnchored('near_dup_poison', { id: 'poison-1' }),
    ]
    const frozen = await freezeRedTeamGeneration(db, {
      version: 'rt-good',
      items,
      reason,
    })
    expect(frozen.version).toBe('rt-good')

    const read = await getRedTeamGeneration(db, 'rt-good')
    expect(read).not.toBeNull()
    expect(read!.items.length).toBe(items.length)
    expect(new Set(read!.items.map((i) => i.id))).toEqual(new Set(items.map((i) => i.id)))
  })

  // 完整性自证：REDTEAM_CLASSES 是 validator class 白名单的单一真相源。
  it('REDTEAM_CLASSES 含四类（白名单单一真相源）', () => {
    expect([...REDTEAM_CLASSES].sort()).toEqual(
      ['contradiction', 'false', 'near_dup_poison', 'stale'].sort(),
    )
  })
})
