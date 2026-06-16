/**
 * bidding-adapter — Engram 的第一个领域适配器(consumer)。
 *
 * 经 Consumer SPI 单调收紧地消费内核，**绝不反向依赖内核内部**：只用 @engram/core 导出的 SPI 面
 * （applyAdapter / recall 结果类型 / 阈值），内核对 bidding 的业务语义零认知。
 *
 * 业务身份注入：adapter 读 recall result 里随出处带回的受控 `sourceMeta.source_type`（一个内核完全不认的 key），
 * 据此收紧 conf——official_datasheet 最受信（不打折），其余类型按 discount 收紧。恒满足 adaptedConf ≤ gConf。
 *
 * EGR-CR-043：业务身份从 recall result 的受控 metadata 缝读取，不再穿透 core schema 旁路查 source.meta，
 * `biddingTighten` 也只吃 recall result（不再吃 raw db）——「Consumer SPI 是唯一对外缝、无旁路」由此恒成立。
 */
import {
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
  applyAdapter,
  type RecallAdapter,
  type RecallResult,
} from '@engram/core'

/** 业务身份键值（只在这个领域包里出现；内核代码绝不引用）。 */
export const OFFICIAL_DATASHEET = 'official_datasheet'
const DEFAULT_DISCOUNT = 0.8

/** 从一条出处的受控 metadata 摘要里读业务身份键 source_type（缺/非字符串 → undefined）。 */
function sourceTypeOf(prov: RecallResult['provenances'][number]): string | undefined {
  const t = prov.sourceMeta.source_type
  return typeof t === 'string' ? t : undefined
}

/**
 * 按 source_type 收紧的 bidding 适配器。official_datasheet 不打折(=gConf)、最受信；其余类型乘 discount。
 * 业务身份取自 recall result 随出处带回的受控 `sourceMeta.source_type`——零 schema 穿透、零额外往返。
 * 收紧细节：
 *   - 最优源胜：一条 claim 只要**有一条**出处是 official_datasheet 即按官方对待（best-source-wins）。
 *   - conf 降到信任门 0.6 以下的结果重算 mustVerify=true，保持消费门一致（否则会被内核 applyAdapter 拦）。
 *   - 折后跌破内核消费下界 0.4 的结果直接丢弃——不把"不可消费"档泄露给下游（recall 本就不会吐 <0.4）。
 * discount 默认 0.8、应 ≤1；若误传 >1 会抬高 conf，此时由内核 applyAdapter 抛 'adapter relaxed' 兜底（纵深防御）。
 */
export function biddingAdapter(opts: { discount?: number } = {}): RecallAdapter {
  const discount = opts.discount ?? DEFAULT_DISCOUNT
  return (results) =>
    results
      .map((r) => {
        const official = r.provenances.some((p) => sourceTypeOf(p) === OFFICIAL_DATASHEET)
        const factor = official ? 1 : discount
        const value = r.confidence.value * factor
        return {
          ...r,
          confidence: { ...r.confidence, value },
          mustVerify: value < MUST_VERIFY_THRESHOLD,
        }
      })
      .filter((r) => r.confidence.value >= KERNEL_CONFIDENCE_FLOOR) // 折到 floor 以下 → 丢，不泄露不可消费档
}

/**
 * 一站式：按业务身份收紧 → 经内核 applyAdapter 强制单调不变量（违反即抛 'adapter relaxed'）。
 * consumer 拿内核召回结果调它，得到收紧后的子集——**只吃 recall result，不碰 raw db / schema**。
 */
export function biddingTighten(
  kernelResults: RecallResult[],
  opts: { discount?: number } = {},
): RecallResult[] {
  return applyAdapter(kernelResults, biddingAdapter(opts))
}
