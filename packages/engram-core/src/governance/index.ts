/**
 * GovernanceController 恒温器（S26，PRD A.7/A.8）—— barrel。确定性闭环控制律 + 五指标读取 + 版本化持久化 +
 * 生产编排（fail-silent）+ L2 仿真谐波。领域无关，只调内核 SPI/config，不碰任何冻结枚举/红边。
 */
export {
  stepController,
  deriveTargets,
  BASELINE_POLICY,
  DEFAULT_CONTROL_CONFIG,
  POLICY_KNOBS,
  type GovernanceMetrics,
  type GovernancePolicy,
  type ControlConfig,
  type ControlStep,
  type PolicyKnob,
} from './control-law.js'
export {
  gateThresholdsFor,
  standardsInputFromPolicy,
  gateWouldTighten,
  MAX_CONSUME_FLOOR_RAISE,
  MAX_MUST_VERIFY_RAISE,
} from './gate-policy.js'
export {
  writeGovernanceState,
  getActivePolicy,
  getGovernanceHistory,
  rollbackTo,
  type GovernanceStateRow,
  type WriteGovernanceStateInput,
} from './governance-state.js'
export {
  readMetrics,
  defaultMetricReaders,
  NEUTRAL_METRICS,
  readDistillBacklog,
  readEntailRejectRate,
  readConflictQueueDepth,
  readImmuneLag,
  readFalseQuarantineRate,
  type MetricRead,
  type MetricReader,
  type MetricReaders,
  type MetricsReadResult,
} from './metric-readers.js'
export { runGovernanceCycle, type RunCycleOptions, type RunCycleResult } from './controller.js'
export {
  simulate,
  constantSeries,
  type L2SimResult,
  type L2SimOptions,
  type KnobConvergence,
} from './l2-sim.js'
