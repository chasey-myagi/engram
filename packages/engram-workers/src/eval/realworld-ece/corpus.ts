/**
 * M3-A(lean)真实世界校准语料 —— 客观真值已知的「源文档」,喂**真 Qwen Distiller** 抽取(raw emergent、非 hard-set)。
 *
 * 与 M2 的本质区别:
 *  - M2:直接 seed claim、hard-set raw、预设各档真值率(受控)。
 *  - M3:每条 fact 是一份**源文档**(陈述句,真/假客观);真 Distiller 读它、抽 claim,claim 的 raw 由**真因子流水线**
 *    从 provenance 算出(emergent)。正确率由 oracle 客观判(correct = 源文档真假),**不预设 raw↔真值关系**——M3 就是要
 *    *发现* emergent 置信到底准不准。
 *
 * raw 跨度:用**真实通道**(源 authorityScore,0.6–1.0,**与真假无关**)给 emergent raw 一点变化,不 hard-set raw。
 * **诚实预期(lean)**:新鲜、仅有出处的 claim raw 天然又低又窄(entailment/usage/humanReview 因子=0,封顶 ~0.5),
 * 故结果很可能是窄带、低信号——大概率实证「光抽取的 emergent 置信对真假近乎无区分,需核验/使用才校准」。要真曲线得上全闭环。
 */

export interface RealWorldFact {
  id: string
  subject: string
  predicate: string
  /** 源文档文本(claim_text 的来源;true 用真值 object、false 用同族另一个值)。 */
  docText: string
  /** 召回查询(语义同指、措辞不同)。 */
  query: string
  /** 客观真值(源文档陈述与真实世界是否一致)。oracle 据此判 adopted/refuted。 */
  isTrue: boolean
  /** 源 authorityScore(0.6–1.0,确定性、**与 isTrue 无关**):真实通道给 emergent raw 一点跨度。 */
  sourceAuthority: number
}

const CAPITALS: [string, string][] = [
  ['France', 'Paris'],
  ['Japan', 'Tokyo'],
  ['Australia', 'Canberra'],
  ['Canada', 'Ottawa'],
  ['Brazil', 'Brasília'],
  ['Egypt', 'Cairo'],
  ['Norway', 'Oslo'],
  ['Kenya', 'Nairobi'],
  ['Peru', 'Lima'],
  ['Greece', 'Athens'],
  ['Turkey', 'Ankara'],
  ['Thailand', 'Bangkok'],
  ['Portugal', 'Lisbon'],
  ['Sweden', 'Stockholm'],
  ['Austria', 'Vienna'],
  ['Ireland', 'Dublin'],
  ['Morocco', 'Rabat'],
  ['Vietnam', 'Hanoi'],
  ['Chile', 'Santiago'],
  ['Hungary', 'Budapest'],
]
const ELEMENTS: [string, string][] = [
  ['Hydrogen', '1'],
  ['Helium', '2'],
  ['Carbon', '6'],
  ['Oxygen', '8'],
  ['Sodium', '11'],
  ['Iron', '26'],
  ['Copper', '29'],
  ['Silver', '47'],
  ['Gold', '79'],
  ['Neon', '10'],
  ['Calcium', '20'],
  ['Zinc', '30'],
  ['Lead', '82'],
  ['Nitrogen', '7'],
  ['Sulfur', '16'],
  ['Potassium', '19'],
]

function norm(s: string): string {
  return s.toLowerCase().trim()
}
function altAt(values: string[], i: number, off: number, trueObject: string): string {
  const t = norm(trueObject)
  for (let k = 0; k < values.length; k++) {
    const v = values[(i + off + k) % values.length]!
    if (norm(v) !== t) return v
  }
  return trueObject
}

/**
 * 确定性构建:首都 + 元素两族真值表 → 每条造一份源文档。isTrue 按 index 奇偶 ~50/50(与 authority 无关);
 * sourceAuthority 按 index 在 0.6–1.0 间确定性铺开(与 isTrue 无关)。无随机。
 */
export function buildRealWorldCorpus(): RealWorldFact[] {
  const capVals = CAPITALS.map((c) => c[1])
  const elemVals = ELEMENTS.map((e) => e[1])
  const rows: { subject: string; predicate: string; trueObject: string; alt: string }[] = []
  CAPITALS.forEach(([country, capital], i) => {
    rows.push({
      subject: `The capital of ${country}`,
      predicate: 'is',
      trueObject: capital,
      alt: altAt(capVals, i, 7, capital),
    })
  })
  ELEMENTS.forEach(([el, z], i) => {
    rows.push({
      subject: `The atomic number of ${el}`,
      predicate: 'is',
      trueObject: z,
      alt: altAt(elemVals, i, 5, z),
    })
  })

  const n = rows.length
  return rows.map((r, i) => {
    const isTrue = i % 2 === 0
    const object = isTrue ? r.trueObject : r.alt
    // authority 在 [0.6, 1.0] 确定性铺开(与 isTrue 解耦:用 (i*7)%n 打散,避免与奇偶 isTrue 同相)。
    const sourceAuthority = 0.6 + (((i * 7) % n) / (n - 1)) * 0.4
    return {
      id: `rw-${i}`,
      subject: r.subject,
      predicate: r.predicate,
      docText: `${r.subject} ${r.predicate} ${object}.`,
      query: `${r.subject} ${r.predicate} what`,
      isTrue,
      sourceAuthority: Math.round(sourceAuthority * 100) / 100,
    }
  })
}
