/**
 * L1 Arbiter golden runner（A.9）—— 对每个 golden 冲突对跑真 Arbiter，验「裁决正确性 + 顺序一致」。
 *
 * 验真而非 smoke：
 *   ① 跑真 runArbiter（真 loadConflictSide 现拍 + 真 adjudicateConflict 纯阶梯 + 真 resolveConflict/escalateConflict
 *      落库）。fake model 只逐对调 adjudicate_conflict 工具，**绝不替阶梯选边**——胜者全由确定性阶梯算定。
 *   ② 正确性：读回 resolved/escalated，把胜者 claimId 映射回 'a'/'b' ref，比对人工标签的 expectWinner + expectRung。
 *   ③ 顺序一致（A.9 核心）：同一形状的冲突 seed 两次，一次按 (a,b)、一次按 (b,a) 入参且 loop 反序处理；
 *      断言两次的**胜方 ref + rung 完全一致**。若胜负被挪进 LLM / 阶梯次序写反，两次结果会分叉 → orderConsistent=false。
 *
 * 故任何「让顺序/入参影响裁决」的退化都把 orderConsistent 拉到 false、把 accuracy 拉下阈 → 红。
 */
import { runArbiter } from '../arbiter.js'
import { ARBITER_GOLDEN, type ArbiterGoldenItem } from './l1-arbiter.golden.js'

/** 一次 runArbiter 的最小结果投影（胜方 ref / 是否升级 / rung）。 */
export interface ArbiterRunObservation {
  /** 机判胜者映射回的 ref（'a'/'b'）；升级则 null。 */
  winnerRef: 'a' | 'b' | null
  /** 是否升级主编（并列/不可机判）。 */
  escalated: boolean
  /** 定胜负的阶（resolved=②③④⑤；escalate='human'）。 */
  rung: string | null
}

export interface ArbiterClaimObservation {
  id: string
  /** 正向 (a,b) 入参 + loop 正序的一次观测。 */
  forward: ArbiterRunObservation
  /** 反向 (b,a) 入参 + loop 反序的一次观测（顺序一致性对照）。 */
  reverse: ArbiterRunObservation
  /** 裁决与人工标签一致（胜方 ref + rung）。 */
  correct: boolean
  /** 正反两次的胜方 ref + rung 完全一致（顺序无关）。 */
  orderConsistent: boolean
}

export interface ArbiterGoldenReport {
  total: number
  correctCount: number
  /** 裁决正确率（胜方 + rung 对齐人工标签）∈[0,1]（A.9 判据 = 1）。 */
  accuracy: number
  /** 顺序一致的对数（正反两次同胜方同 rung）。 */
  orderConsistentCount: number
  /** 顺序一致率 ∈[0,1]（A.9 判据 = 1，adjudication-order consistency）。 */
  orderConsistency: number
  observations: ArbiterClaimObservation[]
}

/** seed 一对冲突（按给定 ref→side 映射），返回两侧 claimId + ref 反查表。 */
export interface SeededConflict {
  aId: string
  bId: string
  /** claimId → 'a'/'b' ref（把读回的胜者映射回标签空间）。 */
  refOf: (claimId: string) => 'a' | 'b' | null
}

export interface ArbiterGoldenDeps {
  resetDb: () => Promise<void>
  /**
   * seed 一个 golden 冲突对到 per-test DB：两侧 active、recallable、同文本（recall 双返）+ 一条 contradicts 边，
   * 按 side 设 asOf/authority/extraIndepSources，按 aSupersedesB/bSupersedesA 设 supersedes 边。返回两侧 id + ref 反查。
   */
  seedConflict: (item: ArbiterGoldenItem) => Promise<SeededConflict>
  /** 跑真 runArbiter，限定本对、按给定入参顺序逐对处理（fake model 不选边）。 */
  arbitrateWith: (pair: [string, string]) => ReturnType<typeof runArbiter>
  /** 读机判自裁标记（winner/loser/rung）。 */
  resolvedWinner: () => Promise<{ winnerId: string; rung: string } | null>
  /** 读主编队列是否有本对的升级标记 + rung。 */
  escalation: () => Promise<{ rung: string } | null>
}

/** 跑一次：seed 形状 → arbitrate(入参顺序) → 读回胜者/升级，映射回 ref。 */
async function runOnce(
  deps: ArbiterGoldenDeps,
  item: ArbiterGoldenItem,
  order: 'forward' | 'reverse',
): Promise<ArbiterRunObservation> {
  await deps.resetDb()
  const seeded = await deps.seedConflict(item)
  const pair: [string, string] =
    order === 'forward' ? [seeded.aId, seeded.bId] : [seeded.bId, seeded.aId]
  await deps.arbitrateWith(pair)

  const resolved = await deps.resolvedWinner()
  if (resolved) {
    return { winnerRef: seeded.refOf(resolved.winnerId), escalated: false, rung: resolved.rung }
  }
  const esc = await deps.escalation()
  if (esc) {
    return { winnerRef: null, escalated: true, rung: esc.rung }
  }
  return { winnerRef: null, escalated: false, rung: null }
}

/**
 * 跑整套 Arbiter golden：每对各跑两次（正向 (a,b) / 反向 (b,a)），算裁决正确率 + 顺序一致率。
 */
export async function runArbiterGolden(
  deps: ArbiterGoldenDeps,
  items: readonly ArbiterGoldenItem[] = ARBITER_GOLDEN,
): Promise<ArbiterGoldenReport> {
  const observations: ArbiterClaimObservation[] = []
  for (const item of items) {
    const forward = await runOnce(deps, item, 'forward')
    const reverse = await runOnce(deps, item, 'reverse')

    const labelOk = (o: ArbiterRunObservation): boolean => {
      if (item.expectWinner === 'escalate') {
        return o.escalated && !o.winnerRef && o.rung === item.expectRung
      }
      return !o.escalated && o.winnerRef === item.expectWinner && o.rung === item.expectRung
    }
    // 正确性以正向为准（反向只为顺序一致），但两者都必须对得上标签才算 correct（防一向对一向错）。
    const correct = labelOk(forward) && labelOk(reverse)
    const orderConsistent =
      forward.winnerRef === reverse.winnerRef &&
      forward.escalated === reverse.escalated &&
      forward.rung === reverse.rung

    observations.push({ id: item.id, forward, reverse, correct, orderConsistent })
  }

  const total = observations.length
  const correctCount = observations.filter((o) => o.correct).length
  const orderConsistentCount = observations.filter((o) => o.orderConsistent).length
  return {
    total,
    correctCount,
    accuracy: total === 0 ? 0 : correctCount / total,
    orderConsistentCount,
    orderConsistency: total === 0 ? 0 : orderConsistentCount / total,
    observations,
  }
}
