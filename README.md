# Engram

> agent 原生的可生长知识库内核。**一条 claim = 一个 engram。**
> 不是 RAG —— 是 agent 的可生长记忆 / 第二大脑。

Engram 是一个**领域无关**的事实层:把企业杂乱的 raw 来源(产品文档、历史标书、合同、聊天记录、ask_user 的 Q/A)蒸馏成**带强制出处、可校准置信、能钻回原文**的 claim,供任意 agent 在 loop 内**写得快、信得慢、越用越准**地消费。

`bidding-agent` 是 Engram 的**第一个领域适配器(consumer)**,不是主人。

## 核心范式

- **wiki×KB 二象性**:`page` = 人读视图,`claim` = 机器消费的事实原子(唯一召回单元)。
- **三层不塌缩**:`raw source` → `claim` → `page/view`,claim 永远能向下钻回 source。
- **agent 写,人主编**:agent 蒸馏/消费/回写,人只审异常、裁冲突、纠错。
- **乐观写入 / 悲观消费**:写得快、信得慢,由动态 confidence 耦合。
- **事后免疫**:唯一事前硬门 = 强制 provenance;其余靠乐观分级 + verifier 巡查。
- **内核 / 领域适配分层**:内核只认 source/claim/relation/provenance/confidence;业务语义下沉 adapter。

## 仓库结构

```
docs/
  PRD.md                              # 可执行 PRD(build-from 契约 + 排期)← 从这里开始
  design/
    agentic-knowledge-core.html       # 设计稿(13 节/22 图,why & what 的完整论证)
```

## 状态

`ready-for-agent` —— 设计稿与 PRD 就绪,**实现 ≈ 0**(地基待建)。

最该先回答的一句话:**confidence 什么时候从来源计数器变成可校准的概率。** 这是 P0 的第一件事;在它就位前,所有评测数字都是对不存在系统的幻觉。

## 推进路线(地基优先,详见 PRD §Further Notes)

| Phase | 内容 | 解锁门 |
|---|---|---|
| P0 地基 | report_usage 埋点 · confidence→连续+g · 最小 SPI | reliability diagram + ECE 非平凡 |
| P1 评测点火 | L5 缺口题 · prod 失败回流 | 盲区有分 + 失败池非空 |
| P2 内核闭环 | 五工种上线 · L1/L2 组件 benchmark | 组件全绿 + 不振荡 |
| P3 系统八维 | 八维落库 · 纵向 · 归因脊柱 | 校准可信 |
| P4 红蓝北极星(future) | 红队/蓝队对抗 | 三前置齐备才解锁 |

## 技术栈

Express + ws(Node ≥22 ESM)· PostgreSQL + Drizzle + pgvector(HNSW)· pi-coding-agent · React 19。

## 阅读顺序

1. **[docs/PRD.md](docs/PRD.md)** —— 要建什么、契约、测试缝、排期。
2. **[docs/design/agentic-knowledge-core.html](docs/design/agentic-knowledge-core.html)** —— 为什么这么设计(架构图/状态机/控制面/红蓝发散)。本地 `open` 看。

两者冲突时:架构裁决以设计稿为准,scope/排期以 PRD 为准。
