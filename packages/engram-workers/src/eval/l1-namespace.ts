/**
 * L1 golden 隔离（A.9「golden 答案放独立 namespace、只判分不被召回」+ 内核领域无关红线）。
 *
 * 隔离的承重不在某个字符串标签，而在**结构**：L1 是 per-agent 行为 golden —— fixture（source content / claim shapes /
 * conflict pairs）只在评测 runner 里**临时 seed 进 per-test DB** 然后随 DROP DATABASE 一起消失；它们**绝不**经
 * 生产写路径（append_claim / commit_claim）落成持久 claim，故 recall_claims 在结构上永不召回它们。L1_GOLDEN_NAMESPACE
 * 只是给这批 fixture 的标签（可观测 / 将来给 seed 的源打 meta 用），不承重隔离 —— 与 L5 的 L5_GAP_NAMESPACE 同一裁断。
 *
 * 与 A1 区分（红线 #4）：A1「考卷=毒株」须先过免疫流水线才晋升 golden（带 reward 的造题是最强真值污染源）；
 * 本文件的 L1 是 per-agent 行为 golden（盯工种「会污染库的危险错」），不进 KB、不带 reward、不参与晋升，二者刻意分开。
 *
 * 与 bidding 隔离（A.9）：本目录的 fixture 全是**领域无关通用事实**，**不得** import 任何 bidding-adapter 的 golden。
 */

/** 这批 L1 行为 golden fixture 的命名空间标签（纯标注、不承重隔离；隔离 = 它们从不被写成持久 claim ⇒ recall 永不召回）。 */
export const L1_GOLDEN_NAMESPACE = 'eval:l1-golden' as const
