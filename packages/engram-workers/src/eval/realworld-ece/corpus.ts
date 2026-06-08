/**
 * M3-A 真实世界校准语料 —— 客观真值已知的「源文档」,喂**真 Qwen Distiller** 抽取(raw emergent、非 hard-set)。
 *
 * 两个 builder:
 *  - buildRealWorldCorpus(lean/floor 实证):单源、真假 50/50 与 authority 解耦 —— 用来证明「光抽取进不了可消费态」。
 *  - buildCorroboratedCorpus(Option C):多源印证 + 注入过自信 —— 让 claim 过 0.5 晋升门、落进可消费窄带,
 *    在真 recall/usage/g 上量出**真 ECE 曲线**。两者共用 buildRows() 的真值表。
 *
 * 与 M2 的本质区别:M2 直接 seed claim、hard-set raw;M3 每条 fact 是一份**源文档**,真 Distiller 读它抽 claim,
 * claim 的 raw 由**真因子流水线**从 provenance 算出(emergent)。正确率由 oracle 客观判(correct = 源文档真假)。
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
  ['Spain', 'Madrid'],
  ['Italy', 'Rome'],
  ['Germany', 'Berlin'],
  ['Poland', 'Warsaw'],
  ['Finland', 'Helsinki'],
  ['Denmark', 'Copenhagen'],
  ['Switzerland', 'Bern'],
  ['Netherlands', 'Amsterdam'],
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
  ['Magnesium', '12'],
  ['Aluminium', '13'],
  ['Silicon', '14'],
  ['Phosphorus', '15'],
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

interface FactRow {
  subject: string
  predicate: string
  trueObject: string
  /** 同族的另一个值(false 文档用它,保证 ≠ 真值)。 */
  alt: string
}

/** 确定性真值表:首都 + 元素两族 → 每条一行 {subject, predicate, trueObject, alt}。两 builder 共用。 */
function buildRows(): FactRow[] {
  const capVals = CAPITALS.map((c) => c[1])
  const elemVals = ELEMENTS.map((e) => e[1])
  const rows: FactRow[] = []
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
  return rows
}

/**
 * lean/floor 实证语料:每条造一份单源文档。isTrue 按 index 奇偶 ~50/50;sourceAuthority 在 0.6–1.0 确定性铺开
 * (与 isTrue 解耦,用 (i*7)%n 打散)。无随机。用来证明单源新鲜 claim 进不了可消费态(见 realworld-ece.test.ts)。
 */
export function buildRealWorldCorpus(): RealWorldFact[] {
  const rows = buildRows()
  const n = rows.length
  return rows.map((r, i) => {
    const isTrue = i % 2 === 0
    const object = isTrue ? r.trueObject : r.alt
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

// ───────────────────────── Option C：多源印证 + 注入过自信 ─────────────────────────

export interface CorroboratedFact {
  id: string
  subject: string
  predicate: string
  docText: string
  query: string
  isTrue: boolean
  /** 每源 authorityScore(按 tier 定,落在可消费窄带)。 */
  sourceAuthority: number
  /** 独立印证源总数 n(含 Distiller 抽取的那 1 条);indepSupport=1−0.5^(n−1)。 */
  corroborationCount: number
  /** tier 序号 0/1/2(置信由低到高)。 */
  tier: number
  /** 该 tier 注入的真值率(用于不变量断言;实际 isTrue 按此率在 tier 内均匀铺开)。 */
  tierTrueRate: number
  /**
   * 该 fact 预期 recall 置信(= 0.3·auth + 0.15·entail + 0.15·indep(n);humanReview/usage=0、staleDecay 钉 1)。
   * 注:写库时 entail 因子是中性 0.5,recall 时由 patrol pass **实时覆盖到 1.0**(见 harness addCorroboration 注释),
   * 故此处按 entail=1.0 计入 0.15。权重取内核默认(0.3/0.15/0.15);corroborated-ece.test.ts ② 断言此值 = 真实 recall
   * 置信集合,内核 DEFAULT_WEIGHTS 一旦漂移即**大声失败**(语料滑出可消费窄带而非静默失真)。
   */
  expectedConfidence: number
}

/** 每源 n 条独立印证。n=4 ⇒ indepSupport=0.875 ⇒ 即便最低 tier authority 也过 0.5 门(配 Verifier entail pass)。 */
const CORROBORATION_COUNT = 4
const TIER_SIZE = 16

/**
 * 三 tier(各 16 条):authority 由低到高,预期 recall 置信落可消费窄带 [~0.52, ~0.58];每 tier 注入**过自信**
 * (真值率 < 置信)、且**单调**(置信越高真值率越高)。g 该学到这条单调修正、在留出事实上把 ECE 压下。
 * authority 跨 tier 拉开(0.80/0.89/0.98)使三档置信清晰可分(≫ 任何数值噪声)——窄带里能放下的最多就是这么几档。
 */
const TIERS: { authority: number; trueCount: number }[] = [
  { authority: 0.8, trueCount: 4 }, // 预期置信≈0.521,真值率 4/16=0.250 ⇒ 过自信≈0.27
  { authority: 0.89, trueCount: 6 }, // 预期置信≈0.548,真值率 6/16=0.375 ⇒ 过自信≈0.17
  { authority: 0.98, trueCount: 8 }, // 预期置信≈0.575,真值率 8/16=0.500 ⇒ 过自信≈0.075
]

function indepSupport(n: number): number {
  return 1 - Math.pow(0.5, Math.max(0, n - 1))
}

/**
 * 把一张真值表(48 行)铺成多源印证语料:3 个连续 tier 块(各 16 条);heldoutEvery=3 的按序切分会从每块各取 ~5–6 条
 * ⇒ fit/heldout 两侧都含三档。每条多源印证(n=4)+ tier 内按注入真值率 Bresenham **均匀铺开** isTrue(确定性、精确)。
 * tier 纯按 index 连续切块,**与真值表里的族无关**(只决定 authority/真值率;族与置信/真值无因果)。
 * isTrue = 「源所述值 == 真值」(false = 源记错;claim 忠实抄源,故 claim 也错)。Option C / M3-B 共用本铺法。
 */
function buildCorroboratedFrom(rows: FactRow[], idPrefix: string): CorroboratedFact[] {
  const slice = rows.slice(0, TIERS.length * TIER_SIZE) // 取前 48 条,整除成 3×16
  const indep = indepSupport(CORROBORATION_COUNT)

  return slice.map((r, i) => {
    const tier = Math.floor(i / TIER_SIZE)
    const cfg = TIERS[tier]!
    const j = i % TIER_SIZE
    // Bresenham 均匀铺开:floor((j+1)·T/N) > floor(j·T/N) ⇒ 恰 T 个 true、均匀分布、确定性。
    const isTrue =
      Math.floor(((j + 1) * cfg.trueCount) / TIER_SIZE) >
      Math.floor((j * cfg.trueCount) / TIER_SIZE)
    const object = isTrue ? r.trueObject : r.alt
    const auth = cfg.authority
    return {
      id: `${idPrefix}-${String(i).padStart(2, '0')}`,
      subject: r.subject,
      predicate: r.predicate,
      docText: `${r.subject} ${r.predicate} ${object}.`,
      query: `${r.subject} ${r.predicate} what`,
      isTrue,
      sourceAuthority: auth,
      corroborationCount: CORROBORATION_COUNT,
      tier,
      tierTrueRate: cfg.trueCount / TIER_SIZE,
      expectedConfidence: Math.round((0.3 * auth + 0.15 + 0.15 * indep) * 1000) / 1000,
    }
  })
}

/**
 * Option C 语料:可世界核验的**公共事实**(首都/元素)。真跑里真 Verifier 会事实核查、把假 claim 挡在 active 外
 * ⇒ 量不到过自信(见 run-corroborated.ts 真跑发现)。
 */
export function buildCorroboratedCorpus(): CorroboratedFact[] {
  return buildCorroboratedFrom(buildRows(), 'co')
}

// ───────────────────────── M3-B：判官无法核查的私域/新颖事实 ─────────────────────────

/** 私域事实族:虚构实体 + 数值属性(LLM 无先验 ⇒ entailment 判官无法世界核查)。各 12 条 → 48。 */
const PRIVATE_FAMILIES: {
  subject: (code: string) => string
  unit: string
  base: number
  step: number
  code: (k: number) => string
}[] = [
  {
    subject: (c) => `The torque rating of actuator ${c}`,
    unit: 'N·m',
    base: 60,
    step: 7,
    code: (k) => `VX-${210 + k}`,
  },
  {
    subject: (c) => `The resonance frequency of alloy ${c}`,
    unit: 'Hz',
    base: 410,
    step: 13,
    code: (k) => `KX-${330 + k}`,
  },
  {
    subject: (c) => `The allocated budget of project ${c}`,
    unit: 'k credits',
    base: 180,
    step: 11,
    code: (k) => `MRLN-${40 + k}`,
  },
  {
    subject: (c) => `The rated capacity of module ${c}`,
    unit: 'units',
    base: 24,
    step: 5,
    code: (k) => `QP-${500 + k}`,
  },
]
const PRIVATE_PER_FAMILY = 12
/** 错源用的偏移:erroneous source 把真值 +ERR_DELTA 记错(同格式、确定性、≠真值)。 */
const ERR_DELTA = 17

/** 构造 48 条虚构事实真值表:trueObject=真值、alt=错记值(真值+ERR_DELTA)。LLM 无先验 ⇒ 判官只能靠源、无法核查。 */
function buildPrivateRows(): FactRow[] {
  const rows: FactRow[] = []
  for (const fam of PRIVATE_FAMILIES) {
    for (let k = 0; k < PRIVATE_PER_FAMILY; k++) {
      const code = fam.code(k)
      const trueVal = fam.base + k * fam.step
      rows.push({
        subject: fam.subject(code),
        predicate: 'is',
        trueObject: `${trueVal} ${fam.unit}`,
        alt: `${trueVal + ERR_DELTA} ${fam.unit}`,
      })
    }
  }
  return rows
}

/**
 * M3-B 语料:判官**无法世界核查**的私域/新颖事实。结构同 Option C(3 tier、n=4、单调注入过自信),但真跑里真 Verifier
 * 查不出假 claim(无先验)⇒ 假货能进 active ⇒ 可消费集**真带过自信** ⇒ g 该把置信**向下**修正。这才是真实世界过自信 ECE。
 * isTrue=「源所述值==真值」:false 即 erroneous source(把真值记成 真值+17),claim 忠实抄错。
 */
export function buildPrivateCorpus(): CorroboratedFact[] {
  return buildCorroboratedFrom(buildPrivateRows(), 'pv')
}
