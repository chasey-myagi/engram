/**
 * bidding-adapter — Engram 的第一个领域适配器(consumer)。
 *
 * 经 Consumer SPI 单调收紧地消费内核，**绝不反向依赖内核内部**：只用 @engram/core 导出的 SPI 面
 * （applyAdapter / recall 结果类型 / schema / 阈值），内核对 bidding 的业务语义零认知。
 *
 * 业务身份注入：adapter 读 source.meta.source_type（一个内核完全不认的 key），据此收紧 conf——
 * official_datasheet 最受信（不打折），其余类型按 discount 收紧。恒满足 adaptedConf ≤ gConf。
 */
import { inArray } from 'drizzle-orm'

import {
  MUST_VERIFY_THRESHOLD,
  applyAdapter,
  schema,
  type DB,
  type RecallAdapter,
  type RecallResult,
} from '@engram/core'

/** 业务身份键值（只在这个领域包里出现；内核代码绝不引用）。 */
export const OFFICIAL_DATASHEET = 'official_datasheet'
const DEFAULT_DISCOUNT = 0.8

/**
 * 读 source.meta.source_type 建 sourceId→type 映射。业务身份只在消费侧解读；内核把 meta 当不透明 jsonb。
 */
export async function readSourceTypes(
  db: DB,
  sourceIds: string[],
): Promise<Map<string, string | undefined>> {
  const map = new Map<string, string | undefined>()
  const ids = [...new Set(sourceIds)]
  if (ids.length === 0) return map
  const rows = await db
    .select({ id: schema.source.id, meta: schema.source.meta })
    .from(schema.source)
    .where(inArray(schema.source.id, ids))
  for (const r of rows) {
    const meta = r.meta as { source_type?: unknown }
    map.set(r.id, typeof meta?.source_type === 'string' ? meta.source_type : undefined)
  }
  return map
}

/**
 * 按 source_type 收紧的 bidding 适配器。official_datasheet 不打折(=gConf)、最受信；其余类型乘 discount(<1)。
 * 恒满足 adaptedConf ≤ gConf（单调收紧）；conf 降到信任门以下的结果重算 mustVerify，保持门一致。
 */
export function biddingAdapter(
  sourceTypeById: Map<string, string | undefined>,
  opts: { discount?: number } = {},
): RecallAdapter {
  const discount = opts.discount ?? DEFAULT_DISCOUNT
  return (results) =>
    results.map((r) => {
      const official = r.provenances.some(
        (p) => sourceTypeById.get(p.sourceId) === OFFICIAL_DATASHEET,
      )
      const factor = official ? 1 : discount
      const value = r.confidence.value * factor
      return {
        ...r,
        confidence: { ...r.confidence, value },
        mustVerify: value < MUST_VERIFY_THRESHOLD,
      }
    })
}

/**
 * 一站式：读 source_type → 按业务身份收紧 → 经内核 applyAdapter 强制单调不变量（违反即抛 'adapter relaxed'）。
 * consumer 拿内核召回结果调它，得到收紧后的子集。
 */
export async function biddingTighten(
  db: DB,
  kernelResults: RecallResult[],
  opts: { discount?: number } = {},
): Promise<RecallResult[]> {
  const sourceIds = kernelResults.flatMap((r) => r.provenances.map((p) => p.sourceId))
  const sourceTypeById = await readSourceTypes(db, sourceIds)
  return applyAdapter(kernelResults, biddingAdapter(sourceTypeById, opts))
}
