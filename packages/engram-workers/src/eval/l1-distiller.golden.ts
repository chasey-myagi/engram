/**
 * L1 Distiller golden（A.9 CI 红线 · 内核领域无关）—— 盯 Distiller「会污染库的危险错」：抽漏原子 claim、
 * 或把 provenance locator 写错位（钻不回原文）。判据（A.9）：claim 抽取准确率 **≥95%** + provenance **不错位**。
 *
 * 这是**行为 golden**（per-agent component golden），不是 A1「考卷=毒株」那种须过免疫流水线才晋升的 golden-question；
 * 它从不被写成 claim、从不被 recall 召回（见 l1-namespace.ts），只判分。
 *
 * 领域无关红线：所有 fixture 是**通用事实**（连接器吞吐、电池容量、保修期…），**绝不**是 bidding 的 SKU/标书列。
 * 不 import 任何 bidding-adapter golden。Distiller 若复用 bidding column-analyzer，须先在相同标书对标 <5% 差再上线
 * （那是 adapter 侧的事，内核 L1 在此只守领域无关的抽取脊柱）。
 *
 * 每个 fixture：一条领域无关 source（content + kind）+ 它**应**被抽出的原子事实集（locator + 钻回片段 + 三元）。
 * locator 是该 kind 的真实锚（'L2' / 'cell:R2C2' / 'turn:3' / 'p1:L2'…）——runner 会独立跑 SourceReader 校验
 * 「该 locator 确实定位到原文那一块、且片段含该事实」（钻回真值），故 golden 自身对 reader 分块诚实、不靠硬编码。
 */
import type { SourceKind } from '@engram/core'

/** golden 里一条「应被抽出的原子事实」。 */
export interface GoldenClaim {
  /** 抽出的 claim 文本（一条 = 一个原子事实）。 */
  claimText: string
  subject: string
  predicate: string
  object: string
  /** 该事实在原文中的 locator 锚（须是 SourceReader 对该 content 真实产出的某个 segment 的 locator）。 */
  locator: string
  /** 该 locator 钻回原文应命中的逐字片段（runner 据此校验 locator 不错位）。 */
  drillsBackTo: string
}

/** 一条 Distiller golden fixture：领域无关 source + 它应被抽出的原子事实集。 */
export interface DistillerGoldenItem {
  id: string
  kind: SourceKind
  /** 是否含图（走 VLM 视觉通道）。缺省按 kind 默认。 */
  hasImages?: boolean
  content: string
  claims: GoldenClaim[]
}

/**
 * 冻结的 Distiller golden 集：覆盖全部 7 个可读 source_kind（A.9「5 种 kind 各样本」的超集），
 * 通用事实、领域无关。每个 fixture 的 claims[].locator 都对应该 content 经 SourceReader 产出的真实分块。
 */
export const DISTILLER_GOLDEN: readonly DistillerGoldenItem[] = Object.freeze(
  [
    {
      id: 'distiller-structured-lines',
      kind: 'structured_spec',
      content:
        'connector qx-7731 max sustained throughput is 480 mbps\n' +
        'connector qx-7731 operating temperature is 70 celsius\n' +
        'connector qx-7731 weight is 240 g',
      claims: [
        {
          claimText: 'connector qx-7731 max sustained throughput is 480 mbps',
          subject: 'qx-7731',
          predicate: 'maxThroughput',
          object: '480mbps',
          locator: 'L1',
          drillsBackTo: 'connector qx-7731 max sustained throughput is 480 mbps',
        },
        {
          claimText: 'connector qx-7731 operating temperature is 70 celsius',
          subject: 'qx-7731',
          predicate: 'operatingTemperature',
          object: '70celsius',
          locator: 'L2',
          drillsBackTo: 'connector qx-7731 operating temperature is 70 celsius',
        },
        {
          claimText: 'connector qx-7731 weight is 240 g',
          subject: 'qx-7731',
          predicate: 'weight',
          object: '240g',
          locator: 'L3',
          drillsBackTo: 'connector qx-7731 weight is 240 g',
        },
      ],
    },
    {
      id: 'distiller-structured-table',
      kind: 'structured_spec',
      // TSV → cell anchors. header is row 1; values drill back to specific cells.
      content: 'part\tcapacity\tvoltage\npump-a\t4000 mah\t12 v\npump-b\t6000 mah\t24 v',
      claims: [
        {
          claimText: 'pump-a capacity is 4000 mah',
          subject: 'pump-a',
          predicate: 'capacity',
          object: '4000mah',
          locator: 'cell:R2C2',
          drillsBackTo: '4000 mah',
        },
        {
          claimText: 'pump-a voltage is 12 v',
          subject: 'pump-a',
          predicate: 'voltage',
          object: '12v',
          locator: 'cell:R2C3',
          drillsBackTo: '12 v',
        },
        {
          claimText: 'pump-b capacity is 6000 mah',
          subject: 'pump-b',
          predicate: 'capacity',
          object: '6000mah',
          locator: 'cell:R3C2',
          drillsBackTo: '6000 mah',
        },
      ],
    },
    {
      id: 'distiller-human-qa',
      kind: 'human_qa',
      content:
        'Q: what is the warranty period?\nA: 24 months\nQ: what is the retry budget?\nA: 3 attempts',
      claims: [
        {
          claimText: 'warranty period is 24 months',
          subject: 'product',
          predicate: 'warrantyPeriod',
          object: '24months',
          locator: 'qa:1',
          drillsBackTo: 'warranty period',
        },
        {
          claimText: 'retry budget is 3 attempts',
          subject: 'gateway',
          predicate: 'retryBudget',
          object: '3attempts',
          locator: 'qa:2',
          drillsBackTo: 'retry budget',
        },
      ],
    },
    {
      id: 'distiller-conversation',
      kind: 'conversation_log',
      content:
        'ann: kickoff for the relay project\n' +
        'bob: the dual-band failover landed in firmware revision r12\n' +
        'carol: the mttf for the cryo pump is 50000 hours',
      claims: [
        {
          claimText: 'dual-band failover landed in firmware revision r12',
          subject: 'mesh-relay',
          predicate: 'dualBandFailoverRevision',
          object: 'r12',
          locator: 'turn:2',
          drillsBackTo: 'dual-band failover landed in firmware revision r12',
        },
        {
          claimText: 'cryo pump mttf is 50000 hours',
          subject: 'cryo-pump',
          predicate: 'mttf',
          object: '50000hours',
          locator: 'turn:3',
          drillsBackTo: 'mttf for the cryo pump is 50000 hours',
        },
      ],
    },
    {
      id: 'distiller-historical',
      kind: 'historical_artifact',
      content:
        'the clearing node was commissioned in 1998 under the original settlement regime.\n\n' +
        'the satellite uplink scheduler tolerates packet loss up to 2 percent.',
      claims: [
        {
          claimText: 'clearing node was commissioned in 1998',
          subject: 'clearing-node',
          predicate: 'commissionedYear',
          object: '1998',
          locator: 'seg:1',
          drillsBackTo: 'commissioned in 1998',
        },
        {
          claimText: 'satellite uplink scheduler tolerates packet loss up to 2 percent',
          subject: 'uplink-scheduler',
          predicate: 'packetLossTolerance',
          object: '2percent',
          locator: 'seg:2',
          drillsBackTo: 'packet loss up to 2 percent',
        },
      ],
    },
    {
      id: 'distiller-agent-synthesis',
      kind: 'agent_synthesis',
      content:
        '## throughput\nthe sharded ledger supports 256 concurrent tenants before resharding\n' +
        '## reliability\nthe high-torque actuator rated duty cycle is 40 percent',
      claims: [
        {
          claimText: 'sharded ledger supports 256 concurrent tenants before resharding',
          subject: 'sharded-ledger',
          predicate: 'maxConcurrentTenants',
          object: '256',
          locator: 'sec:1',
          drillsBackTo: 'supports 256 concurrent tenants',
        },
        {
          claimText: 'high-torque actuator rated duty cycle is 40 percent',
          subject: 'actuator',
          predicate: 'dutyCycle',
          object: '40percent',
          locator: 'sec:2',
          drillsBackTo: 'duty cycle is 40 percent',
        },
      ],
    },
    {
      id: 'distiller-external-feed',
      kind: 'external_feed',
      content:
        'photonics module warranty period updated to 36 months\nupstream gateway default retry budget set to 5',
      claims: [
        {
          claimText: 'photonics module warranty period is 36 months',
          subject: 'photonics-module',
          predicate: 'warrantyPeriod',
          object: '36months',
          locator: 'item:1',
          drillsBackTo: 'warranty period updated to 36 months',
        },
        {
          claimText: 'upstream gateway default retry budget is 5',
          subject: 'upstream-gateway',
          predicate: 'retryBudget',
          object: '5',
          locator: 'item:2',
          drillsBackTo: 'retry budget set to 5',
        },
      ],
    },
    {
      id: 'distiller-formal-document',
      kind: 'formal_document', // image-bearing by default → VLM page/line anchors
      content:
        'Specification Sheet\nmax load is 200 kg\f Appendix A\ncalibration gas is argon-methane',
      claims: [
        {
          claimText: 'max load is 200 kg',
          subject: 'assembly',
          predicate: 'maxLoad',
          object: '200kg',
          locator: 'p1:L2',
          drillsBackTo: 'max load is 200 kg',
        },
        {
          claimText: 'calibration gas is argon-methane',
          subject: 'analyzer',
          predicate: 'calibrationGas',
          object: 'argon-methane',
          locator: 'p2:L2',
          drillsBackTo: 'calibration gas is argon-methane',
        },
      ],
    },
  ].map((it) => Object.freeze(it)),
)

/** golden 里原子事实总数（分母）。 */
export function distillerGoldenClaimTotal(
  items: readonly DistillerGoldenItem[] = DISTILLER_GOLDEN,
): number {
  return items.reduce((n, it) => n + it.claims.length, 0)
}
