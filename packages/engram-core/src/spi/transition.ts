/**
 * claim 状态机（A.4）—— 每个工种与编辑动作的脊柱。蓝边只收紧、红边才放松，刻意不对称、内核强制。
 *
 * 合法迁移（transitionClaim 管的部分；→superseded 走 supersedeClaim，不在这里）：
 *   draft   → active      promote：蓝(agent/Verifier) 需 conf≥0.5 ∧ entailment 通过；或人 Approve（旁路门）。
 *   active  → flagged      蓝（疑似幻觉 / 掉出门 / 新冲突）。
 *   flagged → quarantined  蓝（仍无支撑）。
 *   flagged / quarantined / superseded → active   **红**：仅人可做，且须**记录新的正向 exact 证据**。
 * 其余 (from,to) 一律非法（如 draft→quarantined、superseded→flagged）→ 拒。
 *
 * 不对称在内核硬执行：蓝/agent 调用方只能收紧（promote / flag / quarantine）；放松（X→active）非人即拒。
 * status 由事件驱动：promote 读 conf 作判据，但 status 不由 conf 单独决定（人可 Approve、放松要证据）。
 * S13 的 entailment 用**注入的合成判据**（真 Verifier entailment 生产者是 S17，届时这半门才算真绿）。
 */
import { eq } from 'drizzle-orm'

import { getActiveStandards } from '../config/standards.js'
import { applyG, rawFromStoredFactors, type StoredConfidence } from '../confidence/confidence.js'
import type { DB } from '../db/client.js'
import { randomUUID } from 'node:crypto'
import { claim, claimProvenance, type ClaimStatus } from '../db/schema.js'
import { isHumanRole } from './reflux.js'

/** draft→active 的连续 confidence 晋升门（A.4）：蓝边 promote 需 conf≥此值 ∧ entailment 通过。 */
export const PROMOTE_CONFIDENCE_FLOOR = 0.5

type TransitionKind = 'promote' | 'blue' | 'red'

/** A.4 合法迁移表（transitionClaim 域；→superseded 由 supersedeClaim 专管，不入此表）。 */
const LEGAL: Partial<Record<ClaimStatus, Partial<Record<ClaimStatus, TransitionKind>>>> = {
  draft: { active: 'promote' },
  active: { flagged: 'blue' },
  flagged: { quarantined: 'blue', active: 'red' },
  quarantined: { active: 'red' },
  superseded: { active: 'red' },
}

/** 放松（红边）所需的新正向 exact 证据。 */
export interface PositiveEvidence {
  sourceId: string
  locator: string
  excerpt?: string
}

export interface TransitionOptions {
  /** 调用方身份。'human…' = 人（可放松）；其余 = 蓝/agent（只能收紧）。 */
  by: string
  /** draft→active 蓝边晋升需要的 entailment 判据（S13 合成注入；S17 由真 Verifier 产出替换）。 */
  entailmentPass?: boolean
  /** 红边放松（X→active）必须记录的新正向 exact 证据（无则拒）。 */
  evidence?: PositiveEvidence
}

/**
 * 按 A.4 迁移一条 claim 的状态。非法迁移 / 越权放松 / 晋升门未达 / 放松缺证据 → 抛（不改库）。
 * 返回 { from, to }。→superseded 不走这里（用 supersedeClaim，它要造新版本）。
 */
export async function transitionClaim(
  db: DB,
  claimId: string,
  toStatus: ClaimStatus,
  opts: TransitionOptions,
): Promise<{ from: ClaimStatus; to: ClaimStatus }> {
  if (toStatus === 'superseded') {
    throw new Error(
      'transition: → superseded must go through supersedeClaim (it creates a new version)',
    )
  }
  const [row] = await db
    .select({ status: claim.status, factors: claim.confidenceFactors })
    .from(claim)
    .where(eq(claim.id, claimId))
  if (!row) {
    throw new Error(`transition: claim ${claimId} not found`)
  }
  const from = row.status
  if (from === toStatus) {
    throw new Error(`transition: claim ${claimId} is already '${from}' (no-op)`)
  }
  const kind = LEGAL[from]?.[toStatus]
  if (!kind) {
    throw new Error(`transition: illegal transition ${from} → ${toStatus} (A.4)`)
  }

  if (kind === 'promote') {
    // draft→active：人 Approve 旁路门；蓝边须 conf≥0.5 ∧ entailment 通过。
    if (!isHumanRole(opts.by)) {
      const std = await getActiveStandards(db)
      const stored = row.factors as StoredConfidence
      const conf = applyG(
        rawFromStoredFactors(stored.factors, std.factorWeights),
        stored.calibrationVersion,
      )
      if (!(conf >= PROMOTE_CONFIDENCE_FLOOR)) {
        throw new Error(
          `transition: draft → active blocked — conf ${conf.toFixed(3)} < ${PROMOTE_CONFIDENCE_FLOOR} (stays draft)`,
        )
      }
      if (opts.entailmentPass !== true) {
        throw new Error(
          'transition: draft → active blocked — entailment did not pass (stays draft)',
        )
      }
    }
    await db.update(claim).set({ status: 'active' }).where(eq(claim.id, claimId))
    return { from, to: toStatus }
  }

  if (kind === 'blue') {
    // 收紧：蓝/agent 与人都可做（agent 自由收紧）。
    await db.update(claim).set({ status: toStatus }).where(eq(claim.id, claimId))
    return { from, to: toStatus }
  }

  // kind === 'red'：放松（X→active）。仅人可做 + 须记录新正向 exact 证据。
  if (!isHumanRole(opts.by)) {
    throw new Error(
      `transition: relaxation ${from} → active requires a human caller (blue/agent can only tighten)`,
    )
  }
  if (!opts.evidence) {
    throw new Error(
      `transition: relaxation ${from} → active requires recorded new positive exact evidence`,
    )
  }
  const evidence = opts.evidence
  return db.transaction(async (tx) => {
    // 记录新正向 exact 证据（放松的依据，append-only 留痕）。
    await tx.insert(claimProvenance).values({
      id: randomUUID(),
      claimId,
      sourceId: evidence.sourceId,
      locator: evidence.locator,
      excerpt: evidence.excerpt,
      relevance: 'exact',
    })
    await tx.update(claim).set({ status: 'active' }).where(eq(claim.id, claimId))
    return { from, to: toStatus }
  })
}
