/**
 * NC-exact 红线统一闸门（S21）—— 永久红线 #3 / A.6。**领域无关内核**，Verifier(D3 巡查) 与 Arbiter(冲突收敛) 共用同一条缝。
 *
 * 红线（A.6「NC-exact」）：任何把一条 claim 判成 **non_compliant / refuted** 的路径，
 *   必须有 **≥1 条 `relevance='exact'` 的反向证据**（原文明确反向命题，含定量否定；区别于仅语义蕴含的 `supporting`）。
 *   否则该判定 **拒判 + 强制升级主编**（落一条 ruling_refused 事件），**绝不**落该 NC/refuted 判定。
 *
 * 为什么是「统一闸门」：判 claim 为负的两条路在本仓库各有形态——
 *   - Verifier `fail`(幻觉)/`not_co_true`(不可同真) → 收紧 active→flagged / flagged→quarantined（判**目标 claim** 为负）。
 *     反向证据 = 目标 claim 自己那条「原文明确反向/定量否定」的 `exact` 出处（A.6：exact 含定量否定）。
 *   - Arbiter 机判自裁 → **败者**被判为负（采信胜者、压败者）。反向证据 = **胜者** 那条明确反向命题的 `exact` 出处。
 *   两条路都归约成同一问：「**承载反向命题的那条 claim** 上是否有 ≥1 条 `exact` 出处？」由本函数一处判定，
 *   两路共用 —— 任一路退化（漏读四档 / 放行弱证据）都被同一套测试逮住，杜绝分叉。
 *
 * 四档语义（A.6，本闸门**读且区分**）：`exact`(原文明确陈述该命题，含定量否定) 才算反向证据；
 *   `supporting`(间接支持) / `tangential`(相关不决定) / `irrelevant` 一律**不**算 —— 只有 exact 能把 claim 判负。
 *
 * 红线#2「只人能放松」：本闸门只在「能否判负」上把关；拒判时升级人（写 ruling_refused 进主编队列），
 *   **绝不**自己放松/复活/改任何 claim.status。调用方在 ok 时才落各自的收紧/采信判定。
 */
import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import type { DB, Tx } from '../db/client.js'
import { claimProvenance, metricsEvents } from '../db/schema.js'

type Queryable = DB | Tx

/** ruling_refused 事件的 metrics_event_kind 值（S21）。NC-exact 拒判 → 升级主编的「事件即标记」。 */
export const RULING_REFUSED = 'ruling_refused' as const

/** 被拒的负判类型（审计/可解释；不进任何计分）。 */
export type RefusedRulingKind = 'non_compliant' | 'refuted'

/**
 * NC-exact 闸门的判定结果。
 *   - ok=true：承载反向命题的 claim 有 ≥1 条 `exact` 出处 → 调用方可落负判。
 *   - ok=false：无 exact 反向证据 → 调用方**必须不**落负判；闸门已写 ruling_refused 升级主编。
 */
export type NcExactGateResult =
  | { ok: true; exactCount: number }
  | { ok: false; exactCount: number; eventId: string }

/** ruling_refused 事件 payload（主编队列读出 / 审计；绝不进计分）。 */
export interface RulingRefusedPayload {
  /** 本应被判为负、因缺 exact 反向证据而拒判的 claim。 */
  ruledAgainstClaimId: string
  /** 承载反向命题、被检查 exact 出处的 claim（Verifier 路 = 目标自身；Arbiter 路 = 胜者）。 */
  reverseEvidenceClaimId: string
  /** 被拒的负判类型。 */
  rulingKind: RefusedRulingKind
  /** 发起该负判的路径（'verifier' | 'arbiter'），可解释。 */
  path: string
  /** 检查到的 exact 反向出处数（0 才会拒）。 */
  exactCount: number
  /** 人类可读理由。 */
  reason: string
  /** 发起者身份（agent:verifier / agent:arbiter / 测试角色）。 */
  byRole: string
}

/**
 * 数一条 claim 上 `relevance='exact'` 的出处数（四档里只认 exact —— supporting/tangential/irrelevant 不计）。
 * 纯读、确定性。这是「区分四档」的单一真相点：两条判负路都经此数 exact，不各自重写四档解释。
 */
export async function countExactProvenances(q: Queryable, claimId: string): Promise<number> {
  const rows = await q
    .select({ relevance: claimProvenance.relevance })
    .from(claimProvenance)
    .where(eq(claimProvenance.claimId, claimId))
  let n = 0
  for (const r of rows) {
    // A.6 四档：仅 exact（原文明确陈述/定量否定该命题）算反向证据。其余三档明确不算。
    if (r.relevance === 'exact') n += 1
  }
  return n
}

/**
 * NC-exact 统一闸门（红线 #3 / A.6）。判一条 claim 为 non_compliant/refuted 前**必调**：
 *   承载反向命题的 claim（reverseEvidenceClaimId）须有 ≥1 条 `exact` 出处。
 *     - 有 → `{ ok:true }`，调用方可落负判。
 *     - 无 → 写一条 ruling_refused 事件升级主编，返回 `{ ok:false, eventId }`，调用方**必须不**落负判。
 * **绝不**改任何 claim.status（红线#2）。
 *
 * reverseEvidenceClaimId 缺省 = ruledAgainstClaimId（Verifier 路：目标 claim 自己的 exact 反向/定量否定出处）。
 * Arbiter 路显式传胜者 id（胜者那条明确反向命题的 exact 出处）。
 */
export async function assertNcExactEvidence(
  db: DB,
  opts: {
    ruledAgainstClaimId: string
    reverseEvidenceClaimId?: string
    rulingKind: RefusedRulingKind
    path: string
    byRole: string
  },
): Promise<NcExactGateResult> {
  const reverseEvidenceClaimId = opts.reverseEvidenceClaimId ?? opts.ruledAgainstClaimId
  const exactCount = await countExactProvenances(db, reverseEvidenceClaimId)
  if (exactCount > 0) {
    return { ok: true, exactCount }
  }
  // 拒判 + 强制升级人。绝不落负判（调用方据 ok=false 短路）。
  const reason =
    `NC-exact red line: refusing to rule claim ${opts.ruledAgainstClaimId} ${opts.rulingKind} — ` +
    `no relevance='exact' reverse proposition on ${reverseEvidenceClaimId} ` +
    `(only supporting/tangential/irrelevant evidence). Escalated to editor-in-chief.`
  const payload: RulingRefusedPayload = {
    ruledAgainstClaimId: opts.ruledAgainstClaimId,
    reverseEvidenceClaimId,
    rulingKind: opts.rulingKind,
    path: opts.path,
    exactCount,
    reason,
    byRole: opts.byRole,
  }
  const id = randomUUID()
  await db.insert(metricsEvents).values({
    id,
    kind: RULING_REFUSED,
    queryText: null,
    payload,
  })
  return { ok: false, exactCount, eventId: id }
}

/** ruling_refused 事件的读出形状（payload 已校验）。主编（人）从这里取被拒的负判。 */
export interface RefusedRuling {
  eventId: string
  payload: RulingRefusedPayload
  createdAt: Date
}

function isRefusedPayload(p: unknown): p is RulingRefusedPayload {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  return (
    typeof o.ruledAgainstClaimId === 'string' &&
    typeof o.reverseEvidenceClaimId === 'string' &&
    (o.rulingKind === 'non_compliant' || o.rulingKind === 'refuted') &&
    typeof o.path === 'string' &&
    typeof o.exactCount === 'number' &&
    typeof o.reason === 'string' &&
    typeof o.byRole === 'string'
  )
}

/**
 * 读 NC-exact 拒判升级队列（ruling_refused 事件），最新在前。
 * 主编（人）从这里取因缺 exact 反向证据而被拒的负判，人工核验后才可（只人能放松）落终判。
 */
export async function getRefusedRulings(db: DB): Promise<RefusedRuling[]> {
  const rows = await db
    .select()
    .from(metricsEvents)
    .where(eq(metricsEvents.kind, RULING_REFUSED))
    .orderBy(desc(metricsEvents.createdAt), desc(metricsEvents.id))
  return rows
    .filter((r) => isRefusedPayload(r.payload))
    .map((r) => ({
      eventId: r.id,
      payload: r.payload as RulingRefusedPayload,
      createdAt: r.createdAt,
    }))
}
