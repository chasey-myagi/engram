# Engram PRD · agent 原生可生长知识库

> **状态**:`ready-for-agent`(待实现)
> **定位**:独立产品,非 bidding-agent 子模块。bidding-agent 是 Engram 的**第一个领域适配器(consumer)**,不是主人。
> **设计稿(canonical)**:[`docs/design/agentic-knowledge-core.html`](./design/agentic-knowledge-core.html) —— 13 节 / 22 图,本 PRD 是它的可执行投影。
> **一句话**:不是 RAG,是 agent 的可生长记忆/第二大脑。一条 claim = 一个 engram。

---

## Problem Statement

采购/销售/合规等团队的 agent(如 bidding-agent)在回答"公司能否满足这条标书要求"时,需要快速、准确、可追溯地命中**企业内部的某一个具体事实**(某颗芯片是否支持 4K@120、某份合同的有效期、某次客户 Q/A 的结论)。但企业知识的现状是:

1. **raw 来源杂乱且持续涌入**:产品文档、历史标书、合同、聊天记录、ask_user 的 Q/A,异构、多模态、互相矛盾,不是一次性导入。
2. **现有方案要么冷、要么哑**:
   - 纯 RAG 是冷冰冰的相似度匹配,召回的是 chunk(原文切片),不是已判定的事实;矛盾、时效、权威性全靠 agent 临场重读,慢且不稳。
   - 现有 wiki 知识库模块和业务逻辑深度耦合,confidence 是 stub(`min(1, 来源数×0.3)`,单源官方 datasheet 也被锁死 0.3),`wikiEnabled=false` —— 内容备好了但 agent 根本不敢用,**结构性地产生不了价值**。
3. **信任无法量化**:系统说一条事实"可信度 0.3"时,这个数字和"它真实为真的概率"没有任何校准关系,于是下游既不敢信、也无法设阈值。
4. **越用不会越好**:知识不会因为被使用、被纠正而自动沉淀和升信;agent 每次都从零重读 raw。

**痛点一句话**:agent 没有一个**写得快、信得慢、越用越准、且每条结论都能钻回原文**的企业事实层。

## Solution

构建 **Engram** —— 一个领域无关的、agent 原生的可生长知识库内核。核心范式:

- **wiki×KB 二象性**:同一份知识有两张脸。`page` = 人读的视图(wiki 面);`claim` = 机器消费的事实原子(KB 面)。**claim 是唯一的召回单元**。
- **三层永不塌缩**:`raw source`(不可变原文)→ `claim`(蒸馏出的、带强制出处的事实)→ `page/view`(给人看的组装)。任何 claim 永远能向下钻回它的 source。
- **主体翻转**:**agent 写,人主编**。agent 持续蒸馏、消费、回写;人不录入,只做异常审核、冲突裁决、纠错(主编/editor-in-chief)。
- **乐观写入 / 悲观消费**:写得快(低门槛 append),信得慢(消费时按动态 confidence 设门)。二者由 confidence 这一活值耦合。
- **事后免疫系统**:治理从"事前门禁"搬到"事后巡查"。唯一的事前硬门是**强制 provenance**(无出处的 claim 根本进不来,DB 层 NOT NULL FK)。其余靠 D2 乐观分级 + D3 verifier 巡查。
- **内核 / 领域适配分层**:内核只认 source/claim/relation/provenance/confidence;`compliant 判断、forbidden flag、FAQ 三件套、capability 轴、scope、page_type 枚举` 等全部下沉到 domain adapter。bidding-agent 通过 Consumer SPI 接入,是第一个 adapter。

agent 的使用是**嵌在 loop 内的闭环**:检索(claim 即用)→ 悲观核验 → 乐观写回 → 使用反馈升降信,四阶段在一次 agent loop 内闭合。Engram 内部还有一支**5 工种内部编队**(Distiller/Verifier/Reconciler/Arbiter/Harvester)持续维护库的健康。

最终交付一个可被任意 agent 复用的事实层,且**越被使用、越被纠正,就越准、越校准**。

---

## User Stories

### A. 消费方 agent(以 bidding-agent 为首个 adapter)

1. 作为消费方 agent,我想用一句自然语言 query 调 `recall_claims`,拿到一组**已判定的 claim + 各自的 calibrated confidence 快照**,这样我不必重读 raw 就能直接用。
2. 作为消费方 agent,我想让每条召回的 claim 都带 ≥1 条 provenance(指回 source 的可点击锚),这样我能在答案里给出引用、也能在存疑时钻回原文。
3. 作为消费方 agent,我想让 Engram 按 confidence 门帮我过滤:`<0.4 不召回`、`0.4–0.6 召回但标 mustVerify`、`≥0.6 可直接采信`,这样我能把"信得慢"外包给库而不是每次自己判断。
4. 作为消费方 agent,当我对一条 claim 的某次使用产生结果(被采纳 / 被用户纠正 / 被驳回)时,我想调 `report_usage` 回报,这样库能据此升降信、并积累真实失败分布。
5. 作为消费方 agent,当我从一次任务里产出了新事实(如 ask_user 得到的 Q/A 结论),我想调 `append_claim` 乐观写回,这样下次别的任务能复用,而不必再问一遍用户。
6. 作为消费方 agent,我想通过领域 adapter 注入业务身份(把某 source 标成"官方 datasheet")而**不污染内核**,这样内核保持领域无关,我的业务语义又能影响召回。
7. 作为消费方 agent,我想让 adapter 只能**单调收紧**(提高门、缩小召回),不能放松内核的安全不变量,这样无论挂多少 adapter,"无出处不召回 / 低信不召回 / 矛盾显式"三条永远成立。
8. 作为消费方 agent,当库里**本就没有**某事实的答案时,我想得到一个明确的"零召回 + 记缺口"信号,而不是被一条编造的 claim 误导,这样我能诚实地标记"需人工补充"。
9. 作为消费方 agent,我想让 `recall_claims` 在矛盾事实上返回**两条都给我 + 标 contradicts + 各自时效/权威**,由我(或库的采信规则)决定信谁,而不是被相似度盲选一条。

### B. 最终用户(采购/销售/合规)与主编(editor-in-chief)

10. 作为最终用户,我在消费方 agent 一侧零直接接触 Engram,我只看到 agent 给出的带引用的答案,这样我的体验是"问 agent",不是"学一个新系统"。
11. 作为主编,我想要一个 claim 粒度、按 confidence 升序排列的审核 inbox(键盘流 j/k/a/e/r),这样我能优先处理最可疑的事实。
12. 作为主编,我想用三个动作处理一条 claim:Approve(endorse 拉满 human_review 因子)、Edit-Approve(先 append 新版本再 endorse)、Reject(→ quarantined,保留可审计),这样我永远不"原地改事实"。
13. 作为主编,我想让我的三个动作都只**投 confidence 因子**、不直接写 status,status 由门限重算决定,这样界面纪律和库层不变量同构。
14. 作为主编,我想成为**唯一**能让 claim 状态"放松"(赦免 / 回滚 / 解除隔离)的角色;agent 只能"收紧",这样系统刻意不对称:宁可错杀好 claim,不放过坏 claim。
15. 作为主编,我想看到每条 claim 的完整谱系(它的 provenance、被哪些 page 引用、历史版本、被谁 supersede),这样我裁决冲突时有全貌。
16. 作为主编,当两条 claim 矛盾时,我想按固定优先级裁决:`人工裁定 > 取代关系 > 时效 > 权威 > 印证数`,这样裁决可解释、可复现。

### C. 内部编队(Engram 自养的 5 工种 agent)

17. 作为 **Distiller**,我想读懂涌入的 source(按 kind 选 read 策略:layout/table/turns/VLM)、蒸馏出带强制出处的 claim、跨源去重、探测冲突、单事务 commit,这样进库的是"事实"不是"切片"。
18. 作为 Distiller,我想在抽 claim 时**强制每条 ≥1 出处**,无出处即拒,这样事前硬门由我把守。
19. 作为 **Verifier**,我想巡查低置信/高冲突/过时的 claim(entailment 核验、时效巡查),把站不住的标 flagged/supersede,这样库的健康度被持续维护而非一次性。
20. 作为 **Reconciler**,我想识别"伪装成精炼的等价投毒"和异常 lineage(近重复去重),这样同源刷印证、近重复投毒会被识破。
21. 作为 **Arbiter**,我想在冲突无法机判时按优先级裁或升级给主编,这样矛盾有确定的收敛路径。
22. 作为 **Harvester**,我想从消费方的 `report_usage` 真值流里统计 observed correctness、喂给校准,这样"使用"变成"升信"的燃料。
23. 作为内部编队的任一工种,我想有**独立的 DB 角色 + 会话隔离**,裁判(judge)与运动员(athlete)分离,这样巡查者不会给自己产出背书。
24. 作为 Distiller/Arbiter(真 agent loop 工种),我想在 `maxSteps + 独立预算池 + 明确升级路径` 的有界 loop 内工作,失败一律收敛到"安全降级"而非无限重试。
25. 作为 Verifier/Reconciler/Harvester(非 loop 工种),我想以"函数/统计 + 点状一次 LLM"形态运行(内嵌一次 LLM ≠ agent loop),这样我便宜、可预测、可大规模并行。

### D. 控制面 / 平台运维

26. 作为平台,我想用一个**确定性的 GovernanceController(恒温器)**管理乐观/悲观平衡点:库健康度下降时自动收紧 D2 分级门,这样平衡点是随健康度自调的活值,不是写死常数。
27. 作为平台,我**否决在线 LLM meta-orchestrator**:编排走数据面 choreography(claim 状态变化触发下一工种),不靠一个在线大模型调度,这样失效时静音退回三层主干、零编排单点。
28. 作为平台,我想要一个**旁挂式离线 Advisor**:它只读、只产建议(如候选校准映射 g'),建议必须过**确定性验收门**才能变成可执行 event,这样能力(诊断)与权力(拍板)分离。
29. 作为平台,我想让任何"放松类"变更(改门、翻转状态、回灌 g)都可一键回退(如 `g=identity` 一个 flag 五分钟回到裸 confidence),这样治理动作全部可逆。
30. 作为平台,我想让 claim 存储是 **append-only**:supersede 不删旧版本,这样任何结论都可审计、可回滚。

### E. confidence 与校准

31. 作为系统,我想把 confidence 从"来源计数器"变成**连续的、可校准的概率**:`raw = Σ wᵢ·factorᵢ`(七因子线性合成)→ `conf = g(raw)`(单调映射),这样下游阈值才有意义。
32. 作为系统,我想让七因子语义权重 `w` 是**配置态**(主编设,回答"为什么信"),校准映射 `g` 是**统计态**(由 observed correctness 拟合,回答"数值=真实概率"),二者**职责分离**。
33. 作为系统,我想让 `g` 起步用 temperature(`conf=σ(raw/T)`),进阶用 isotonic 非参单调,这样从最简能跑、又能演进到更准。
34. 作为系统,我想用 calibrated confidence 在每次 recall 当刻取快照(事后查会漂),这样"我当时为什么信它"可复盘。
35. 作为系统,我想确保 raw **先连续化**(替换 `min(1, 来源数×0.3)` 的 5 档离散),否则 g 无意义、ECE 数学上测不了 —— 这是命门前置。

### F. 免疫 / 数据完整性

36. 作为系统,我想要 **D1 库层硬门**:provenance NOT NULL,无出处的 claim 物理上写不进来(只验可追溯,不判对错)。
37. 作为系统,我想要 **D2 乐观分级**:新 claim 默认进 draft(影子区,不召回),达门才晋升 active,这样写入廉价、消费谨慎。
38. 作为系统,我想要 **D3 事后巡查**:Verifier 周期性 LLM 巡查存量 claim,这样错误即使溜进来也会被事后逮到。
39. 作为系统,我想要 claim 状态机 `draft → active → flagged → quarantined → superseded`,agent 边(蓝)只能收紧,人边(红)才能放松,这样治理方向被结构强制。
40. 作为系统,在判定某条 claim 为 non_compliant / refuted 时,我想要 ≥1 条 `relevance=exact` 的反向证据,否则拒绝该判定、强制升级人工,这样硬否定不会被弱证据轻易触发。
41. 作为系统,我想用**独立来源判定**数印证:`independent(s1,s2) = id≠ ∧ hash≠ ∧ 无 derived_from 血缘`,印证只数独立 supports 源,这样同源抄写无法刷高印证。
42. 作为系统,我想用 embedding(作用于 **claimText**,非 raw chunk;~768–1024 维;commit 时算;pgvector + HNSW)做召回与去重底座,并对 embedding 做版本锚,这样模型升级后历史向量可识别需重嵌。
43. 作为系统,我想用两阶段 lineage 匹配:① embedding 近邻 + subjectKey 召候选 ② 确定性规则 + 灰区一次 LLM,产出"同一(共 lineageId)/ refines / contradicts / 无关",这样"同一事实"的判定既快又可控。

### G. 评测 / benchmark

44. 作为评测系统,我想**经同一套 Consumer SPI 接入**(评测题=recall、红队样本=append、真值=report_usage),零评测专用代码路径,这样测的是真系统不是影子系统(评测=消费)。
45. 作为评测系统,我想要 **L1 每-agent 组件 golden set**,盯每个工种"会污染库的危险错"(如 Distiller 抽错 claim、Verifier 漏检幻觉),这样每个工种各自可回归。
46. 作为评测系统,我想要 **L2 控制面仿真**,验证恒温器收敛不振荡、Advisor→验收门链路正确,这样控制逻辑可测。
47. 作为评测系统,我想要 **L3 系统八维**(P/R@k · grounding · ★校准 ECE · 覆盖 · 时效 · ★免疫红队 · 下游 A/B · ★纵向越用越好),其中三个★是命门,这样系统级质量有统一口径。
48. 作为评测系统,我想要 10–20 道 **L5 缺口题**(库里本无答案,正解=门后零召回+记缺口),专测"该说不知道时说不知道"的零幻觉诚实性,这样补上当前单标量 benchmark 的最大盲区。
49. 作为评测系统,我想把 prod 的真实失败(report_usage 的驳回/纠正)回流进回归集,这样回归集是活的、贴真实分布。
50. 作为评测系统,我想用红队四类对抗样本(false / contradiction / stale / near-dup-poison)注入、检验对应工种的免疫反应,这样免疫力可量化。
51. 作为评测系统,我想严守两条永久红线:**A1 考卷本身也要被验真**(题=毒株,带 reward 的造题是最强真值污染源,必须先过"题的免疫流水线"才晋升 golden);**A3 ELO/胜负率严禁进纵向趋势和校准 g**(否则 Goodhart,系统学会让对手变弱而非自己更准)。
52. 作为评测工程师,我想要 golden 答案放**独立 namespace、只判分不被召回**,这样不会因 KB 泄漏导致分数虚高。

---

## Implementation Decisions

### 技术栈(对齐设计稿,与 bidding-agent 同构以便复用经验,但独立部署)

- **运行时**:Express + ws(Node ≥22 ESM)。
- **存储**:PostgreSQL + Drizzle ORM;向量检索用 **pgvector + HNSW**。append-only(supersede 不物理删)。
- **agent 运行时**:`harness-pi`(自研后端 agent runtime,站在 `@mariozechner/pi-ai` 上;pi-coding-agent 的 sibling 而非其 fork/扩展)。5 工种跑在 `@harness-pi/core`(AgentSession + hook/plugin/controller)上,各自独立 session + 逻辑角色(`by_role` 标记);物理 DB role 隔离(CREATE ROLE / RLS)**待实现**(当前角色边界由应用层守卫强制,见 EGR-CR-006);有界 loop 工种(Distiller/Arbiter)= maxTurns + tokenBudget + LifecycleRestart。与 bidding-agent 复用同一套 hook/plugin 经验。
- **前端**:React 19(主编 Studio + 评测看板),沿用项目暖色品牌(plum/cream)。
- **领域适配**:bidding-adapter 作为独立包,通过 Consumer SPI 依赖 Engram 内核,**不反向依赖**。

### 五个内核 primitive(领域无关)

- `source` —— 不可变原文。字段含 `id / contentHash / kind(formal_document|structured_spec|human_qa|conversation_log|historical_artifact|agent_synthesis|external_feed) / authorityScore(连续,消费方可覆盖) / meta(领域身份注入口)`。
- `claim` —— 蒸馏事实原子。`id / claimText / subject / predicate / object / status / confidence(连续) / lineageId / asOf`。
- `relation` —— claim/page 间的 typed 边:`supports / contradicts / refines / derived_from / supersedes`。
- `provenance`(表名 `claim_provenance`)—— claim→source 的强制出处,**NOT NULL FK**(D1 硬门)。
- `confidence` —— 不是单列而是一套:七因子 + raw + g + 快照。
- 辅助:`page_claims`(page 组装哪些 claim)、`claim_verification`(D3 巡查 / 校准真值记录)。

### Consumer SPI(唯一对外通道,也是最高测试缝)

三个动作,**所有消费方(含评测)只经此进出,无旁路**:

- `recall_claims(query, ctx) -> {claim, confSnapshot, provenance[]}[]` —— 检索;内部完成七因子聚合 → g 映射 → 消费门过滤。
- `append_claim(draft, provenance[]) -> claimId` —— 乐观写入(默认 draft,强制出处)。
- `report_usage(claimId, outcome) -> void` —— 回报使用结果(采纳/纠正/驳回),喂校准 + 失败池。

adapter 是 SPI 之上的**单调收紧算子**:两层 —— 配置态(权重/门的静态收紧)+ 请求态(单调收紧,不可放松内核不变量)。

### confidence 管线(命门)

```
raw  = Σ wᵢ·factorᵢ        # 七因子:来源权威·人审·entail·多源印证·使用反馈·(−冲突)·(−时效);w=配置态
conf = g(raw)              # g 单调:起步 temperature σ(raw/T);进阶 isotonic 非参
# g 由 observed correctness 校准拟合(评测三环),与 w 分离
# 消费门:conf<0.4 不召回;0.4–0.6 mustVerify;≥0.6 可采信
```

★ 前置硬约束:**raw 必须先连续化**,替换现状 `min(1, 来源数×0.3)` 的 5 档离散。这是 P0 的第一件事,在它就位前所有评测数字都是对不存在系统的幻觉。

### 派生算法(设计稿 §11 已定义,可照实现)

- **embedding**:作用于 claimText;commit 时算;pgvector+HNSW;版本锚(模型升级→标记需全量重嵌)。
- **lineage 匹配**:两阶段(embedding 近邻+subjectKey 召候选 → 确定性规则+灰区一次 LLM)→ 同一/refines/contradicts/无关。
- **独立来源判定**:`id≠ ∧ hash≠ ∧ ¬derivedChain`;印证只数独立 supports 源。
- **same_fact 判据**:`subject≡ ∧ predicate≡ ∧ object_equiv`(数值/单位归一 或 语义等价,灰区→LLM)。

### ingestion / Distiller 管线(5 阶段)

`① 读懂(read_source 按 kind) → ② 抽 claim(★强制 ≥1 出处,无出处即拒) → ③ 跨源去重(等价→合并出处,印证+1,不删) → ④ 冲突探测(矛盾→落 contradicts,两条都留) → ⑤ commit_claim(单事务,claim+出处+关系)`。矛盾不阻塞写入;低置信/高冲突 claim 事后推入 Verifier 编队 + 人审队列(不在管线内同步阻塞)。

### 免疫系统(三道防线 + 状态机)

- **D1**:库层只验可追溯(provenance NOT NULL),不判对错。
- **D2**:乐观分级(draft 影子区 → 达门晋升 active)。
- **D3**:Verifier LLM 巡查存量;失衡时恒温器自动收紧 D2。
- **状态机**:`draft / active / flagged / quarantined / superseded`;agent 蓝边只收紧,人红边才放松;NC/refuted 判定需 ≥1 exact 反向证据否则强制升级人。

### 控制面(架构裁决)

- **否决在线 meta-orchestrator**;采纳"数据面 choreography + 确定性恒温器 + 旁挂离线 Advisor 经确定性验收门"。
- 能力/权力分离:Advisor 只读+只产建议;恒温器+验收门拍板。失效静音退回三层主干。
- agent 形态按"执行前状态是否收敛"判:Distiller/Arbiter=有界 loop;Verifier/Reconciler/Harvester=函数/统计+点状 one-shot。

### 评测子系统(三层金字塔)

- **L1** 每-agent 组件 golden set;**L2** 控制面仿真;**L3** 系统八维(命门=校准 ECE + 红队免疫 + 纵向越用越好)。
- 经同一套 Consumer SPI 接入(评测=消费);golden 答案独立 namespace 不被召回。
- 校准回灌三环嵌套:内环(秒级实时消费用当前 g)→ 中环(分/时级:真值→ECE→Fitter 产候选 g'→验收门→原子替换)→ 外环(release/纵向:frozen golden 同卷复考,ΔECE↓/Δcoverage↑ append-only)。

### 内核 / 领域适配边界

内核**只**认 source/claim/relation/provenance/confidence/staleness/conflict/retrieval/write-governance。下沉 adapter:`compliant 判断 / forbidden flag / FAQ 三件套 / capability 轴 / scope / page_type 枚举`。bidding-adapter = 首个适配器。

---

## Testing Decisions

**什么是好测试**:只测外部行为,不测实现细节。最高缝 = **Consumer SPI**(recall/append/report_usage)—— 因为评测本身也走这套缝(评测=消费),所以这是 ROI 最高、最防回归的测试点,优先于任何内部缝。

**优先用既有缝、用最高缝**:

1. **Consumer SPI 契约测试(最高缝,首选)** —— 对 recall_claims/append_claim/report_usage 做黑盒契约测试:给定库状态 + query,断言召回集、confSnapshot、门过滤行为。覆盖"无出处不召回""低信不召回""矛盾两条都返""缺口零召回"等不变量。
2. **confidence g 纯函数单测** —— g 与七因子聚合是纯函数,可独立单测:输入因子向量 → 断言 raw 连续、g 单调、门边界正确。校准 ECE 用合成 reliability 数据断言可算且非平凡。
3. **commit_claim 事务测试** —— 断言"claim+出处+关系"单事务原子性;无出处写入必须失败(D1 硬门)。
4. **L1 每-agent 组件 golden set** —— 每个工种一套 golden,盯"会污染库的危险错";Distiller 抽 claim 准确率、Verifier 幻觉检出率、Reconciler 近重复识别、Arbiter 冲突裁决一致性。
5. **L2 控制面仿真** —— 给恒温器喂健康度时序,断言收敛不振荡;给 Advisor 喂候选 g',断言只有过验收门的才生效、且 `g=identity` 可即时回退。
6. **L3 系统八维 + L5 缺口题** —— 端到端经 SPI;L5 缺口题断言"门后零召回 + 记缺口",测零幻觉诚实性。
7. **红队四类样本注入** —— false/contradiction/stale/near-dup-poison 各注入,断言对应工种的免疫反应触发。

**prior art**:bidding-agent 的 benchmark service(`computeMetrics` + `readGroundTruth`)、metrics 子系统(单表事件 + 聚合)、benchmark 三件套(suites/runs/leaderboard)是直接可借鉴的测试与度量范式;Engram 的 L3 八维落库沿用"append-only 事件 + 离线聚合"模式。

**红线(测试必须守)**:A1 考卷也要被验真(题先过题的免疫流水线才晋升 golden);A3 ELO/胜负率严禁进纵向趋势与校准 g。

---

## Out of Scope

- **红蓝对抗联赛 / 市场 / 自指(设计稿 §10 北极星,Phase 4)** —— 是远期形态,**不是现在做**。解锁前置:连续可校准 conf + 独立 judge + 真实 usage 锚 三者齐备。在地基跑通前不启动。
- **横切关注点的完整方案**:认证 / 多租户 / 大规模分片 / 跨库迁移 / 强一致性 / 完整可观测体系 —— 本 PRD 只保证内核三层 + SPI + 单库可跑;这些留待后续 PRD。
- **具体领域逻辑**:compliant 判断、forbidden flag、FAQ 三件套、capability 轴等属 adapter,不进内核,不在本 PRD 实现(bidding-adapter 单独排期)。
- **bidding-agent 的迁移本身**:把现有 wiki 模块切到 Engram 是后续工作;本 PRD 交付内核 + SPI + bidding-adapter 的接入契约,不含数据迁移脚本。
- **在线 LLM meta-orchestrator**:已被架构裁决否决,不实现。

---

## Further Notes

### 推进路线(地基优先,逐阶段过门 —— 设计稿 §12)

| Phase | 内容 | 验收 / 解锁门 |
|---|---|---|
| **P0 地基** | report_usage 埋点 · confidence→连续多因子+g · 最小 SPI 三动作 | 画出第一张 reliability diagram,ECE 可算且非平凡 |
| **P1 评测点火**(<1 周,过 Gate 两件事) | 10–20 道 L5 缺口题 · prod 失败回流进回归 | 盲区有分 + 真实失败池非空 |
| **P2 内核闭环 + L1/L2** | 五工种真上线 · 每 agent 组件 golden · 恒温器仿真 | L1 各 agent P/R 绿 + L2 不振荡 |
| **P3 系统八维 + 纵向** | 八维落库 · 冻结红队代际 · 归因脊柱 | ③ECE↓ ④coverage↑ 可画曲线 + 失败可单环归因 |
| **P4 红蓝北极星**(future) | 单红队+冻结代际 →(证明不够用后)league/市场/自指 | 三前置齐备才解锁 |

### 最该先回答的一句话

> "最该先回答的不是红队怎么造题,而是 confidence 什么时候从来源计数器变成可校准的概率。"

P0 的第一件事就是这个。在它就位前,八维度数字全是幻觉。

### 现状事实(来自 bidding-agent 现有 wiki,作为反面教材与起点参考,实现前需重新 verify)

- `confidence = min(1, 来源数×0.3)` 是 v1 stub:单源(含官方 datasheet)被锁死 0.300 < 0.6 门;`claimsWithDocCount/staleDays/userApproved` 三因子 weight=0(注释说待升级,至今未升)。**这是现有 wiki 产生不了价值的结构性根因,confidence 连续化+校准是 ROI 最高的第一步。**
- 现有 `wikiEnabled=false`,内容备好但 agent 没在用 —— 印证"信不过就不会用"的恶性循环,Engram 要从信任侧破局。

### 与设计稿的关系

本 PRD 是设计稿 [`docs/design/agentic-knowledge-core.html`](./design/agentic-knowledge-core.html)(13 节/22 图)的可执行投影。设计稿是 why & what 的完整论证(含架构图、状态机、控制面、红蓝发散);本 PRD 是 build-from 的契约与排期。两者冲突时以设计稿的架构裁决为准,以本 PRD 的 scope/排期为准。

正文(Problem/Solution/Stories/Decisions)回答 **what & why**;下方 **附录 A** 把"读完仍不知道怎么写"的决策点冻结成可施工的契约(schema / 公式 / 枚举 / 状态表)。附录里所有具体数值均为**起步基线·可配置**,不是最终调参 —— 冻结的是接口与判据,不是 magic number。

---

# 附录 A · 实现规范(冻结决策点)

> 目的:把 §Implementation Decisions 里偏散文的判定,落成工程师能直接照写的契约。命名约定:SQL 列用 snake_case(`claim_text`),TS/接口用 camelCase(`claimText`),同一字段两种写法等价。

## A.1 五 primitive 的库 schema(关键字段)

```sql
-- source:不可变原文。content_hash 幂等去重;authority_score 连续、消费方可覆盖
CREATE TABLE source (
  id            UUID PRIMARY KEY,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL UNIQUE,
  kind          source_kind NOT NULL,        -- formal_document|structured_spec|human_qa|conversation_log|historical_artifact|agent_synthesis|external_feed
  authority_score FLOAT NOT NULL DEFAULT 0.5, -- 连续基线;adapter 可经 meta 覆盖,不写死等级
  meta          JSONB NOT NULL DEFAULT '{}',  -- 领域身份注入口(见 A.6),内核不解释
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- claim:事实原子。confidence 是一套(raw / g / 因子快照),非单列
CREATE TABLE claim (
  id            UUID PRIMARY KEY,
  claim_text    TEXT NOT NULL,
  subject       TEXT, predicate TEXT, object TEXT,   -- 结构化三元(用于 same_fact 判据)
  status        claim_status NOT NULL DEFAULT 'draft',-- draft|active|flagged|quarantined|superseded
  confidence    FLOAT NOT NULL,              -- = g(raw),消费门只读它
  confidence_raw FLOAT NOT NULL,             -- = base·penalties(见 A.3)
  confidence_factors JSONB NOT NULL,         -- 七因子分项 + 当时 w + calibration_version(可解释 + 复盘)
  lineage_id    UUID NOT NULL,               -- 跨版本不变身份(supersede 不改 lineage_id)
  as_of         TIMESTAMPTZ NOT NULL,        -- 原文时点(算时效)
  created_by    TEXT NOT NULL,               -- agent_id 或 user_id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- claim_provenance:D1 硬门。每条 claim ≥1 出处,无出处物理写不进
CREATE TABLE claim_provenance (
  id          UUID PRIMARY KEY,
  claim_id    UUID NOT NULL REFERENCES claim(id),
  source_id   UUID NOT NULL REFERENCES source(id),   -- NOT NULL = D1
  locator     TEXT NOT NULL,                          -- 页/行/turn 锚,可点击钻回
  excerpt     TEXT,
  relevance   prov_relevance NOT NULL DEFAULT 'supporting' -- exact|supporting|tangential|irrelevant(见 A.6)
);

-- relation:claim/page 间 typed 边
CREATE TABLE relation (
  id        UUID PRIMARY KEY,
  from_claim UUID NOT NULL REFERENCES claim(id),
  to_claim   UUID REFERENCES claim(id),
  type      relation_type NOT NULL          -- supports|contradicts|refines|derived_from|supersedes
);

-- claim_verification:三用途(D3 巡查标注 / 校准真值 / embedding 版本锚)
CREATE TABLE claim_verification (
  id         UUID PRIMARY KEY,
  claim_id   UUID NOT NULL REFERENCES claim(id),
  kind       verification_kind NOT NULL,    -- patrol|usage_truth|reembed_marker
  verdict    JSONB NOT NULL,                -- 如 {entailment:'pass'} / {outcome:'corrected'} / {embed_version:'v2'}
  by_role    TEXT NOT NULL,                 -- verifier|harvester|human:<id>(judge≠athlete:角色入表)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- page_claims:page = claim 的 M:N 组装(page 落库持久;改 claim 即改 page;page 可有 draft 态)
CREATE TABLE page_claims (page_id UUID, claim_id UUID, ord INT, PRIMARY KEY(page_id, claim_id));
```

**D1 实现**:`claim_provenance.source_id` NOT NULL;`append_claim` 在事务内先插 ≥1 provenance,否则 `RAISE`(不进库)。**append-only**:supersede 只插新 claim(同 `lineage_id`)+ 一条 `supersedes` relation,旧 claim 标 `status=superseded`,不物理删。

## A.2 Consumer SPI 契约(唯一对外缝,评测同走)

```typescript
// —— recall ——
type RecallQuery   = { text: string; facets?: string[] }
type RecallContext = { consumerId: string; taskId?: string; confidenceFloor?: number } // floor 只能更严(≥内核 0.4)
type ConfidenceSnapshot = {
  value: number; raw: number                 // value=g(raw)
  factors: Record<FactorName, number>        // 七因子分项(见 A.3)
  weights: Record<FactorName, number>        // 当时 w(配置快照)
  calibrationVersion: string                 // g 版本
  takenAt: string                            // 召回当刻(事后查会漂,必须快照)
}
type RecallResult = {
  claim: ClaimSnapshot
  conf: ConfidenceSnapshot
  provenances: { sourceId: string; locator: string; relevance: ProvRelevance }[]
  mustVerify: boolean                        // = (conf.value < 0.6);conf<0.4 的 claim 根本不出现在结果里
}
function recall_claims(q: RecallQuery, ctx: RecallContext): RecallResult[]

// —— append(乐观写入,默认 draft,强制出处)——
type DraftClaim = { claimText: string; subject?: string; predicate?: string; object?: string }
type ProvenanceInput = { sourceId: string; locator: string; excerpt?: string; relevance?: ProvRelevance }
function append_claim(d: DraftClaim, prov: ProvenanceInput[] /* 长度≥1,否则 throw */): { claimId: string }

// —— report_usage(回报使用结果,喂校准 + 失败池)——
type UsageOutcome = 'adopted' | 'corrected' | 'refuted' | 'partial'
function report_usage(claimId: string, outcome: UsageOutcome, ctx?: { taskId?: string; note?: string }): void
```

**消费门(内核强制,adapter 只能更严)**:`conf<0.4` 丢弃(不召回)· `0.4≤conf<0.6` 召回且 `mustVerify=true` · `conf≥0.6` 可直采。

**adapter 单调收紧验证**(生产 + 测试都跑):内核先算 `gConf[]`,adapter 产出 `adaptedConf[]`,断言 `∀i: adaptedConf[i] ≤ gConf[i] + ε`(只能压低)且 adapter 不得增召回、不得伪造/改写 provenance。违反即 `throw 'adapter relaxed'`。adapter 两层:**配置态**(主编在 Standards 表设 `factor_weights`/门限,改后新请求即刻重算、历史快照冻结)+ **请求态**(单次 recall 只能在配置基线上再收紧)。`provenance 权重不可为 0`(护住 D1)、`Σw ≤ 1`。

## A.3 confidence 七因子 + raw + g(命门)

**七因子规范表**(取值全归一到 `[0,1]`;w 为起步基线、可配置):

| # | 因子 | 语义 | 性质 | 起步 w | 数据源 | 算时机 |
|---|---|---|---|---|---|---|
| f0 | authority | 来源权威 | 加性 | 0.30 | `source.authority_score` | commit |
| f1 | humanReview | 人审背书 | 加性 | 0.30 | `claim_verification(kind=patrol, human)` | 人审事件 |
| f2 | entailment | 出处可推导 | 加性 | 0.15 | Verifier entailment 结果 | 巡查 |
| f3 | indepSupport | 多源独立印证 | 加性 | 0.15 | 独立 supports 源数(A.6 归一) | commit/重算 |
| f4 | usageCorrect | 使用反馈正确率 | 加性 | 0.10 | Harvester 统计 report_usage | batch |
| f5 | conflict | 活跃矛盾 | **乘性惩罚** | — | 活跃 `contradicts` 边数 | recall |
| f6 | stale | 时效 | **乘性惩罚** | — | `as_of` 与 now 的天数差 | recall |

**合成公式**(加性因子求和、惩罚因子乘性衰减,保证 `raw∈[0,1]`,且时效/矛盾按设计语义是"衰减"而非"线性扣分"):

```
base        = Σ_{i∈0..4} wᵢ·fᵢ                      # Σw=1 ⇒ base∈[0,1]
staleDecay  = 0.5 ^ (ageDays / halfLifeDays)         # halfLife 按 source.kind:formal=730 / artifact=180 / conversation=90
conflictDecay = 1 / (1 + α · activeContradicts)      # α=0.5 起步
raw         = base · staleDecay · conflictDecay      # ∈[0,1] —— 替换现状 min(1,来源数×0.3) 五档(★P0 命门)
conf        = g(raw)                                 # 见下;无法计算的因子用 neutral(印证=0、人审未发生=0、entail 未跑=0.5)
```

**g 的分档实现路径**(w 答"为什么信"=语义、g 答"数值=真实概率"=统计,二者分离;A3:ELO/胜负率严禁进 g):

1. **P0 起步**:`g = identity`(conf=raw)。先让 raw 连续化本身产生价值,reliability diagram 可画、ECE 可算即达 P0 验收。
2. **首次校准**:积累 `≥200` 条 `usage_truth` 真值后,Advisor 拟合 **isotonic**(`X=raw, y=observed_correctness, increasing=True`);temperature/Platt 为可选中间档。
3. **回灌**:候选 `g'` 必须过 A.8 验收门才原子替换;`calibration_version` 锚定快照,`code_version` 变更标记历史 raw/conf 不可比。
4. **回退**:`g=identity` 一个 flag 即时回到裸 raw(Story 29 可逆红线)。

## A.4 claim 状态转移表

| from → to | 谁可触发 | 条件 |
|---|---|---|
| (新) → draft | append_claim | 默认;影子区不召回 |
| draft → active | agent/Verifier(蓝·收紧) | `conf≥0.5` **且** entailment pass(强源 primary 可自动);或人 Approve |
| active → flagged | Verifier(蓝) | 检出疑似幻觉 / 跌破门 / 新冲突 |
| flagged → quarantined | Verifier/Arbiter(蓝) | 仍无确凿支持;或人 Reject |
| * → superseded | Distiller/Arbiter(蓝) | append 新版本(同 lineage_id)时自动标旧 |
| quarantined/flagged → active | **仅人**(红·放松) | 主编 赦免 / 找到新正向 exact 证据 |
| superseded → active | **仅人**(红) | 主编 回滚 |

蓝边只收紧、红边才放松;刻意不对称。`status` 由上表事件驱动,不由 `confidence` 单独决定(但晋升条件读 conf)。

## A.5 冲突收敛(确定性、可回归)

**优先级(自上而下,先命中先裁)**:`① 人工裁定 > ② 取代关系(supersede)> ③ 时效(as_of 新)> ④ 来源权威 > ⑤ 独立印证数`。

**Arbiter 机判 vs 升级分工**:②③④⑤ 能产出**唯一**胜者 → Arbiter 机判自裁(落 contradicts + 采信标记,不惊动人);若并列(同权威同时效)或证据不足 → 升级主编,主编用同一张优先级表 + ① 人工裁定手裁。两条路径**共用同一张优先级表**,只是 ① 仅人可用。

## A.6 派生算法冻结

- **entailment 定义**:claim 表述能否从其 provenance 原文逻辑推出。`pass`=可推 / `fail(幻觉)`→flagged / `与他 claim 不可同真`→推 conflict 队列给 Arbiter。
- **provenance relevance 四档**:`exact`(原文明确陈述该命题,含定量否定)/`supporting`(间接支持)/`tangential`(相关不决定)/`irrelevant`。**NC-exact 红线**:判 `non_compliant`/`refuted` 须 ≥1 条 `relevance=exact` 的反向证据,否则拒判、强制升级人(`exact` ⟺ 原文明确反向命题,区别于仅语义蕴含的 `supporting`)。
- **lineage 两阶段**:① 召候选:embedding `top-k=50` + 相似度 `≥0.75`,并 subjectKey 串联。② 判同:确定性规则 `subject≡∧predicate≡∧object 数值等价(单位归一)→same(共 lineage_id)` / `object 反向→contradicts` / `predicate 细化→refines`;三规则都不中且相似度 `≥0.65` → 灰区一次 LLM 判 `{same|refines|contradicts|unrelated}`。
- **独立来源 + 印证计数**:`independent(s1,s2) = s1.id≠s2.id ∧ hash≠ ∧ ¬∃ derived_from 血缘路径`。印证只数独立 supports 源;`agent_synthesis` 衍生源按上游独立性打折(0.5)、`hash` 相同不计 —— 防同源刷印证。
- **near-dup-poison(Reconciler)**:embedding 近 + `subject≡` 但 `object` 被悄悄改小/反 = 可疑 → 调 entailment 验 `A.object ⊆ B.object`?是真精炼(refines)否则疑投毒 → flagged 升 Arbiter。
- **使用反馈 → f4 映射**:`report_usage` 落 `claim_verification(kind=usage_truth)` → Harvester batch 统 `observed_correctness = adopted / (adopted+refuted)`(只计**独立用户/不同 task**,同源刷单不计)→ `f4 = clamp(observed·k − 0.5, 0, 1)`,样本不足(`n<N`)的 claim f4 压低。
- **source.meta 业务注入示例**:`{"domain":"bidding","source_type":"official_datasheet","product_id":"SKU-123"}`;adapter 在 recall 回调里读 `meta.source_type` 抬该 claim 的 authority 因子,**内核不感知业务语义**。
- **embedding 版本锚**:embedding 作用于 `claim_text`,commit 时算,pgvector+HNSW;model 升级 → 标 `claim_verification(kind=reembed_marker)` → 后台 cron 批量重嵌(跳过已是新版的),版本号随快照走。

## A.7 五工种编排 + loop 判据

**事件驱动 choreography(无在线 meta-orchestrator)**:

| 工种 | 触发 | 形态 | 失败降级 |
|---|---|---|---|
| Distiller | `source.ingested` | **有界 loop**(maxSteps+预算池) | 降级:标 source 待人工,不阻塞 |
| Verifier | 每日 cron + draft/flagged 入队 | 函数/统计 + 点状 1×LLM | 跳过本轮,下轮重试 |
| Reconciler | `batch_appended` | 函数 + 灰区 1×LLM | 保守:不合并,留两条 |
| Arbiter | `conflict.detected` | **有界 loop** | 升级主编 |
| Harvester | report_usage batch + 每日 | 纯统计 | 无 g 更新,维持现状 |

**loop vs one-shot 工程判据**:执行前状态空间是否已收敛 —— `若需多步、且下一步依赖上一步产出(分支因子运行时才知)→ 真 agent loop(Distiller/Arbiter);否则 = 函数/统计 + 点状一次 LLM(内嵌 1×LLM ≠ loop)`。judge≠athlete:各工种带独立逻辑角色(`by_role` 入 `claim_verification`)+ 会话审计,巡查者不给自己背书;物理 DB role 隔离(CREATE ROLE / RLS)**待实现**,当前角色边界由应用层守卫强制(见 EGR-CR-006)。

## A.8 控制面:恒温器五指标 + Advisor 验收门

**GovernanceController(确定性恒温器)**周期比对五标量,健康度下降则**收紧 D2**(抬 draft→active 晋升门 / 提高 Verifier 巡查频次):

| 指标 | 含义 | 收紧动作(示例) |
|---|---|---|
| distillBacklog | 蒸馏队列积压 | 限流 ingestion |
| entailRejectRate | entailment 拒绝率 | 抬晋升门 |
| conflictQueueDepth | 待裁冲突深度 | 提 Arbiter 优先级 |
| immuneLag | flag→quarantine 中位延迟 | 提 Verifier 频次 |
| falseQuarantineRate | 人工翻案的误隔离率 | 放宽巡查激进度 |

**Advisor 验收门(确定性函数,守住"否决在线 meta-orchestrator"红线)**:Advisor 只读 + 只产建议(候选 `g'`/策略),必须绑定**验证依据**(golden 上的 ΔECE)。验收门 = 确定性函数,5 项全过才 `approve`:`① g' 单调? ② 值域∈[0,1]? ③ 消费门翻转受控(不剧烈)? ④ 不与恒温器当前动作冲突? ⑤ 每个校准桶样本足?`。`approve`→原子提交;`reject`→记日志、**fail-silent 维持现状**(不阻塞)。能力(Advisor 诊断)与权力(门拍板)分离;失效静音退回三层主干。

## A.9 评测落地

- **L1 每-agent golden**(`tests/data/l1-{agent}.jsonl`,CI 红线):Distiller=5 种 kind 各样本,断言 claim 抽取准确率≥95% + provenance 不错位;Verifier=50 条各状态 claim + 人工 entail 真值,断言 flag/quarantine 与人一致;Reconciler 分层 L1a(规则可判 same)/L1b(灰区 refines)/L1c(反向 contradicts);Arbiter=真实矛盾对 + "该信谁"标注,断言裁决顺序一致。
- **L5 缺口题**(季度冻结):金标 = `recall 返回空集 ∧ 记 gap 事件`。生成路径:从 prod `report_usage` 驳回池采"当时 recall 空/被纠正"且人工确认"库里确无" → QA 过门入库。断言:`recall.length===0 ∧ ∃ metrics_events(kind='gap_recorded')`。若某版本开始能答某 L5 题 → 移出 L5、进归因脊柱(证明"长出了知识")。
- **与 bidding-agent 隔离**:Distiller 若复用 bidding 的 column-analyzer 逻辑,Engram 的 L1 golden **不得混入** bidding benchmark 的 golden;若新写,先在相同标书上对标旧提取准确率差 `<5%` 再上线。golden 答案放独立 namespace、只判分不召回(防 KB 泄漏虚高)。
