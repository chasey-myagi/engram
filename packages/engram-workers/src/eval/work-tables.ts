/**
 * 「工作表」清单的**单一真相**：评测/对抗注入（红队毒株、Distiller 抽取、A1 候选…）会写到的表。
 * per-item 毒株隔离靠在每条样本前 TRUNCATE 这批表来保证（见 red-blue-round / redteam-injector / runner demo）。
 *
 * 此前这份清单在 4 处逐字重复（red-blue-round.test / redteam-immunity.test / runner 测 / runner main demo）；
 * 新增工作表时若漏改一处，毒株会**静默泄漏**进下一条样本、污染真值。集中到这一处后：新增工作表只改这里。
 * （注：worker 单测的 6 表子集 reset 是各自更窄的隔离需求，与毒株隔离无关，不并入此清单。）
 */
export const EVAL_WORK_TABLES = [
  'source',
  'claim',
  'claim_provenance',
  'relation',
  'claim_verification',
  'metrics_events',
  'l5_candidates',
  'golden_questions',
  'promotion_audit',
] as const

/** 构造清空全部工作表的 TRUNCATE 语句（CASCADE）。调用方：`await pool.query(truncateEvalWorkTablesSql())`。 */
export function truncateEvalWorkTablesSql(): string {
  return `TRUNCATE ${EVAL_WORK_TABLES.join(', ')} CASCADE`
}
