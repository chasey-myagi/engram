/**
 * 恒温器派生策略的**版本化持久化**（S26）—— 沿 standards.ts 的 append-only / 「活动=最新一行」式样。
 *
 * - writeGovernanceState：落一行新策略版本（含触发它的五指标快照 + reason + createdBy）。审计留痕。
 * - getActivePolicy：活动策略 = createdAt 最新一行（平手按 id 倒序）；表空 → BASELINE_POLICY（四旋钮归零）。
 * - getGovernanceHistory：全版本史，最新在前（审计/回滚选点用）。
 * - rollbackTo：**真·可逆**——把某历史版本的 policy 追写成新版本，并在同一事务里**联动回写 standards**，
 *   让 recall 的生效门（standards 表）也回到目标 policy 对应的门。两表同事务，绝不物理改写历史（append-only）。
 *
 * 不动任何 claim / claim.status / 冻结枚举：这是独立新表，纯治理配置态。
 */
import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import { getActiveStandards, setStandardsTx } from '../config/standards.js'
import type { DB, Tx } from '../db/client.js'
import { governanceState } from '../db/schema.js'
import { BASELINE_POLICY, type GovernanceMetrics, type GovernancePolicy } from './control-law.js'
import { standardsInputFromPolicy } from './gate-policy.js'

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

/**
 * 在给定执行器（DB 或 Tx）上落一行新策略版本（append-only）。返回落库行。
 * 抽出供 runGovernanceCycle 在「write-policy + raise-gate」同一事务内复用，保证两步跨表写原子。
 */
export async function writeGovernanceStateTx(
  exec: DB | Tx,
  input: WriteGovernanceStateInput,
): Promise<GovernanceStateRow> {
  const id = randomUUID()
  const rows = await exec
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

/** 落一行新策略版本（append-only）。返回落库行。单写本就原子，薄包装 writeGovernanceStateTx。 */
export async function writeGovernanceState(
  db: DB,
  input: WriteGovernanceStateInput,
): Promise<GovernanceStateRow> {
  return writeGovernanceStateTx(db, input)
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
 * **回滚**到某历史版本，**两表联动、同事务**（EGR-CR-021 / 与 EGR-CR-033 的原子性诉求同源）：
 *   ① 把该版本的 policy 作为**新版本**追写到 governance_state（append-only，可审计、可再回滚）。
 *   ② 联动追写一行 standards——把 recall 的**生效消费门**也回到目标 policy 对应的门
 *      （`gateThresholdsFor(target.policy.promotionGateLevel)`，与抬门时 `standardsInputFromPolicy` 同源，
 *       round-trip 一致；复用当前活动权重，rollback 不动权重）。
 *
 * 这是显式、留痕的「人工受控放松」：不走 controller 的 tighten-only 闸门（`gateWouldTighten`），
 * 但仍受 `setStandardsTx` 内 `assertThresholds`（≥ 内核 0.4/0.6）二次护栏兜底。
 * 任一步抛错 → Postgres 整体回滚 → policy 不会留半提交。绝不物理删/改历史行。stateId 不存在 → 抛。
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
  return db.transaction(async (tx) => {
    const stateRow = await writeGovernanceStateTx(tx, {
      policy: t.policy,
      metrics: t.metrics,
      reason: `rollback to ${stateId} (was: ${t.reason})`,
      createdBy: by,
    })
    // 联动回写生效门：用当前活动权重 + 目标 policy 派生的门，无条件追写一行 standards。
    const active = await getActiveStandards(tx)
    await setStandardsTx(tx, standardsInputFromPolicy(t.policy, active.factorWeights, by))
    return stateRow
  })
}
