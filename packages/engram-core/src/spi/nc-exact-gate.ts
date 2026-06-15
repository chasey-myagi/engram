/**
 * NC-exact 红线统一闸门（S21）—— 永久红线 #3 / A.6。**领域无关内核**，Verifier(D3 巡查) 与 Arbiter(冲突收敛) 共用同一条缝。
 *
 * 红线（A.6「NC-exact」）：任何把一条 claim 判成 **non_compliant / refuted** 的路径，
 *   必须有 **≥1 条 `relevance='exact'` 的反向证据**（原文明确反向命题，含定量否定；区别于仅语义蕴含的 `supporting`）。
 *   否则该判定 **拒判 + 强制升级主编**（落一条 ruling_refused 事件），**绝不**落该 NC/refuted 判定。
 *
 * 反向证据**只可能**落在「承载反向命题的那条**对端 claim**」上 —— 即原文明确陈述「与被判 claim 相反」之命题的另一条 claim：
 *   - Arbiter 机判自裁 → **败者**被判为负（采信胜者、压败者）。反向命题 = **胜者**（它的 exact 出处即「与败者相反」的原文）。
 *   - Verifier `not_co_true`（与某条 claim 不可同真）→ 反向命题 = **矛盾对端 peer**（其 exact 出处即「与目标相反」的原文）。
 *
 * 关键不变量（linus / 红线#3）：**一条 claim 自己的 `exact` 出处永远是「支持它自己」的证据，绝不是「反对它自己」的反向证据。**
 *   `prov_relevance` 四档描述的是「某出处对**它所挂的那条 claim**的支撑强度」，不含任何「反向」语义。
 *   故 `reverseEvidenceClaimId` **必须**是一条与 `ruledAgainstClaimId` 不同的对端 claim；传入自身 = 契约误用（直接抛）。
 *   `null` = 调用方拿不出任何承载反向命题的对端 → 无证据可判负 → 拒判升级人（如 Verifier not_co_true 找不到矛盾对端）。
 *
 * `fail`（幻觉/出处推不出）**不经此闸门**：它不是「有反向命题在反对 claim」，而是「claim 缺自身出处支撑」——
 *   是缺支撑的**可疑 flag**（蓝边收紧、可被人放松），不是需反向证据的硬否定。调用方对 fail 直接 flag，不调本闸门。
 *
 * 四档语义（A.6，本闸门**读且区分**）：对端 claim 上唯 `exact`(原文明确陈述其命题，含定量否定) 才算反向证据；
 *   `supporting`(间接支持) / `tangential`(相关不决定) / `irrelevant` 一律**不**算 —— 只有对端的 exact 出处能把被判 claim 判负。
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
 *   - ok=true：承载反向命题的**对端 claim**有 ≥1 条 `exact` 出处 → 调用方可落负判。
 *   - ok=false：无对端 / 对端无 exact 反向证据 → 调用方**必须不**落负判；闸门已写 ruling_refused 升级主编。
 */
export type NcExactGateResult =
  | { ok: true; exactCount: number }
  | { ok: false; exactCount: number; eventId: string }

/** ruling_refused 事件 payload（主编队列读出 / 审计；绝不进计分）。 */
export interface RulingRefusedPayload {
  /** 本应被判为负、因缺 exact 反向证据而拒判的 claim。 */
  ruledAgainstClaimId: string
  /**
   * 承载反向命题、被检查 exact 出处的**对端 claim**（Arbiter 路 = 胜者；Verifier not_co_true 路 = 矛盾对端 peer）。
   * `null` = 调用方拿不出任何对端（无从指认反向命题）→ 直接拒判升级人。**绝不**是 ruledAgainstClaimId 自身。
   */
  reverseEvidenceClaimId: string | null
  /** 被拒的负判类型。 */
  rulingKind: RefusedRulingKind
  /** 发起该负判的路径（'verifier' | 'arbiter'），可解释。 */
  path: string
  /** 检查到的 exact 反向出处数（0 才会拒；无对端时为 0）。 */
  exactCount: number
  /** 人类可读理由。 */
  reason: string
  /** 发起者身份（agent:verifier / agent:arbiter / 测试角色）。 */
  byRole: string
}

/**
 * 数一条 claim 上 `relevance='exact'` 的出处数（四档里只认 exact —— supporting/tangential/irrelevant 不计）。
 * 纯读、确定性。这是「区分四档」的单一真相点：两条判负路都经此数对端的 exact，不各自重写四档解释。
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
 *   承载反向命题的**对端 claim**（reverseEvidenceClaimId）须有 ≥1 条 `exact` 出处。
 *     - 有 → `{ ok:true }`，调用方可落负判。
 *     - 无（对端无 exact，或 reverseEvidenceClaimId=null 即无从指认对端）→ 写一条 ruling_refused 事件升级主编，
 *       返回 `{ ok:false, eventId }`，调用方**必须不**落负判。
 * **绝不**改任何 claim.status（红线#2）。
 *
 * reverseEvidenceClaimId **必须显式传入**（无缺省）：
 *   - Arbiter 路传**胜者** id；Verifier not_co_true 路传**矛盾对端 peer** id（无对端 → null）。
 *   - 传入 == ruledAgainstClaimId 是**契约误用**（claim 自身 exact 出处是支持它、绝非反对它）→ 直接抛，杜绝语义反转。
 */
export async function assertNcExactEvidence(
  db: Queryable,
  opts: {
    ruledAgainstClaimId: string
    /** 承载反向命题的对端 claim id；无从指认对端时传 null。**绝不**传 ruledAgainstClaimId 自身。 */
    reverseEvidenceClaimId: string | null
    rulingKind: RefusedRulingKind
    path: string
    byRole: string
  },
): Promise<NcExactGateResult> {
  const { ruledAgainstClaimId, reverseEvidenceClaimId } = opts
  // 不变量（红线#3 / linus）：反向证据必须来自一条**不同**的对端 claim。claim 自己的 exact 出处支持它自己，
  // 永远不可能是「反对它自己」的反向证据；把自身当反向证据即语义反转，物理上无法兑现红线#3。
  if (reverseEvidenceClaimId !== null && reverseEvidenceClaimId === ruledAgainstClaimId) {
    throw new Error(
      `NC-exact gate misuse: reverseEvidenceClaimId must be a DISTINCT contradicting peer, ` +
        `never the ruled-against claim itself (${ruledAgainstClaimId}). A claim's own provenance ` +
        `supports IT and can never be reverse evidence against it (red line #3 / A.6).`,
    )
  }

  const exactCount =
    reverseEvidenceClaimId === null ? 0 : await countExactProvenances(db, reverseEvidenceClaimId)
  if (reverseEvidenceClaimId !== null && exactCount > 0) {
    return { ok: true, exactCount }
  }

  // 拒判 + 强制升级人。绝不落负判（调用方据 ok=false 短路）。
  const reason =
    reverseEvidenceClaimId === null
      ? `NC-exact red line: refusing to rule claim ${ruledAgainstClaimId} ${opts.rulingKind} — ` +
        `no contradicting peer identified to carry a reverse proposition. Escalated to editor-in-chief.`
      : `NC-exact red line: refusing to rule claim ${ruledAgainstClaimId} ${opts.rulingKind} — ` +
        `peer ${reverseEvidenceClaimId} carries no relevance='exact' reverse proposition ` +
        `(only supporting/tangential/irrelevant evidence). Escalated to editor-in-chief.`
  const payload: RulingRefusedPayload = {
    ruledAgainstClaimId,
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
    (typeof o.reverseEvidenceClaimId === 'string' || o.reverseEvidenceClaimId === null) &&
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
