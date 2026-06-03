/**
 * 配置态规范表（A.2/A.3，主编设）—— factor_weights + 消费门门限。
 *
 * append-only：每次 setStandards 落一行新版本；「活动规范」= created_at 最新一行（无则用内核内置默认）。
 * 改后**新召回请求**用活动权重/门限即刻重算（见 recallClaims），历史快照（已返回的值拷贝）冻结、不回溯漂移。
 *
 * 写时护不变量（拒绝违反）：
 *   - 权重：各 ≥0、0 < Σw ≤ 1、authority(出处)权重 >0（护 D1）—— 走 confidence.assertWeights。
 *   - 门限：consume_floor ≥ 内核硬下界 0.4、must_verify_threshold ≥ 内核 0.6（都只能抬严，绝不能降到内核门以下）；
 *           consume_floor ≤ must_verify_threshold ≤ 1。
 */
import { randomUUID } from 'node:crypto'

import { desc } from 'drizzle-orm'

import {
  DEFAULT_WEIGHTS,
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
  assertWeights,
  type FactorWeights,
} from '../confidence/confidence.js'
import type { DB } from '../db/client.js'
import { standards } from '../db/schema.js'

export interface Standards {
  factorWeights: FactorWeights
  /** 消费下界：value < 此值绝不召回（≥ 内核 0.4）。 */
  consumeFloor: number
  /** 信任门：value < 此值的召回结果带 mustVerify=true。 */
  mustVerifyThreshold: number
}

export interface StandardsRow extends Standards {
  id: string
  createdBy: string
  createdAt: Date
}

export interface StandardsInput {
  factorWeights: FactorWeights
  /** 默认 = 内核 0.4。 */
  consumeFloor?: number
  /** 默认 = 内核 0.6。 */
  mustVerifyThreshold?: number
  /** 写入者（审计）。 */
  createdBy?: string
}

/** 内核内置默认规范：Standards 表为空时的活动规范（起步基线，与 S1–S6 行为一致）。 */
export const DEFAULT_STANDARDS: Standards = {
  factorWeights: DEFAULT_WEIGHTS,
  consumeFloor: KERNEL_CONFIDENCE_FLOOR,
  mustVerifyThreshold: MUST_VERIFY_THRESHOLD,
}

function assertThresholds(consumeFloor: number, mustVerify: number): void {
  // 配置态只能把门**抬严**，绝不能降到内核硬门以下（红线：consumer/config 只收紧）。
  if (!(consumeFloor >= KERNEL_CONFIDENCE_FLOOR)) {
    throw new Error(
      `standards: consumeFloor must be ≥ kernel floor ${KERNEL_CONFIDENCE_FLOOR} (got ${consumeFloor})`,
    )
  }
  // mustVerifyThreshold 同理只能 ≥ 内核 0.6：降到 0.6 以下会抹平 [floor,0.6) 的"须先核验"band（放松信任门），
  // 且与 adapter.ts 硬编码的 0.6 收紧校验自相矛盾。
  if (!(mustVerify >= MUST_VERIFY_THRESHOLD)) {
    throw new Error(
      `standards: mustVerifyThreshold must be ≥ kernel trust bar ${MUST_VERIFY_THRESHOLD} (config can only raise the gate, never relax it; got ${mustVerify})`,
    )
  }
  if (!(mustVerify >= consumeFloor && mustVerify <= 1)) {
    throw new Error(
      `standards: mustVerifyThreshold must satisfy consumeFloor ≤ t ≤ 1 (got ${mustVerify}, floor ${consumeFloor})`,
    )
  }
}

/**
 * 设新规范（append-only）。校验权重 + 门限，违反即抛、不写。返回落库的新版本行。
 * 不重算任何历史 claim、不动任何已发快照——只影响此后的新召回请求。
 */
export async function setStandards(db: DB, input: StandardsInput): Promise<StandardsRow> {
  assertWeights(input.factorWeights) // 各≥0 / 0<Σw≤1 / authority>0
  const consumeFloor = input.consumeFloor ?? KERNEL_CONFIDENCE_FLOOR
  const mustVerifyThreshold = input.mustVerifyThreshold ?? MUST_VERIFY_THRESHOLD
  assertThresholds(consumeFloor, mustVerifyThreshold)

  const id = randomUUID()
  const rows = await db
    .insert(standards)
    .values({
      id,
      factorWeights: input.factorWeights,
      consumeFloor,
      mustVerifyThreshold,
      createdBy: input.createdBy ?? 'editor:unknown',
    })
    .returning()
  const row = rows[0]!
  return {
    id: row.id,
    factorWeights: row.factorWeights as FactorWeights,
    consumeFloor: row.consumeFloor,
    mustVerifyThreshold: row.mustVerifyThreshold,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

/** 活动规范 = created_at 最新一行（平手按 id 倒序）；表空则内置默认。 */
export async function getActiveStandards(db: DB): Promise<Standards> {
  const rows = await db
    .select({
      factorWeights: standards.factorWeights,
      consumeFloor: standards.consumeFloor,
      mustVerifyThreshold: standards.mustVerifyThreshold,
    })
    .from(standards)
    .orderBy(desc(standards.createdAt), desc(standards.id))
    .limit(1)
  if (rows.length === 0) return DEFAULT_STANDARDS
  const r = rows[0]!
  return {
    factorWeights: r.factorWeights as FactorWeights,
    consumeFloor: r.consumeFloor,
    mustVerifyThreshold: r.mustVerifyThreshold,
  }
}
