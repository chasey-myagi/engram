# Engram · Handoff(交接给下一会话)

> 这份文档记录的是**思路、由来、被否决的方案、未决项**——即"为什么是现在这样"。
> **不重复** PRD / 设计稿里已有的内容,只指路。先读这三个产物再读本文:
> - 可执行 PRD:[`docs/PRD.md`](./PRD.md)(正文 + 附录 A 冻结决策点)
> - 设计稿(13 节/22 图,why & what 的完整论证):[`docs/design/agentic-knowledge-core.html`](./design/agentic-knowledge-core.html)(本地 `open`)
> - 长期记忆:`~/.claude/projects/-Users-chasey-MOI-projects-bidding-agent/memory/project_wiki_kernel_redesign.md`

---

## 0 · 现状（2026-06-18 更新 · ⚠️ 以本节为准；下文 §1/§6/§7/§9 是早期快照已过时）

**实现早已不是 ≈0。** engram 已建出 **P0–P3 + P4b 自闭环 runner**，并刚完成一轮 **code-review 台账清零**（24/24 修复合入 main，全程 review-gate 三门 + 组合态验证）。

- **仓库**：`chasey-myagi/engram`（GitHub，有 remote），本地 `~/Dev/personal-projects/engram`，默认/集成分支 **`main`**，迁移链到 `0025`。pnpm monorepo 三包：`@engram/core`（内核）+ `@engram/workers`（5 工种 + 红蓝对抗 + P4b `EngramRunner`）+ `@engram/bidding-adapter`。测试需 pg 5433（`docker compose up -d db`），现 **660(core)+259(workers) 测试绿**。
- **管理面**：经 项目看板（workspace Chasey，Engram project `ec90df1a`，issue 镜像自 GitHub、带 `repo:engram`）。GitHub=代码真相，项目看板=管理面。
- **实现进度**：P0 连续 conf+g / P1 评测 / P2 五工种+L1·L2 / P3 系统八维+纵向+归因脊柱 + P4b 红蓝代际自闭环 **均已落地并加固**。**命门（confidence 连续化+校准）早已解决**；CR-003（recall_snapshot 绑定）刚把「真实 usage 锚 + 校准完整性」补到位。
- **本轮关键裁决（owner 拍板）**：EGR-CR-006 走**方案 B**（文档诚实化，真 DB role/RLS 隔离延后）；EGR-CR-003 走**方案 A**（recall_snapshot 表绑定预测概率 + 校准 INNER JOIN 硬排除裸行 + report 校验 by_role）。
- **下一阶段（已建票，GitHub→项目看板 镜像）**：
  - `#199`(CHA-178, AFK · **进行中**) seedRecallSnapshot test-only helper 移出 `@engram/core` 公开 barrel。
  - `#200`(CHA-177, HITL · backlog) 工种物理 DB role/RLS 隔离（CR-006 方案 A，延后；触发条件：不可信 worker / 多租户 / 合规）。
  - `#201`(CHA-176, EPIC · needs-decision · backlog) **P4 红蓝北极星**——PRD 明确远期，3 前置（连续可校准 conf ✅ / 独立 judge 待确认 / 真实 usage 锚 ✅）齐备才解锁；含待决策（蓝队评分 0/1 vs Brier、红队信息档位、ELO 是否进对客报告）。
- **harness-pi 上游**：DX #38/#39 已 CLOSED，engram 锁 `@earendil-works/pi-ai ^0.2.1`（详见 `engram/CLAUDE.md`）。

> 下文 **§2 由来 / §3 已定架构裁决 / §5 审美方向 仍有效**（历史与决策，别推翻）；**§1 / §6 / §7 / §9 是 greenfield 初期快照，已被本节取代**。

## 1. 一句话现状（⚠️ 早期快照，现状见 §0）

Engram = agent 原生可生长知识库,**独立产品**(原 repo: `~/MOI/projects/engram`,commit `5a6fda8`,无 remote)。~~当前是设计稿 + 可执行 PRD,实现 ≈ 0~~ **← 已过时：实现已达 P0–P3+P4b、有 GitHub remote，见 §0**。bidding-agent 是 Engram 第一个领域适配器,不是主人。

## 2. 由来:这个想法怎么长出来的(对话轨迹)

按时间,每一步都是用户主动转向的结果——下一会话别把它当"我的发挥",这是用户定的方向:

1. 「看看 wiki 知识库」→ 检视 bidding-agent 现有 wiki 模块。
2. 「单独拎出来开发」→ 想抽出来独立做。
3. 「别太结合 bidding 业务逻辑,基于 wiki 知识库的原理和核心做」→ 转向第一性原理。
4. 「**彻底忘掉现有实现,当成独立完整的 agent 知识库项目**」→ greenfield,去 `kb_` 前缀、零 file:line、零"演进自"。这是最关键的一次转向:**不要回去抄现有 wiki 的设计**。
5. 「画!用 HTML 画精美一点」+ ultracode → 产出设计稿 HTML。
6. 多轮打磨:Part1/2 结合(不是分别加厚/缩减)、图表优先、逐图统一尺寸/字号/留白。
7. 「agent team 要不要 meta-agent 编排?各 agent 是 one-shot 还是 loop?怎么评判够好?要 benchmark 吗?」→ 加 §9 编排 + §10 评测。
8. 「benchmark 不只整体,每个 agent 也要」→ per-agent benchmark(L1)。
9. 「能否在 benchmark 上演红蓝对抗?发散一下」→ 探索红蓝。
10. 「红蓝=北极星 + 近期两件事,凝成 §10 小节 + 画闭环图 + 写推进路线 + 补未定义机制」→ §10c/§11/§12/§13。
11. (本会话)最后一轮**视觉统一打磨**(见 §4)。
12. (本会话)`to-prd` → 独立 repo + 可执行 PRD + 附录 A(见 §5)。

## 3. 已定的架构裁决(settled,别重新辩论)

这些在设计稿里有完整论证,这里只列"已拍板、不要回炉"的清单:

- **否决在线 LLM meta-orchestrator**。采纳:数据面 choreography + 确定性恒温器 + 旁挂离线 Advisor 经确定性验收门。**能力(诊断)与权力(拍板)分离**。
- **乐观写入 / 悲观消费**,由动态 confidence 耦合。
- **事后免疫**:唯一事前硬门 = provenance NOT NULL(D1);其余 D2 乐观分级 + D3 verifier 巡查。
- **内核 / 领域适配分层**:内核只认 source/claim/relation/provenance/confidence;compliant 判断、forbidden flag、capability 轴等全下沉 adapter。
- **三层不塌缩**:raw source → claim → page。claim 是**唯一召回单元**。
- **agent 写,人主编**(只审异常/裁冲突/纠错,不录入)。
- **三层 benchmark 金字塔**(L1 组件 / L2 控制面仿真 / L3 系统八维)。评测=消费(同走 Consumer SPI)。
- **红蓝对抗 = Phase 4 北极星,不是现在做**(见 §6 的硬约束)。
- **永久红线**:① provenance 强制;② 仅人可放松 claim 状态(agent 只收紧);③ NC/refuted 判定须 ≥1 exact 反向证据;④ **A1 考卷也要被验真**;⑤ **A3 ELO/胜负率严禁进校准 g 和纵向趋势**(Goodhart)。
- **工程冻结(本会话附录 A 定)**:七因子 = 5 加性(Σw=1→base∈[0,1])+ 2 乘性惩罚(stale 半衰期、conflict 衰减)→ raw∈[0,1];**g 起步=identity**,≥200 真值后 Advisor 拟合 isotonic 过验收门替换;冲突优先级确定性规则 `人>supersede>时效>权威>印证`。

## 4. 本会话的两件事(细节,便于复现/续做)

### 4.1 设计稿视觉统一打磨
对 `agentic-knowledge-core.html` 做了最后一轮统一(改的是 bidding-agent 那份,**随后整份 copy 进 engram**,两份在 copy 当刻一致)。手段:7-agent 并行几何审计 + 我亲自核源裁定。要点:
- House Style 已编码:字号∈{8,9,10,11,12,13,14,16,20}、描边∈{1,1.2,1.6,2}、圆角∈{6,8,10,12}、文字 fill 只用 `var(--token)`。
- 修了 FIG 6b/7b/10a/11a 的零散不一致;**FIG 10c 整体重排去密**(两条挤叠+畸形的飞轮弧合并成一条;题免疫/蓝队副标题原本溢出盒子~30-76px,精简到不溢出;viewBox 348→360)。
- 驳回了 1 条审计误报:FIG 4a `secondary` 用裸 oklch 是**故意的四级权威色彩渐变**(无对应 token),不是缺陷。

⚠️ **设计稿现在有两份**:`bidding-agent/docs/4.0-scope/agentic-knowledge-core.html`(原始)和 `engram/docs/design/agentic-knowledge-core.html`(独立产品副本)。**今后改设计稿只改 engram 这份**,避免分叉;bidding 那份视作历史。

### 4.2 to-prd → PRD
- 偏离 to-prd 默认("发布到 bidding-agent issue tracker"):按用户指令改为**写进独立 repo 的文件**,`ready-for-agent` 标在 PRD 头部。
- 起草后跑 **4-critic 对抗评审**(完整性×2 / 可执行性 / 一致性,15 high + 24 med)。定论:**架构忠实,但工程精度不足,工程师读完不知道怎么写**(~78% / 7.2)。→ 把高/中价值发现冻结成 **附录 A(A.1-A.9)**:五 primitive SQL schema、Consumer SPI 的 TS 契约、七因子+g 公式、claim 状态转移表、冲突优先级、派生算法(lineage/独立来源/near-dup-poison/entailment/relevance 四档)、五工种编排+loop 判据、恒温器五指标+Advisor 验收门、L1/L5 评测落地。
- 附录 A 所有数值标注"起步基线·可配置"——冻结的是接口与判据,不是 magic number。

## 5. 设计稿的审美方向(改 HTML 前必读,否则会跑偏)

这是踩过坑后定的,别推翻:
- **基调 = 暖色工程图纸 / 解剖图谱**(warm engineering blueprint),不是炫酷。
- **明确反对**:① 霓虹发光 on black(neon-on-black);② 紫雾(purple-haze);③ 高饱和 editorial 风。这三条是项目 anti-reference,我第一版就踩了前两条、被 impeccable 纠回。
- 用项目自有的暖墨色 + 实心 plum + 语义色(saffron/emerald/info/terra)。字体 DM Sans / Playfair Display / JetBrains Mono。oklch 色彩空间,light/dark 双主题。
- ⚠️ Chrome 插件 `mcp__claude-in-chrome__*` 被禁(全局 CLAUDE.md),**无法渲染截图肉眼验图**——SVG 一致性只能靠读源码 + 几何推算(本会话审计就是这么做的)。

## 6. 最该先回答的一句话(命门)

> **confidence 什么时候从"来源计数器"变成"可校准的概率"。**

现状根因(bidding-agent 现有 wiki,**用前仍需 verify**):`confidence = min(1, 来源数×0.3)` 是 stub(`src/server/kb/wiki-confidence.ts:56`),单源含官方 datasheet 被锁死 0.3 < 0.6 门;`wikiEnabled=false`;prod 仅 10 个真实页全单源→全 0.3。**这是现有 wiki 产生不了价值的结构性根因。** 在 confidence 连续化+校准就位前,所有八维度评测数字都是对不存在系统的幻觉——所以红蓝是北极星(Phase 4),不是现在做。

推进顺序(PRD §Further Notes 有表):**P0 地基**(confidence→连续+g、report_usage 埋点、最小 SPI)→ **P1 评测点火**(<1 周:10-20 道 L5 缺口题 + prod 失败回流)→ P2 内核+L1/L2 → P3 系统八维+纵向 → P4 红蓝。

## 7. 未决项(用户尚未拍板,下次可主动问)

1. **要不要 `to-issues`** 把 PRD 五阶段路线拆成 tracer-bullet issues?(上一轮我提了,用户还没答)
2. **要不要真的开始实现 P0**?(目前全是设计/PRD,用户没下"开干"指令——别擅自动手写实现代码)
3. 红蓝 Phase 4 **到底做不做**?(北极星可以永远是北极星)
4. 蓝队评分 **0/1 还是 Brier**?红队信息**档位**从哪起?
5. **ELO 能否出现在对客报告**?(我建议立成治理红线:不进对客报告;待用户确认)
6. PRD 附录 A 的**起步数值**(七因子权重 0.30/0.30/0.15/0.15/0.10、半衰期 730/180/90、α=0.5、isotonic 触发阈 200 等)需在实现时用真实数据调——它们是占位基线不是定论。

## 8. 给下一会话的建议 skill

- **`to-issues`** —— 若用户同意,把 `docs/PRD.md`(尤其五阶段路线 + 附录 A 的可施工单元)拆成可独立认领的 issues。
- **`impeccable`** —— 任何对设计稿 HTML 或未来主编 Studio / 评测看板 UI 的设计改动,走它(注意 §5 审美红线 + 无法截图验证的约束)。
- **dev 类**(`tdd-workflow` / `test-review` / `code-review`)—— 一旦进入 P0 实现。测试最高缝 = **Consumer SPI**(评测=消费),见 PRD §Testing + 附录 A.9。
- ⚠️ 全局规矩:**说中文**;除非明确要求不写总结文档;新项目 engram 无 remote,push/commit 前问用户。

## 9. 关键路径速查

| 东西 | 位置 |
|---|---|
| 可执行 PRD | `~/MOI/projects/engram/docs/PRD.md` |
| 设计稿(权威,独立产品副本) | `~/MOI/projects/engram/docs/design/agentic-knowledge-core.html` |
| 设计稿(历史原件,勿再改) | `~/MOI/projects/bidding-agent/docs/4.0-scope/agentic-knowledge-core.html` |
| 长期记忆 | `memory/project_wiki_kernel_redesign.md`(+ `MEMORY.md` 索引) |
| 现状根因代码(verify 用) | `bidding-agent/src/server/kb/wiki-confidence.ts:56` |
| repo HEAD | engram `5a6fda8`(无 remote) |
