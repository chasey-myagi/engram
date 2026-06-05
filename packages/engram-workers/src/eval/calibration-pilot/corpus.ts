/**
 * M2 接地校准语料 —— **客观真值已知**的事实集,用于在真 Qwen 嵌入 + 真 usage 回路上验校准闭环。
 *
 * 设计(透明、可复现、零随机):
 *  - 事实来自真实世界小表(首都/元素/天文/地理),每个 subject **只出现一次**(避免同 subject 矛盾对污染召回)。
 *    isTrue=true ⇒ statement 用真值;isTrue=false ⇒ object 换成同表另一个值(客观错误,如「澳大利亚首都是悉尼」)。
 *  - 每个事实带一个 **rawTarget**(目标置信),分布在 3 档(strong/mid/weak)+ 档内确定性抖动 ⇒ raw 横跨 ~[0.45,0.9]。
 *    **为什么直接给 rawTarget 而非靠 provenance 算**:新鲜、仅有出处的 claim 的 raw 天然窄且低(entailment/humanReview/
 *    usageCorrect 因子对未经核验/使用的 claim = 0,raw 封顶 ~0.5)——真实的 raw 跨度来自 claim **成熟度**(累积的核验/
 *    使用/人审)。本 pilot 直接把因子设到 rawTarget = **模拟不同成熟度 claim 的静态横截面**,好让 reliability diagram
 *    有跨度、能看出真曲线。召回/使用/拟合/ECE **全是真的**,只有"成熟度"是模拟的。
 *  - **故意注入「现实式过自信」**:各档真值率 P(correct) 单调升(raw 越高越可能对 ⇒ raw 有信息量),但**每档都低于该档
 *    rawTarget**(强档高估约 14 个百分点)。于是 identity-g 的 ECE 偏高,isotonic g 应学到单调下压、ECE 降。
 *  - **这是受控实验**:真值与 rawTarget 由本文件按透明过程独立赋予,验的是「校准闭环在真嵌入+真 usage 上闭合、g 真把
 *    ECE 压下来」,**不是**真实世界 ECE 数字(那要 M3 真实未受控语料 + 真 QA 数据集 + 真 claim 成熟度)。
 */

export type ProvTier = 'strong' | 'mid' | 'weak'

export interface CorpusFact {
  id: string
  subject: string
  predicate: string
  object: string
  statement: string
  query: string
  isTrue: boolean
  tier: ProvTier
  /** 目标置信(seed 时把 5 因子都设到它 ⇒ raw=rawTarget;模拟该 claim 的成熟度横截面)。 */
  rawTarget: number
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
  ['Finland', 'Helsinki'],
  ['Poland', 'Warsaw'],
  ['Cuba', 'Havana'],
  ['Iceland', 'Reykjavik'],
  ['Nigeria', 'Abuja'],
  ['Argentina', 'Buenos Aires'],
  ['Switzerland', 'Bern'],
  ['Indonesia', 'Jakarta'],
  ['Pakistan', 'Islamabad'],
  ['Ukraine', 'Kyiv'],
]
const ELEMENTS: [string, string][] = [
  ['Hydrogen', '1'],
  ['Helium', '2'],
  ['Carbon', '6'],
  ['Oxygen', '8'],
  ['Sodium', '11'],
  ['Aluminium', '13'],
  ['Iron', '26'],
  ['Copper', '29'],
  ['Silver', '47'],
  ['Gold', '79'],
  ['Neon', '10'],
  ['Calcium', '20'],
  ['Zinc', '30'],
  ['Lead', '82'],
  ['Uranium', '92'],
  ['Nitrogen', '7'],
  ['Sulfur', '16'],
  ['Chlorine', '17'],
  ['Potassium', '19'],
  ['Tin', '50'],
]
const MISC: [string, string, string][] = [
  ['The Pacific Ocean', 'is the largest ocean on', 'Earth'],
  ['Mount Everest', 'is the tallest mountain on', 'Earth'],
  ['The Sahara', 'is the largest hot desert on', 'Earth'],
  ['The Nile', 'is among the longest rivers on', 'Earth'],
  ['Jupiter', 'is the largest planet in', 'the Solar System'],
  ['Mercury', 'is the closest planet to', 'the Sun'],
  ['The Amazon', 'is the largest rainforest on', 'Earth'],
  ['Antarctica', 'is the coldest continent on', 'Earth'],
  ['Light', 'travels faster than', 'sound'],
  ['Water', 'is composed of hydrogen and', 'oxygen'],
  ['The heart', 'pumps blood through', 'the body'],
  ['Photosynthesis', 'occurs in', 'plants'],
  ['The Moon', 'orbits', 'the Earth'],
  ['Diamond', 'is a crystalline form of', 'carbon'],
  ['Bees', 'produce', 'honey'],
]

/** 各档 [真值率 P(correct), rawTarget 基准]。真值率单调升但低于 rawBase(过自信),三档都 ≥ 消费门(可召回)。 */
const TIER_PLAN: Record<ProvTier, { trueRate: number; rawBase: number }> = {
  strong: { trueRate: 0.68, rawBase: 0.82 },
  mid: { trueRate: 0.55, rawBase: 0.64 },
  weak: { trueRate: 0.45, rawBase: 0.5 },
}

const TIERS: ProvTier[] = ['strong', 'mid', 'weak']

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/** 确定性抖动 ∈ [-0.05, 0.05](由 index 派生,无随机),让档内 raw 也有跨度 ⇒ reliability diagram 更连续。 */
function jitter(i: number): number {
  return ((((i * 1103515245 + 12345) >>> 0) % 101) - 50) / 1000
}

function makeFact(
  i: number,
  subject: string,
  predicate: string,
  trueObject: string,
  altObject: string,
  isTrue: boolean,
  tier: ProvTier,
): CorpusFact {
  const object = isTrue ? trueObject : altObject
  return {
    id: `cf-${i}`,
    subject,
    predicate,
    object,
    statement: `${subject} ${predicate} ${object}`,
    query: `${subject} ${predicate} what`,
    isTrue,
    tier,
    rawTarget: clamp(TIER_PLAN[tier].rawBase + jitter(i), 0.42, 0.92),
  }
}

/** 确定性构建语料:三族真值表摊平 → 轮转分档 → 按各档真值率(确定性、非随机)赋 isTrue。 */
export function buildCorpus(): CorpusFact[] {
  const triples: [string, string, string, string][] = []
  for (let i = 0; i < CAPITALS.length; i++) {
    const [country, capital] = CAPITALS[i]!
    triples.push([
      `The capital of ${country}`,
      'is',
      capital,
      CAPITALS[(i + 7) % CAPITALS.length]![1],
    ])
  }
  for (let i = 0; i < ELEMENTS.length; i++) {
    const [el, z] = ELEMENTS[i]!
    triples.push([`The atomic number of ${el}`, 'is', z, ELEMENTS[(i + 5) % ELEMENTS.length]![1]])
  }
  for (let i = 0; i < MISC.length; i++) {
    const [s, p, o] = MISC[i]!
    triples.push([s, p, o, MISC[(i + 3) % MISC.length]![2]])
  }

  const byTier: Record<ProvTier, number[]> = { strong: [], mid: [], weak: [] }
  triples.forEach((_t, i) => byTier[TIERS[i % 3]!]!.push(i))

  const facts: CorpusFact[] = []
  for (const tier of TIERS) {
    const idxs = byTier[tier]!
    const nTrue = Math.round(TIER_PLAN[tier].trueRate * idxs.length)
    idxs.forEach((i, k) => {
      const [subject, predicate, trueObject, altObject] = triples[i]!
      facts.push(makeFact(i, subject, predicate, trueObject, altObject, k < nTrue, tier))
    })
  }
  return facts
}
