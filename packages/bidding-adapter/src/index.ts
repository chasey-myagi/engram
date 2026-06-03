import { ENGRAM_VERSION } from '@engram/core'

/**
 * bidding-adapter — Engram 的第一个领域适配器(consumer)。
 * 经 Consumer SPI 单调收紧地消费内核，绝不反向依赖内核内部。
 *
 * 地基骨架：仅证明 workspace 依赖方向（adapter → core）接通。
 */
export const ADAPTER_TARGETS_ENGRAM = ENGRAM_VERSION
