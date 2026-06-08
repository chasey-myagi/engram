/**
 * M2 接地校准语料 —— **客观真值已知**的事实集,用于在真 Qwen 嵌入 + 真 usage 回路上验校准映射(g)拟合闭环。
 *
 * 设计(透明、可复现、零随机):
 *  - 事实来自真实世界小表(首都/元素/天文/地理),每个 subject **只出现一次**(避免同 subject 矛盾对污染召回)。
 *    isTrue=true ⇒ statement 用真值;isTrue=false ⇒ object 换成同族另一个值(客观错误,如「澳大利亚首都是悉尼」)。
 *  - 事实分到 5 个**离散置信档**(level),**每档很多条**(~20)、共享同一 rawTarget ⇒ 每档有可测的「正确率」。
 *    **为什么离散档而非每条唯一 raw**:校准的单元是「档(置信水平)」——要在某档上学到 P(correct|档),该档就得有
 *    多条事实凑出一个比率;按 fact 切分时,留出的是该档的**别的**事实,g 用该档**训练事实**学到的比率去预测留出事实
 *    ⇒ 真泛化。若每条 fact 唯一 raw,则每档只 1 条、比率退化成 0/1,isotonic 只能背个体标签、不泛化(这是上一版的坑)。
 *  - **为什么直接给 rawTarget 而非靠 provenance 算**:新鲜、仅有出处的 claim 的 raw 天然窄且低(entailment/humanReview/
 *    usageCorrect 因子对未核验/未使用的 claim=0,raw 封顶 ~0.5)——真实 raw 跨度来自 claim **成熟度**(累积核验/使用/人审)。
 *    本 pilot 直接把因子设到 rawTarget = 模拟不同成熟度 claim 的横截面,好让 reliability diagram 有跨度。
 *    召回/使用/拟合/ECE **全是真的**,只有"成熟度"是模拟的。**M2 验的是命门的校准映射(g)半边,不测 raw 七因子计算半边**
 *    (后者在 core 的 confidence 单测里验)。
 *  - **故意注入「现实式过自信」**:各档真值率 P(correct) 单调升(raw 越高越可能对 ⇒ raw 有信息量),但**每档都低于该档
 *    rawTarget**(高档高估约 18 个百分点)。于是 identity-g 的 ECE 偏高,isotonic g 应学到单调下压、ECE 降。
 *  - **这是受控实验**:真值与档由本文件按透明过程独立赋予,验的是「g 拟合闭环在真嵌入+真 usage 上闭合 + 在**真·样本外
 *    事实**上把 ECE 压下来」,**不是**真实世界 ECE 数字(那要 M3:真实未受控语料 + 真 QA 数据集 + 真 claim 成熟度)。
 */

export interface CorpusFact {
  id: string
  subject: string
  predicate: string
  object: string
  statement: string
  query: string
  isTrue: boolean
  /** 置信档号(0..LEVELS-1)。同档共享 rawTarget。 */
  level: number
  /** 目标置信(seed 时把 5 因子都设到它 ⇒ raw=rawTarget)。 */
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
  ['Spain', 'Madrid'],
  ['Italy', 'Rome'],
  ['Germany', 'Berlin'],
  ['Russia', 'Moscow'],
  ['India', 'New Delhi'],
  ['China', 'Beijing'],
  ['Mexico', 'Mexico City'],
  ['Colombia', 'Bogotá'],
  ['Denmark', 'Copenhagen'],
  ['Belgium', 'Brussels'],
  ['Netherlands', 'Amsterdam'],
  ['Romania', 'Bucharest'],
  ['Czechia', 'Prague'],
  ['Iran', 'Tehran'],
  ['Iraq', 'Baghdad'],
  ['Saudi Arabia', 'Riyadh'],
  ['Cambodia', 'Phnom Penh'],
  ['Bolivia', 'Sucre'],
  ['Ethiopia', 'Addis Ababa'],
  ['Ghana', 'Accra'],
  ['Cameroon', 'Yaoundé'],
  ['Bulgaria', 'Sofia'],
  ['Croatia', 'Zagreb'],
  ['Serbia', 'Belgrade'],
  ['Lebanon', 'Beirut'],
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
  ['Magnesium', '12'],
  ['Silicon', '14'],
  ['Phosphorus', '15'],
  ['Argon', '18'],
  ['Nickel', '28'],
  ['Bromine', '35'],
  ['Iodine', '53'],
  ['Platinum', '78'],
  ['Mercury', '80'],
  ['Lithium', '3'],
]
const MISC: [string, string, string][] = [
  ['The Pacific Ocean', 'is the largest ocean on', 'Earth'],
  ['Mount Everest', 'is the tallest mountain above sea level on', 'Earth'],
  ['The Sahara', 'is the largest hot desert on', 'Earth'],
  ['Jupiter', 'is the largest planet in', 'the Solar System'],
  ['Mercury', 'is the closest planet to', 'the Sun'],
  ['The Amazon', 'is the largest rainforest on', 'Earth'],
  ['Antarctica', 'is the coldest continent on', 'Earth'],
  ['Water', 'is composed of hydrogen and', 'oxygen'],
  ['Diamond', 'is a crystalline form of', 'carbon'],
  ['The speed of light', 'is faster than the speed of', 'sound'],
  ['Venus', 'is the hottest planet in', 'the Solar System'],
  ['The Dead Sea', 'is the lowest land elevation on', 'Earth'],
  ['Photosynthesis', 'produces', 'oxygen'],
  ['Saturn', 'is best known for its', 'rings'],
  ['The Vatican', 'is the smallest country on', 'Earth'],
]

/** 5 个离散置信档 [rawTarget, 真值率]。真值率单调升但每档低于 rawTarget(过自信,缺口随 raw 增大)。三档都 ≥ 消费门、可召回。 */
const LEVELS: { raw: number; trueRate: number }[] = [
  { raw: 0.5, trueRate: 0.46 },
  { raw: 0.6, trueRate: 0.5 },
  { raw: 0.7, trueRate: 0.55 },
  { raw: 0.8, trueRate: 0.6 },
  { raw: 0.88, trueRate: 0.66 },
]

export const NUM_LEVELS = LEVELS.length

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/^the\s+/, '')
    .trim()
}

/** 从同族 object 列表挑一个与真值**确实不同**(归一化后)的 alt:从 i+off 起扫,跳过等价的,杜绝「假事实其实是真的」。 */
function altAt(values: string[], i: number, off: number, trueObject: string): string {
  const t = norm(trueObject)
  for (let k = 0; k < values.length; k++) {
    const v = values[(i + off + k) % values.length]!
    if (norm(v) !== t) return v
  }
  return trueObject // 不可达(每族 ≥2 个不同 object)
}

/**
 * 确定性构建语料:三族真值表摊平 → 轮转分到 5 档 → 每档按其真值率(确定性、非随机:前 ⌈rate·n⌉ 条为 true)赋 isTrue。
 * 产物:每个 subject 唯一、真假客观、**每档很多条共享 rawTarget**(可测比率)、各档过自信单调。
 */
export function buildCorpus(): CorpusFact[] {
  const capVals = CAPITALS.map((c) => c[1])
  const elemVals = ELEMENTS.map((e) => e[1])
  const miscVals = MISC.map((m) => m[2])
  const triples: [string, string, string, string][] = []
  for (let i = 0; i < CAPITALS.length; i++) {
    const [country, capital] = CAPITALS[i]!
    triples.push([`The capital of ${country}`, 'is', capital, altAt(capVals, i, 7, capital)])
  }
  for (let i = 0; i < ELEMENTS.length; i++) {
    const [el, z] = ELEMENTS[i]!
    triples.push([`The atomic number of ${el}`, 'is', z, altAt(elemVals, i, 5, z)])
  }
  for (let i = 0; i < MISC.length; i++) {
    const [s, p, o] = MISC[i]!
    triples.push([s, p, o, altAt(miscVals, i, 3, o)])
  }

  // 轮转分档(每档拿到一批 index)。
  const byLevel: number[][] = Array.from({ length: NUM_LEVELS }, () => [])
  triples.forEach((_t, i) => byLevel[i % NUM_LEVELS]!.push(i))

  const facts: CorpusFact[] = []
  for (let level = 0; level < NUM_LEVELS; level++) {
    const idxs = byLevel[level]!
    const nTrue = Math.round(LEVELS[level]!.trueRate * idxs.length)
    idxs.forEach((i, k) => {
      const [subject, predicate, trueObject, altObject] = triples[i]!
      const isTrue = k < nTrue
      const object = isTrue ? trueObject : altObject
      facts.push({
        id: `cf-${i}`,
        subject,
        predicate,
        object,
        statement: `${subject} ${predicate} ${object}`,
        query: `${subject} ${predicate} what`,
        isTrue,
        level,
        rawTarget: LEVELS[level]!.raw,
      })
    })
  }
  return facts
}
