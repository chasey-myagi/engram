/**
 * Reconciler 工种（S18）—— `batch_appended` 触发。**函数 + 灰区点状一次 LLM**（A.7），不是 agent loop：
 * 不用 AgentRuntime/harness-pi，每对灰区候选对 EntailmentJudge 调**至多一次**。只依赖 @engram/core SPI +
 * EntailmentJudge 端口。
 *
 * 守两件事（A.6「near-dup-poison」+ 独立印证完整性）：
 *   ① 找 embedding 近 + `subject≡` 但 object 被悄悄改小/反 的对（A=本批新写, B=既有锚）。调 entailment 验
 *      A.object⊆B.object？
 *        refines      → 真精炼：记一条 A→B 的 refines 边（不 flag、不合并）。
 *        poison       → 疑投毒：flag A（active→flagged，蓝边收紧，经 transitionClaim）+ 记升级信号（带对端 B 的
 *                       id，补 S17 留空的关系性 conflict 信号）交 Arbiter(S20，本切片只记不裁)。
 *        inconclusive → 保守：留两条，不合并、不判 refines、不 flag（宁可漏、不可误并/误 flag）。
 *   ② 独立印证完整性：对每条本批 claim，探测其挂的 supports 源里是否存在**不独立**对（同 hash / 同 lineage /
 *      直接 derived_from）。有 → surface 一条 anomalous-lineage 审计信号；commit/重算的 countIndependentSupports
 *      已折叠它们（同源不刷 f3），此处是 Reconciler 侧的**显式探测**（强化 S14 的反同源刷印证）。
 *
 * judge≠athlete（红线）：Reconciler 用自己的 by_role（默认 'agent:reconciler'）；**永不审/裁自己产出的 claim**——
 * A 的 created_by 命中本工种 by_role 的对直接跳过（不判、不写）。
 *
 * 红线 #2（agent 只收紧不放松）：flag 走 transitionClaim（内核硬执行 active→flagged 是蓝边收紧；放松 X→active
 * 仅人可做，本工种永不调）。draft 的 A 判出 poison 时不能 draft→flagged（A.4 非法）—— 仍记升级信号（带对端 id）+
 * 留 draft 影子区，交 Arbiter/人，绝不合并。
 *
 * 失败降级（A.7「保守：不合并，留两条」）：单对的 LLM/事务异常被吞（计 skipped），不崩、不阻塞其它对、不无限重试；
 * 下一次 batch_appended 再来。整轮非预期异常也不外抛（返回部分结果）。
 */
import {
  hasNonIndependentPair,
  recordReconcileEscalation,
  reconcilePair,
  schema,
  transitionClaim,
  type ClaimShape,
  type DB,
  type EntailmentJudge,
  type ReconcileVerdict,
  type SourceIndep,
} from '@engram/core'
import { randomUUID } from 'node:crypto'

import { and, cosineDistance, eq, inArray, isNotNull, ne } from 'drizzle-orm'

const DEFAULT_BY_ROLE = 'agent:reconciler'
const DEFAULT_MAX_PAIRS = 200
/** 配对召回的相似度下界（与 core RECONCILE_PAIR_SIMILARITY 同 0.75；这里只用它收窄 SQL 召回）。 */
const PAIR_SIMILARITY_FLOOR = 0.75
/** 每条 A 最多取多少个最近锚 B（防一条 A 拉爆 LLM 预算）。 */
const ANCHORS_PER_CLAIM = 8

export interface ReconcilerDeps {
  db: DB
  /** entailment 判官（端口）。测试注 fake，生产注 DashScope（env-gated）。灰区点状一次 LLM/对。 */
  judge: EntailmentJudge
}

export interface ReconcilerOptions {
  /** 工种判官身份（by_role）。默认 'agent:reconciler'。落升级信号 by_role + judge≠athlete 自审判据。 */
  byRole?: string
  /** 本轮最多审多少对（防无界 LLM）。默认 200。 */
  maxPairs?: number
  /** batch_appended 带来的本批新写 claim id（A 侧）。空/不给则不审（Reconciler 是事件驱动，不做全表扫）。 */
  claimIds?: string[]
}

/** 一对 (A,B) 审查后的处置（可审计）。 */
export interface PairOutcome {
  claimId: string // A（本批新写/被审）
  peerClaimId: string // B（既有锚）
  verdict: ReconcileVerdict
  /** poison 时本次状态迁移（无迁移→null，如 draft 不能 flag / 并发改动）。 */
  transition: { from: schema.ClaimStatus; to: schema.ClaimStatus } | null
  /** 记下的边/信号类型：'refines' | 'escalation'（poison 升级）| null。 */
  recorded: 'refines' | 'escalation' | null
  note?: string
}

/** 一条 claim 的独立印证完整性审计（anti same-source inflation，强化 S14）。 */
export interface IndepAuditOutcome {
  claimId: string
  /** true = 该 claim 的 supports 源里存在不独立对（同 hash / 直接 derived_from）⇒ indepSupport 不应按源条数线性增长。 */
  hasNonIndependentPair: boolean
}

export interface ReconcilerResult {
  byRole: string
  /** 实际调了判官（灰区）并完成审查的对数。 */
  reviewed: number
  /** 因 judge≠athlete（自产出）/ 异常 / 不够格被跳过、未调判官的对数。 */
  skipped: number
  /** 记下的 refines 边数。 */
  refinesLinked: number
  /** 记下的 poison 升级信号数（带对端 id，交 Arbiter）。 */
  escalations: number
  /** poison 触发的 active→flagged 收紧数。 */
  flagged: number
  pairs: PairOutcome[]
  /** 各 A claim 的独立印证完整性审计。 */
  indepAudits: IndepAuditOutcome[]
}

interface ClaimRow {
  id: string
  claimText: string
  subject: string | null
  predicate: string | null
  object: string | null
  status: schema.ClaimStatus
  createdBy: string
}

function shapeOf(c: ClaimRow): ClaimShape {
  return { subject: c.subject, predicate: c.predicate, object: c.object, claimText: c.claimText }
}

const CLAIM_COLS = {
  id: schema.claim.id,
  claimText: schema.claim.claimText,
  subject: schema.claim.subject,
  predicate: schema.claim.predicate,
  object: schema.claim.object,
  status: schema.claim.status,
  createdBy: schema.claim.createdBy,
}

/** 取本批 A claim（限定 claimIds，只取还活着的；superseded 永不入）。空批直接返空（不生成 `IN ()`）。 */
async function loadBatch(db: DB, claimIds: string[], maxPairs: number): Promise<ClaimRow[]> {
  if (claimIds.length === 0) return []
  return db
    .select(CLAIM_COLS)
    .from(schema.claim)
    .where(and(inArray(schema.claim.id, claimIds), ne(schema.claim.status, 'superseded')))
    .limit(maxPairs)
}

/**
 * 给一条 A，找它的近锚 B：embedding 近邻（相似度 ≥0.75）∩ `subject≡` ∩ 非自身 ∩ 非 superseded。
 * 用 A 已存的 embedding（commit 时落）；A 无 embedding（老行）→ 无锚（返空，不烧 LLM）。
 * 同 subject 是 near-dup-poison 的硬前提，直接进 SQL；object 等价/非等价的细分留给 core isReconcileCandidate。
 */
async function findAnchors(db: DB, a: ClaimRow): Promise<{ b: ClaimRow; similarity: number }[]> {
  if (a.subject == null) return [] // 无主语 → 不是结构化 object 攻击面
  const [self] = await db
    .select({ embedding: schema.claim.embedding })
    .from(schema.claim)
    .where(eq(schema.claim.id, a.id))
  const emb = self?.embedding
  if (emb == null) return []
  const distance = cosineDistance(schema.claim.embedding, emb)
  const rows = await db
    .select({ ...CLAIM_COLS, distance })
    .from(schema.claim)
    .where(
      and(
        ne(schema.claim.id, a.id),
        ne(schema.claim.status, 'superseded'),
        isNotNull(schema.claim.embedding),
        eq(schema.claim.subject, a.subject),
      ),
    )
    .orderBy(distance)
    .limit(ANCHORS_PER_CLAIM)
  const out: { b: ClaimRow; similarity: number }[] = []
  for (const r of rows) {
    const { distance: d, ...rest } = r
    const similarity = 1 - Number(d)
    if (similarity >= PAIR_SIMILARITY_FLOOR) out.push({ b: rest, similarity })
  }
  return out
}

/** 记一条 A→B 的 refines 边（去重：同向已存在即跳过）。 */
async function linkRefines(db: DB, fromId: string, toId: string): Promise<boolean> {
  const present = await db
    .select({ id: schema.relation.id })
    .from(schema.relation)
    .where(
      and(
        eq(schema.relation.type, 'refines'),
        eq(schema.relation.fromClaim, fromId),
        eq(schema.relation.toClaim, toId),
      ),
    )
    .limit(1)
  if (present.length > 0) return false
  await db
    .insert(schema.relation)
    .values({ id: randomUUID(), fromClaim: fromId, toClaim: toId, type: 'refines' })
  return true
}

/**
 * 读一条 claim 的全部 supports 源的独立性结构面（id / contentHash / kind / derivedFromSourceId），喂独立印证探测。
 * 只取 relevance∈{exact,supporting} 的 supports 源（A.6：tangential/irrelevant 不计印证）。一次 join 查回，
 * 不走 getSource（它只取 content/kind/authority，没有 contentHash/derivedFromSourceId 这两个独立性判据列）。
 */
async function loadSupportSources(db: DB, claimId: string): Promise<SourceIndep[]> {
  const rows = await db
    .select({
      id: schema.source.id,
      contentHash: schema.source.contentHash,
      kind: schema.source.kind,
      derivedFromSourceId: schema.source.derivedFromSourceId,
      relevance: schema.claimProvenance.relevance,
    })
    .from(schema.claimProvenance)
    .innerJoin(schema.source, eq(schema.claimProvenance.sourceId, schema.source.id))
    .where(eq(schema.claimProvenance.claimId, claimId))
  const out: SourceIndep[] = []
  for (const r of rows) {
    if (r.relevance !== 'exact' && r.relevance !== 'supporting') continue // 只 supports 源计印证（A.6）
    out.push({
      id: r.id,
      contentHash: r.contentHash,
      kind: r.kind,
      derivedFromSourceId: r.derivedFromSourceId,
    })
  }
  return out
}

/**
 * 跑一轮 Reconciler 审查（batch_appended）：对本批每条 A → 找近锚 B → 灰区 entailment 判 A⊆B →
 * refines 边 / poison 收紧+升级 / inconclusive 留两条。并对每条 A 做独立印证完整性探测。
 * judge≠athlete：跳过自产出 A。单对异常吞掉（skipped）。整轮非预期异常也不外抛。
 */
export async function runReconciler(
  deps: ReconcilerDeps,
  opts: ReconcilerOptions = {},
): Promise<ReconcilerResult> {
  const byRole = opts.byRole ?? DEFAULT_BY_ROLE
  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS
  const result: ReconcilerResult = {
    byRole,
    reviewed: 0,
    skipped: 0,
    refinesLinked: 0,
    escalations: 0,
    flagged: 0,
    pairs: [],
    indepAudits: [],
  }

  let batch: ClaimRow[]
  try {
    batch = await loadBatch(deps.db, opts.claimIds ?? [], maxPairs)
  } catch {
    return result // 连本批都取不出（DB 抖动）→ 整轮跳过，下次 batch 再来
  }

  let budget = maxPairs
  for (const a of batch) {
    // 独立印证完整性探测（每条 A 一次，纯函数 + 读源；与 LLM 预算无关）。
    try {
      const sources = await loadSupportSources(deps.db, a.id)
      result.indepAudits.push({
        claimId: a.id,
        hasNonIndependentPair: hasNonIndependentPair(sources),
      })
    } catch {
      // 探测失败不阻塞 poison 审查；不记审计行。
    }

    // judge≠athlete：永不审/背书自己产出的 claim。
    if (a.createdBy === byRole || a.createdBy.startsWith(`${byRole}:`)) {
      result.skipped += 1
      result.pairs.push({
        claimId: a.id,
        peerClaimId: '',
        verdict: 'inconclusive',
        transition: null,
        recorded: null,
        note: 'judge≠athlete: skipped self-authored claim',
      })
      continue
    }

    let anchors: { b: ClaimRow; similarity: number }[]
    try {
      anchors = await findAnchors(deps.db, a)
    } catch {
      result.skipped += 1
      continue
    }

    for (const { b, similarity } of anchors) {
      if (budget <= 0) break
      budget -= 1
      try {
        const verdict = await reconcilePair(deps.judge, shapeOf(a), shapeOf(b), similarity)
        await handleVerdict(deps, byRole, a, b, verdict, result)
      } catch (err) {
        // 单对失败（事务/写冲突）→ 保守：跳过本对，留两条，下次 batch 重试。
        result.skipped += 1
        result.pairs.push({
          claimId: a.id,
          peerClaimId: b.id,
          verdict: 'inconclusive',
          transition: null,
          recorded: null,
          note: `reconcile error: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
    if (budget <= 0) break
  }

  return result
}

/** 据裁决落账：refines 边 / poison 收紧+升级（带对端 id）/ inconclusive 留两条。 */
async function handleVerdict(
  deps: ReconcilerDeps,
  byRole: string,
  a: ClaimRow,
  b: ClaimRow,
  verdict: ReconcileVerdict,
  result: ReconcilerResult,
): Promise<void> {
  if (verdict === 'refines') {
    const linked = await linkRefines(deps.db, a.id, b.id)
    if (linked) result.refinesLinked += 1
    result.reviewed += 1
    result.pairs.push({
      claimId: a.id,
      peerClaimId: b.id,
      verdict,
      transition: null,
      recorded: linked ? 'refines' : null,
    })
    return
  }

  if (verdict === 'poison') {
    // 记升级信号（带对端 B 的 id）—— 补 S17 留空的关系性 conflict 信号，交 Arbiter(S20)。先记信号（即便 flag 因
    // A.4 非法/并发失败也不丢信号），再尝试蓝边收紧 active→flagged。
    await recordReconcileEscalation(deps.db, {
      claimId: a.id,
      conflictsWith: b.id,
      byRole,
      judgeVersion: deps.judge.version,
    })
    result.escalations += 1

    let transition: { from: schema.ClaimStatus; to: schema.ClaimStatus } | null = null
    if (a.status === 'active') {
      try {
        transition = await transitionClaim(deps.db, a.id, 'flagged', { by: byRole })
        result.flagged += 1
      } catch {
        // 并发已改动 / 门校验失败 → 信号已记，留待 Arbiter/下次；不崩。
        transition = null
      }
    }
    // draft 的 A：draft→flagged 非法（A.4），不收紧——信号已记，留 draft 影子区交 Arbiter/人。
    result.reviewed += 1
    result.pairs.push({
      claimId: a.id,
      peerClaimId: b.id,
      verdict,
      transition,
      recorded: 'escalation',
    })
    return
  }

  // inconclusive：保守，留两条，不合并、不判 refines、不 flag。仍计 reviewed（调了判官）。
  result.reviewed += 1
  result.pairs.push({ claimId: a.id, peerClaimId: b.id, verdict, transition: null, recorded: null })
}

/**
 * Reconciler 触发声明（A.7：batch_appended）。choreography 无在线 meta-orchestrator：工种**声明**自己的触发，
 * 由外层调度器（事件总线）在一批 claim 写入后按此调 runReconciler（带本批 claimIds）。这里只声明，不内嵌总线。
 */
export const RECONCILER_TRIGGER = {
  on: 'batch_appended' as const,
} as const

/** 处理 batch_appended 事件：对本批新写 claim 跑一轮 Reconciler 审查。薄包装 runReconciler。 */
export async function reconcileBatch(
  deps: ReconcilerDeps,
  claimIds: string[],
  opts: Omit<ReconcilerOptions, 'claimIds'> = {},
): Promise<ReconcilerResult> {
  return runReconciler(deps, { ...opts, claimIds })
}
