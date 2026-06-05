/**
 * P4a · 红蓝对抗回合（runRedBlueRound）—— 端到端真 DB 驱动真工种，复用 S29/S12/S31 真件、零 bespoke mock。
 *
 * 覆盖六交付 + 两铁律：
 *   1) 红队：冻结世代（freezeRedTeamGeneration；append-only、撞名抛）。
 *   2) 题免疫 A1（铁律）：每条 item 先过真 promoteCandidate 才进被计分 cohort；库本能答的带毒 item 被 BLOCK、永不计分。
 *   3) 蓝队答题：经 S29 真注入器驱动真 Verifier/Reconciler/Arbiter 免疫反应（答案=系统是否处置毒株）。
 *   4) 裁判判分：per-class detection rate 落 redteam_immunity_scores（纯报告维度）。
 *   5) 失败归因回流（S31）：每个 breach 经 attributeFailure 归到**恰好一个** loop。
 *   6) 下一代更难题：漏检项 escalate 成更难、冻结、版本化、append-only 的下一代；perfect round ⇒ 无 escalation。
 *   A1 铁律：自败/带毒 item 进不了 scored cohort（测一条被 BLOCK）。
 *   A3 铁律：检出率/胜负结构上**不进**校准拟合器（collectUsageCalibrationSamples）与纵向（recompete 白名单只有 ece/coverage）。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addSource,
  appendClaim,
  attributeFailure,
  collectUsageCalibrationSamples,
  createDb,
  freezeRedTeamGeneration,
  getImmunityScores,
  getRecompeteEvents,
  getRedTeamGeneration,
  loopForRedTeamClass,
  makeFakeEmbedder,
  recordImmunityScore,
  recordRecompete,
  RECOMPETE_DIMENSIONS,
  RESPONSIBLE_LOOPS,
  schema,
  transitionClaim,
  type DB,
  type Embedder,
  type ProvenanceInput,
  type RedTeamClass,
  type RedTeamItem,
} from '@engram/core'

import { runRedBlueRound, escalateMiss, type RoundResult } from '../red-blue-round.js'
import { REDTEAM_GENERATION_ITEMS } from '../redteam.gen.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'engram-core',
  'drizzle',
)

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder: Embedder = makeFakeEmbedder()

/** 清所有可被注入污染的工作表（红队世代/分表单独清，因 freeze 是 append-only 跨 item 持久）。 */
async function resetWorkTables(): Promise<void> {
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, l5_candidates, golden_questions, promotion_audit CASCADE',
  )
}

/** 清红队世代/免疫分/纵向表（每个回合用独立 version，避免 freeze 撞名）。 */
async function resetRedTeamTables(): Promise<void> {
  await pool.query(
    'TRUNCATE redteam_immunity_scores, redteam_generations, recompete_events CASCADE',
  )
}

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

/** 经真路径写一条 active claim（4 条 authority=1.0 独立 exact 源 → base≥0.5 过 D2 门）。 */
async function appendActiveClaim(draft: {
  claimText: string
  subject?: string
  predicate?: string
  object?: string
}): Promise<string> {
  const provs: ProvenanceInput[] = []
  for (let i = 0; i < 4; i++) {
    const src = await addSource(db, {
      content: `evidence: ${draft.claimText}`,
      contentHash: randomUUID(),
      kind: 'formal_document',
      authorityScore: 1.0,
    })
    provs.push({ sourceId: src.sourceId, locator: `seed:${i}`, relevance: 'exact' })
  }
  const { claimId } = await appendClaim(
    db,
    embedder,
    { ...draft, createdBy: 'agent:distiller' },
    provs,
  )
  await transitionClaim(db, claimId, 'active', { by: 'agent:distiller', entailmentPass: true })
  return claimId
}

/** 取一类 item 子集（每类 1 条，够测全四类又快）。 */
function oneOfEachClass(): RedTeamItem[] {
  const classes = ['false', 'contradiction', 'stale', 'near_dup_poison'] as const
  return classes.map((c) => REDTEAM_GENERATION_ITEMS.find((i) => i.redteamClass === c)!)
}

describe('P4a · 红蓝对抗回合（runRedBlueRound：真 DB 驱动真工种）', () => {
  describe('完整回合（全检出 → perfect round）', () => {
    let result: RoundResult

    beforeAll(async () => {
      await resetRedTeamTables()
      result = await runRedBlueRound(
        { db, embedder },
        {
          generationVersion: 'rb-round-perfect',
          items: oneOfEachClass(),
          resetWorkTables,
        },
      )
    })

    it('① 红队：这代世代被冻结进库（append-only 锚）', async () => {
      const gen = await getRedTeamGeneration(db, 'rb-round-perfect')
      expect(gen).not.toBeNull()
      expect(gen!.items.length).toBe(4)
    })

    it('② 题免疫 A1：四条 item 全过真 promoteCandidate → 全进被计分 cohort', () => {
      expect(result.admissions.length).toBe(4)
      expect(result.admissions.every((a) => a.admitted)).toBe(true)
      expect(result.scoredItemIds.length).toBe(4)
      expect(result.blockedItemIds.length).toBe(0)
    })

    it('③④ 蓝队答题 + 裁判判分：四类全检出（detection rate=1），落 redteam_immunity_scores', async () => {
      expect(result.classScores.length).toBe(4)
      for (const s of result.classScores) {
        expect(s.detected).toBe(s.injected) // 全检出
        expect(s.detectionRate).toBe(1)
      }
      // 判分作为纯报告维度落库（每类一行）。
      const rows = await getImmunityScores(db, 'rb-round-perfect')
      expect(rows.length).toBe(4)
      const byClass = new Set(rows.map((r) => r.redteamClass))
      expect(byClass).toEqual(new Set(['false', 'contradiction', 'stale', 'near_dup_poison']))
    })

    it('⑤ 无 breach（全检出）⇒ breaches 为空', () => {
      expect(result.breaches.length).toBe(0)
    })

    it('⑥ perfect round ⇒ 下一代为空、未冻结（无可生长处）', async () => {
      expect(result.nextGeneration.items.length).toBe(0)
      expect(result.nextGeneration.frozen).toBe(false)
      const nextGen = await getRedTeamGeneration(db, 'rb-round-perfect+1')
      expect(nextGen).toBeNull() // 没冻结新世代
    })
  })

  describe('有漏检的回合（breach → S31 单环归因 → escalation 下一代）', () => {
    let result: RoundResult
    // 一条蓄意「逮不到」的 false item：evidence **真蕴含** claim（claim 下界 ≤ evidence 下界）⇒ bound oracle 判 pass
    // ⇒ 真 Verifier 不 flag ⇒ 蓝队漏检（真 breach，非伪造）。与一条正常会被逮到的 false item 同跑。
    const undetectableFalse: RedTeamItem = {
      id: 'false-evades',
      redteamClass: 'false',
      claimText: 'Foobar metric is at least 3 units',
      subject: 'foobar',
      predicate: 'metric',
      object: 'at least 3',
      // evidence 下界(10) ≥ claim 下界(3) ⇒ oracle 判 pass ⇒ Verifier 不 flag ⇒ 漏检。
      evidence: 'Foobar metric is at least 10 units.',
      sourceKind: 'formal_document',
    }
    const detectableFalse = REDTEAM_GENERATION_ITEMS.find((i) => i.redteamClass === 'false')!

    beforeAll(async () => {
      await resetRedTeamTables()
      result = await runRedBlueRound(
        { db, embedder },
        {
          generationVersion: 'rb-round-miss',
          items: [detectableFalse, undetectableFalse],
          resetWorkTables,
        },
      )
    })

    it('蓝队对蓄意逃逸 item 漏检（detected<injected）⇒ 产生 breach', () => {
      const falseScore = result.classScores.find((s) => s.redteamClass === 'false')!
      expect(falseScore.injected).toBe(2)
      expect(falseScore.detected).toBe(1) // 一条逮到、一条逃逸
      expect(result.breaches.length).toBe(1)
      expect(result.breaches[0]!.redteamClass).toBe('false')
    })

    it('⑤ breach 经 S31 attributeFailure 归到**恰好一个** loop（false→verifier_miss）', () => {
      const br = result.breaches[0]!
      // 恰好一个 responsibleLoop，且在合法环域内。
      expect(RESPONSIBLE_LOOPS).toContain(br.attribution.responsibleLoop)
      expect(br.attribution.candidates.length).toBe(1) // 单环（redteam_breach 类别确定性映射）
      expect(br.attribution.responsibleLoop).toBe(br.attribution.candidates[0])
      // 与 S31 的类别→环映射一致（同一真函数，非重新发明）。
      expect(br.attribution.responsibleLoop).toBe(loopForRedTeamClass('false'))
      expect(br.attribution.failureKind).toBe('redteam_breach')
      expect(br.attribution.failureRef).toBe('rb-round-miss:false')
    })

    it('⑥ escalation：下一代非空、由漏检项 seed、且更难（margin 收窄），冻结进库', async () => {
      expect(result.nextGeneration.items.length).toBe(1) // 仅漏检的那条
      expect(result.nextGeneration.frozen).toBe(true)
      const esc = result.nextGeneration.items[0]!
      // seed from miss：血缘 id 含原 miss id。
      expect(esc.id).toContain('false-evades')
      // 更难 = claim 下界向 evidence 下界(10) 靠拢（3 → ~6），仍 < 10 ⇒ 仍是 false 但更贴近检出边界。
      const lb = (s: string) => parseFloat(s.match(/(\d+(?:\.\d+)?)/)![1]!)
      expect(lb(esc.claimText)).toBeGreaterThan(3)
      expect(lb(esc.claimText)).toBeLessThan(10)
      // 真冻结进库（版本化 append-only，旧世代留存）。
      const nextGen = await getRedTeamGeneration(db, 'rb-round-miss+1')
      expect(nextGen).not.toBeNull()
      expect(nextGen!.items.length).toBe(1)
      const prevGen = await getRedTeamGeneration(db, 'rb-round-miss')
      expect(prevGen!.items.length).toBe(2) // 上一代原样保留（未被改写）
    })

    it('escalation 确定性 + 方向正确：escalateMiss 纯函数(同输入逐字段相等)，且四类各把 margin **朝检出边界**收窄(不只是变了、是变难了；反转算术会失败本断言)', () => {
      const num = (s: string | undefined): number =>
        s ? parseFloat(s.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 'NaN') : NaN
      const fixedNow = new Date('2026-03-15T00:00:00.000Z')
      for (const cls of ['false', 'contradiction', 'near_dup_poison', 'stale'] as const) {
        const item = REDTEAM_GENERATION_ITEMS.find((i) => i.redteamClass === cls)!
        const a = escalateMiss(item, 'detv1', fixedNow)
        const b = escalateMiss(item, 'detv1', fixedNow)
        expect(a).toEqual(b) // 纯函数：同 (item, ver, now) 逐字段相等（含 stale 的 asOf——注入 now，绝不烤 Date.now()）
        expect(a.id).toBe(`${item.id}::esc:detv1`) // 血缘 id 含原 id
        expect(a.redteamClass).toBe(cls)

        // 方向：升代必须把对抗 margin **严格朝检出边界**收窄（反转 `<`/`>` 或 `+`/`-` 会让值远离边界 → 失败这里）。
        if (cls === 'false') {
          const evidLb = num(item.evidence) // claim 下界朝 evidence 下界(检出翻转边界)靠拢
          const before = Math.abs(num(item.object ?? item.claimText) - evidLb)
          const after = Math.abs(num(a.object ?? a.claimText) - evidLb)
          expect(after).toBeLessThan(before)
        } else if (cls === 'contradiction' || cls === 'near_dup_poison') {
          const aObj = num(item.anchor?.object) // 被审 object 朝 anchor object 靠拢（分歧/投毒幅度更小）
          const before = Math.abs(num(item.object) - aObj)
          const after = Math.abs(num(a.object) - aObj)
          expect(after).toBeLessThan(before)
        } else {
          const orig = new Date(item.asOf!).getTime() // stale：asOf 朝注入 now 靠拢半步（更接近半衰期阈值）
          const escd = new Date(a.asOf!).getTime()
          expect(escd).toBeGreaterThan(orig) // 更晚（朝 now）
          expect(escd).toBeLessThan(fixedNow.getTime()) // 仍早于 now（半步、未越过）
          // 且确定性地**依赖注入的 now**（换 now → 不同 asOf；证明用的是注入时钟而非墙钟/常量）。
          const c = escalateMiss(item, 'detv1', new Date('2026-09-15T00:00:00.000Z'))
          expect(c.asOf).not.toBe(a.asOf)
        }
      }
    })
  })

  // class→loop 映射全覆盖（gate#1 test-review：此前只有 false 一类经 round 验过 breach→归因）。
  // 注：contradiction/stale 的「真 e2e 漏检」无法构造——其病原属性本身即检出触发器（确定性检测器逮不住才反常）；
  // 故对四类经 round 用的**同一** S31 attributeFailure 机制逐类钉死 class→单环映射。
  describe('⑤ breach → S31 单环归因：四类 redteam_breach 各确定性映射到恰好一个 loop', () => {
    it.each(['false', 'contradiction', 'near_dup_poison', 'stale'] as const)(
      'redteam_breach[%s] → candidates 恰好一个 = loopForRedTeamClass(%s)',
      async (cls: RedTeamClass) => {
        const gen = `breach-${cls}-${randomUUID().slice(0, 8)}`
        await freezeRedTeamGeneration(db, {
          version: gen,
          items: [REDTEAM_GENERATION_ITEMS.find((i) => i.redteamClass === cls)!],
          reason: `breach mapping test ${cls}`,
        })
        await recordImmunityScore(db, {
          generationVersion: gen,
          redteamClass: cls,
          injected: 2,
          detected: 1, // breach: 漏检 1
        })
        const attribution = await attributeFailure(db, {
          kind: 'redteam_breach',
          generationVersion: gen,
          redteamClass: cls,
        })
        expect(attribution.candidates.length).toBe(1) // 恰好一个（P3 门：单环）
        expect(attribution.responsibleLoop).toBe(loopForRedTeamClass(cls))
        expect(attribution.responsibleLoop).toBe(attribution.candidates[0])
        expect(RESPONSIBLE_LOOPS).toContain(attribution.responsibleLoop)
      },
    )
  })

  describe('A1 铁律：库本能答的带毒 item 被 BLOCK、永不进 scored cohort', () => {
    beforeEach(async () => {
      await resetRedTeamTables()
    })

    it('一条 claimText 库已有同义 active claim 的 item → kbTrulyLacks=false → BLOCK，不计分', async () => {
      // 带毒 item：库里**预先**有一条与其 claimText 同义的 active claim（recall 会命中 ⇒ 这是污染真值的考题）。
      const poisoned: RedTeamItem = {
        id: 'poisoned-exam',
        redteamClass: 'false',
        claimText: 'The poisoned exam asks an already-answered question xyzzy-7',
        evidence: 'irrelevant',
        sourceKind: 'formal_document',
      }
      const cleanFalse = REDTEAM_GENERATION_ITEMS.find((i) => i.redteamClass === 'false')!

      // resetWorkTables 包一层：**清完库后**为带毒 item 重新 seed 那条同义 active claim（让 A1 在 clean+seed 上验真）。
      // 这是 A1 在「库本能答」分支被真实触发的唯一干净注入点（评测=消费，经真 append/transition，不旁路改状态）。
      const seedingReset = async () => {
        await resetWorkTables()
        await appendActiveClaim({ claimText: poisoned.claimText })
      }

      const res = await runRedBlueRound(
        { db, embedder },
        {
          generationVersion: 'rb-a1-block',
          items: [cleanFalse, poisoned],
          resetWorkTables: seedingReset,
        },
      )

      // 带毒 item 被 A1 BLOCK：不在被计分 cohort，进 blocked。
      const poisonAdm = res.admissions.find((a) => a.itemId === 'poisoned-exam')!
      expect(poisonAdm.admitted).toBe(false)
      expect(res.blockedItemIds).toContain('poisoned-exam')
      expect(res.scoredItemIds).not.toContain('poisoned-exam')
      // 带毒 item 绝不进 golden（永不计分），且 A1 给了人读理由（库已能答）。
      expect(poisonAdm.reasons.some((r) => r.includes('KB already answers'))).toBe(true)
      const goldens = await db.select().from(schema.goldenQuestions)
      // cleanFalse 过门会进 golden；带毒的 poisoned-exam 绝不进。
      const poisonGolden = goldens.filter((g) => g.query === poisoned.claimText)
      expect(poisonGolden.length).toBe(0)
    })
  })

  describe('A3 铁律：检出率/胜负结构上不进校准 g 与纵向趋势', () => {
    it('一整回合（含 breach 与判分）跑完后，校准拟合器取样仍为空（拟合器只读 usage_truth，绝不读免疫分）', async () => {
      await resetRedTeamTables()
      const undetectable: RedTeamItem = {
        id: 'a3-evades',
        redteamClass: 'false',
        claimText: 'A3 metric is at least 1 unit',
        evidence: 'A3 metric is at least 99 units.', // evidence 蕴含 claim ⇒ 漏检 ⇒ breach + 判分
        sourceKind: 'formal_document',
      }
      await runRedBlueRound(
        { db, embedder },
        {
          generationVersion: 'rb-a3',
          items: [undetectable],
          resetWorkTables,
        },
      )
      // 回合落了免疫分（判分）。但校准拟合器结构上只读 claim_verification(kind='usage_truth')，从不读免疫分表。
      const samples = await collectUsageCalibrationSamples(db)
      expect(samples.length).toBe(0) // 检出率/胜负一条都没漏进 g 拟合输入（A3 守住）
    })

    it('回合从不写纵向 recompete；且 recompete 白名单物理拒检出率维度（detection_rate 写不进纵向）', async () => {
      await resetRedTeamTables()
      await runRedBlueRound(
        { db, embedder },
        {
          generationVersion: 'rb-a3b',
          items: [oneOfEachClass()[0]!], // 一条干净 false（会检出）
          resetWorkTables,
        },
      )
      // 回合**从不**调 recordRecompete ⇒ 纵向表无任何本回合行。
      const events = await getRecompeteEvents(db)
      expect(events.length).toBe(0)
      // 结构性边界：即便有人试图把检出率塞进纵向，白名单（只有 ece/coverage）会物理拒。
      expect(RECOMPETE_DIMENSIONS as readonly string[]).not.toContain('detection_rate')
      await expect(
        recordRecompete(db, {
          frozenGoldenVersion: 'x',
          releaseSnapshot: 'r',
          // @ts-expect-error 故意传非白名单维度（检出率），证明写入处硬拒。
          dimension: 'detection_rate',
          value: 1,
          delta: null,
          ring: 'outer',
        }),
      ).rejects.toThrow()
    })
  })

  describe('错误路径 / 兜底分支', () => {
    it('escalateMiss 兜底：无可解析数字的 miss item → 原样升代（只换 id 血缘，其余字段逐字段不变）', () => {
      const noNum: RedTeamItem = {
        id: 'no-number',
        redteamClass: 'false',
        claimText: 'this claim has no digits at all',
        evidence: 'and the evidence has none either',
        sourceKind: 'structured_spec',
      }
      const esc = escalateMiss(noNum, 'v2', new Date('2026-03-15T00:00:00.000Z'))
      expect(esc.id).toBe('no-number::esc:v2') // 仅 id 升代血缘
      expect({ ...esc, id: noNum.id }).toEqual(noNum) // 其余字段逐字段原样（无数字可收窄 ⇒ 不改值，仍是 miss）
    })

    it('autoFreeze=false 且世代已预冻结 → 回合正常跑通，不二次 freeze（不撞名抛）', async () => {
      await resetRedTeamTables()
      const items = [oneOfEachClass()[0]!] // 一条干净 false
      await freezeRedTeamGeneration(db, {
        version: 'rb-prefrozen',
        items,
        reason: 'pre-frozen by caller',
      })
      const res = await runRedBlueRound(
        { db, embedder },
        { generationVersion: 'rb-prefrozen', items, resetWorkTables, autoFreeze: false },
      )
      expect(res.scoredItemIds.length).toBeGreaterThanOrEqual(1) // 跑通（未因二次 freeze 撞名抛）
      expect(await getRedTeamGeneration(db, 'rb-prefrozen')).not.toBeNull()
    })

    it('autoFreeze=false 且世代未预冻结 → 在任何蓝队注入**之前**快速失败（claim 表仍空旁证未白跑）', async () => {
      await resetRedTeamTables()
      await resetWorkTables()
      await expect(
        runRedBlueRound(
          { db, embedder },
          {
            generationVersion: 'rb-never-frozen',
            items: [oneOfEachClass()[0]!],
            resetWorkTables,
            autoFreeze: false,
          },
        ),
      ).rejects.toThrow(/not pre-frozen/)
      // 快速失败发生在 ②③ 注入之前 ⇒ claim 表仍空（没白跑蓝队才 FK 炸）。
      expect((await db.select().from(schema.claim)).length).toBe(0)
    })

    it('空 items → 拒（一个回合至少跑 1 条对抗 item）', async () => {
      await expect(
        runRedBlueRound(
          { db, embedder },
          { generationVersion: 'rb-empty', items: [], resetWorkTables },
        ),
      ).rejects.toThrow(/>=1/)
    })

    it('同一 generationVersion 跑两次 → 第二次撞名抛（世代 append-only、纵向锚不可静默重写）', async () => {
      await resetRedTeamTables()
      const items = [oneOfEachClass()[0]!]
      await runRedBlueRound(
        { db, embedder },
        { generationVersion: 'rb-dup', items, resetWorkTables },
      )
      await expect(
        runRedBlueRound({ db, embedder }, { generationVersion: 'rb-dup', items, resetWorkTables }),
      ).rejects.toThrow() // freezeRedTeamGeneration UNIQUE 撞名 → 世代不可静默重写
    })
  })
})
