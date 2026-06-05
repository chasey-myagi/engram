/**
 * 恒温器派生策略的**版本化持久化**（S26）—— 沿 standards.ts 的 append-only / 「活动=最新一行」式样。
 *
 * - writeGovernanceState：落一行新策略版本（含触发它的五指标快照 + reason + createdBy）。审计留痕。
 * - getActivePolicy：活动策略 = createdAt 最新一行（平手按 id 倒序）；表空 → BASELINE_POLICY（四旋钮归零）。
 * - getGovernanceHistory：全版本史，最新在前（审计/回滚选点用）。
 * - rollbackTo：**可逆**——把某历史版本的 policy 追写成新版本（append-only，绝不物理改写历史）。
 *
 * 不动任何 claim / claim.status / 冻结枚举：这是独立新表，纯治理配置态。
 */
import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import type { DB } from '../db/client.js'
import { governanceState } from '../db/schema.js'
import { BASELINE_POLICY, type GovernanceMetrics, type GovernancePolicy } from './control-law.js'

/** governance_state 一行的读出形状。 */
export interface GovernanceStateRow {
  id: string
  policy: GovernancePolicy
  /** 触发本步的五指标快照（+ 可选 targets，审计用）。 */
  metrics: GovernanceMetrics & { targets?: GovernancePolicy }
  reason: string
  createdBy: string
  createdAt: Date
}

export interface WriteGovernanceStateInput {
  policy: GovernancePolicy
  metrics: GovernanceMetrics & { targets?: GovernancePolicy }
  reason: string
  createdBy?: string
}

function toRow(r: typeof governanceState.$inferSelect): GovernanceStateRow {
  return {
    id: r.id,
    policy: {
      promotionGateLevel: r.promotionGateLevel,
      patrolFrequency: r.patrolFrequency,
      ingestionThrottle: r.ingestionThrottle,
      arbiterPriority: r.arbiterPriority,
    },
    metrics: r.metrics as GovernanceMetrics & { targets?: GovernancePolicy },
    reason: r.reason,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }
}

/** 落一行新策略版本（append-only）。返回落库行。 */
export async function writeGovernanceState(
  db: DB,
  input: WriteGovernanceStateInput,
): Promise<GovernanceStateRow> {
  const id = randomUUID()
  const rows = await db
    .insert(governanceState)
    .values({
      id,
      promotionGateLevel: input.policy.promotionGateLevel,
      patrolFrequency: input.policy.patrolFrequency,
      ingestionThrottle: input.policy.ingestionThrottle,
      arbiterPriority: input.policy.arbiterPriority,
      metrics: input.metrics,
      reason: input.reason,
      createdBy: input.createdBy ?? 'controller:governance',
    })
    .returning()
  return toRow(rows[0]!)
}

/** 活动策略 = createdAt 最新一行（平手按 id 倒序）；表空则 BASELINE_POLICY。 */
export async function getActivePolicy(db: DB): Promise<GovernancePolicy> {
  const rows = await db
    .select()
    .from(governanceState)
    .orderBy(desc(governanceState.createdAt), desc(governanceState.id))
    .limit(1)
  if (rows.length === 0) return BASELINE_POLICY
  return toRow(rows[0]!).policy
}

/** 全策略版本史，最新在前（审计/回滚选点用）。 */
export async function getGovernanceHistory(db: DB): Promise<GovernanceStateRow[]> {
  const rows = await db
    .select()
    .from(governanceState)
    .orderBy(desc(governanceState.createdAt), desc(governanceState.id))
  return rows.map(toRow)
}

/**
 * **回滚**到某历史版本：把该版本的 policy 作为**新版本**追写（append-only，可审计、可再回滚）。
 * 绝不物理删/改历史行——回滚本身也是一次留痕。stateId 不存在 → 抛。
 */
export async function rollbackTo(
  db: DB,
  stateId: string,
  by = 'human:editor',
): Promise<GovernanceStateRow> {
  const [target] = await db
    .select()
    .from(governanceState)
    .where(eq(governanceState.id, stateId))
    .limit(1)
  if (!target) {
    throw new Error(`governance: rollback target state ${stateId} not found`)
  }
  const t = toRow(target)
  return writeGovernanceState(db, {
    policy: t.policy,
    metrics: t.metrics,
    reason: `rollback to ${stateId} (was: ${t.reason})`,
    createdBy: by,
  })
}
