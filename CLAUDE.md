# Engram · 项目工作指引（给在本仓库干活的 agent）

> Engram = agent 原生可生长知识库**内核**。一条 claim = 一个 engram。不是 RAG。
> bidding-agent 是第一个领域适配器(consumer)，不是主人。内核**领域无关**。

## 先读什么

1. `docs/PRD.md` —— 要建什么 + **附录 A**（build-from 契约：schema / 公式 / 状态表 / 判据）。
2. `docs/design/agentic-knowledge-core.html` —— 为什么这么设计（架构裁决以它为准）。

冲突时：架构以设计稿为准，scope / 排期以 PRD 为准。

## 命令

- `pnpm -r typecheck` · `pnpm -r test` · `pnpm -r build` · `pnpm format`（pnpm monorepo；先 `pnpm -r build` 再 typecheck/test）
- Node ≥22，ESM（`"type": "module"`，相对 import 带 `.js` 后缀）。

## 仓库布局 + Agent 运行时

- monorepo（pnpm workspace）：`packages/engram-core`（`@engram/core`，内核）+ `packages/bidding-adapter`（`@engram/bidding-adapter`，首个领域适配器，经 SPI 单调收紧、**不反向依赖**内核）。
- **agent 运行时 = `harness-pi`**（自研，站在 `@mariozechner/pi-ai` 上；pi-coding-agent 的 sibling 而非扩展）。5 工种跑在 `@harness-pi/core`（AgentSession + hook/plugin/controller）；有界 loop（Distiller/Arbiter）= maxTurns + tokenBudget + LifecycleRestart。
- 已知上游 gap（只在 P2 起承重）：harness-pi#1（PG metrics sink）/ #2（auto-compaction）/ #3（streaming）。

## 永久红线（实现时不可破）

1. **强制 provenance**：无出处的 claim 物理写不进（`claim_provenance.source_id` NOT NULL，D1）。
2. **只人能放松**：claim 状态放松（赦免 / 回滚 / 解隔离）仅人可做；agent 只能收紧。
3. **NC / refuted 须 ≥1 条 `relevance=exact` 反向证据**，否则拒判、升级人。
4. **A1 考卷也要被验真**：题=毒株，先过题的免疫流水线才晋升 golden。
5. **A3 ELO / 胜负率严禁进校准 g 和纵向趋势**（防 Goodhart）。

## 命门（P0 第一件事）

confidence 从「来源计数器」变成「连续、可校准的概率」：替换 `min(1, 来源数×0.3)` 五档离散。
在它就位前，所有评测数字都是对不存在系统的幻觉。

## 最高测试缝

Consumer SPI（`recall_claims` / `append_claim` / `report_usage`）—— 评测=消费，同走这套缝。

## 纪律

除非 issue 明确要求，不要写超出该切片范围的实现代码；不要 push / commit 前未经确认。
