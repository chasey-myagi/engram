/**
 * claim 状态机（A.4）—— 每个工种与编辑动作的脊柱。蓝边只收紧、红边才放松，刻意不对称、内核强制。
 *
 * 合法迁移（transitionClaim 管的部分；→superseded 走 supersedeClaim，不在这里）：
 *   draft   → active      promote：蓝(agent/Verifier) 需 conf≥0.5 ∧ entailment 通过；或人 Approve（旁路门）。
 *   active  → flagged      蓝（疑似幻觉 / 掉出门 / 新冲突）。
 *   flagged → quarantined  蓝（仍无支撑）。
 *   quarantined/flagged → active   **红·放松（赦免）**：仅人。
 *   superseded → active            **红·放松（回滚）**：仅人。
 * 其余 (from,to) 一律非法（如 draft→quarantined、superseded→flagged）→ 拒。
 *
 * 红边证据是**可选**的（对齐 PRD A.4 与设计稿 FIG 6b、红线#2）：赦免/回滚是人的编辑性放松，授权来自「人」本身，
 * **不**强制新证据；给了 evidence 才连带把新正向 exact 出处 append-only 留痕（"找到新正向 exact 证据" 那条路）。
 * 不对称在内核硬执行：蓝/agent 只能收紧（promote / flag / quarantine）；放松（X→active）非人即拒。
 * status 由事件驱动：promote 读 conf 作判据，但 status 不由 conf 单独决定（人可 Approve、红边人授权放松）。
 * S13 的 entailment 用**注入的合成判据**（真 Verifier entailment 生产者是 S17，届时这半门才算真绿）。
 *
 * 并发：全程在一个事务里、对 claim 行 `SELECT … FOR UPDATE` 锁定后再校验+写（对齐 supersedeClaim），
 * 序列化同一 claim 的并发迁移 —— 杜绝 TOCTOU（读到旧 status 却无条件写、把并发取代掉的 claim 复活等）。
 */
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { getActiveStandards } from '../config/standards.js'
import { applyG, rawFromStoredFactors, type StoredConfidence } from '../confidence/confidence.js'
import type { DB } from '../db/client.js'
import { claim, claimProvenance, type ClaimStatus } from '../db/schema.js'
import { computeEntailmentFactor } from '../verifier/patrol-verdict.js'
import { computeHumanReviewFactor } from '../editor/human-review.js'
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

/** 红边放松可选附带的新正向 exact 证据（给了则 append-only 留痕；不给则纯人授权赦免/回滚）。 */
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
  /** 红边放松（X→active）**可选**的新正向 exact 证据；给了才记一条出处。赦免/回滚无证据也可（仅人授权）。 */
  evidence?: PositiveEvidence
}

/**
 * 按 A.4 迁移一条 claim 的状态。非法迁移 / 越权放松 / 晋升门未达 → 抛（不改库）。返回 { from, to }。
 * 全程在事务内对该行加 FOR UPDATE 锁，序列化并发迁移。→superseded 不走这里（用 supersedeClaim）。
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
  // 活动规范（仅 promote 门用）。配置态、低争用，事务外读快照即可。
  const std = await getActiveStandards(db)

  return db.transaction(async (tx) => {
    // 锁行 + 事务内读最新 status（杜绝 TOCTOU；对齐 supersedeClaim 的 .for('update') 范式）。
    const [row] = await tx
      .select({ status: claim.status, factors: claim.confidenceFactors })
      .from(claim)
      .where(eq(claim.id, claimId))
      .for('update')
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
        const stored = row.factors as StoredConfidence
        // conf 用存档因子 × 活动权重现算（与 recall 一致）；conflictDecay 取存档快照（draft 通常尚无矛盾，
        // 活值冲突一致性留作后续与 recall 的 S8 实时口径对齐）。
        // S17：f2 entailment 按 recall 同款实时口径——接到该 claim 最新 patrol 裁决（Verifier 在调本迁移前刚写入），
        // 让「entailment pass 抬 f2」真正参与 conf≥0.5 判据（闭合 S13 合成桩；无 patrol 则中性 0.5，与存档一致、行为不变）。
        // S22：f1 humanReview 同款实时口径——接到该 claim 最新主编人审。蓝边 promote 通常发生在人审之前（f1=中性 0、
        // 与存档一致、行为不变）；接它只为与 recall 重算口径一致，绝不让 agent 借它放松（红线#2：人审只人能投）。
        const liveHumanReview = await computeHumanReviewFactor(tx, claimId)
        const liveEntailment = await computeEntailmentFactor(tx, claimId)
        const factors = {
          ...stored.factors,
          humanReview: liveHumanReview,
          entailment: liveEntailment,
        }
        const conf = applyG(
          rawFromStoredFactors(factors, std.factorWeights),
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
      await tx.update(claim).set({ status: 'active' }).where(eq(claim.id, claimId))
      return { from, to: toStatus }
    }

    if (kind === 'blue') {
      // 收紧：蓝/agent 与人都可做（agent 自由收紧）。
      await tx.update(claim).set({ status: toStatus }).where(eq(claim.id, claimId))
      return { from, to: toStatus }
    }

    // kind === 'red'：放松（X→active）。仅人可做（红线#2）。证据可选：赦免/回滚无证据亦可。
    if (!isHumanRole(opts.by)) {
      throw new Error(
        `transition: relaxation ${from} → active requires a human caller (blue/agent can only tighten)`,
      )
    }
    if (opts.evidence) {
      // 给了新正向 exact 证据 → append-only 留痕（"找到新正向 exact 证据" 那条放松路）。
      await tx.insert(claimProvenance).values({
        id: randomUUID(),
        claimId,
        sourceId: opts.evidence.sourceId,
        locator: opts.evidence.locator,
        excerpt: opts.evidence.excerpt,
        relevance: 'exact',
      })
    }
    await tx.update(claim).set({ status: 'active' }).where(eq(claim.id, claimId))
    return { from, to: toStatus }
  })
}
