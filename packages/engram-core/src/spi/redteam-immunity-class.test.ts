/**
 * EGR-CR-055（#130）· redteam class 运行时白名单（不需 DB 的纯单测）。
 * 验：isRedTeamClass 正负例 + recordImmunityScore 在 insert 前先拒未知 class（不留脏行）。
 * DB 集成侧（真 constraint / 聚合不被污染）见 @engram/workers redteam-immunity.test.ts。
 */
import { describe, expect, it, vi } from 'vitest'

import type { DB } from '../db/client.js'
import { isRedTeamClass, recordImmunityScore } from './redteam-generation.js'

describe('EGR-CR-055 · isRedTeamClass 运行时白名单', () => {
  it('A1 · 四类全 true；非四类 / 非字符串全 false', () => {
    for (const ok of ['false', 'contradiction', 'stale', 'near_dup_poison']) {
      expect(isRedTeamClass(ok)).toBe(true)
    }
    for (const bad of ['sql_injection', 'reward', '', 'False', 'NEAR_DUP_POISON']) {
      expect(isRedTeamClass(bad)).toBe(false)
    }
    for (const nonStr of [null, undefined, 123, {}, [], true]) {
      expect(isRedTeamClass(nonStr)).toBe(false)
    }
  })
})

describe('EGR-CR-055 · recordImmunityScore 在 insert 前拒未知 class', () => {
  it('A2 · 伪造 class → reject(/unknown redteamClass/) 且 db.insert 从未被调用', async () => {
    // insert 不应被触达：spy 一旦被调用即让测试自暴（证明在 insert 前 fail，不留脏行）。
    const insert = vi.fn(() => {
      throw new Error('db.insert must not be called for an unknown redteamClass')
    })
    const fakeDb = { insert } as unknown as DB

    await expect(
      recordImmunityScore(fakeDb, {
        generationVersion: 'x',
        redteamClass: 'sql_injection' as any,
        injected: 10,
        detected: 5,
      }),
    ).rejects.toThrow(/unknown redteamClass.*sql_injection|sql_injection.*unknown redteamClass/)

    expect(insert).not.toHaveBeenCalled()
  })

  it('A2b · 未知 class 的拒绝先于计数校验（即便计数也非法，错误仍是 class 错误）', async () => {
    const insert = vi.fn(() => {
      throw new Error('db.insert must not be called')
    })
    const fakeDb = { insert } as unknown as DB

    await expect(
      recordImmunityScore(fakeDb, {
        generationVersion: 'x',
        redteamClass: 'reward' as any,
        injected: -1, // 计数也非法，但 class 校验在前 → 报 class 错误
        detected: 5,
      }),
    ).rejects.toThrow(/unknown redteamClass/)

    expect(insert).not.toHaveBeenCalled()
  })
})
