# Engram

> agent 原生的可生长知识库**内核**。**一条 claim = 一个 engram。**
> 不是 RAG —— 召回的是已判定、带强制出处、带可校准置信的**事实原子**,不是相似度切片。

Engram 是一个**领域无关**的事实层:把杂乱的 raw 来源(文档、历史标书、合同、聊天记录、ask_user 的 Q/A)蒸馏成**带强制出处、可校准置信、能钻回原文**的 claim,供任意 agent 在 loop 内**写得快、信得慢、越用越准**地消费。

`@engram/bidding-adapter` 是第一个领域适配器(consumer),不是主人。内核对任何业务零认知。

---

## 状态

**内核 + 五工种 + 自闭环全部实现,可在本机跑通 demo。** 整份 PRD(P0–P3,垂直切片 S1–S31)+ 追加的 P4 红蓝对抗北极星(P4a 对抗回合 + P4b 可执行自闭环)已落地,每片过 test / code / linus 三门禁后合入 `dev`。`pnpm -r test` = **638 测全绿**(core 492 / workers 134 / bidding 12)。

**还没做的(诚实边界,见下方[「还没做」](#还没做))**:没有 HTTP/WebSocket server、没有前端 UI / 主编 Studio、wiki page 人读视图未渲染、bidding 无真实投标业务逻辑、生产数据/真 LLM 端到端尚未接入(demo 全走 fake 端口)。**「能跑起来」= 命令行 demo 打通遥测,不等于产品级服务。**

---

## Quickstart

需要 **Node ≥ 22**、**pnpm**(`pnpm@10.15.0`)、**Docker**(跑 pgvector)。

```bash
docker compose up -d db          # pgvector/pgvector:pg16,映射 :5433
pnpm install
pnpm -r build                    # tsc 编译三包到 dist/

# 跑可执行 demo:自建一次性库 → 迁移 → 一拍 live 闭环 + 一回合红蓝对抗 → 打印遥测 → 清库
node packages/engram-workers/dist/runner/main.js

# 跑测试(需要 db;连接串走 DATABASE_URL,默认即下方值)
export DATABASE_URL=postgresql://engram:engram@localhost:5433/engram
pnpm -r test
```

demo 实际输出(全程离线、确定性,零网络零 API key):

```
=== live 闭环一拍 ===
  级联触达工种：{"distiller":1,"reconciler":1,"verifier":1}（失效=0，截断=false）
  恒温器：ran=true changed=false raisedGate=false
  首次校准：未拟合(below_threshold, samples=0) — g 维持 identity（诚实）

=== 红蓝对抗北极星一回合 ===
  A1 题免疫：进被计分 4 / BLOCK 0
  [false] 检出 1/1（detectionRate=1）
  [contradiction] 检出 1/1（detectionRate=1）
  [stale] 检出 1/1（detectionRate=1）
  [near_dup_poison] 检出 1/1（detectionRate=1）
  breach(漏检+单环归因)：0
  下一代更难题：0 条（冻结=false）

[engram] 北极星闭环 demo 跑通 ✓
```

schema 改了重新生成迁移:`pnpm --filter @engram/core exec drizzle-kit generate`。

---

## 仓库结构

pnpm monorepo,纯 ESM(相对 import 带 `.js` 后缀,各包 `tsc -p .` 编译到 `dist/`):

```
packages/
  engram-core/         @engram/core —— 内核(领域无关)
                       source/claim/relation/provenance/confidence + Consumer SPI
                       + 校准(isotonic+验收门) + 治理恒温器 + 同事实 + 验证器 + 编辑台 + eval 脊柱
  engram-workers/      @engram/workers —— 五工种(跑在 harness-pi)+ choreography 事件总线
                       + 红蓝对抗 + EngramRunner 自闭环(可跑 demo: src/runner/main.ts)
  bidding-adapter/     @engram/bidding-adapter —— 首个领域适配器(consumer),经 SPI 单调收紧消费
docs/
  PRD.md                            要建什么 + 附录 A(build-from 契约:schema/公式/状态表/判据)
  design/agentic-knowledge-core.html 为什么这么设计(架构裁决以它为准)
  HANDOFF.md                        思路/由来/未决项交接
CLAUDE.md                           给在本仓库干活的 agent 的工作指引(命令 / 红线 / 纪律)
```

依赖关系:`workers` 和 `bidding-adapter` 都只依赖 `@engram/core` 的导出面,**绝不反向依赖内核内部**。

---

## 核心范式

- **不是 RAG**:一条 claim = 一个 engram,召回的是已判定的事实原子(带校准 confidence 快照 + 强制 provenance),不是相似度 chunk。
- **乐观写入 / 悲观消费**:写得快(低门槛 append、默认进 `draft` 影子区不召回),信得慢(消费时按动态 confidence 设门过滤);二者由 confidence 这一活值耦合。
- **事后免疫系统**:治理从「事前门禁」搬到「事后巡查」——唯一事前硬门是强制 provenance(D1),其余靠 D2 乐观分级(draft 达门晋升 active)+ D3 Verifier 巡查。
- **主体翻转**:agent 写、人主编——agent 持续蒸馏/消费/回写,人不录入,只做异常审核、冲突裁决、纠错(editor-in-chief);主编三动作(Approve / Edit-Approve / Reject)只投 confidence 因子,不直接写 status。
- **内核领域无关 / 适配分层**:内核只认 source/claim/relation/provenance/confidence;业务语义(compliant 判断、forbidden flag…)下沉 adapter。
- **Consumer SPI 是唯一对外缝、也是最高测试缝**:`recall_claims` / `append_claim` / `report_usage` 三动作,所有消费方(含评测)只经此进出、无旁路——**评测 = 消费,测的是真系统**。
- **append-only 可审计**:supersede 不物理删(同 `lineage_id` 插新版本 + `supersedes` 边,旧标 `superseded`);状态机 `draft→active→flagged→quarantined→superseded`,agent 蓝边只收紧、人红边才放松。
- **控制面否决在线 LLM meta-orchestrator**:走数据面 choreography(claim 状态变化触发下一工种)+ 确定性恒温器(健康度降则收紧 D2 门)+ 旁挂离线 Advisor(只读、只产建议、必过确定性验收门);失效静音退回三层主干,零编排单点。

## 五工种(跑在 harness-pi,经 SPI 自养知识库)

| 工种 | 触发 | 形态 | 职责 |
|---|---|---|---|
| **Distiller** | `source.ingested` | 有界 agent loop | 按 `source.kind` 选读策略,蒸馏带强制出处的 claim、跨源去重、探冲突、单事务 commit |
| **Verifier** | draft/flagged 入队 + cron | 函数/统计 + 点状 LLM | 巡查低置信/高冲突/过时 claim,entailment 核验幻觉,站不住的标 flagged |
| **Reconciler** | `batch_appended` | 函数 + 灰区 LLM | 识近重复与「伪装成精炼的等价投毒」,按独立来源去重防同源刷印证 |
| **Harvester** | `report_usage` + cron | 纯统计,无 LLM | 从 usage_truth 统 observed_correctness(只计独立用户,防刷单)喂 f4 与校准 |
| **Arbiter** | `conflict.detected` | 有界 agent loop | 冲突按固定优先级裁(人工>取代>时效>权威>独立印证数),能定唯一胜者则机判、否则升级主编 |

`judge ≠ athlete`:各工种独立 DB 角色 + 会话隔离,巡查者不给自己产出背书。

## 命门:confidence 从「来源计数器」到「可校准的概率」

PRD 的第一性问题。`raw = Σwᵢ·fᵢ · staleDecay · conflictDecay`(七因子,纯函数,单测钉死),`conf = g(raw)`。`w`(为什么信,配置态)与 `g`(把 raw 映成真实概率,统计态)职责分离。

**毕业机器已装好并接进 live 闭环**:`fitIsotonic`(PAVA,确定性单调非参回归)→ Advisor 诊断 → **6 项验收门** → `commitCalibrationMap` 原子换,由 runner 每拍调起。**但 g 默认仍是 `identity`**:只有当真实 `usage_truth` 样本累积 **≥ 200** 且候选 `g'` 过验收门,活动版本才从 identity 原子切到 isotonic 映射;`<200` 诚实维持 identity(`below_threshold`)。一个 flag 即时回退到 identity。每条 claim 钉死自己的 `calibrationVersion`,recall 按该版本现算 value、老快照冻结。

## 自闭环(`runner.runClosedLoop` 一拍走完四面)

**consume**(recall_claims:SPI 检索 + 七因子聚合 + g 映射 + 消费门过滤)→ **核验**(Distiller 蒸馏带出处 claim + Verifier/Reconciler/Arbiter 事后免疫巡查)→ **写回**(append_claim 乐观写入,默认 draft、强制出处)→ **再校准**(report_usage → usage_truth → Harvester 喂 f4 + 喂 g 的拟合 → 验收门 → 原子换 g)。

**红蓝对抗闭合生长**(`runRedBlueRound`,跑在 sandbox、绝不与 live 同连接):红队四类对抗样本(false / contradiction / stale / near-dup-poison)经真 `append_claim` 注入 → 驱动真工种产生免疫反应 → 判分 → 单环归因定位 breach → 冻结世代逐代升级。「越被使用、越被纠正、越被攻击,就越准、越校准」。

## 五条永久红线(结构性强制,非仅文档)

1. **强制 provenance(D1)**:无出处的 claim 物理写不进——应用层前置 guard(`requireProvenance` 抛错)+ DB 层 `claim_provenance.source_id` NOT NULL FK 兜底(null/不存在的 source 被拒、整事务回滚)。只验可追溯,不判对错。
2. **只人能放松**:状态放松(赦免/回滚/解隔离)仅人(红边)可做;agent(蓝边)只能收紧。刻意不对称。
3. **NC/refuted 须 ≥1 条 `relevance=exact` 反向证据**:判 non_compliant/refuted 须有原文明确反向命题,否则拒判、强制升级人。
4. **A1 考卷也要被验真**:评测题 = 毒株,必须先过同一套工种的免疫流水线才晋升 golden,否则污染回归集。
5. **A3 ELO/胜负率严禁进校准 g 与纵向**:防 Goodhart。拟合器与 ECE 输入边界只吃 `(raw, correct)` 两字段,胜负率无字段可进、编译期就拦。

---

## 技术栈

Node ≥ 22 · 纯 ESM · pnpm monorepo · TypeScript(NodeNext)· PostgreSQL + **Drizzle ORM** + **pgvector**(HNSW)· **harness-pi**(`@harness-pi/core`,站在 `@mariozechner/pi-ai` 上)作 agent loop 运行时 · **vitest**(真 PG 集成测试,每文件建一次性库)。

agent 运行时用 `makeHarnessPiRuntime(model)`:测试注 `createFakeModel(...)`(脚本化、零网络),生产注真 model(pi-ai 的 openai-completions provider 指向 DashScope/Qwen 或 Moonshot,env-gated)。同理 embedder(`makeDashScopeEmbedder`)、判官(`makeDashScope{Entailment,SameFact}Judge`)、视觉读源(`makeVlmSourceReader`,Qwen-VL)都已就位、env-gated。

> 历史 PRD 提到的 Express / ws / React 19 / pi-coding-agent **均未使用**:无 HTTP server、无前端,agent 运行时是 harness-pi 而非 pi-coding-agent。

## 还没做

诚实清单,避免 README 吹没做的东西:

- **HTTP / WebSocket server**:零 `.listen()`/server。唯一可执行入口是 CLI demo(`runner/main.js`)。
- **前端 UI / 主编 Studio / 评测看板**:零 React、零 `.tsx`。主编三动作的后端函数(approve/editApprove/reject/getEditorInbox/getClaimLineage)都在,但没有 UI/HTTP 暴露给人操作。
- **wiki page 人读视图**:schema 里 `page` 仅以 `page_claims` M:N 结表存在,没有 page 实体表、没有渲染。「wiki×KB 二象性」的人读视图侧未做。
- **bidding 真实投标业务**:`bidding-adapter` 是骨架(89 行 + 12 测),只做召回侧业务身份贴现(读 `source.meta.source_type`,`official_datasheet` 不打折、其余按 discount 收紧,恒满足 `adaptedConf ≤ gConf`)。零 RFP 解析/标书生成/合规匹配。它正确演示了「consumer 经 SPI 单调收紧、不反向依赖内核」这条红线,但不是能投标的 agent。
- **真实数据 / 真 LLM 端到端**:端口齐备,但 demo 全走 fake reader/model/embedder/judge。接真模型 + 真数据是下一步集成(见 docs/HANDOFF.md)。

## 推进路线

| Phase | 内容 | 状态 |
|---|---|---|
| P0 地基 | report_usage 埋点 · confidence→连续+g · 最小 SPI | ✅ |
| P1 评测点火 | L5 缺口诚实信号 · prod 失败回流 | ✅ |
| P2 内核闭环 | 五工种上线 · 状态机 · 同事实 · 恒温器 · Advisor+验收门 · L1 golden CI 红线 | ✅ |
| P3 系统八维 | isotonic 校准 · 红队四类免疫 · L3 八维落库 · 归因脊柱 + 纵向 | ✅ |
| P4 红蓝北极星 | 红蓝对抗回合 + 可执行自闭环 runner(追加目标,PRD 外) | ✅ |
| P5+ | league / market / self-reference 等对抗扩展 · 真实数据接入 · UI/server | 未来 |

---

## 阅读顺序

1. **[docs/PRD.md](docs/PRD.md)** —— 要建什么、契约、测试缝、排期。
2. **[docs/design/agentic-knowledge-core.html](docs/design/agentic-knowledge-core.html)** —— 为什么这么设计(架构图/状态机/控制面/红蓝发散),本地 `open` 看。
3. **[docs/HANDOFF.md](docs/HANDOFF.md)** —— 思路由来 + 未决项。

冲突时:架构以设计稿为准,scope/排期以 PRD 为准。
