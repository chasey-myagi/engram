/**
 * Verifier 工种（S17）—— D3 事后巡查。**函数/统计 + 点状一次 LLM**（A.7），不是 agent loop：
 * 不用 AgentRuntime/harness-pi，每条被巡查 claim 对 EntailmentJudge 调**恰一次**。触发 = 每日 cron + draft/flagged
 * 入队（见 VERIFIER_TRIGGER）。只依赖 @engram/core SPI + EntailmentJudge 端口。
 *
 * 巡查内容（A.6/A.7）：
 *   ① entailment 核验：claim 表述能否从其 provenance 原文推出。
 *        pass         → 出处可推导（draft 满足 conf≥0.5 时晋升 active；active/flagged 保持）。
 *        fail（幻觉） → 收紧（active→flagged；flagged→quarantined）。
 *        not_co_true  → 记一条 conflict 信号交 Arbiter（S20，本切片只记不裁）+ 同 fail 般收紧。
 *   ② 时效巡查：claim 越过其 kind 半衰期 → flag（active→flagged）。
 *
 * 蓝边收紧（红线 #2，agent 只能收紧）：active→flagged / flagged→quarantined / draft→active(晋升)，全经 transitionClaim
 * （它内核强制：放松 X→active 仅人可做；这里 agent 永不调用放松边）。
 *
 * judge≠athlete（红线）：巡查裁决落 claim_verification(kind='patrol', by_role=本工种角色)，与产出 claim 的
 * created_by(athlete) 不同。**永不给自己产出的 claim 背书**：created_by 命中本工种 by_role 的 claim 直接跳过（不判、不写）。
 *
 * 失败降级（A.7「跳过本轮，下轮重试」）：单条 claim 的 LLM/事务异常被吞（计入 skipped），不崩、不阻塞其它 claim、不无限重试；
 * 下一轮 cron 再来。整轮的非预期异常也不向上抛（返回部分结果）。
 */
import {
  getSource,
  halfLifeDaysForKind,
  transitionClaim,
  writePatrolVerdict,
  schema,
  type DB,
  type EntailmentEvidence,
  type EntailmentJudge,
  type EntailmentVerdict,
  type PatrolVerdict,
} from '@engram/core'
import { and, desc, eq, inArray, ne, or } from 'drizzle-orm'

const MS_PER_DAY = 86_400_000
const DEFAULT_BY_ROLE = 'agent:verifier'
const DEFAULT_MAX_CLAIMS = 200

/** 巡查的目标状态：只看可被收紧/晋升的生命周期。superseded(终态) / quarantined(只人能放松) 不巡。 */
const PATROL_STATUSES: readonly schema.ClaimStatus[] = ['draft', 'active', 'flagged']

export interface VerifierDeps {
  db: DB
  /** entailment 判官（端口）。测试注 fake，生产注 DashScope（env-gated）。点状一次 LLM/claim。 */
  judge: EntailmentJudge
}

export interface VerifierOptions {
  /** 工种判官身份（by_role）。默认 'agent:verifier'。落 claim_verification.by_role + judge≠athlete 自背书判据。 */
  byRole?: string
  /** 本轮最多巡查多少条 claim（防无界）。默认 200。 */
  maxClaims?: number
  /** 限定只巡这些 claimId（draft/flagged 入队触发时用）；不给则按状态扫全部待巡 claim（cron 用）。 */
  claimIds?: string[]
}

/** 单条 claim 巡查后的处置（可审计）。 */
export interface PatrolOutcome {
  claimId: string
  /** entailment 裁决；'skipped' = 自产出/异常跳过（不判）。 */
  entailment: EntailmentVerdict | 'skipped'
  /** 是否被时效巡查判定为 stale。 */
  stale: boolean
  /** 本次状态迁移（无迁移则 null）。 */
  transition: { from: schema.ClaimStatus; to: schema.ClaimStatus } | null
  /** 跳过/异常原因（若有）。 */
  note?: string
}

export interface VerifierResult {
  byRole: string
  /** 实际被巡查（调用了判官 / 跑了时效）并写了 patrol 裁决的 claim 数。 */
  patrolled: number
  /** 因 judge≠athlete（自产出）或异常被跳过、未写裁决的 claim 数。 */
  skipped: number
  /** 本轮触发的状态迁移数（晋升 / flag / quarantine）。 */
  transitions: number
  outcomes: PatrolOutcome[]
}

interface CandidateClaim {
  id: string
  claimText: string
  subject: string | null
  predicate: string | null
  object: string | null
  status: schema.ClaimStatus
  asOf: Date
  createdBy: string
}

/** 取本轮待巡 claim：限定 claimIds（入队）或按 PATROL_STATUSES 扫（cron）。superseded 永不入。 */
async function selectCandidates(
  db: DB,
  opts: { claimIds?: string[]; maxClaims: number },
): Promise<CandidateClaim[]> {
  const cols = {
    id: schema.claim.id,
    claimText: schema.claim.claimText,
    subject: schema.claim.subject,
    predicate: schema.claim.predicate,
    object: schema.claim.object,
    status: schema.claim.status,
    asOf: schema.claim.asOf,
    createdBy: schema.claim.createdBy,
  }
  if (opts.claimIds && opts.claimIds.length > 0) {
    // 入队触发：限定这些 id，但仍只巡可巡状态（防把 superseded/quarantined 误入）。
    return db
      .select(cols)
      .from(schema.claim)
      .where(
        and(
          inArray(schema.claim.id, opts.claimIds),
          inArray(schema.claim.status, [...PATROL_STATUSES]),
        ),
      )
      .limit(opts.maxClaims)
  }
  // cron：扫全部待巡状态（最新在前，便于优先巡新写入/新收紧的）。
  return db
    .select(cols)
    .from(schema.claim)
    .where(inArray(schema.claim.status, [...PATROL_STATUSES]))
    .orderBy(desc(schema.claim.createdAt))
    .limit(opts.maxClaims)
}

/** 一条 claim 的全部 supports 出处（exact/supporting）+ 各自源原文，组装成判官输入。最强源 kind 供时效巡查。 */
async function loadEvidence(
  db: DB,
  claimId: string,
): Promise<{ evidence: EntailmentEvidence[]; halfLifeDays: number }> {
  const provs = await db
    .select({
      sourceId: schema.claimProvenance.sourceId,
      locator: schema.claimProvenance.locator,
      excerpt: schema.claimProvenance.excerpt,
      relevance: schema.claimProvenance.relevance,
    })
    .from(schema.claimProvenance)
    .where(eq(schema.claimProvenance.claimId, claimId))

  const evidence: EntailmentEvidence[] = []
  let strongestAuthority = -1
  let halfLifeDays = 180 // 无源（理论上 D1 不可能）→ 中性桶
  for (const p of provs) {
    // tangential/irrelevant 出处不喂 entailment（A.6：不决定命题），也不参与时效最强源。
    if (p.relevance !== 'exact' && p.relevance !== 'supporting') continue
    const src = await getSource(db, p.sourceId)
    if (!src) continue
    evidence.push({
      sourceContent: src.content,
      locator: p.locator,
      relevance: p.relevance,
      ...(p.excerpt != null ? { excerpt: p.excerpt } : {}),
    })
    if (src.authorityScore > strongestAuthority) {
      strongestAuthority = src.authorityScore
      halfLifeDays = halfLifeDaysForKind(src.kind)
    }
  }
  return { evidence, halfLifeDays }
}

/**
 * 找一条 claim 的矛盾对端（conflict 信号的 peer，S20 路由跟进）：取其 contradicts 边另一端、且对端**未被取代**的 claimId。
 * 用于 not_co_true 时回填 PatrolVerdict.conflictsWith —— 把「与谁不可同真」交给 Arbiter（pairwise 裁决的正主）。
 * 多个对端则取确定性的一个（id 最小，可回归）；无对端（巡查判定的语义冲突尚无显式边）→ null，不强填。
 */
async function findContradictingPeer(db: DB, claimId: string): Promise<string | null> {
  const edges = await db
    .select({ from: schema.relation.fromClaim, to: schema.relation.toClaim })
    .from(schema.relation)
    .where(
      and(
        eq(schema.relation.type, 'contradicts'),
        or(eq(schema.relation.fromClaim, claimId), eq(schema.relation.toClaim, claimId)),
      ),
    )
  const peers = new Set<string>()
  for (const e of edges) {
    const other = e.from === claimId ? e.to : e.from
    if (other != null && other !== claimId) peers.add(other)
  }
  if (peers.size === 0) return null
  // 对端须仍存活（superseded 不再参与矛盾）；多个取 id 最小（确定性）。
  const rows = await db
    .select({ id: schema.claim.id })
    .from(schema.claim)
    .where(and(inArray(schema.claim.id, [...peers]), ne(schema.claim.status, 'superseded')))
  const alive = rows.map((r) => r.id).sort()
  return alive.length > 0 ? alive[0]! : null
}

/**
 * 据 entailment 裁决 + 时效 + 当前状态，按 A.4 收紧/晋升一条 claim。返回迁移结果（无迁移 → null）。
 * 全经 transitionClaim（蓝边收紧由内核放行，放松边内核拒）。conf 门由 transitionClaim 自校（draft→active 需 conf≥0.5）。
 */
async function applyTransition(
  db: DB,
  c: CandidateClaim,
  entailment: EntailmentVerdict,
  stale: boolean,
  byRole: string,
): Promise<{ from: schema.ClaimStatus; to: schema.ClaimStatus } | null> {
  const supported = entailment === 'pass'
  const tighten = entailment === 'fail' || entailment === 'not_co_true' || stale

  if (c.status === 'draft') {
    // draft：只有 entailment pass 才尝试晋升（真 entailmentPass 生产者，闭合 S13 合成桩）。conf<0.5 由 transitionClaim 拒（仍 draft）。
    // entailment fail 的 draft 不能 draft→flagged（A.4 非法）；留 draft 影子区，下轮再巡或交人。
    if (!supported) return null
    try {
      return await transitionClaim(db, c.id, 'active', { by: byRole, entailmentPass: true })
    } catch {
      // conf 未达门 / 并发已被改动 → 维持 draft，下轮再来（不崩）。
      return null
    }
  }

  if (c.status === 'active') {
    if (tighten) {
      return transitionClaim(db, c.id, 'flagged', { by: byRole })
    }
    return null // pass 且不 stale → 保持 active
  }

  if (c.status === 'flagged') {
    // 已被 flag 的 claim 再巡仍无支撑（fail/not_co_true/stale）→ 收紧到 quarantined。pass 则保持 flagged（放松仅人可做）。
    if (tighten) {
      return transitionClaim(db, c.id, 'quarantined', { by: byRole })
    }
    return null
  }

  return null
}

/**
 * 跑一轮 Verifier 巡查：选候选 → 逐条（点状一次 LLM）entailment + 时效 → 写 patrol 裁决 → 蓝边收紧/晋升。
 * judge≠athlete：跳过自产出 claim。单条异常吞掉（skipped），下轮重试。整轮非预期异常也不外抛。
 */
export async function runVerifier(
  deps: VerifierDeps,
  opts: VerifierOptions = {},
): Promise<VerifierResult> {
  const byRole = opts.byRole ?? DEFAULT_BY_ROLE
  const maxClaims = opts.maxClaims ?? DEFAULT_MAX_CLAIMS
  const result: VerifierResult = {
    byRole,
    patrolled: 0,
    skipped: 0,
    transitions: 0,
    outcomes: [],
  }

  let candidates: CandidateClaim[]
  try {
    candidates = await selectCandidates(deps.db, {
      ...(opts.claimIds !== undefined ? { claimIds: opts.claimIds } : {}),
      maxClaims,
    })
  } catch {
    // 连候选都选不出（DB 抖动）→ 整轮跳过，下轮重试（不崩、不无限重试）。
    return result
  }

  for (const c of candidates) {
    // judge≠athlete：Verifier 永不巡/背书自己产出的 claim（created_by 命中本工种 by_role）。
    if (c.createdBy === byRole || c.createdBy.startsWith(`${byRole}:`)) {
      result.skipped += 1
      result.outcomes.push({
        claimId: c.id,
        entailment: 'skipped',
        stale: false,
        transition: null,
        note: 'judge≠athlete: skipped self-authored claim',
      })
      continue
    }

    try {
      const { evidence, halfLifeDays } = await loadEvidence(deps.db, c.id)
      // 点状一次 LLM：每条 claim 调判官恰一次。
      const entailment: EntailmentVerdict = await deps.judge.judge({
        claimText: c.claimText,
        subject: c.subject,
        predicate: c.predicate,
        object: c.object,
        evidence,
      })
      // 时效巡查：年龄超过 kind 半衰期 → stale。
      const ageDays = Math.max(0, (Date.now() - c.asOf.getTime()) / MS_PER_DAY)
      const stale = ageDays > halfLifeDays

      // S20 路由跟进：not_co_true（与他 claim 不可同真）时回填矛盾对端，把 pairwise 冲突信号交给 Arbiter（裁决正主）。
      // 其余裁决（pass/fail）不是 pairwise 冲突，不填 conflictsWith。S17 当初延迟的这格由此闭合。
      const conflictsWith =
        entailment === 'not_co_true' ? await findContradictingPeer(deps.db, c.id) : null
      // 落 patrol 裁决（judge≠athlete：by_role=本工种）。append-only，多轮各留一行；f2 读最新一条。
      const verdict: PatrolVerdict = {
        entailment,
        reason: reasonFor(c.status, stale),
        judgeVersion: deps.judge.version,
        ...(conflictsWith != null ? { conflictsWith } : {}),
      }
      await writePatrolVerdict(deps.db, { claimId: c.id, byRole, verdict })
      result.patrolled += 1

      const transition = await applyTransition(deps.db, c, entailment, stale, byRole)
      if (transition) result.transitions += 1
      result.outcomes.push({ claimId: c.id, entailment, stale, transition })
    } catch (err) {
      // 单条失败（LLM 异常 / 事务冲突）→ 跳过本条，下轮重试。不崩、不阻塞其它 claim。
      result.skipped += 1
      result.outcomes.push({
        claimId: c.id,
        entailment: 'skipped',
        stale: false,
        transition: null,
        note: `patrol error: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return result
}

function reasonFor(status: schema.ClaimStatus, stale: boolean): string {
  const parts: string[] = [status]
  if (stale) parts.push('stale')
  return parts.join('+')
}

/**
 * Verifier 触发声明（A.7：每日 cron + draft/flagged 入队）。choreography 无在线 meta-orchestrator：
 * 工种**声明**自己的触发，由外层调度器（cron / 事件总线）按此调 runVerifier。这里只声明，不内嵌定时器。
 *  - cron: 每日定时，扫全部待巡 claim（不带 claimIds）。
 *  - enqueue: claim 写入(draft)/被收紧(flagged) 时入队，带 claimId 精准巡查。
 */
export const VERIFIER_TRIGGER = {
  cron: 'daily',
  enqueueOn: ['draft', 'flagged'] as const,
} as const

/** 处理入队事件：对单个（或一批）draft/flagged claim 立即跑巡查。薄包装 runVerifier。 */
export async function verifyEnqueued(
  deps: VerifierDeps,
  claimIds: string[],
  opts: Omit<VerifierOptions, 'claimIds'> = {},
): Promise<VerifierResult> {
  return runVerifier(deps, { ...opts, claimIds })
}
