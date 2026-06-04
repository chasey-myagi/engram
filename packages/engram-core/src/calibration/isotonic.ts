/**
 * Isotonic 校准拟合器（S28，命门 A.3 第 2 档「首次校准」）—— 把 S27 的 `CalibrationFitter` 端口落成
 * **确定性、单调** 的非参回归：PAVA（Pool-Adjacent-Violators，increasing=True）。
 *
 * 输入严格 = `{ rawPredicted, correct }`（S27 GoldenSample 边界，X=claim raw confidence、y=observed∈{0,1}）。
 * **A3 红线在此输入边界硬守**：拟合器只吃这两字段，结构上没有任何 ELO / 胜负率 / 排名通道——
 * 与 S5 computeReliability / S19 usage-correct 同源同口径。任何想把胜负率喂进 g 的尝试都缺字段、编译期就拦下。
 *
 * 算法（确定性、零随机、零时钟、零 LLM）：
 *   ① 按 X(=rawPredicted) 升序、平手按 y 升序稳定排序（同 X 的样本聚成一个初始 block，y 取该 X 的平均正确率）；
 *   ② PAVA：从左到右扫，若相邻 block 违反「非递减」（左均值 > 右均值）则**合并**（按样本数加权平均），
 *      回溯合并直到全局非递减——这给出在 [0,1]×[0,1] 上唯一的、最小二乘意义下的单调拟合（PAVA 的标准结论）；
 *   ③ 把每个 block 折成一个 knot：x=该 block 的 X 代表点（block 内样本 X 的均值，已夹到 [0,1]），y=block 的拟合均值。
 *      相邻 block 若 x 撞号（同一 raw 落进不同 block，理论上 PAVA 不会产生，纯防御）则取后者，保证 x 严格升序。
 *   ④ 收尾保证 ≥2 个**不同** knot（FIX 3 的门会拒退化常值 g）：单 block / 全同 X / 全同 y 时，
 *      在保持单调与 [0,1] 的前提下补一个端点 knot，使输出有非零 spread（见 ensureDistinctKnots）。
 *
 * 产出的 CalibrationMap 满足 assertCalibrationMap（x 严格升序、y 非递减、值域 [0,1]）；交给 advise→验收门→原子换。
 * **确定性**：同一组样本（顺序无关——内部稳定排序）恒产出逐字相同的 knots（单测断言 rerun 全等）。
 */
import {
  assertCalibrationMap,
  type CalibrationKnot,
  type CalibrationMap,
} from '../confidence/confidence.js'
import type { CalibrationFitter, GoldenSample } from './advisor.js'

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** PAVA 的一个 block：合并后的 (Σ(w·x), Σ(w·y), Σw) —— x/y 都按样本权 w 加权平均还原。 */
interface Block {
  sumWX: number
  sumWY: number
  /** 权和（= 该 block 覆盖的样本数；合并时累加，作加权平均的权）。 */
  w: number
}

function meanX(b: Block): number {
  return b.sumWX / b.w
}
function meanY(b: Block): number {
  return b.sumWY / b.w
}

/** 一个**已按 distinct x 聚合**的输入点（x 唯一、y=该 x 上样本的平均正确率、w=样本数）。 */
interface AggPoint {
  x: number
  y: number
  w: number
}

/**
 * ① 先按 distinct x 聚合：同一 raw 的所有样本折成一个点 (x, mean(y), count)。
 * 这保证「同 X → 同拟合值」（不会因把同 X 的 0/1 当独立点喂 PAVA 而退化成阶梯）。结果按 x 升序。
 */
function aggregateByX(samples: { x: number; y: number }[]): AggPoint[] {
  const byX = new Map<number, { sumY: number; n: number }>()
  for (const s of samples) {
    const cur = byX.get(s.x)
    if (cur) {
      cur.sumY += s.y
      cur.n += 1
    } else {
      byX.set(s.x, { sumY: s.y, n: 1 })
    }
  }
  return [...byX.entries()]
    .map(([x, { sumY, n }]) => ({ x, y: sumY / n, w: n }))
    .sort((a, b) => a.x - b.x)
}

/**
 * PAVA（pool-adjacent-violators，increasing）—— 纯函数核心。
 * 入参是**按 x 升序的聚合点**；返回非递减的 block 序列（每个 block 的加权 meanY 全局非递减）。
 */
function pava(points: AggPoint[]): Block[] {
  const stack: Block[] = []
  for (const p of points) {
    let cur: Block = { sumWX: p.w * p.x, sumWY: p.w * p.y, w: p.w }
    // 回溯合并：只要栈顶 block 的加权均值 > 当前 block 的加权均值（违反非递减）就合并，直到不违反。
    while (stack.length > 0 && meanY(stack[stack.length - 1]!) > meanY(cur)) {
      const top = stack.pop()!
      cur = { sumWX: top.sumWX + cur.sumWX, sumWY: top.sumWY + cur.sumWY, w: top.w + cur.w }
    }
    stack.push(cur)
  }
  return stack
}

/**
 * 把 block 序列折成升序 knots（x=block 内 X 均值、y=block 拟合均值）。
 * x 撞号（纯防御，PAVA 合并后理论不会同 x 落不同 block）取后者，保证 x 严格升序。
 */
function blocksToKnots(blocks: Block[]): CalibrationKnot[] {
  const knots: CalibrationKnot[] = []
  for (const b of blocks) {
    const x = clamp01(meanX(b))
    const y = clamp01(meanY(b))
    const prev = knots[knots.length - 1]
    if (prev && x <= prev.x) {
      // 同 x：保留 y 较大者（非递减），并把 x 留在 prev（不前进 x，避免破坏严格升序）。
      if (y > prev.y) prev.y = y
      continue
    }
    knots.push({ x, y })
  }
  return knots
}

/**
 * 收尾：保证 ≥2 个**不同** knot 且有非零输出 spread（否则 FIX 3 的验收门会拒退化常值 g）。
 * - knots 为空（无样本，理论上 ≥200 门已挡）→ 退回 identity 两端点。
 * - 单 knot（全同 X 或全合并成一个 block）→ 补一个端点，使 x 严格升序、y 仍非递减、值域 [0,1]。
 *   常值情形（所有样本同一 observed）刻意不强行制造 spread：那是数据真说「这一段就是常值」，
 *   该不该换 g 由验收门按 ΔECE + 距离判（FIX 3 只拒**单 knot/全程常值**这种**结构性退化**，不拒数据本身平坦）。
 */
function ensureDistinctKnots(knots: CalibrationKnot[]): CalibrationKnot[] {
  if (knots.length === 0) {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]
  }
  if (knots.length >= 2) return knots
  const only = knots[0]!
  // 单 knot：补另一端点形成两个不同 x 的 knot（y 取同值——是否退化由 FIX 3 验收门按 spread 拒）。
  // 靠左则补右端、否则补左端，保持 x 严格升序、y 非递减、值域 [0,1]。
  return only.x < 1 ? [only, { x: 1, y: only.y }] : [{ x: 0, y: only.y }, only]
}

/**
 * Isotonic 拟合：GoldenSample[] → 单调 CalibrationMap（PAVA）。确定性、纯函数。
 * version 由 caller 给（落库具名版本）。空样本 → identity 形状两端点（不应发生：≥200 门在 caller 侧先挡）。
 */
export function fitIsotonic(samples: GoldenSample[], version: string): CalibrationMap {
  // ① 按 distinct x 聚合（同 raw 折成一个点，y=平均正确率，w=样本数）——保证「同 X → 同拟合值」、顺序无关、确定。
  const points = aggregateByX(
    samples.map((s) => ({ x: clamp01(s.rawPredicted), y: s.correct ? 1 : 0 })),
  )
  // ② PAVA → 非递减 block；③ block → 升序非递减 knots；④ 保证 ≥2 不同 knot。
  const knots = ensureDistinctKnots(blocksToKnots(pava(points)))
  const map: CalibrationMap = { version, knots }
  // 兜底自检：产出必满足几何不变量（升序 / 非递减 / [0,1]），否则是算法 bug，宁可 fail-loud。
  assertCalibrationMap(map)
  return map
}

/**
 * 把 fitIsotonic 适配成 S27 的 `CalibrationFitter` 端口（注入到 Advisor / recalibrate 用）。
 * version 闭包进函数——同一个 fitter 总产出同一具名版本（caller 想换版本就再 make 一个）。
 */
export function makeIsotonicFitter(version: string): CalibrationFitter {
  return (samples: GoldenSample[]): CalibrationMap => fitIsotonic(samples, version)
}
