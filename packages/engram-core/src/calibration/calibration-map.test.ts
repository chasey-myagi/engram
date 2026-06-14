/**
 * S27 纯函数单测 —— g′ 表示 / applyG-by-version / Advisor 诊断 / 验收门逐项咬合。零 DB、零随机。
 * DB 集成（版本化 store / 原子换 / 老快照冻结 / 即时回退 / 能力≠权力）在 __tests__/calibration-advisor.test.ts。
 */
import { describe, expect, it } from 'vitest'

import {
  applyG,
  applyGMap,
  assertCalibrationMap,
  CALIBRATION_IDENTITY,
  IDENTITY_MAP,
  type CalibrationMap,
} from '../confidence/confidence.js'
import { computeReliability } from './calibration.js'
import { advise, identityLikeCandidate, type GoldenSample } from './advisor.js'
import {
  GATE_CHECK_IDS,
  MAX_GATE_FLIP_FRACTION,
  MIN_OUTPUT_SPREAD,
  MIN_SAMPLES_PER_BIN,
  runAcceptanceGate,
  type GateInputs,
} from './acceptance-gate.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 一个良性单调候选：把中段 raw 压低、高段抬高（S 形校准的离散近似），升序非递减、值域 [0,1]。
const MONO_MAP: CalibrationMap = {
  version: 'mono-v1',
  knots: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.3 },
    { x: 1, y: 1 },
  ],
}

describe('S27 g′ 表示 + applyGMap（分段线性、单调插值）', () => {
  it('identity（空 knots）直通 raw 且夹到 [0,1]', () => {
    expect(applyGMap(0.42, IDENTITY_MAP)).toBe(0.42)
    expect(applyGMap(-1, IDENTITY_MAP)).toBe(0)
    expect(applyGMap(2, IDENTITY_MAP)).toBe(1)
  })

  it('结点处取结点值，区间内线性插值', () => {
    expect(applyGMap(0, MONO_MAP)).toBeCloseTo(0, 9)
    expect(applyGMap(0.5, MONO_MAP)).toBeCloseTo(0.3, 9)
    expect(applyGMap(1, MONO_MAP)).toBeCloseTo(1, 9)
    // [0,0.5] 段：y = 0 + (raw/0.5)*0.3 → raw=0.25 → 0.15
    expect(applyGMap(0.25, MONO_MAP)).toBeCloseTo(0.15, 9)
    // [0.5,1] 段：y = 0.3 + ((raw-0.5)/0.5)*0.7 → raw=0.75 → 0.65
    expect(applyGMap(0.75, MONO_MAP)).toBeCloseTo(0.65, 9)
  })

  it('端点外夹断：左于首结点取首 y，右于末结点取末 y', () => {
    const m: CalibrationMap = {
      version: 'clip',
      knots: [
        { x: 0.3, y: 0.2 },
        { x: 0.7, y: 0.9 },
      ],
    }
    expect(applyGMap(0.1, m)).toBeCloseTo(0.2, 9) // 左夹断
    expect(applyGMap(0.95, m)).toBeCloseTo(0.9, 9) // 右夹断
  })

  it('单调输入 → 单调输出（非递减保序，校准不破坏排序）', () => {
    let prev = -1
    for (let raw = 0; raw <= 1.0001; raw += 0.05) {
      const y = applyGMap(raw, MONO_MAP)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = y
    }
  })
})

describe('S27 assertCalibrationMap（写时硬不变量）', () => {
  it('良性映射 + identity 通过', () => {
    expect(() => assertCalibrationMap(MONO_MAP)).not.toThrow()
    expect(() => assertCalibrationMap(IDENTITY_MAP)).not.toThrow()
  })
  it('x 非升序 → 抛', () => {
    expect(() =>
      assertCalibrationMap({
        version: 'x',
        knots: [
          { x: 0.5, y: 0 },
          { x: 0.5, y: 1 },
        ],
      }),
    ).toThrow(/ascending/)
  })
  it('y 递减（非单调）→ 抛', () => {
    expect(() =>
      assertCalibrationMap({
        version: 'x',
        knots: [
          { x: 0, y: 0.8 },
          { x: 1, y: 0.2 },
        ],
      }),
    ).toThrow(/non-decreasing/)
  })
  it('值域越界 → 抛', () => {
    expect(() =>
      assertCalibrationMap({
        version: 'x',
        knots: [
          { x: 0, y: 0 },
          { x: 1, y: 1.5 },
        ],
      }),
    ).toThrow(/\[0,1\]/)
  })
})

describe('S27 applyG-by-version（identity 直通；非 identity 需对版本的 map）', () => {
  it('identity 版本直通 raw，不需 map', () => {
    expect(applyG(0.37, CALIBRATION_IDENTITY)).toBe(0.37)
    expect(applyG(0.37)).toBe(0.37)
  })
  it('非 identity 版本但未传 map → 抛（防用错 g）', () => {
    expect(() => applyG(0.5, 'mono-v1')).toThrow(/requires a resolved map/)
  })
  it('非 identity 版本传入对应 map → 应用该 g′', () => {
    expect(applyG(0.5, 'mono-v1', MONO_MAP)).toBeCloseTo(0.3, 9)
  })
  it('版本与 map.version 不一致 → 抛（防张冠李戴）', () => {
    expect(() => applyG(0.5, 'mono-v1', IDENTITY_MAP)).toThrow(/does not match/)
  })
})

describe('S27 Advisor（只读诊断 + 绑 ΔECE；候选只是返回值、不改任何活动状态）', () => {
  // 构造一组「raw 偏高于真实正确率」的样本：低 raw 段其实更可靠，identity 高估 → 校准应降 ECE。
  const samples: GoldenSample[] = []
  for (let i = 0; i < 20; i++) samples.push({ rawPredicted: 0.9, correct: i < 6 }) // raw 0.9 实测 0.3
  for (let i = 0; i < 20; i++) samples.push({ rawPredicted: 0.5, correct: i < 5 }) // raw 0.5 实测 0.25

  it('把 raw=0.9 映到 0.3、raw=0.5 映到 0.25 的候选 → ΔECE 显著 <0（更准）', () => {
    const candidate: CalibrationMap = {
      version: 'fix-v1',
      knots: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.25 },
        { x: 0.9, y: 0.3 },
        { x: 1, y: 0.35 },
      ],
    }
    const proposal = advise(samples, IDENTITY_MAP, candidate)
    expect(proposal.candidate).toBe(candidate)
    expect(proposal.deltaEce).toBeLessThan(0)
    expect(proposal.candidateEce).toBeLessThan(proposal.currentEce)
    expect(proposal.sampleCount).toBe(40)
  })

  it('identityLike 候选 ΔECE≈0（与 identity 数值等价，用于跑通链路而非改 ECE）', () => {
    const proposal = advise(samples, IDENTITY_MAP, identityLikeCandidate('id-like'))
    expect(Math.abs(proposal.deltaEce)).toBeLessThan(1e-9)
  })
})

// ---- 验收门：逐项各自咬合（approve 路径 + 各项 reject 路径）----

/** 一组足量、均匀分布、桶都 ≥ MIN_SAMPLES 的样本（让 ⑤ 默认过，便于单测其它检查）。 */
function wellSampled(): GoldenSample[] {
  const s: GoldenSample[] = []
  // 每个 0.1 宽桶塞 MIN_SAMPLES_PER_BIN+1 条，raw 落在桶心，correct 一半一半。
  for (let b = 0; b < 10; b++) {
    const center = b / 10 + 0.05
    for (let k = 0; k <= MIN_SAMPLES_PER_BIN; k++) {
      s.push({ rawPredicted: center, correct: k % 2 === 0 })
    }
  }
  return s
}

function baseInputs(candidate: CalibrationMap, samples: GoldenSample[]): GateInputs {
  const reliability = computeReliability(
    samples.map((x) => ({ predicted: applyGMap(x.rawPredicted, candidate), correct: x.correct })),
    10,
  )
  return {
    candidate,
    current: IDENTITY_MAP,
    consumeFloor: 0.4,
    promotionGateLevel: 0, // 恒温器未收紧（④ 默认无约束）
    sampleRaws: samples.map((x) => x.rawPredicted),
    reliability,
  }
}

describe('S27 验收门（确定性，全项通过才 approve；逐项可咬）', () => {
  it('全项通过 → approve（identityLike 候选，不改门人群、桶足）', () => {
    const samples = wellSampled()
    const verdict = runAcceptanceGate(baseInputs(identityLikeCandidate('ok'), samples))
    expect(verdict.approved).toBe(true)
    expect(verdict.failedCheck).toBeUndefined()
    expect(verdict.checks.every((c) => c.passed)).toBe(true)
  })

  it('① 非单调候选 → reject 在 monotonic', () => {
    const bad: CalibrationMap = {
      version: 'nonmono',
      knots: [
        { x: 0, y: 0.9 },
        { x: 1, y: 0.1 },
      ],
    }
    const v = runAcceptanceGate(baseInputs(bad, wellSampled()))
    expect(v.approved).toBe(false)
    expect(v.failedCheck).toBe('monotonic')
  })

  it('② 值域越界候选 → reject 在 range（单调但 y>1）', () => {
    const bad: CalibrationMap = {
      version: 'oor',
      knots: [
        { x: 0, y: 0 },
        { x: 1, y: 1.4 },
      ],
    }
    const v = runAcceptanceGate(baseInputs(bad, wellSampled()))
    expect(v.approved).toBe(false)
    // 越界也违反单调判据之外的 range；range 是它命中的项之一（首个未过项按 ①→⑤ 顺序）。
    expect(['range', 'monotonic']).toContain(v.failedCheck)
    expect(v.checks.find((c) => c.id === 'range')!.passed).toBe(false)
  })

  it('③ 消费门翻转过猛 → reject 在 consumption_flip', () => {
    // 候选把所有 raw 抬到 1（远高于 floor），而 current=identity 下大量样本本在门下 → 越门集合大翻转。
    const violent: CalibrationMap = {
      version: 'violent',
      knots: [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ],
    }
    const samples = wellSampled() // 大量 raw < 0.4，identity 下在门下；候选下全部 ≥ floor
    const v = runAcceptanceGate(baseInputs(violent, samples))
    expect(v.approved).toBe(false)
    expect(v.failedCheck).toBe('consumption_flip')
    const flip = v.checks.find((c) => c.id === 'consumption_flip')!
    expect(flip.passed).toBe(false)
  })

  // 少量样本在 [0.3,0.4)（identity 门下、候选 loosen 下越门），大量样本远高于门（两版都越门、不翻转）。
  // 翻转占比 = 越门样本 / 总样本 = 6/36 ≈ 0.167 ≤ 0.2 → ③ 过；④ 因「净越门数变多」咬住。
  const LOOSEN: CalibrationMap = {
    version: 'loosen',
    knots: [
      { x: 0, y: 0 },
      { x: 0.35, y: 0.45 },
      { x: 1, y: 1 },
    ],
  }
  function loosenSamples(): GoldenSample[] {
    const s: GoldenSample[] = []
    for (let k = 0; k < 6; k++) s.push({ rawPredicted: 0.32, correct: k % 2 === 0 })
    for (let k = 0; k < 30; k++) s.push({ rawPredicted: 0.9, correct: true })
    return s
  }

  it('④ 恒温器收紧时候选净放松（更多越门）→ reject 在 thermostat_conflict', () => {
    const inputs = baseInputs(LOOSEN, loosenSamples())
    inputs.promotionGateLevel = 0.5 // 恒温器正收紧
    const v = runAcceptanceGate(inputs)
    // ③ 必须先过（翻转小），④ 才能成为咬住项。
    expect(v.checks.find((c) => c.id === 'consumption_flip')!.passed).toBe(true)
    expect(v.approved).toBe(false)
    expect(v.failedCheck).toBe('thermostat_conflict')
  })

  it('④ 同样候选但恒温器未收紧（level=0）→ ④ 不约束、可过', () => {
    const inputs = baseInputs(LOOSEN, loosenSamples())
    inputs.promotionGateLevel = 0
    const v = runAcceptanceGate(inputs)
    expect(v.checks.find((c) => c.id === 'thermostat_conflict')!.passed).toBe(true)
  })

  it('⑤ 某非空桶样本不足 → reject 在 bin_samples', () => {
    // 只给极少量样本（每桶 < MIN_SAMPLES_PER_BIN），其它检查都过、⑤ 咬住。
    const sparse: GoldenSample[] = [
      { rawPredicted: 0.25, correct: true },
      { rawPredicted: 0.65, correct: false },
    ]
    const v = runAcceptanceGate(baseInputs(identityLikeCandidate('sparse'), sparse))
    expect(v.approved).toBe(false)
    expect(v.failedCheck).toBe('bin_samples')
  })

  it('阈值常量是确定性的起步基线', () => {
    expect(MAX_GATE_FLIP_FRACTION).toBeGreaterThan(0)
    expect(MAX_GATE_FLIP_FRACTION).toBeLessThan(1)
    expect(MIN_SAMPLES_PER_BIN).toBeGreaterThanOrEqual(1)
    expect(MIN_OUTPUT_SPREAD).toBeGreaterThan(0)
  })
})

// ---- S28 FIX 3：⑥ output_spread 拒退化常值/单 knot g（不抢前序检查的咬合项）----
describe('S28 验收门 ⑥ output_spread（FIX 3：拒退化无分辨力 g）', () => {
  it('常值 g（两端点同 y）→ reject 在 output_spread（spread=0）', () => {
    // 常值 g 把每条 claim 压成同一个 0.7——抹平全部排序语义。样本 raw 全在 [0.6,0.9]：identity 下与常值 0.7 下
    // 都 ≥floor（无翻转、③ 过），桶足（⑤ 过）、恒温器未收紧（④ 过）⇒ 首个未过项确是 ⑥ output_spread。
    const constMap: CalibrationMap = {
      version: 'const',
      knots: [
        { x: 0, y: 0.7 },
        { x: 1, y: 0.7 },
      ],
    }
    const highSamples: GoldenSample[] = []
    for (const center of [0.65, 0.75, 0.85]) {
      for (let k = 0; k <= MIN_SAMPLES_PER_BIN; k++) {
        highSamples.push({ rawPredicted: center, correct: k % 2 === 0 })
      }
    }
    const inputs = baseInputs(constMap, highSamples)
    // 自检前提：③④⑤ 都过（否则它们会先咬住、本测就测不到 ⑥）。
    const v = runAcceptanceGate(inputs)
    expect(v.checks.find((c) => c.id === 'consumption_flip')!.passed).toBe(true)
    expect(v.checks.find((c) => c.id === 'bin_samples')!.passed).toBe(true)
    expect(v.approved).toBe(false)
    expect(v.failedCheck).toBe('output_spread')
  })

  it('有真实 spread 的单调 g（identityLike）→ ⑥ 过', () => {
    const v = runAcceptanceGate(baseInputs(identityLikeCandidate('spready'), wellSampled()))
    expect(v.checks.find((c) => c.id === 'output_spread')!.passed).toBe(true)
  })

  it('⑥ 放在末位：consumption_flip 先咬住时 failedCheck 不被 ⑥ 抢（y 全=1 既翻门又零 spread）', () => {
    // 候选把所有 raw 抬到 1：既触发 ③ 消费门大翻转、又是常值（spread=0）。首个未过项应是 ③ 而非 ⑥。
    const violentConst: CalibrationMap = {
      version: 'violent-const',
      knots: [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ],
    }
    const v = runAcceptanceGate(baseInputs(violentConst, wellSampled()))
    expect(v.approved).toBe(false)
    expect(v.failedCheck).toBe('consumption_flip') // ③ 先于 ⑥（既有测试的咬合项不变）
    expect(v.checks.find((c) => c.id === 'output_spread')!.passed).toBe(false) // ⑥ 也确实没过
  })

  it('identity g（空 knots）天然有分辨力：⑥ 过（直通 raw、保序）', () => {
    const v = runAcceptanceGate(baseInputs(IDENTITY_MAP, wellSampled()))
    expect(v.checks.find((c) => c.id === 'output_spread')!.passed).toBe(true)
  })
})

// ---- EGR-CR-008：验收门项数 = 唯一真值源（注释计数不得漂移）----
describe('EGR-CR-008 验收门项数是唯一真值源（注释计数不得漂移）', () => {
  it('runAcceptanceGate 返回的 checks 与 GATE_CHECK_IDS 一一对应（同序、同集合）', () => {
    const v = runAcceptanceGate(baseInputs(identityLikeCandidate('ok'), wellSampled()))
    expect(v.checks.map((c) => c.id)).toEqual([...GATE_CHECK_IDS])
  })

  it('GATE_CHECK_IDS 恰含 6 项且无重复（output_spread 为 S28 FIX 3 第 6 项）', () => {
    expect(new Set(GATE_CHECK_IDS).size).toBe(GATE_CHECK_IDS.length)
    expect(GATE_CHECK_IDS).toContain('output_spread')
    expect(GATE_CHECK_IDS.length).toBe(6)
  })

  it('calibration 源码/测试名中不再残留历史门计数（旧的 N 分之 M 串）', () => {
    // 历史串从片段拼出，避免本测试文件自身命中下面对它的扫描（它把本文件也纳入扫描清单）。
    const stale = [`5${'/'}6`, `5${'/'}5`]
    const staleRe = new RegExp(stale.join('|'))
    const files = [
      './fit-from-usage.ts',
      './advisor.ts',
      './recalibrate.ts',
      './acceptance-gate.ts',
      './calibration-map.test.ts',
      '../index.ts',
      '../__tests__/calibration-advisor.test.ts',
      '../__tests__/calibration-isotonic.test.ts',
    ].map((f) => fileURLToPath(new URL(f, import.meta.url)))
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} 含历史门计数`).not.toMatch(staleRe)
    }
  })
})
