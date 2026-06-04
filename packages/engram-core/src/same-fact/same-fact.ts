/**
 * 「同一事实」引擎（A.6 lineage 两阶段判同）—— 工种依赖的去重/合并/冲突地基。
 *
 * ① 召候选（stage 1）：claim_text 嵌入近邻 top-k=50 且相似度 ≥0.75，并 subjectKey 串联（同 subject 也拉进来）。
 * ② 判同（stage 2）：先跑确定性规则
 *      subject≡ ∧ predicate≡ ∧ object 数值等价(单位归一) → same（共 lineage_id，合并）
 *      subject≡ ∧ predicate≡ ∧ object 不等价              → contradicts（object 反向）
 *      subject≡ ∧ object 等价 ∧ predicate≠              → refines（谓词细化）
 *    三规则都不中且相似度 ≥0.65 → 灰区**一次** LLM 判 {same|refines|contradicts|unrelated}。
 * 模型无关：LLM 经 SameFactJudge 注入，测试走确定性 fake，生产真 impl env-gated（不进 CI）。
 */

/** 灰区判定四态（确定性规则 + LLM 共用）。 */
export type SameFactVerdict = 'same' | 'refines' | 'contradicts' | 'unrelated'

/** same-fact 判定看的 claim 结构面（三元 + 文本）。 */
export interface ClaimShape {
  subject: string | null
  predicate: string | null
  object: string | null
  claimText: string
}

/** 灰区 LLM 判官（模型无关）。judge(a,b) 在确定性规则不中、相似度≥0.65 时被调用恰一次。 */
export interface SameFactJudge {
  readonly version: string
  judge(a: ClaimShape, b: ClaimShape): Promise<SameFactVerdict>
}

/** stage 1 候选召回的相似度下界（A.6）。 */
export const SAME_FACT_CANDIDATE_SIMILARITY = 0.75
/** stage 1 近邻 top-k（A.6）。 */
export const SAME_FACT_TOPK = 50
/** stage 2 灰区 LLM 触发的相似度下界（A.6）：规则不中且相似度≥此值才花一次 LLM。 */
export const SAME_FACT_GRAY_ZONE_SIMILARITY = 0.65

/** 量纲单位换算到各自基准单位的因子（A.6 单位归一）。可扩展。 */
const UNIT_FACTOR: Record<string, { dim: string; factor: number }> = {
  // 长度（基准 m）
  m: { dim: 'len', factor: 1 },
  cm: { dim: 'len', factor: 0.01 },
  mm: { dim: 'len', factor: 0.001 },
  km: { dim: 'len', factor: 1000 },
  // 质量（基准 kg）
  kg: { dim: 'mass', factor: 1 },
  g: { dim: 'mass', factor: 0.001 },
  mg: { dim: 'mass', factor: 0.000001 },
  t: { dim: 'mass', factor: 1000 },
  // 时间（基准 s）
  s: { dim: 'time', factor: 1 },
  ms: { dim: 'time', factor: 0.001 },
  min: { dim: 'time', factor: 60 },
  h: { dim: 'time', factor: 3600 },
}

function parseQuantity(s: string): { value: number; unit: string } | null {
  const m = /^(-?\d*\.?\d+)\s*([a-zA-Zµ]*)$/.exec(s.trim())
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value)) return null
  return { value, unit: m[2]!.toLowerCase() }
}

function approxEqual(x: number, y: number): boolean {
  return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))
}

/**
 * object 等价判定（A.6）：归一化字符串相等，或数值/单位归一后相等（'1m' ≡ '100cm'，'5' ≡ '5.0'）。
 * 不同量纲 / 不可解析 → 退回大小写无关的精确字符串比较。
 */
export function objectEquivalent(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true
  const qa = parseQuantity(a)
  const qb = parseQuantity(b)
  if (!qa || !qb) return false
  if (qa.unit === '' && qb.unit === '') return approxEqual(qa.value, qb.value) // 纯数值
  const ua = UNIT_FACTOR[qa.unit]
  const ub = UNIT_FACTOR[qb.unit]
  if (!ua || !ub || ua.dim !== ub.dim) return false // 未知单位 / 跨量纲 → 不等价
  return approxEqual(qa.value * ua.factor, qb.value * ub.factor)
}

/**
 * 确定性判同规则（stage 2 第一关）。命中返回 same/contradicts/refines；不命中返回 null（交灰区 LLM）。
 * 需要 subject 齐全且相等才可能命中（无结构三元的自由文本一律 null → 灰区）。
 */
export function deterministicVerdict(a: ClaimShape, b: ClaimShape): SameFactVerdict | null {
  if (a.subject == null || b.subject == null || a.subject !== b.subject) return null
  const predicateEq = a.predicate != null && b.predicate != null && a.predicate === b.predicate
  const objectEq = a.object != null && b.object != null && objectEquivalent(a.object, b.object)
  if (predicateEq) {
    // 同 subject 同 predicate：object 等价→同一；不等价→矛盾（object 反向，S8 规则的单位归一版）。
    return objectEq ? 'same' : 'contradicts'
  }
  if (objectEq && a.predicate !== b.predicate) {
    // 同 subject 同 object、谓词不同 → 细化（同一对象的不同/更细谓词面）。
    return 'refines'
  }
  return null
}

/**
 * stage 2 判同：先确定性规则，不中且相似度≥0.65 才花**一次** LLM（灰区）；相似度<0.65 直接判 unrelated（不调 LLM）。
 */
export async function adjudicate(
  a: ClaimShape,
  b: ClaimShape,
  similarity: number,
  judge: SameFactJudge,
): Promise<SameFactVerdict> {
  const rule = deterministicVerdict(a, b)
  if (rule !== null) return rule
  if (similarity >= SAME_FACT_GRAY_ZONE_SIMILARITY) return judge.judge(a, b)
  return 'unrelated'
}
