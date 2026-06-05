/**
 * S29 红队四类免疫 + 冻结世代 + A1/A3 红线（A.9 stories 38/50/51）—— 端到端真 DB 驱动真工种。
 *
 * 不是 smoke：四类对抗样本全经**真 append_claim SPI** 注入（评测=消费，零旁路），免疫反应由**真 Verifier/Arbiter/
 * Reconciler**（fake 端口 entailment judge / harness-pi fake runtime）驱动，断言只读 DB 真状态。回归会让对应类检出率跌。
 *
 *   1) 四注入器 + 免疫反应：false→Verifier flag / contradiction→S8 边+Arbiter 路 / stale→消费门压穿+时效 flag /
 *      near_dup_poison→Reconciler poison flag+升级。
 *   2) 免疫力维度：per-class detected/injected → detectionRate，落 redteam_immunity_scores（不进任何计分）。
 *   3) 冻结世代：freezeRedTeamGeneration 版本化 append-only；同名重写被 UNIQUE 拒；新世代=新版本、旧世代留存；
 *      对同一冻结集重打分得同一结果。
 *   4) A1 红线：每条红队 item 本身是毒株，须先过 S12 promoteCandidate 才进 scored golden；故意自败的毒株被 BLOCK。
 *   5) A3 红线：免疫分/检出率结构上**不是**校准拟合器（collectUsageCalibrationSamples）或任何纵向趋势的输入。
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
  collectUsageCalibrationSamples,
  createDb,
  freezeRedTeamGeneration,
  getImmunityScores,
  getRedTeamGeneration,
  getRedTeamGenerations,
  makeFakeEmbedder,
  promoteCandidate,
  recordImmunityScore,
  schema,
  transitionClaim,
  type DB,
  type ProvenanceInput,
} from '@engram/core'

import { runRedTeamGeneration, type ClassScore } from '../redteam-injector.js'
import { REDTEAM_GENERATION_ITEMS } from '../redteam.gen.js'
import { truncateEvalWorkTablesSql } from '../work-tables.js'

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
const embedder = makeFakeEmbedder()

/** 清所有可被注入污染的表（红队样本临时 seed、随每条 reset 消失；红队世代/分表单独清）。 */
async function resetWorkTables(): Promise<void> {
  await pool.query(truncateEvalWorkTablesSql())
}

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  pool.on('error', () => {}) // 吞 teardown 期 DROP ... WITH(FORCE) 终止连接的 57P01（测试已结束、连接被服务端杀属预期）
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

function scoreOf(scores: ClassScore[], cls: string): ClassScore {
  const s = scores.find((x) => x.redteamClass === cls)
  if (!s) throw new Error(`no score for class ${cls}`)
  return s
}

/**
 * 经真 append_claim 写一条带 4 条独立 supports 源（authority=1.0）的 claim 并晋升 active（base≥0.5 过 D2 门）。
 * 用于 A1 测试里造「库内已有的 active 锚 / 能被 recall 命中的背景事实」（评测=消费，经真路径，不旁路改状态）。
 */
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
    provs.push({ sourceId: src.sourceId, locator: `a1:${i}`, relevance: 'exact' })
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

describe('S29 · red-team four-class immunity (real workers via SPI)', () => {
  describe('四注入器 + 免疫反应（真工种驱动）', () => {
    let scores: ClassScore[]

    beforeAll(async () => {
      scores = await runRedTeamGeneration(
        { db, embedder },
        REDTEAM_GENERATION_ITEMS,
        resetWorkTables,
      )
    })

    it('false → Verifier entailment fail → claim flagged（每条都被真 Verifier 逮到）', () => {
      const s = scoreOf(scores, 'false')
      expect(s.injected).toBeGreaterThanOrEqual(3)
      expect(s.detected).toBe(s.injected) // 全检出
      for (const o of s.outcomes) {
        expect(o.reaction.worker).toBe('verifier')
        expect(o.reaction.entailment).toBe('fail') // 真 oracle 实算判 fail（非硬编码）
        expect(o.reaction.finalStatus).toBe('flagged') // 真 transitionClaim 蓝边收紧
      }
    })

    it('contradiction → append-time S8 contradicts edge + 真 Arbiter 路由', () => {
      const s = scoreOf(scores, 'contradiction')
      expect(s.injected).toBeGreaterThanOrEqual(3)
      expect(s.detected).toBe(s.injected)
      for (const o of s.outcomes) {
        expect(o.reaction.worker).toBe('arbiter')
        expect(o.reaction.contradictsEdges).toBeGreaterThan(0) // S8 append 时落了 contradicts 边
        // Arbiter 对这对产出了裁决（机判自裁 or 升级主编），即免疫反应触发。
        expect(
          (o.reaction.arbiterResolved as number) + (o.reaction.arbiterEscalated as number),
        ).toBeGreaterThan(0)
      }
    })

    it('stale → staleDecay 压穿消费门（recall 召不回）+ Verifier 时效巡查 flag', () => {
      const s = scoreOf(scores, 'stale')
      expect(s.injected).toBeGreaterThanOrEqual(3)
      expect(s.detected).toBe(s.injected)
      for (const o of s.outcomes) {
        expect(o.reaction.worker).toBe('verifier')
        expect(o.reaction.recalled).toBe(false) // 远古 staleDecay 把 value 压到消费门下 → recall 召不回
        expect(o.reaction.stale).toBe(true) // Verifier 时效巡查判 stale
        expect(o.reaction.finalStatus).toBe('flagged') // active→flagged
      }
    })

    it('near_dup_poison → Reconciler poison → flag + 升级信号（带对端 id，S18）', () => {
      const s = scoreOf(scores, 'near_dup_poison')
      expect(s.injected).toBeGreaterThanOrEqual(3)
      expect(s.detected).toBe(s.injected)
      for (const o of s.outcomes) {
        expect(o.reaction.worker).toBe('reconciler')
        expect(o.reaction.verdict).toBe('poison') // 真 objectSubsetViaEntailment 实算判 poison
        expect(o.reaction.escalatedToAnchor).toBe(true) // 升级信号带对端锚 id（S18 关系性 conflict 信号）
        expect(o.reaction.flagged).toBe(true) // active→flagged 蓝边收紧
      }
    })

    it('回归护栏（真反证）：把 false claim **晋升到 active** 后**不跑 Verifier** → 仍 active、未被 flag —— flag 由工种驱动而非 append/transition', async () => {
      // 旧版断言「draft ≠ flagged」是**恒真**的（A.4 无 draft→flagged 合法边），删掉 Verifier 也照样绿、根本不盯工种。
      // 真反证：必须先把幻觉**晋升到 active**（一条本可被 Verifier 收紧的活跃 claim），再证明「不跑 Verifier 就不会被 flag」。
      await resetWorkTables()
      const item = REDTEAM_GENERATION_ITEMS.find((i) => i.redteamClass === 'false')!
      // 与 runFalse 同款：挂 4 条 authority=1.0 独立 exact 源让 base 过 0.5 晋升门。
      const provs: { sourceId: string; locator: string; relevance: 'exact' }[] = []
      for (let i = 0; i < 4; i++) {
        const s = await addSource(db, {
          content: `${item.evidence} #neg-${i}`,
          contentHash: randomUUID(),
          kind: item.sourceKind as schema.SourceKind,
          authorityScore: 1.0,
        })
        provs.push({ sourceId: s.sourceId, locator: `neg:${i}`, relevance: 'exact' })
      }
      const { claimId } = await appendClaim(
        db,
        embedder,
        {
          claimText: item.claimText,
          ...(item.subject !== undefined ? { subject: item.subject } : {}),
          ...(item.predicate !== undefined ? { predicate: item.predicate } : {}),
          ...(item.object !== undefined ? { object: item.object } : {}),
        },
        provs,
      )
      // 晋升到 active（桩 entailmentPass）——一条**活跃**幻觉，本可被 Verifier 收紧到 flagged。
      await transitionClaim(db, claimId, 'active', { by: 'agent:distiller', entailmentPass: true })
      const promoted = (
        await db
          .select({ s: schema.claim.status })
          .from(schema.claim)
          .where(eq(schema.claim.id, claimId))
      )[0]!.s
      expect(promoted).toBe('active') // 晋升真成功（否则下面的反证空过）

      // **不跑 Verifier** → 活跃幻觉无人收紧 → 仍 active、未被 flag。
      // 这条在「删掉 Verifier 检出路径」时仍 active（正确反证）；在「append/transition 误 flag」时会 fail（真盯）。
      const [row] = await db
        .select({ s: schema.claim.status })
        .from(schema.claim)
        .where(eq(schema.claim.id, claimId))
      expect(row!.s).toBe('active') // 仍 active、绝非 flagged —— 免疫=工种驱动，缺工种就没免疫
    })
  })

  describe('免疫力维度（append-only，不进任何计分）', () => {
    let scores: ClassScore[]

    beforeAll(async () => {
      // 先冻结世代（FK 要求分行挂在已冻结世代上）。
      await pool.query('TRUNCATE redteam_immunity_scores, redteam_generations CASCADE')
      await freezeRedTeamGeneration(db, {
        version: 'rt-dim-test',
        items: [...REDTEAM_GENERATION_ITEMS],
        reason: 'S29 dimension test generation',
      })
      scores = await runRedTeamGeneration(
        { db, embedder },
        REDTEAM_GENERATION_ITEMS,
        resetWorkTables,
      )
      for (const s of scores) {
        await recordImmunityScore(db, {
          generationVersion: 'rt-dim-test',
          redteamClass: s.redteamClass,
          injected: s.injected,
          detected: s.detected,
          payload: { perItem: s.outcomes.map((o) => ({ id: o.itemId, detected: o.detected })) },
        })
      }
    })

    it('每类一行 detection-rate 维度，落 redteam_immunity_scores（detectionRate = detected/injected）', async () => {
      const rows = await getImmunityScores(db, 'rt-dim-test')
      expect(rows.length).toBe(4) // 四类
      for (const r of rows) {
        expect(r.detectionRate).toBeCloseTo(r.detected / r.injected, 10)
        expect(r.detected).toBeLessThanOrEqual(r.injected)
      }
      const byClass = new Set(rows.map((r) => r.redteamClass))
      expect(byClass).toEqual(new Set(['false', 'contradiction', 'stale', 'near_dup_poison']))
    })

    it('维度 append-only：再记一次同类不覆盖、各留一行，且**旧行值原样保留**（不被新 record 改写）', async () => {
      const beforeRows = await getImmunityScores(db, 'rt-dim-test', 'false')
      const priorFirst = beforeRows[0]! // 最早一行（asc(createdAt,id) → 始终居首）
      await recordImmunityScore(db, {
        generationVersion: 'rt-dim-test',
        redteamClass: 'false',
        injected: 99, // 故意用不同值：若新 record 误改旧行，下面的 toEqual 会逮到
        detected: 1,
      })
      const afterRows = await getImmunityScores(db, 'rt-dim-test', 'false')
      expect(afterRows.length).toBe(beforeRows.length + 1) // append-only，不覆盖
      expect(afterRows[0]).toEqual(priorFirst) // 旧行逐字段原样保留（detected/injected/rate/时间…全不变）
    })
  })

  describe('冻结世代（版本化 append-only，纵向比较的固定敌手）', () => {
    beforeEach(async () => {
      await pool.query('TRUNCATE redteam_immunity_scores, redteam_generations CASCADE')
    })

    it('一个世代是冻结的：同名重写被 UNIQUE 拒（不可静默重写）', async () => {
      await freezeRedTeamGeneration(db, {
        version: 'rt-frozen',
        items: [...REDTEAM_GENERATION_ITEMS],
        reason: 'gen 1',
      })
      // 同 version 再写（哪怕换了 items）→ DB UNIQUE 拒，世代不可被悄悄改写。
      await expect(
        freezeRedTeamGeneration(db, {
          version: 'rt-frozen',
          items: [REDTEAM_GENERATION_ITEMS[0]!],
          reason: 'attempt to overwrite',
        }),
      ).rejects.toThrow()
      // 原世代 items 原样保留。
      const gen = await getRedTeamGeneration(db, 'rt-frozen')
      expect(gen!.items.length).toBe(REDTEAM_GENERATION_ITEMS.length)
    })

    it('新世代=新版本，旧世代原样保留（纵向比较的两个锚）', async () => {
      await freezeRedTeamGeneration(db, {
        version: 'rt-2026Q1',
        items: [REDTEAM_GENERATION_ITEMS[0]!, REDTEAM_GENERATION_ITEMS[3]!],
        reason: 'Q1',
      })
      await freezeRedTeamGeneration(db, {
        version: 'rt-2026Q2',
        items: [...REDTEAM_GENERATION_ITEMS],
        reason: 'Q2',
      })
      const all = await getRedTeamGenerations(db)
      expect(all.map((g) => g.version)).toContain('rt-2026Q1')
      expect(all.map((g) => g.version)).toContain('rt-2026Q2')
      const q1 = await getRedTeamGeneration(db, 'rt-2026Q1')
      expect(q1!.items.length).toBe(2) // Q1 未被 Q2 改写
    })

    it('对同一冻结集重打分得同一结果（确定性：固定敌手 → 可纵向比较）', async () => {
      await freezeRedTeamGeneration(db, {
        version: 'rt-rescore',
        items: [...REDTEAM_GENERATION_ITEMS],
        reason: 'rescore',
      })
      const gen = await getRedTeamGeneration(db, 'rt-rescore')
      const run1 = await runRedTeamGeneration({ db, embedder }, gen!.items, resetWorkTables)
      const run2 = await runRedTeamGeneration({ db, embedder }, gen!.items, resetWorkTables)
      const sig = (scores: ClassScore[]) =>
        scores
          .map((s) => `${s.redteamClass}:${s.detected}/${s.injected}`)
          .sort()
          .join('|')
      expect(sig(run1)).toBe(sig(run2)) // 同一冻结集、同一确定性工种 → 同分
    })
  })

  describe('A1 红线（题=毒株，先过 S12 免疫流水线才进 scored golden）', () => {
    beforeEach(resetWorkTables)

    /**
     * seed 一条 L5 缺口候选 + 它溯源的来源 claim。返回 {candidateId, sourceClaimId}。
     *  - poisonForKb=false：来源 claim 是**无关**事实，query 是真缺口 → recall(query) 空 → kbTrulyLacks=true → 应晋升。
     *  - poisonForKb=true：来源 claim 文本 == query 且 active → recall(query) 命中 → kbTrulyLacks=false → 带毒考题，应 BLOCK。
     */
    async function seedCandidate(
      query: string,
      poisonForKb: boolean,
    ): Promise<{ candidateId: string; sourceClaimId: string }> {
      // 来源 claim 走真路径写 active（候选 locator 要溯到它的出处；poisonForKb 时它能被 query recall 命中）。
      const claimId = await appendActiveClaim({
        claimText: poisonForKb ? query : 'an unrelated background fact about widgets',
      })
      const candidateId = randomUUID()
      await db.insert(schema.l5Candidates).values({
        id: candidateId,
        sourceEventId: randomUUID(),
        query,
        claimId,
        confirmedBy: 'human:curator',
        status: 'queued',
      })
      return { candidateId, sourceClaimId: claimId }
    }

    it('干净缺口考题（库真没答案）→ 过免疫流水线 → 晋升 scored golden', async () => {
      const { candidateId } = await seedCandidate(
        'What is the gross tonnage of vessel ZZZ-404?',
        false,
      )
      const res = await promoteCandidate(db, embedder, candidateId, {
        confirmedBy: 'human:curator',
      })
      expect(res.promoted).toBe(true)
      expect(res.result.passed).toBe(true)
      const goldens = await db
        .select()
        .from(schema.goldenQuestions)
        .where(eq(schema.goldenQuestions.candidateId, candidateId))
      expect(goldens.length).toBe(1) // 进了 scored golden 命名空间
    })

    it('带毒考题（库本能答 / 自相矛盾的毒株）→ 被 BLOCK，绝不进 scored golden', async () => {
      // 带毒：query 与一条 active 库内 claim 同义 → recall 命中 → kbTrulyLacks=false → 这是污染真值的考题。
      const { candidateId } = await seedCandidate('an unrelated background fact', true)
      const res = await promoteCandidate(db, embedder, candidateId, {
        confirmedBy: 'human:curator',
      })
      expect(res.promoted).toBe(false) // BLOCK：免疫流水线拒绝带毒考题
      const goldens = await db
        .select()
        .from(schema.goldenQuestions)
        .where(eq(schema.goldenQuestions.candidateId, candidateId))
      expect(goldens.length).toBe(0) // 绝不进 scored cohort
      // 候选转终态 rejected + 审计留痕（谁/何时/凭何 BLOCK）。
      const [cand] = await db
        .select({ status: schema.l5Candidates.status })
        .from(schema.l5Candidates)
        .where(eq(schema.l5Candidates.id, candidateId))
      expect(cand!.status).toBe('rejected')
    })

    it('自相矛盾的结构化毒株考题（与库 active 锚同 S/P、object 反向）→ noSelfContradiction=false → BLOCK', async () => {
      // 先 seed 一条 active 锚（同 subject+predicate；经真路径写 active）。候选溯源到它（D1 出处可溯）。
      const anchorClaimId = await appendActiveClaim({
        claimText: 'The vessel cargo capacity is 5000 tons',
        subject: 'vessel',
        predicate: 'cargoTons',
        object: '5000',
      })
      // query 用与库内活跃 claim 无 trigram 交集的独特 token（fake 嵌入器下 recall 召不回 → kbTrulyLacks=true →
      // 才会进到「造毒株 + S8 自相矛盾检查」这一步，让 noSelfContradiction 真正被评估）。
      const candidateId = randomUUID()
      await db.insert(schema.l5Candidates).values({
        id: candidateId,
        sourceEventId: randomUUID(),
        query: 'zqxwvk9999',
        claimId: anchorClaimId,
        confirmedBy: 'human:curator',
        status: 'queued',
      })
      // 毒株框架：同 subject+predicate、object 反向 → 造毒株时 S8 落 contradicts 边 → noSelfContradiction=false → BLOCK。
      const res = await promoteCandidate(db, embedder, candidateId, {
        confirmedBy: 'human:curator',
        poison: { subject: 'vessel', predicate: 'cargoTons', object: '9999' },
      })
      expect(res.result.kbTrulyLacks).toBe(true) // gap query 召不回 → 进到造毒株步
      expect(res.promoted).toBe(false)
      expect(res.result.noSelfContradiction).toBe(false) // 自相矛盾被逮到
      const goldens = await db
        .select()
        .from(schema.goldenQuestions)
        .where(eq(schema.goldenQuestions.candidateId, candidateId))
      expect(goldens.length).toBe(0)
    })
  })

  describe('A3 红线（免疫分/检出率结构上不进校准 g 与纵向趋势）', () => {
    beforeEach(async () => {
      await resetWorkTables()
      await pool.query('TRUNCATE redteam_immunity_scores, redteam_generations CASCADE')
    })

    it('免疫分写入后，校准拟合器取样仍为空（拟合器只读 usage_truth，绝不读免疫分表）', async () => {
      await freezeRedTeamGeneration(db, {
        version: 'rt-a3',
        items: [...REDTEAM_GENERATION_ITEMS],
        reason: 'a3 boundary',
      })
      // 写一堆免疫分维度（detected/injected）——若有任何泄漏通道，这些「胜负/检出」会污染校准样本。
      for (const cls of ['false', 'contradiction', 'stale', 'near_dup_poison'] as const) {
        await recordImmunityScore(db, {
          generationVersion: 'rt-a3',
          redteamClass: cls,
          injected: 100,
          detected: 100, // 100% 检出 = 最强「胜率」信号；若漏进 g 拟合就坏了
        })
      }
      // 校准拟合器取样：结构上只读 claim_verification(kind='usage_truth')，从不读 redteam_immunity_scores。
      const samples = await collectUsageCalibrationSamples(db)
      expect(samples.length).toBe(0) // 免疫分一条都没漏进校准输入边界（A3 红线守住）
    })

    it('免疫分表与校准拟合器零代码耦合：detection rate 不是任何 GoldenSample 字段', async () => {
      await freezeRedTeamGeneration(db, {
        version: 'rt-a3b',
        items: [...REDTEAM_GENERATION_ITEMS],
        reason: 'b',
      })
      await recordImmunityScore(db, {
        generationVersion: 'rt-a3b',
        redteamClass: 'false',
        injected: 50,
        detected: 50,
      })
      // 即便注入了真 usage_truth 样本，校准只吃 {rawPredicted, correct}，没有任何 detectionRate/胜负率字段。
      const src = await addSource(db, {
        content: 'c',
        contentHash: randomUUID(),
        kind: 'formal_document',
        authorityScore: 0.6,
      })
      const { claimId } = await appendClaim(
        db,
        embedder,
        { claimText: 'calibration sample claim' },
        [{ sourceId: src.sourceId, locator: 'x', relevance: 'exact' }],
      )
      await db.insert(schema.claimVerification).values({
        id: randomUUID(),
        claimId,
        kind: 'usage_truth',
        verdict: {
          outcome: 'adopted',
          predictedConfidence: 0.7,
          calibrationVersion: 'identity',
          taskId: 't1',
        },
        byRole: 'human:user-1',
      })
      const samples = await collectUsageCalibrationSamples(db)
      expect(samples.length).toBe(1)
      // GoldenSample 只有 rawPredicted + correct —— 无 detectionRate/win-rate/ELO 字段（结构性边界）。
      expect(Object.keys(samples[0]!).sort()).toEqual(['correct', 'rawPredicted'])
    })
  })
})
