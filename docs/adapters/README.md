# Engram · 新领域接入指南（adapter onboarding）

> 给谁看：想把 Engram 接到一个**新领域**（客服 / 合规 / 研发 / 科研 / 投研 / 临床，乃至 agent 自己的长期记忆）的人。
> 一句话：内核领域无关，bidding 只是**第一个** adapter；接一个新领域 = 写一个 SPI 之上的**单调收紧** adapter + 备一个**真值源**，内核不动。
> 上游契约：`docs/PRD.md` 附录 A（schema / SPI / 七因子 / 状态表）· 架构裁决以 `docs/design/agentic-knowledge-core.html` 为准（FIG 5b 适配分层 / FIG 8b 部署边界）。

---

## 0. 先别写代码：判断你的知识是不是 Engram 的形状

Engram 不是对所有知识通吃的 KB。它的整套机器（强制出处、七因子 confidence、校准 g、免疫巡查、越用越准）都建立在四条**对知识形状**的硬预设上。先过这四条 gate，再决定要不要接。

| # | 预设 | 不满足会怎样 |
|---|---|---|
| P1 | 知识能拆成**原子事实**（subject-predicate-object），而非一段叙事 / 一套手感 | lineage、same_fact、conflict 判据全部失效 |
| P2 | 每条事实有**可点回的出处** | 撞 D1 硬门（`claim_provenance.source_id` NOT NULL），物理写不进 |
| P3 | 事实有**真 / 假**，且"真的概率"**可被校准** | 七因子 → g → ECE 整条命门空转，confidence 是装饰 |
| P4 | 存在一个**反馈回路**喂真值（`report_usage`） | g 永远拟合不出来，所有评测数字是"对不存在系统的幻觉" |

**判定**：四条全中 → 直接接，几乎不用碰内核。缺 P1/P3（流程性 / 主观 / 无真假知识）→ 不要接，硬塞只会退化成"慢 RAG"。缺 P4（接不到真值源）→ 可以先接，但要知道 confidence 停在 `g=identity`、命门未点亮（见 §3.2）。

> 真正的适用半径**不由领域划**，由"这块知识是不是带出处、可判真假、有反馈回路的原子事实"划。详见根因讨论（本仓库 conversation / HANDOFF）。

---

## 1. 内核 / adapter 边界（C6）：什么下沉、什么绝不下穿

内核**只**认 9 个抽象概念：`source · claim · relation · provenance · confidence · staleness · conflict · retrieval · write-governance`。一个领域词都没有。

| 留在内核（领域无关） | 下沉到 adapter（领域语义） |
|---|---|
| 五 primitive schema + 状态机 | `compliant` 判断 / `forbidden` flag / FAQ 三件套 |
| 七因子合成 + g 校准 + 消费门 | capability 轴 / scope / page_type 枚举 |
| 强制 provenance（D1）/ 乐观分级（D2）/ 巡查（D3） | 把某 source 标成"官方 datasheet"这类**业务身份** |
| 冲突优先级裁决 / lineage / 独立源印证 | 授权策略 / 业务关系映射 / 客户隔离 / 领域分类 |

**C6 红线：业务语义到此为止，绝不下穿。** 内核连"什么是合规"都不知道——它只知道"这条 claim 的 authority 因子被 adapter 抬高了 0.2"。

---

## 2. 接入要做的三件事

### 2.1 实现一个 adapter（SPI 之上的单调收紧算子）

adapter 经 **Consumer SPI** 消费内核，**绝不反向依赖内核内部**（workspace 依赖方向恒为 `adapter → core`）。SPI 三动作是唯一对外缝，评测也走同一套缝（评测=消费，无旁路）。

**SPI 表面现状**（务必区分已实现 / 契约待实现）：

| 动作 | 语义 | 现状 | 位置 |
|---|---|---|---|
| `addSource(db, SourceInput)` | 幂等入原文（content_hash 去重，meta 透传） | ✅ 已实现 | `packages/engram-core/src/spi/append-claim.ts` |
| `appendClaim(db, DraftClaim, ProvenanceInput[])` | 乐观写入，默认 draft，**强制 ≥1 出处**，单事务 | ✅ 已实现 | 同上 |
| `supersedeClaim(...)` | append-only 取代（同 lineageId + supersedes 边，旧标 superseded 不删） | ✅ 已实现 | 同上 |
| `recallClaims(db, embedder, query, ctx?) → RecallResult[]` | 检索：候选近邻 → 七因子聚合 → g → 消费门过滤 → 拍 `ConfidenceSnapshot` | ✅ 已实现 | `packages/engram-core/src/spi/recall-claims.ts` |
| `reportUsage(db, claimId, outcome, ctx?) → { verificationId }` | append-only 写 `usage_truth`，喂校准 + 失败池；**不动 `claim.confidence`（解耦）** | ✅ 已实现 | `packages/engram-core/src/spi/report-usage.ts` |

> ✅/⏳ 状态以内核公共 export 面 `packages/engram-core/src/index.ts` 为准（上表「位置」列指向真实现文件）。
>
> 写入侧（addSource / appendClaim / supersedeClaim）+ 消费侧（recallClaims / reportUsage）SPI **均已落地**，现在就能接「完整闭环消费」的 adapter。`outcome` 合法取值见单一真相源 `USAGE_OUTCOMES = ['adopted','corrected','refuted','partial']`（`packages/engram-core/src/spi/report-usage.ts`），其中 `FAILURE_OUTCOMES = ['corrected','refuted']` 进失败池。

**adapter 的两层能力**（PRD A.2 / 设计稿 FIG 5b）：

- **配置态**：主编在该领域的 Standards 页设 `factor_weights` / 门限 / 半衰期。改后**新请求即刻重算，历史快照冻结**。这是"人定标准、影响内核默认基线"。
- **请求态**：单次 recall 里只能在配置基线上**再收紧**。这是"消费策略、永远不能放宽配置态基线"。

**单调收紧不变量（生产 + 测试都断言，违反即 throw）**：

```
内核先算 gConf[]，adapter 产出 adaptedConf[]，必须满足：
  ∀i: adaptedConf[i] ≤ gConf[i] + ε        // 只能压低，不能抬高召回置信
  且 adapter 不得增召回、不得伪造 / 改写 provenance
  且 provenance 权重不可为 0（护住 D1）、Σw ≤ 1
违反 → throw 'adapter relaxed'
```

这条是"挂多少领域 adapter，内核三条安全不变量（无出处不召回 / 低信不召回 / 矛盾显式）永远成立"的**数学根基**，不是约定俗成。

### 2.2 备一个真值源（接 P4，否则命门不亮）

confidence 从"来源计数器"变成"可校准概率"靠 `report_usage` 喂的 observed correctness。**新领域必须回答：我从哪知道一条 claim 后来是对是错？**

- 投标域：人工驳回 / 用户纠正 → `report_usage(corrected|refuted)`。
- 客服域：工单是否解决、回访满意度。
- 科研域：后续被引证实 / 证伪。
- agent memory 域：这条经验下次复用时是否站得住。

没有真值源 → g 停在 `g=identity`（conf=raw），P0 验收（画出 reliability diagram、ECE 可算）就达不到。**这是接任何新领域的真正前置门，比写 adapter 更硬。**

### 2.3 用 `source.meta` 注入业务身份（不污染内核）

业务身份走 `SourceInput.meta`（JSONB），内核**原样存、不解释**。adapter 在 recall 回调里读 meta 来收紧。

```jsonc
// addSource 时注入，内核不感知任何 key 的语义
{ "domain": "bidding", "source_type": "official_datasheet", "product_id": "SKU-123" }
// adapter 在 recall 回调读 meta.source_type，抬该 claim 的 authority 因子 —— 内核全程不懂"datasheet"是什么
```

---

## 3. 接入 checklist（逐项勾）

**Gate（接之前）**
- [ ] 过 §0 四条预设：P1 原子事实 / P2 有出处 / P3 可判真假 / P4 有真值源。缺哪条、后果是否可接受，写下来。

**adapter 实现**
- [ ] 新建 `packages/<domain>-adapter` 包，依赖方向 `adapter → @engram/core`，**不反向依赖**内核内部。
- [ ] 定义该领域的 `source.meta` schema（业务身份 key），并在 `addSource` 时注入。
- [ ] 实现配置态：该领域的 `factor_weights` / 门限 / 半衰期（落 Standards，不硬编码进内核）。
- [ ] 实现请求态收紧回调，并写**单调收紧断言测试**（`adaptedConf ≤ gConf + ε`、不增召回、不改 provenance、provenance 权重 ≠ 0、Σw ≤ 1）。
- [ ] 选好 `source.kind`（见 §4 耦合点）：能落进现有 7 枚举就用现有；若必须新增 = **内核改动**，走内核评审。

**真值源**
- [ ] 明确该领域 `report_usage` 的真值从哪来（谁、何时、怎么判 adopted/corrected/refuted/partial）。
- [ ] 真值只计**独立用户 / 不同 task**（防同源刷单），样本不足的 claim f4 压低。

**评测（走同一套 SPI 缝）**
- [ ] 该领域的 L1 golden **独立 namespace**，不与 bidding 的 golden 混；golden 答案只判分、不被召回（防 KB 泄漏虚高）。
- [ ] 若复用了 bidding 的抽取逻辑（如 column-analyzer），先在相同语料上对标准确率差 `<5%` 再上线。
- [ ] 准备 L5 缺口题（库里本无答案，正解=门后零召回 + 记缺口），测该领域的"该说不知道时说不知道"。

**红线复核（不可破，CLAUDE.md 永久红线）**
- [ ] 强制 provenance：无出处物理写不进（D1）。
- [ ] 只人能放松：adapter / agent 只能收紧，赦免 / 回滚 / 解隔离仅人可做。
- [ ] NC / refuted 须 ≥1 条 `relevance=exact` 反向证据，否则拒判、升级人。
- [ ] 评测的 ELO / 胜负率严禁进校准 g 和纵向趋势（防 Goodhart）。

---

## 4. 内核耦合点 / 扩展点（诚实清单）

"领域无关"做得很彻底，但仍有少数地方接新领域**可能要碰内核**——提前知道，别接到一半才发现：

1. **`source_kind` 是内核 enum**（`formal_document | structured_spec | human_qa | conversation_log | historical_artifact | agent_synthesis | external_feed`，见 `schema.ts`）。它领域无关、覆盖面广，但若某领域的"读法"无法归入这 7 类，新增一个值 = 改内核 enum + 迁移，不是 adapter 私事。先尽量映射到现有值。
2. **半衰期按 kind 取**（`staleDecay = 0.5^(ageDays/halfLife)`，formal=730 / artifact=180 / conversation=90，PRD A.3）。新领域时效特性差异大时，halfLife 应做成配置态（按 kind 或按 meta），而非新增 kind。
3. **七因子语义是内核固定的**（authority / humanReview / entailment / indepSupport / usageCorrect / −conflict / −stale）。adapter 调的是**权重 w**，不是因子集合。某领域要全新一类信号 → 先问能不能映射到现有七因子，不能才上内核议题。
4. **治理回路假定有人类主编**（红边放松仅人可做）。纯单 agent 的 memory 场景没有这个角色，那套人审 inbox 会悬空——要么退化成全自动（牺牲安全不对称），要么补一个"弱化版自治主编"，**设计稿当前未覆盖，属待补**。

> 判据：碰 schema / enum / 因子集合 / 状态机 = 内核改动，走内核评审；碰 w / 门限 / 半衰期 / meta 解释 = adapter 私事，随便改。

---

## 5. 候选领域速查（按契合度）

天然契合（同 bidding 形状，换 adapter 即用）：

| 领域 | 为什么是 Engram 的形状 | 命中的内核机制 |
|---|---|---|
| 合规 / 法务 / 政策 | 必须引条款、法规会变、新旧互相取代 | provenance + staleness + supersede + **NC-exact 红线** |
| 客服 / 售后 | 文档互相矛盾、要给引用、FAQ 去重蒸馏 | 矛盾两条都留 + 跨源印证 + claim 即用 |
| 研发知识 / ADR / postmortem | "当初为何选 X"、决策被推翻要标过时 | supersede + lineage + 冲突裁决 |
| 科研文献事实层 | "某研究发现 Y"、研究打架、引用=出处 | 几乎是字面模型：带证据 + contradicts 边的科学 claim |
| 金融 / 投研情报 | 公司事实、报告打架、来源权威、时效命门 | authority 因子 + conflict + stale |
| 医疗 / 临床决策支持 | 必须引证、时效要命、禁忌需硬证据 | provenance + NC-exact（高风险强监管，慎接） |

最有野心、最贴名字（engram=记忆痕迹）：

- **agent 自己的长期记忆**：出处=对话 / commit，confidence=经验是否站得住，supersede=被新事实推翻。相对普通 vector memory 的杀手锏是**免疫系统 + 裁判≠运动员**，能防 agent 把自己的幻觉当记忆复读。注意 §4-4 的主编悬空问题。
- **多 agent 编队共享记忆 / 黑板**：独立 DB role + 会话隔离本就是为"防一个 agent 的幻觉污染全队"造的。

**不要接**（硬塞会让命门空转、退回慢 RAG）：

- 流程性 / 手感性知识（怎么做某事、调参直觉）—— 违反 P1 / P3。
- 纯主观 / 偏好类（"用户喜欢蓝色"）—— 违反 P3。
- 高频实时数据（报价、传感器流）—— staleness 是半衰期不是实时，用普通 DB 更对。
- 创作 / 叙事类 —— 无法原子化、无真假。

---

## 6. 参考

- `docs/PRD.md` 附录 A.2（SPI 契约）· A.3（七因子 + g）· A.6（派生算法 + `source.meta` 注入示例）· A.9（评测隔离）。
- `docs/design/agentic-knowledge-core.html` FIG 5b（adapter 单调收紧分层）· FIG 8b（SPI 边界以下全部领域无关可复用）。
- `packages/engram-core/src/spi/append-claim.ts`（写半边 SPI 实现）· `packages/engram-core/src/db/schema.ts`（五 primitive + 枚举）。
- `packages/bidding-adapter/`（首个 adapter：已经 Consumer SPI 单调收紧消费内核 —— `src/index.test.ts` 真实 `recallClaims` 并断言收紧；仍缺 server / UI / real-bidding 端到端集成）。
