/**
 * Plan A 决策价值实验的**纯核**(零 import、零 DB)—— 一个消费者**用置信做决策**:answer-vs-abstain @ 阈值
 * (选择性预测 / coverage-risk)。前四关(M2/M3-A/Option C/M3-B)只量校准(ECE),从没量「校准 → 决策变好」;本片是那一跳的纯逻辑。
 *
 * **A3 边界(结构性)**:本模块**不 import 任何东西**——置信→预测值的映射经 `predict` 回调注入(identity 现在 / g 以后),
 * 故决策核**永不**触达 calibration/g/governance,决策指标也物理上无路反喂 g。这是「决策不进 g」的最干净落点。
 *
 * 指标(标准选择性预测口径):
 *   coverage         = answered / total                  (答了多少)
 *   answeredAccuracy = correctAnswered / answered        (答对率,答了的里)
 *   selectiveRisk    = wrongAnswered / answered          (= 1 − answeredAccuracy,答了的里答错率)
 *   regret           = wrongAnswered / total             (常数 harm/错答、按全集归一 = 一个错误动作落到整任务的概率)
 */

/** 决策核的最小输入(结构化):一个样本的预测原始置信 + 它客观对错。FactSample 等天然满足。 */
export interface DecisionSample {
  rawPredicted: number
  correct: boolean
}

export type Decision = 'answer' | 'abstain'

/** 阈值决策:预测置信 ≥ 阈值则答,否则弃答(升级/留白)。 */
export function decideAnswerOrAbstain(predictedConfidence: number, threshold: number): Decision {
  return predictedConfidence >= threshold ? 'answer' : 'abstain'
}

export interface DecisionMetrics {
  total: number
  answered: number
  /** answered / total。 */
  coverage: number
  /** correctAnswered / answered;answered=0 时 NaN(无可评)。 */
  answeredAccuracy: number
  /** wrongAnswered / answered(= 1 − answeredAccuracy);answered=0 时 NaN。 */
  selectiveRisk: number
  /** wrongAnswered / total(常数 harm/错答、按全集归一)。 */
  regret: number
}

/**
 * 在一组样本上,用注入的 `predict`(raw→置信:identity 或 g)+ 阈值,算选择性预测指标。纯函数、确定性、无副作用。
 */
export function computeDecisionMetrics(
  samples: DecisionSample[],
  predict: (raw: number) => number,
  threshold: number,
): DecisionMetrics {
  const total = samples.length
  let answered = 0
  let correctAnswered = 0
  for (const s of samples) {
    if (decideAnswerOrAbstain(predict(s.rawPredicted), threshold) === 'answer') {
      answered += 1
      if (s.correct) correctAnswered += 1
    }
  }
  const wrongAnswered = answered - correctAnswered
  return {
    total,
    answered,
    coverage: total > 0 ? answered / total : 0,
    answeredAccuracy: answered > 0 ? correctAnswered / answered : NaN,
    selectiveRisk: answered > 0 ? wrongAnswered / answered : NaN,
    regret: total > 0 ? wrongAnswered / total : 0,
  }
}

/** 全集答对率(answer-everything 基线;敏感度门用它对比「按置信选择性回答」是否更优)。 */
export function overallAccuracy(samples: DecisionSample[]): number {
  if (samples.length === 0) return NaN
  return samples.filter((s) => s.correct).length / samples.length
}
