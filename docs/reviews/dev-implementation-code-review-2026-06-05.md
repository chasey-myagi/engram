# Engram dev 实现代码审查记录

- 日期：2026-06-05
- 当前基线：`feat/m3a-harness` / `23b77115c37b0fb49f385ee6d21551308e0bb7be`（相对 `origin/dev` = `baaa9decb6a4e4e9fa3f549b18ff5207ed4d216b` 新增 M3-A realworld-ece 骨架）
- 初始审查快照：`dev` / `8536ff5635dc572d5eaad2fa7e13597d88603401`
- 范围：`@engram/core`、`@engram/workers`、adapter onboarding 文档
- 状态：living review ledger，下面 findings 需要持续补充和逐项关闭
- 备注：本台账从 `dev` 快照开始；当前 checkout 已推进到 M3-A harness 分支，下面 findings 均以当前基线复核，除非证据段另有说明。

## 已验证基线

当前 HEAD `23b77115c37b0fb49f385ee6d21551308e0bb7be` 已重新验证：

- `pnpm -r build`：通过
- `pnpm -r typecheck`：通过
- `pnpm -r test`：通过，core 492 / workers 140 / bidding-adapter 12
- `git diff --check`：通过

格式检查状态：

- `pnpm exec prettier --check docs/reviews/dev-implementation-code-review-2026-06-05.md`：通过
- 未重跑全仓 `pnpm format:check`；当前工作区仍有未跟踪 `.firecrawl/` 抓取产物，本轮只用 Prettier 校验 review 文档本身，并用 `git diff --check` 确认 tracked diff whitespace clean。

这些结果只说明当前测试覆盖内是绿的，不代表下面的实现风险已经被覆盖。

## Review Gates

- `linus-review` sub-agent：**Please fix and resend**。两轮只读审查确认 EGR-CR-001/002/003/005/009/010/043，并新增 EGR-CR-012/013/044/045/046/047；metric-focused 复审确认 EGR-CR-052，并新增 EGR-CR-053/054。
- `test-review` sub-agent：**FAIL**。第一轮 Final Score `7.08/10`，第二轮 Final Score `4.53/10`；核心红线和 calibration pilot 仍缺硬门回归测试。第二轮报告中 heldout/fact-split leakage / 语料前提部分经本地复核已被当前测试覆盖，未入账；确认 EGR-CR-043，并新增 EGR-CR-048。redteam generation focused 复审 Final Score `6.30/10`，确认 EGR-CR-051，并指出 EGR-CR-055。
- A1/golden/red-team 独立 reviewer：只读完成，确认 A1 基础免疫路径存在，但指出 red-blue/redteam 评分面仍可绕过或清掉 `golden_questions` / `promotion_audit`。
- worker-audit / dispatcher explorer：只读完成，确认事件总线和人审 pending 队列仍有 fail-safe / payload validation 缺口；本地复核后新增 EGR-CR-037/038/039/040。
- M3-A realworld-ece `code-review` sidecar：**FAIL**。确认 EGR-CR-059/060，并新增 EGR-CR-061；sidecar 同时跑过 `pnpm --filter @engram/workers test -- src/eval/__tests__/realworld-ece.test.ts`、`pnpm --filter @engram/workers typecheck`、`git diff --check origin/dev -- <4 files>`，均通过，但不覆盖这些 gate 失败路径。

## Findings

### EGR-CR-001 · P1 · NC-exact 拒判仍会留下影响 recall 的 `not_co_true`

**证据**

- `packages/engram-workers/src/verifier.ts:340-363`：Verifier 先写入 `writePatrolVerdict({ entailment })`，之后才通过 `applyTransition()` 触发 NC-exact gate。
- `packages/engram-workers/src/verifier.ts:259-274`：NC-exact 失败时返回 `ncExactRefused`，状态 transition 不落。
- `packages/engram-core/src/verifier/patrol-verdict.ts:82-93`：`not_co_true` 会被映射成 entailment factor `0`。
- `packages/engram-workers/src/__tests__/verifier.test.ts:347-370`：现有测试断言 status 保持 `active` 和升级事件存在，但没有断言 recall 的 entailment factor 没被污染。

**问题**

红线要求 NC / refuted 必须有至少一条 `relevance=exact` 反向证据，否则拒判并升级人。现在状态收紧确实被拒绝了，但被拒绝的 `not_co_true` verdict 已经写进 patrol 记录，后续 `recall_claims` 读取最新 entailment verdict 时仍可能把 `f2` 压到 0。

这会造成“状态没有收紧，但置信度已经被负判收紧”的半落地结果，绕开了红线的实际语义。

**建议**

- 在写入会影响 `f2` 的 patrol verdict 前先完成 NC-exact gate。
- 或者把拒判 verdict 写成单独的 non-scoring event，并让 `latestEntailmentFactors()` 明确忽略 refused verdict。
- 增加回归测试：构造 active claim + peer 仅 supporting，Verifier 返回 `not_co_true` 后断言 status 不变、存在 `ruling_refused`，并且 `recall_claims(...).confidence.factors.entailment` 仍是原值/中性值，而不是 0。

### EGR-CR-002 · P1 · “只人能放松”目前只是可伪造字符串检查

**证据**

- `packages/engram-core/src/spi/reflux.ts:28-30`：`isHumanRole()` 只判断 `byRole === "human"` 或 `byRole.startsWith("human:")`。
- `packages/engram-core/src/spi/transition.ts:162-180`：red-edge 放松只依赖 `isHumanRole(opts.by)`。
- `packages/engram-core/src/editor/human-review.ts:67-83`：写 human review 只依赖 `isHumanRole(opts.byRole)`。
- `packages/engram-core/src/editor/editor-action.ts:10-18`：editor action 的 human gate 也是同一个字符串判断。
- `packages/engram-core/src/spi/conflict-arbiter.ts:220-265`：human adjudication 同样只依赖 caller 传入的 role 字符串。
- 当前代码未看到 `SET ROLE`、RLS、独立 DB 用户或服务端 actor token 校验。

**问题**

只要调用方能传入 `by: "human:..."`，就能走 red-edge 放松、写 human review、做 human rung conflict adjudication。对于当前 library-only skeleton 这还不是公网漏洞，但它不是可承重的授权边界，和“只人能放松”的永久红线不等价。

**建议**

- 引入不可由业务调用方自由构造的 `ActorContext`，human 身份来自服务端认证/HITL 会话，不来自任意字符串。
- human-only API 只能由受信入口创建 actor，再传入 core。
- 如果文档继续声称“独立 DB 角色 + 物理隔离”，需要落到 DB role / RLS / separate credentials；否则把文档降级成“逻辑 byRole/session 隔离”。
- 增加测试：非 human actor 即使伪造 display role 也不能放松状态；human actor 必须来自受信 factory。

### EGR-CR-003 · P1 · `report_usage` 可污染校准样本，因为 recall snapshot 未绑定

**证据**

- `packages/engram-core/src/spi/report-usage.ts:28-52`：`byRole`、`confidenceAtRecall`、`calibrationVersion`、`query`、`kbLacksAnswer` 都由 caller 提供。
- `packages/engram-core/src/spi/report-usage.ts:119-160`：写入前只校验 `confidenceAtRecall` 在 `[0, 1]`。
- `packages/engram-core/src/calibration/fit-from-usage.ts:94-135`：calibration 直接从 `claim_verification(kind='usage_truth')` 读取 caller 提供的 `predictedConfidence`、`calibrationVersion`、`byRole`、`taskId`。
- `packages/engram-core/src/spi/recall-claims.ts:240-285`：recall 返回 confidence snapshot，但没有持久化 snapshot id，也没有给 `report_usage` 一个可验证 token。

**问题**

confidence 校准是 Engram 的命门，但当前 `report_usage` 接受调用方自报的 recall confidence/version。buggy consumer 或恶意 consumer 可以上报任意置信度和版本，污染 calibration `g`、usage feedback `f4` 和 L5 路由。

**建议**

- recall 时持久化 `recall_snapshot` 或返回签名 `usage_token`，包含 claimId、confidence、rawConfidence、factors、calibrationVersion、query hash、actor/session。
- `report_usage` 只接受 snapshot/token id，不再接受 caller 自报的 confidence/version。
- calibration 只消费 verified snapshot 关联的 usage truth。
- 增加负例测试：伪造 `confidenceAtRecall` 或错误 `calibrationVersion` 时拒写，或被标记为不可进入 calibration。

### EGR-CR-004 · P2 · Runner 的 `usage` 输入只触发 Harvester，不会上报 usage truth

**证据**

- `packages/engram-workers/src/runner/engram-runner.ts:107-123`：`harvestUsage()` 只发布 `report_usage` event payload `{ claimIds }`，然后调用 Harvester。
- `packages/engram-workers/src/runner/engram-runner.ts:159-168`：`runClosedLoop({ usage })` 只调用 `this.harvestUsage(input.usage)`。
- `packages/engram-workers/src/runner/__tests__/engram-runner.test.ts:312-345`：测试里先手动调用 `reportUsage(...)`，再调用 runner 的 usage/harvest 路径。
- `packages/engram-workers/src/harvester.ts:64-168`：Harvester 只读取已经存在的 `usage_truth`，重算 f4；它不创建 usage truth。

**问题**

API 名字和事件类型暗示 runner 能“report usage”，但实际只会 harvest 已经写入的 usage truth。调用者如果只传 `runClosedLoop({ usage: [...] })`，系统不会产生 `claim_verification(kind='usage_truth')`，f4 和 calibration 不会更新。

**建议**

- 二选一：把参数重命名为 `reportedUsageClaimIds` / `usageTruthAlreadyRecorded`，让语义诚实；或让 runner 接收完整 usage event 并调用 `reportUsage()`。
- 增加测试：仅调用 `runClosedLoop({ usage })` 时，如果设计目标是自动上报，就必须能查到新写入的 `usage_truth`；如果设计目标不是自动上报，测试和文档要明确它只做 harvest。

### EGR-CR-005 · P2 · embedding version 没有参与 recall / same-fact candidate 过滤

**证据**

- `packages/engram-core/src/db/schema.ts:115-117`：claim 记录里有 `embedding` 和 `embeddingVersion`。
- `packages/engram-core/src/embedding/embedder.ts:15-16`：embedder 暴露 `version`，说明版本被设计成 stale vector 边界。
- `packages/engram-core/src/spi/recall-claims.ts:139-158`：vector recall 只要求 `embedding IS NOT NULL`，没有过滤 `embeddingVersion === embedder.version`。
- `packages/engram-core/src/spi/commit-claim.ts:68-112`：same-fact/merge candidate search 也只要求 `embedding IS NOT NULL`。
- `packages/engram-core/src/embedding/reembed.ts:1-87`：存在 stale 标记和重嵌逻辑，但 recall/commit 在重嵌完成前仍会混用旧向量。

**问题**

embedding 模型或版本升级后，不同向量空间的旧 embedding 仍可能进入 recall 排序和 same-fact merge 判定。`reembed` 能修复存量数据，但在重嵌完成前，在线查询和写入路径仍可能用 stale vector 做错误候选。

**建议**

- 默认在 recall 和 commit candidate search 里过滤 `claim.embeddingVersion === embedder.version`。
- 若确实需要迁移期 fallback，必须显式配置，并把旧版本结果降权/隔离。
- 增加测试：同一 claim 存在旧 `embeddingVersion` 时，不应被当前 embedder 的 recall/same-fact candidate 命中。

### EGR-CR-006 · P2 · “独立 DB 角色 + 会话隔离”仍是文档口径，不是代码边界

**证据**

- `README.md:102` 当前工作区文档写到“各工种独立 DB 角色 + 会话隔离”。
- 代码里当前能看到 `AgentSession`、`byRole`、`createdBy`、session/event 记录，但没有看到实际数据库 role 切换、RLS policy 或 per-worker credentials。
- EGR-CR-002 已说明 human-only 边界也依赖 caller 字符串。

**问题**

如果“judge != athlete”要求的是物理隔离，目前实现只达到逻辑标记和 session 记录。文档继续用“独立 DB 角色”会误导后续 reviewer，以为隔离已经由数据库强制执行。

**建议**

- 要么实现 DB role/RLS/per-worker credential，并加 integration test 证明某工种不能写不属于自己的表/字段。
- 要么把文档改为“当前为逻辑角色和会话审计，物理 DB role 隔离待实现”。

### EGR-CR-007 · P3 · adapter onboarding 文档仍把已实现 SPI 写成待实现

**证据**

- `docs/adapters/README.md:47-57` 的表格已经列出写入侧 SPI，但仍写 `recall_claims` / `report_usage` 契约待实现，并说“现在 S1 骨架只有写半边能跑”。
- 当前 `@engram/core` 已有 `appendClaim`、`recallClaims`、`reportUsage` 以及对应测试，root README 的工作区版本也已经更新到“kernel + workers + self-loop”。

**问题**

adapter 文档会误导 consumer 侧接入，尤其是把“最高测试缝 Consumer SPI”误写成未实现。

**建议**

- 更新 adapter README，明确当前可用 SPI、仍缺的 server/UI/real bidding integration，以及 `usage` 上报语义。
- 把“bidding-agent 不反向依赖内核”的边界补成接入 checklist。

### EGR-CR-008 · P3 · calibration 注释/门禁计数有轻微漂移

**证据**

- `packages/engram-core/src/calibration/fit-from-usage.ts:16` 和 `:142` 的注释仍提到“5/6 gate -> 5/5”等历史口径。

**问题**

这不是运行时 bug，但 calibration 是命门模块，注释里的 gate 数量漂移会增加 reviewer 误判风险。

**建议**

- 把注释改成当前实际 acceptance gate 名称，而不是历史计数。
- 如果 gate 数量会变化，注释写规则名，不写数字。

### EGR-CR-009 · P1 · calibration version 可重定义，历史 g 快照并没有真正冻结

**证据**

- `packages/engram-core/src/db/schema.ts:239-262`：`calibration_map.version` 只是普通 `text NOT NULL` + hash index，没有 unique 约束。
- `packages/engram-core/src/calibration/calibration-store.ts:74-91`：`appendCalibrationMapTx()` 直接插入 `version + knots`，没有拒绝同 version 不同 knots。
- `packages/engram-core/src/calibration/calibration-store.ts:154-170`：`loadCalibrationMaps()` 按 version 查询多行后，按 `createdAt DESC, id DESC` 取每个 version 的最新行。
- `packages/engram-core/src/__tests__/calibration-advisor.test.ts:204-260` 和 `packages/engram-core/src/__tests__/calibration-isotonic.test.ts:280-325` 证明了“老 claim 钉 identity 不受新活动版本影响”和“新 claim 会钉活动版本”，但没有覆盖“同一个非 identity version 被重新定义”。

**问题**

claim 的 `confidence_factors.calibrationVersion` 本来应该是快照锚。可是同一个 version 允许再次写入不同 knots，而 recall 解析该 version 时会取最新定义。这样旧 claim 即使还钉着原 version，也会在后来同名重定义后得到新的 g 映射，历史快照被静默改写。

这直接破坏 A.3 的“快照冻结”和纵向可比性。更糟的是审计看起来仍是同一个 `calibrationVersion`，但值已经变了。

**建议**

- `calibration_map.version` 应该唯一，或拆成 immutable `calibration_map_definition(version UNIQUE, knots)` + append-only `calibration_activation(version)`。
- `commitCalibrationMap()` 必须拒绝已有 version 的不同 knots；如果允许重复写同一 version，也只能是 byte-for-byte 相同的幂等写。
- 增加回归测试：写 `v1` knots A，创建/召回钉 `v1` 的 claim；再写 `v1` knots B；断言第二次写被拒，或旧 claim 的 recall value 仍按 knots A。

### EGR-CR-010 · P2 · `ctx.minSimilarity` 可以放松语义召回，不符合请求态“只能更严”

**证据**

- `packages/engram-core/src/spi/recall-claims.ts:130-134`：只要 caller 传 `ctx.minSimilarity`，就直接覆盖 embedder 推荐值和内核默认值。
- `packages/engram-core/src/spi/recall-claims.ts:159-160`：候选只按这个最终 `minSimilarity` 过滤。
- `packages/engram-core/src/embedding/embedder.ts:19-32`：embedder 可以声明自己的推荐相似度下界；默认是为了避免小库 top-k 吐出无关项。
- `packages/engram-core/src/__tests__/embedding.test.ts:206-221`：测试确认 `ctx.minSimilarity` 是 override，并确认无 ctx 时才使用 embedder-declared floor。
- `packages/engram-core/src/__tests__/recall-claims.test.ts:261-265` 和 `packages/engram-core/src/__tests__/gap-honesty.test.ts:137-165` 依赖 similarity floor 来区分“无相关候选”和“门后有候选”。

**问题**

`confidenceFloor` 会被夹到内核 floor，因此 consumer 不能放松消费门。但 `minSimilarity` 是另一个召回门，caller 可以传更低值，甚至负值，绕开 embedder 的语义下界，让原本应记 gap 的无关近邻进入候选甚至返回结果。

这和文档里的“请求态只能在配置基线上再收紧”冲突，也会污染 gap honesty 的 `candidateCount/gatedCount` 解释。

**建议**

- 解析相似度门时取最严：`max(ctx.minSimilarity, embedder.minSimilarity ?? DEFAULT_RECALL_MIN_SIMILARITY)`。
- 对非 finite 值回落到 embedder/default；对低于基线的值夹回基线。
- 如果确实需要 debug/评测放宽，应改成显式 unsafe/internal 选项，不属于 Consumer SPI。
- 增加回归测试：embedder 声明 `minSimilarity=0.5`，caller 传 `0.1` 时 cosine 0.3 的 claim 仍不应召回；caller 传 `0.7` 时才进一步收紧。

### EGR-CR-011 · P2 · `source.meta` / authority first-writer-wins 会永久锁错 adapter 业务身份

**证据**

- `packages/engram-core/src/spi/append-claim.ts:267-287`：`addSource()` 以 `contentHash` 去重；冲突时只做 no-op update，明确不更新既有 `content/kind/authorityScore/meta`。
- `packages/engram-core/src/__tests__/append-claim.test.ts:112-142`：测试锁住了 first-writer-wins 行为，第二次同 hash 的 `kind/authorityScore/meta` 不覆盖第一行。
- `docs/adapters/README.md:87-94`：adapter onboarding 要求通过 `SourceInput.meta` 注入业务身份。
- `packages/bidding-adapter/src/index.ts:29-44` 和 `:55-75`：bidding adapter 直接读 `source.meta.source_type`，`official_datasheet` 不打折，非官方打折/低于 floor 丢弃。

**问题**

raw source 内容不可变是对的，但 `meta` / `authorityScore` 在当前设计里承载业务身份和权威信号。若某 source 第一次被裸 ingest，后续同 contentHash 再带 `source_type=official_datasheet` 或更高 authority 写入时只会返回旧 id，业务身份不会被补上。adapter 会把真实官方源当未知/非官方，永久压低或丢弃它支持的 claim。

这不是普通“文档没写清”，而是业务接入会遇到的不可恢复状态：没有 enrichment API，也没有冲突审计事件告诉你第二次的 metadata 被丢了。

**建议**

- 明确把 `source.content` immutable 和 `source.meta/authorityScore` governance-editable 分开。
- 增加 human-only 的 `updateSourceMetadata` / `annotateSourceAuthority` append-only 审计路径，或至少在 `addSource` 冲突且新旧 meta/authority 不一致时返回 `metadataConflict=true`。
- adapter onboarding 必须警告：业务身份必须在首次 `addSource` 时写入；当前没有补标路径。
- 增加测试：先裸写同 hash，再用官方 meta 重写；当前应暴露 conflict/警告，不能静默返回旧 bare source。

### EGR-CR-012 · P1 · `contentHash` 由 caller 提供，provenance 可静默锚到错误 raw source

**证据**

- `packages/engram-core/src/spi/append-claim.ts:41-49`：`SourceInput` 要求 caller 提供 `contentHash`。
- `packages/engram-core/src/spi/append-claim.ts:267-287`：`addSource()` 直接用 caller 的 `contentHash` 做唯一键；冲突时返回既有 row，不校验新旧 `content` 是否一致。
- `packages/engram-core/src/__tests__/append-claim.test.ts:112-142`：测试明确固化了“同 contentHash 但第二次 content 完全不同时仍复用第一行”的行为。
- `docs/PRD.md:28-31` 和 `:287-294` 要求 raw source → claim 的 provenance 可追溯，D1 只验可追溯但这个追溯必须指回真实原文。

**问题**

强制 provenance 的核心不是“有一个 source_id 字符串”，而是 claim 能钻回它实际来自的 raw source。现在任何调用方传错或伪造 `contentHash`，就能让新 content 静默复用旧 source id；随后 claim_provenance 指向的是旧 raw source，而不是这次提交的原文。

这会让 D1 物理门产生伪安全感：claim 看起来有出处，实际出处错了。

**建议**

- 内核根据 `content` 自己计算规范 hash，例如 `sha256(content)`；不要信任 caller 提供的 hash。
- 如果保留 caller-provided hash，也必须在 conflict 时比对既有 `content`，不同则 fail-loud，不准 no-op 复用。
- 增加测试：同 hash 不同 content 第二次 `addSource()` 应拒绝或返回显式 conflict；不能返回第一行 sourceId。

### EGR-CR-013 · P1 · `applyAdapter()` 没锁 claim 本体，adapter 可改事实文本

**证据**

- `packages/engram-core/src/spi/adapter.ts:33-44`：注释明确只管 count / confidence / provenance / mustVerify / contradicts，`claimText / status / raw` 属直通。
- `packages/engram-core/src/spi/adapter.ts:62-98`：运行时只检查 result id、重复、confidence 是否抬高、mustVerify、provenance、contradicts；没有 deep-compare `claim` 本体。
- `packages/bidding-adapter/src/index.test.ts:91-109` 覆盖了合法收紧和 discount > 1 抛错，但没有测试 adapter 改写 claimText/status/asOf/lineageId 等字段。

**问题**

adapter 单调收紧不只是数值不能抬高，也不能改写“被召回的事实”。现在恶意或 buggy adapter 可以返回同一个 `claim.id`、同一 provenance、更低 confidence，但把 `claim.claimText`、`status`、`subject/predicate/object` 等字段改成另一条事实。`applyAdapter()` 会放行。

这绕开了“不得伪造/改写 provenance”的精神：出处没改，但事实本体被改了，consumer 仍会拿着原 provenance 引用错误文本。

**建议**

- `applyAdapter()` 默认把 kernel result 当 immutable record，只允许白名单字段变化：降低 `confidence.value`、更保守 `mustVerify`、丢弃整条 result、可选追加更保守 conflict 标注。
- 至少 deep-compare `claim`、`provenances`、`confidence.raw/factors/weights/calibrationVersion/takenAt`，禁止 adapter 改写 claim 本体和快照解释字段。
- 增加测试：adapter 修改 `claim.claimText` / `status` / `confidence.raw` / `provenances` 时必须抛 `adapter relaxed`。

### EGR-CR-014 · P1 · Reconciler 把“不能推出锚 claim”误落成 `not_co_true`

**证据**

- `packages/engram-core/src/same-fact/reconcile.ts:47-52`：`objectSubsetViaEntailment()` 问的是 A 是否蕴含 B；`fail` 被解释成 `A ⊬ B`，并和 `not_co_true` 一起返回 `poison`。
- `packages/engram-workers/src/reconciler.ts:333-348`：`poison` 直接 `recordReconcileEscalation()`，随后 active A 会被 `transitionClaim(..., 'flagged')` 收紧。
- `packages/engram-core/src/spi/reconcile-signal.ts:41-48`：所有 Reconciler poison 都写成 patrol verdict `entailment: 'not_co_true'`，即 f2=0。
- `packages/engram-workers/src/__tests__/reconciler.test.ts:181-214`：测试里的典型 poison 是 `at least 800` vs `at least 4000`；这只能证明 A 不能推出 B，并不证明两条 claim 不可同真，但测试反而固化了 `computeEntailmentFactor(...) === 0`。

**问题**

`A ⊬ B` 和 `A` / `B` 不可同真不是一回事。`capacity >= 800` 与 `capacity >= 4000` 可以同时为真，只是前者更弱、更不具体；把它写成 `not_co_true` 会把一个可能真实但低信息量的 claim 当成硬冲突，直接把 f2 压到 0，并把状态从 active 收紧到 flagged。

这会让 Reconciler 成为一条绕过 NC-exact 语义的负判入口：它既没有区分 `fail` 与 `not_co_true`，也没有在写入 f2=0 前要求一条真正的 exact 反向命题。

**建议**

- 把 Reconciler verdict 拆开：`weaker/stale`、`not_entailed`、`contradicts/not_co_true` 不应共用 `poison`。
- 只有真实 `not_co_true` 才能写 patrol `not_co_true` 并进入 NC-exact / conflict 裁决路径；普通 `fail` 应该是单独的 stale/weakening audit 或 human-review queue，不应直接 f2=0。
- 增加回归测试：`>=800` vs `>=4000` 这类可同真的弱化 claim 不应产生 `not_co_true` entailment factor；真正互斥的 object 才能进入 `not_co_true` 路。

### EGR-CR-015 · P2 · human resolve 后 `getEditorConflictQueue()` 仍会返回旧 escalated 事件

**证据**

- `packages/engram-core/src/spi/conflict-arbiter.ts:232-265`：`humanAdjudicateConflict()` 复用 `resolveConflict()`，只追加一条 `conflict_adjudicated(outcome='resolved')`。
- `packages/engram-core/src/spi/conflict-arbiter.ts:301-307`：`getEditorConflictQueue()` 读取所有 `conflict_adjudicated` 事件后，只过滤 `payload.outcome === 'escalated'`。
- `packages/engram-core/src/spi/conflict-arbiter.ts:325-336`：`adjudicatedPairKeys()` 已经知道无序 pair key，说明当前事件模型有足够信息按 pair 去重/关闭；queue reader 没有使用这个关闭语义。
- 现有 `conflict-arbiter.test.ts` / `arbiter.test.ts` 覆盖了 escalated 入队和 cron 不重复入队，但没有覆盖“human resolve 后队列消失”。

**问题**

主编裁决是 append-only 没问题，但队列读取不能只看历史 escalated 事件。否则一对冲突先 escalated，再被 `humanAdjudicateConflict()` resolved 后，旧的 escalated event 仍会继续出现在主编队列里，UI / worker 会把已处理事项当成待处理事项。

这会让主编队列成为“事件日志”而不是“待办视图”。长期看会导致重复人工裁决、错误 SLA、以及已裁冲突继续阻塞治理面板。

**建议**

- `getEditorConflictQueue()` 应按 pair key 只返回最新状态为 escalated、且之后没有 resolved 的 pair。
- 或拆分 append-only event log 和 materialized queue projection：event 全留，queue view 只显示未关闭项。
- 增加回归测试：`escalateConflict()` 后 queue=1；随后 `humanAdjudicateConflict()` 同一 pair；queue 应为 0，resolved history 仍保留。

### EGR-CR-016 · P1 · 默认 L5/L3 scoring 面没有接 A1 晋升/迁出投影

**证据**

- `packages/engram-core/src/eval/l5-gap.ts:126-138`：`runL5Suite()` 默认跑静态 `L5_GAP_QUESTIONS`。
- `packages/engram-core/src/eval/l5-migration.ts:149-168`：`liveL5Questions()` 已定义“迁出的题不再算盲点”的投影，但 `runL5Suite()` 默认不使用它。
- `packages/engram-core/src/eval/system-dimensions.ts:66-75` 和 `:199-205`：L3 默认 golden 是静态 `L3_GOLDEN`，`computeSystemDimensions()` 默认直接使用它。
- `packages/engram-core/src/__tests__/gap-honesty.test.ts:123-128` 固化了默认 `runL5Suite(db, embedder)` 跑完整冻结 L5 集；`l5-migration.test.ts:146-154` 只测试 `liveL5Questions()` 本身，不测试默认 suite 会跳过已迁出题。

**问题**

A1 要求“题=毒株，先过免疫流水线才晋升 golden”。当前 `golden_questions` 只保护手动 `promoteCandidate()` 产生的 L5 candidate；默认 L5/L3 scoring 仍直接消费静态常量，拿不到 `promotion_audit` / `basis` / `promotedBy`。

更具体地，某道 L5 题被 `migrateL5IfGrew()` 记录为“知识长出来”之后，默认 `runL5Suite()` 仍会把它当盲点继续打分。库能答它时会被算作 blind-spot 失败，而设计语义是它已经迁出 L5、进入归因脊柱。

**建议**

- 给 L5 suite 增加 DB-aware 默认入口，例如 `runLiveL5Suite()` 或让 `runL5Suite()` 默认读 `liveL5Questions(db)`，静态全集只作为显式 fixture。
- L3 默认 golden 要么也经过 A1/promotion audit，要么在 PRD/代码命名中明确它是“行为 fixture”，不是 A1 golden question。
- 增加测试：先让一题 `migrateL5IfGrew()` 成功，再跑默认生产评分入口，断言该题不计入 blindSpotScore 分母。

### EGR-CR-017 · P1 · red-blue A1 晋升审计会被 per-item reset 清掉，评分只靠内存 cohort

**证据**

- `packages/engram-workers/src/eval/work-tables.ts:9-19`：`EVAL_WORK_TABLES` 包含 `l5_candidates`、`golden_questions`、`promotion_audit`。
- `packages/engram-workers/src/eval/red-blue-round.ts:333-341`：每个 item admission 前调用 `resetWorkTables()`，然后只用内存里的 `admissions` / `admittedSet` / `scoredItems` 决定计分 cohort。
- `packages/engram-workers/src/eval/redteam-injector.ts:517-525`：进入 scorer 后，每条 item 前又调用 `resetDb()`，再次清掉 A1 admission 产生的工作表。

**问题**

red-blue 回合口头上“每条 item 先过真 `promoteCandidate`”，但 admission 产生的 `golden_questions` / `promotion_audit` 不会留到评分后。最终免疫分只能证明内存里的 `admittedSet` 参与过筛，不能在 DB 里证明“这些 scored item 曾经晋升 golden，且 basis 是什么”。

这削弱了 A1 的核心价值：A1 不只是一个布尔 gate，还应该留下可审计的题面晋升证据。现在回合结束后，reviewer 不能从持久层追溯 scored cohort 的 A1 basis。

**建议**

- admission 隔离和评分隔离分开：不要在 scorer reset 时清掉已晋升 cohort 的 `golden_questions` / `promotion_audit`，或把 admission 结果复制到一个 append-only round cohort 表。
- scorer 应从 promoted cohort 读取，而不是只从内存 `Set` 读取。
- 增加测试：`runRedBlueRound()` 结束后，admitted item 对应的 `golden_questions` 与 `promotion_audit` 仍可查询，blocked item 没有被计入 scorer。

### EGR-CR-018 · P1 · red-blue A1 admission 没传结构化 `poison`，自相矛盾门对红队 item 基本失效

**证据**

- `packages/engram-core/src/spi/exam-immunity.ts:147-149`：代码注释明确，不传 `opts.poison` 时自由文本题无法触发 S8，自相矛盾检查恒为 true。
- `packages/engram-workers/src/eval/red-blue-round.ts:157-183`：`admitViaA1()` 把 `item.claimText` 写成 candidate query，但调用 `promoteCandidate(db, embedder, candidateId, { confirmedBy })` 时没有传 `item.subject` / `predicate` / `object`。
- `packages/engram-workers/src/eval/redteam-injector.ts:247-250`、`:378-381`、`:408-411`：真正注入红队 item 时会传结构化 S/P/O，说明 item 本身有足够结构化字段。

**问题**

红队 item 里本来带着 `subject/predicate/object`，但 A1 admission 阶段丢掉了这些字段。结果 `promoteCandidate()` 造出来的毒株 claim 是纯文本 draft，S8 contradiction scan 无法检测同 S/P、反 object 的自相矛盾题。

只要 query 没被 recall 命中，这类结构化自败题就能被 admitted，随后才在蓝队评分阶段当正常红队毒株使用。A1 “题先验真”在最需要结构化判定的红队题上变成了只测 `kbTrulyLacks`。

**建议**

- `admitViaA1()` 调用 `promoteCandidate()` 时传入 `poison: { subject, predicate, object }`。
- 如果某类 item 必须自由文本，应在 admission 结果中显式标记 `noSelfContradiction` 未自动覆盖，而不是当作 pass。
- 增加测试：预置 active 锚，同 S/P 反 object，item 使用唯一 `claimText` 避免 recall 命中；期望 A1 blocked，目前会 admitted。

### EGR-CR-019 · P1 · `runRedTeamGeneration()` 是公开评分入口，但完全绕过 A1 admission

**证据**

- `packages/engram-workers/src/index.ts:89-95`：`runRedTeamGeneration` 被公开导出。
- `packages/engram-workers/src/eval/redteam-injector.ts:517-539`：实现直接 `resetDb()`、`injectAndAssert()`、聚合 detection rate，没有调用 `promoteCandidate()` 或读取 `golden_questions`。
- `packages/engram-workers/src/eval/red-blue-round.ts:344-350`：red-blue round 在外层先做 A1 admission，再把 `scoredItems` 交给 `runRedTeamGeneration()`；这说明 A1 是外部约束，不是 scorer 自带边界。

**问题**

一旦调用方直接使用公开的 `runRedTeamGeneration()`，未经过 A1 验真的红队毒株也会被注入并计分。red-blue round 的外层 gate 不能保护这个公开入口。

这和“题=毒株，先过 A1 免疫流水线才晋升 golden / scored cohort”的红线冲突。越靠近 release/CI 的评分入口，越不应该依赖调用方记得先手动过滤。

**建议**

- 把 `runRedTeamGeneration()` 降级为 internal injector，公开入口只保留带 A1 admission 的 round/suite。
- 或让 `runRedTeamGeneration()` 接受 promoted cohort id / golden row id，拒绝原始 unaudited items。
- 增加测试：构造一个 `runRedBlueRound()` 会 block 的 item，直接喂 `runRedTeamGeneration()` 应拒绝或不计入分母。

### EGR-CR-020 · P2 · `promoteCandidate()` 缺少候选行锁/条件更新，并发 pass/fail 可产生不一致终态

**证据**

- `packages/engram-core/src/spi/exam-immunity.ts:16-22`：文件注释承认造毒株和决定事务分离，且“未加候选行级锁”。
- `packages/engram-core/src/spi/exam-immunity.ts:100-108`：函数在事务外读取候选 `queued` 状态。
- `packages/engram-core/src/spi/exam-immunity.ts:218-245`：最后事务内无条件把同一 candidate 更新为 `promoted` 或 `rejected`。
- `packages/engram-core/src/db/schema.ts:354-368`：`golden_questions.candidate_id` 是 unique，能阻止重复 golden row，但不能阻止后提交的 reject 把 `l5_candidates.status` 改成 `rejected`。

**问题**

两个 curator 并发操作同一 queued candidate 时，都能在事务外读到 `queued`。一个通过并插入 `golden_questions`，另一个失败路径随后无条件更新 candidate 为 `rejected`。最终可能出现 `golden_questions` 存在，但 `l5_candidates.status = rejected` 的矛盾状态。

这会破坏 golden 命名空间和候选状态的一致性，也会让后续读侧不知道该候选到底是否已晋升。

**建议**

- 把候选读取、毒株 authoring 决定、状态更新纳入同一候选锁语义：`SELECT ... FOR UPDATE` 或 `UPDATE ... WHERE id=? AND status='queued' RETURNING` 抢占。
- 通过/失败都必须先成功占有 queued candidate；占不到就返回 already-decided。
- 增加并发测试：`Promise.allSettled()` 同时跑一个 pass 和一个 fail，断言不可能出现 golden row + rejected status。

### EGR-CR-021 · P1 · governance `rollbackTo()` 回滚 policy，不回滚实际生效的 Standards gate

**证据**

- `packages/engram-core/src/governance/controller.ts:87-95`：治理周期只有在 `gateWouldTighten()` 为 true 时才调用 `setStandards()`，也就是只会把 active Standards 门限抬高。
- `packages/engram-core/src/governance/governance-state.ts:95-119`：`rollbackTo()` 只把历史 `governance_state.policy` 追写成新行；没有调用 `setStandards()`，也没有写新的 active Standards。
- `packages/engram-core/src/config/standards.ts:78-128`：真正影响新 recall 的是 `standards` 表最新行，而不是 `governance_state` 最新 policy。
- `packages/engram-core/src/__tests__/governance.test.ts:218-248`：rollback 测试只断言 `getActivePolicy()` 回到旧值和 history append-only，没有断言 `getActiveStandards()` 的 `consumeFloor` / `mustVerifyThreshold` 同步回落。

**问题**

PRD Story 29 要求“改门、翻转状态、回灌 g”这类治理动作可一键回退。当前 controller 抬门时会实际写 `standards`；但 rollback 只更新治理策略表，不更新 active Standards。结果是 UI / 审计看到 `promotionGateLevel` 已回到旧版本，真实 `recall_claims` 仍继续使用之前抬高的 `consumeFloor` / `mustVerifyThreshold`。

更糟的是健康周期也不会自动修复这个脱节：controller 的 gate 写入逻辑只允许 tighten，`gateWouldTighten()` 对低于当前 Standards 的 rollback policy 返回 false，因此 Standards 会一直停在高门。

**建议**

- rollback 需要有一个专门的 human-only standards rollback 路径：追加一行 Standards，把门限回到目标 policy 对应值或目标历史 standards row。
- 如果“controller 不能放松”是有意设计，那么 `rollbackTo()` 不能声称完成改门回滚；应拆成 `rollbackGovernancePolicyOnly()`，并提供显式 `rollbackStandardsTo()`。
- 增加回归测试：先跑治理周期抬高 `consumeFloor`，再 rollback 到 baseline policy；断言新的 active Standards 也回到目标门限，或明确抛错提示 policy-only rollback 不影响 recall gate。

### EGR-CR-022 · P1 · Distiller provenance 只校验 locator 非空，不校验它来自 `read_source` 分块

**证据**

- `packages/engram-workers/src/read/source-reader.ts:26-42`：`ReadSegment` 明确定义 locator + text，`ReadResult.segments` 是 read_source 归一后的“带锚分块”。
- `packages/engram-workers/src/distiller.ts:73-79`：Distiller 把每个 segment 渲染成 `<locator>\t<text>` 交给 loop。
- `packages/engram-workers/src/distiller.ts:147-157`：`commit_claim` 工具只检查 `claimText` 和 `locator` 非空。
- `packages/engram-workers/src/distiller.ts:165-171`：提交 provenance 时直接采用模型传回的 `locator` / `excerpt`，没有验证 locator 是否存在于 `read.segments`，也没有验证 excerpt 是否来自该段。
- `docs/PRD.md:45-46`、`docs/PRD.md:66-68`：消费方和 Distiller 的契约都是 claim 带可点击 provenance，且无出处即拒。

**问题**

D1 强制 provenance 当前只保证 `source_id` 存在、`locator` 是非空字符串。一个出错或被提示注入的 Distiller loop 可以提交 `L999`、`cell:R999C999`，或者引用真实 locator 但把 excerpt/claim 绑到另一段内容上。内核会把这条 provenance 当作 `relevance='exact'` 写入。

这会让“可点击钻回原文”的 provenance 契约失真：UI/consumer 看起来拿到了 exact citation，实际回钻不到 reader 产出的任何 source segment，或者钻回的是不支持该 claim 的段落。换句话说，无出处不写入的红线在 Distiller 工种层被降级成“模型填了一个 locator 字符串”。

**建议**

- 在 `runDistiller()` 读完 source 后构造 `Map<locator, segment>`，`commit_claim` 只允许 locator 命中该 Map。
- 如果提供 `excerpt`，至少要求它是命中 segment text 的子串；否则由工种用命中 segment text 生成/截取 excerpt，而不是信任模型自报。
- unknown locator 应返回 `isError: true` 回灌 loop；如果多次提交 unknown locator 或最终 0 claim，应进入 human_pending / audit，而不是 `done`。
- 增加测试：fake runtime 对非空 read source 提交 `locator='L999'`，期望 claim 不写入，source 进入可观察的失败/人工路径；再测同 locator 但 excerpt 不属于该 segment 也被拒。

### EGR-CR-023 · P1 · core SPI 允许空 locator，公共写入路径能产生不可钻回的 provenance

**证据**

- `packages/engram-core/src/spi/append-claim.ts:62-67`：`ProvenanceInput.locator` 是 string，但没有品牌类型或运行时约束。
- `packages/engram-core/src/spi/append-claim.ts:69-76`：`requireProvenance()` 只检查 provenance 数组长度 ≥1。
- `packages/engram-core/src/spi/append-claim.ts:203-218`：`insertProvenances()` 直接写 `p.locator`。
- `packages/engram-core/src/spi/append-claim.ts:294-308`、`packages/engram-core/src/spi/append-claim.ts:332-362`：`appendClaim()` 和 `supersedeClaimInTx()` 都复用这个弱 guard。
- `packages/engram-core/src/spi/transition.ts:48-61`、`packages/engram-core/src/spi/transition.ts:168-179`：红边放松可附带 exact 正向证据，但 evidence locator 同样直接写入。
- `packages/engram-core/src/db/schema.ts:124-137`：DB 只要求 `locator text NOT NULL`；空字符串仍合法。
- `packages/engram-core/src/__tests__/append-claim.test.ts:93-109`、`packages/engram-core/src/__tests__/append-claim.test.ts:302-314`：现有 D1 测试覆盖“provenance 数组为空”和 `source_id NULL/FK`，没有覆盖空 locator。

**问题**

Consumer SPI 的写半边可以调用：

```ts
appendClaim(db, embedder, { claimText: 'x' }, [{ sourceId, locator: '' }])
```

这会通过 `requireProvenance()`、通过 DB NOT NULL，并最终成为一条带 provenance 的 claim。`recall_claims` 只看是否有 provenance 行，会把这条 claim 当成有出处结果返回；但 consumer/UI 无法从空 locator 钻回原文锚点。

这比 Distiller 的工种内校验更底层：即使修了 `runDistiller()`，`append_claim`、`supersede_claim`、主编红边 evidence 仍能写出不可点击的 exact/supporting provenance。D1 的物理边界现在只护住 `source_id`，没有护住“指回 source 的可点击锚”这个契约。

**建议**

- 在 core 层新增统一 `validateProvenanceInput()`：数组非空、每条 `sourceId` 非空、`locator.trim().length > 0`，必要时也限制 locator 长度。
- `appendClaim()`、`supersedeClaim()`、`commitClaim()`、`transitionClaimInTx()` 的 red-edge evidence 都复用同一 guard。
- DB 层加 check constraint，例如 `length(btrim(locator)) > 0`，避免绕过 SPI 的写入。
- 增加测试：`appendClaim` / `supersedeClaim` / red-edge evidence locator 为空或全空白时拒写，且 claim/status 不被部分提交。

### EGR-CR-024 · P1 · `derived_from` sibling 会被当成独立来源，f3 可被同上游派生源刷高

**证据**

- `docs/PRD.md:99`、`docs/PRD.md:407-412`：独立来源判定要求 `id≠ ∧ hash≠ ∧ ¬derivedChain`，印证只数独立 supports 源。
- `packages/engram-core/src/db/schema.ts:92-94`：`source.derivedFromSourceId` 是源级血缘，目的就是“同链不重复计印证”。
- `packages/engram-core/src/spi/append-claim.ts:99-128`：`computeConfidenceFromProvenances()` 只把当前 claim 的 provenance source ids 查出来，再交给 `countIndependentSupports()`。
- `packages/engram-core/src/same-fact/independent.ts:29-40`：`hasInSetAncestor()` 只在当前 supports 集合内追 `derivedFrom`；祖先不在集合里就停止。
- `packages/engram-core/src/same-fact/independent.ts:45-61`：`countIndependentSupports()` 先按 hash 去重，再只折叠“集合内 derived_from 链”，最后把 survivors 全部计数。
- `packages/engram-core/src/__tests__/same-fact.test.ts:127-158`：现有测试覆盖 root 在集合内的 A <- B <- C 链，没有覆盖 B、C 同源于一个未被该 claim 引用的外部 root。

**问题**

如果有一个上游源 `R`，两个下游源 `B.derivedFromSourceId = R.id`、`C.derivedFromSourceId = R.id`，且某条 claim 只引用 B/C、不引用 R：

```ts
countIndependentSupports([B, C]) // 当前会得到 2
```

原因是 `computeConfidenceFromProvenances()` 只读取 B/C 两行，`hasInSetAncestor()` 看不到集合外的 R，于是 B 和 C 都成为 survivors。结果 f3 把同一个上游派生出的 sibling 当作两条独立印证，直接抬高 confidence 和 Arbiter 阶梯里的“⑤ 独立印证数”。

这违反 A.6 “无 derived_from 血缘路径”的原意。`derived_from` 是血缘图，不是“只有引用了祖先才生效”的本地边；否则领域 adapter 只要把同一 datasheet 派生成多个加工源并只引用加工源，就能刷高 f3。

**建议**

- 计算 supports 时，不只读取 provenance sources，还要递归读取每个 source 的 ancestor chain，折叠到根或稳定 lineage key。
- 对 sibling 情况按同一 ancestor root 计一次；`agent_synthesis` 折扣应在折叠后应用，避免一个上游衍生出多个 synthesis 各拿 0.5。
- 给 `countIndependentSupports()` 或 DB-backed confidence 计算加测试：R 不在 provenances，B/C 都 derived_from R，期望独立计数为 1 而不是 2。
- 如果递归追溯暂时超 scope，至少在 `SourceIndep` 上显式要求传入 `rootSourceId` / `originKey`，不要让当前函数声称覆盖 `derivedChain`。

### EGR-CR-025 · P1 · draft→active 晋升门不吃实时 conflictDecay，带活跃矛盾的 draft 可被 agent 晋升

**证据**

- `docs/PRD.md:146-153`：confidence 管线把冲突惩罚列为七因子之一，消费门按 `conf` 判。
- `docs/PRD.md:387-399`：`draft → active` 蓝边条件是 `conf≥0.5` 且 entailment pass；晋升条件读的是 conf，不是存档裸 base。
- `packages/engram-core/src/spi/append-claim.ts:221-247`、`packages/engram-core/src/__tests__/append-claim.test.ts:453-465`：append/commit 可以给 draft claim 落 `contradicts` 边，且两条 claim 都保留。
- `packages/engram-core/src/spi/transition.ts:115-140`：非 human promote 只实时覆盖 f1/f2，再调用 `rawFromStoredFactors(factors, std.factorWeights)`；没有传入实时 conflictDecay。
- `packages/engram-core/src/spi/transition.ts:119-120`：代码注释明确说 “conflictDecay 取存档快照”，实时一致性留到以后。
- `packages/engram-workers/src/verifier.ts:242-248`：Verifier 对 draft 的 `pass` verdict 会调用 `transitionClaim(..., 'active', { entailmentPass: true })`，因此这是实际晋升路径。
- `packages/engram-workers/src/__tests__/verifier.test.ts:214-230`：现有晋升测试覆盖 live f2 抬升，但没有覆盖“已有活跃 contradicts 边时必须按 live conflictDecay 降低 promote conf”。

**问题**

一个 draft 在写入时就可能与 active claim 形成矛盾边。召回路径会按实时 active contradiction 计算 `conflictDecay`，但 promote gate 仍用存档 `conflictDecay=1`。

因此可以构造 stored/live f2 后裸 conf 刚好 ≥0.5、但乘以一个活跃矛盾后的 live conf <0.5 的 draft。Verifier 只要判 entailment pass，就会把它晋升 active。晋升后这条 claim 可能又因 recall gate 掉出召回，形成“active 但达不到 promote conf”的状态；更严重的是它会进入 active↔active 冲突收敛面，给 Arbiter/主编制造本应卡在 draft 的冲突。

这破坏了同一个 claim 在 promote 与 recall 之间的 confidence 口径一致性。既然 S23 已把 recall/inbox 的实时 confidence 抽成单一口径，状态机 promote 也不能继续用旧 conflict 快照。

**建议**

- 在 `transitionClaimInTx()` 的 promote 分支读取该 claim 的活跃 contradicts 对端，并把 `conflictDecay(liveActiveContradicts)` 传入 `rawFromStoredFactors()`。
- 或复用 `loadLiveConfidence()` / `liveContradictsByClaim()` 的底层口径，避免 promote、recall、inbox 三处漂移。
- 增加测试：draft 与 active peer 已有 `contradicts` 边，patrol pass 把 f2 抬高后裸 conf ≥0.5，但 live conflictDecay 后 <0.5；期望 agent promote 被拒、仍为 draft。另测 human Approve 仍可旁路。

### EGR-CR-026 · P1 · Reconciler 的 `conflictsWith` 升级信号没有接入 runner，near-dup poison 不会交给 Arbiter

**证据**

- `packages/engram-core/src/spi/reconcile-signal.ts:1-11`：Reconciler 升级信号声明为“交 Arbiter(S20) 消费”，`conflictsWith` 是 pairwise conflict 的对端 id。
- `packages/engram-workers/src/reconciler.ts:333-362`：poison verdict 时只调用 `recordReconcileEscalation()` 写 patrol 行，不写 `relation(type='contradicts')`，也不返回事件。
- `packages/engram-workers/src/__tests__/reconciler.test.ts:180-215`、`packages/engram-workers/src/__tests__/reconciler.test.ts:324-347`：测试只断言 escalation 行和 `conflictsWith` 存在，没有断言 Arbiter 被触发。
- `packages/engram-workers/src/runner/engram-runner.ts:202-209`：runner 的 Reconciler handler 调 `reconcileBatch()` 后直接结束，返回 `void`，没有把 `getReconcileEscalations()` 转成 `conflict.detected`。
- `packages/engram-workers/src/runner/engram-runner.ts:222-230`：Arbiter 只响应 `conflict.detected` 事件。
- `packages/engram-workers/src/runner/engram-runner.ts:256-279`：runner 产生 `conflict.detected` 的唯一来源是 `allContradictsPairs()` 扫 `relation(type='contradicts')`。
- `packages/engram-workers/src/arbiter.ts:354-360`：Arbiter 触发声明却写着 Verifier 的 `not_co_true`、Reconciler 的近重复投毒升级、append 的 `contradicts` 边都会进入 `conflict.detected`。

**问题**

S18 near-dup poison 路径当前只把信号写进 `claim_verification(kind='patrol')`：

```text
claim A: verdict.reason = near_dup_poison, conflictsWith = B
```

但 live runner 不读取这条信号，也不会发 `conflict.detected([[A,B]])`。除非同一对同时另有 `relation(type='contradicts')`，Arbiter 永远不会看到这对 pair。结果是 Reconciler 文档承诺的“flag + 升级 Arbiter”实际只完成了 flag/f2 压低，冲突收敛半边断开。

这对 draft poison 更明显：A.4 不允许 draft→flagged，Reconciler 只能记录升级信号；但 runner 不消费信号时，这条 draft poison 既不被收紧，也不被 Arbiter/主编收敛，只静静留在影子区。

**建议**

- 让 Reconciler handler 返回后继事件：从 `reconcileBatch()` 的 `pairs` 结果或 `getReconcileEscalations()` 读出 `[claimId, conflictsWith]`，发 `conflict.detected`。
- 或让 `recordReconcileEscalation()` 同事务写一条可被 `allContradictsPairs()` 扫到的 relation，但要明确这是否等价于 `contradicts`，避免把 near-dup poison 与普通 object 反向混淆。
- 增加 runner/choreography 测试：构造 near-dup poison 没有 `contradicts` relation，只靠 Reconciler escalation；期望 `arbiterRuntimeFor` 收到 `[A,B]`，并产生 resolved/escalated 裁决。
- Verifier 的 `PatrolVerdict.conflictsWith` 也应走同一转换逻辑，避免 pairwise 信号只停在 patrol 行。

### EGR-CR-027 · P1 · ECE 读数没有独立用户/task 门控，可被重复 usage_truth 刷低

**证据**

- `docs/PRD.md:183-185`：L3/纵向把 ECE 列为命门维度，并要求经 Consumer SPI 接入。
- `docs/PRD.md:209`：A3 红线要求测试不能让纵向趋势和校准 g 被 Goodhart 污染。
- `packages/engram-core/src/calibration/fit-from-usage.ts:5-16`：S28 拟合 g 的 usage 取样明确要求“独立用户/不同 task 门控”，同一 `(by_role, taskId)` 只算一票，防止同源刷单堆样本。
- `packages/engram-core/src/calibration/calibration.ts:105-127`：`computeCalibrationFromUsage()` 只 select `verdict`，只按 `kind/outcome/predictedConfidence` 过滤；没有读取 `byRole`，也没有按 `taskId` 去重。
- `packages/engram-core/src/eval/system-dimensions.ts:249-251`：L3 `ece` 直接取 `computeCalibrationFromUsage(db).ece`。
- `packages/engram-core/src/eval/longitudinal-recompete.ts:223-235`：S31 纵向复考也复用 `computeSystemDimensions()` 的 ECE。
- `packages/engram-core/src/__tests__/longitudinal-recompete.test.ts:152-168`：现有 ΔECE-down 测试用同一个 `byRole='consumer:test'`、无 `taskId` 连续写 10 条 adopted，把 ECE 冲低并断言纵向改善。

**问题**

拟合 g 的中环已经知道 usage_truth 需要反刷单门控，但 S5/S30/S31 的 ECE 报表口径没有同样门控。一个 consumer 可以对同一 claim、同一任务重复上报 adopted/correct/refuted，直接改变 reliability diagram 的样本分布。

这不会立刻改 g，但会污染两条承重读数：

1. 系统八维的 `ece`。
2. 纵向 `ΔECE↓`，也就是“越用越好”的核心证据。

现有测试把这个漏洞固化成正例：同一身份重复 10 次就能让 T1 的 ECE 比 T0 更低。那不是系统校准变好，是样本重复权重变了。

**建议**

- 抽出单一 usage calibration sample reader，至少支持 `mode: 'raw-events' | 'independent-identities'`；S30/S31 默认用 independent identities。
- `computeCalibrationFromUsage()` 需要读取 `byRole` + verdict.taskId，并按 `(byRole, taskId)` 或更强的 recall snapshot identity 折叠。
- 保留 raw event ECE 只作为诊断项，不要作为 L3/纵向 gate 的默认值。
- 增加回归测试：同一 `(byRole, taskId)` 重复 100 条 adopted，只能改变 raw event diagnostics，不能改变 gated ECE / `runRecompeteSnapshot()` 的 ΔECE。

### EGR-CR-028 · P2 · 复考 delta 没按 ring 隔离，inner/mid 会污染 outer 纵向曲线

**证据**

- `packages/engram-core/src/eval/longitudinal-recompete.ts:11-15`：实现注释把 `inner/mid/outer` 三环定义为同口径但可叠加对比的读数。
- `packages/engram-core/src/eval/longitudinal-recompete.ts:154-171`：`latestPriorValue()` 只按 `frozenGoldenVersion + dimension` 找上一行，没有把 `ring` 放进条件。
- `packages/engram-core/src/eval/longitudinal-recompete.ts:238-250`：写当前 ring 的 delta 时，`prev` 来自上面这个不带 ring 的查询，并写入 payload。
- `packages/engram-core/src/eval/longitudinal-recompete.ts:267-278`：读曲线时却支持 `{ ring }` 过滤，说明 ring 是一条可独立画的 series 维度。
- `packages/engram-core/src/__tests__/longitudinal-recompete.test.ts:181-196`：现有测试只断言三种 ring 都能写、读时可过滤，没有断言 outer 的 delta 不会拿 inner/mid 的前值。

**问题**

如果先跑 `outer T0`，再跑一次 `mid T0` 或 `inner T0`，随后跑 `outer T1`，`outer T1` 的 delta 会拿最近的 mid/inner 值当 `prev`。这会让“外环 release 纵向”的改善量依赖中环/内环什么时候跑，而不是依赖上一个 outer release 快照。

读 API 可以过滤 outer-only 曲线，但写入时 delta 已经被混环前值污染，过滤也救不回来。

**建议**

- `latestPriorValue()` 增加 `ring` 参数，并在 where 条件里加 `eq(recompeteEvents.ring, ring)`。
- 如果需要全环叠加总览，另设 `ring='all'` 或单独聚合，不要让默认 delta 交叉引用。
- 增加测试：`outer T0 -> mid T0 -> outer T1`，期望 `outer T1.payload.prev` 等于上一个 outer 值，而不是 mid 值。

### EGR-CR-029 · P1 · ECE 聚合忽略 `calibrationVersion`，换 g 后 reliability diagram 混入不可比预测

**证据**

- `docs/PRD.md:380-385`：`calibration_version` 用来锚定快照，`code_version` 变更标记历史 raw/conf 不可比。
- `packages/engram-core/src/spi/report-usage.ts:36-41`：`report_usage` 的 `calibrationVersion` 是召回快照的 g 版本，并注明将来按 g 版本分段校准。
- `packages/engram-core/src/spi/report-usage.ts:145-152`：写入 usage_truth 时确实保存了 `predictedConfidence` 和 `calibrationVersion`。
- `packages/engram-core/src/calibration/fit-from-usage.ts:8-16`、`packages/engram-core/src/calibration/fit-from-usage.ts:94-120`：S28 拟合路径默认只取 `calibrationVersion='identity'`，明确说明非 identity 的 `predictedConfidence` 已经不是 raw，混入会污染拟合。
- `packages/engram-core/src/calibration/calibration.ts:105-127`：公开 ECE 聚合只 select `verdict`，没有按 `calibrationVersion` 过滤或分组。
- `packages/engram-core/src/__tests__/calibration-usage.test.ts:154-213`：现有输入边界测试覆盖 outcome、predictedConfidence、ELO/winRate 忽略，但没有覆盖不同 `calibrationVersion` 的样本必须分段。

**问题**

`predictedConfidence` 是召回当刻的 `value=g(raw)`。换 g 之后，旧样本里的 0.8 和新样本里的 0.8 不一定来自同一个 raw 区间，也不代表同一条映射的校准质量。

当前 `computeCalibrationFromUsage()` 把所有版本摊进一个 reliability diagram；S30/S31 又直接拿这个 ECE 当系统维度和纵向趋势。因此一次 g 切换后，ECE 的变化可能只是“样本来自不同 g 版本”，不是系统更准或更差。PRD 已经说 historical raw/conf 不可比，代码却在报表层把它们混成可比。

**建议**

- 给 `computeCalibrationFromUsage()` 增加 `calibrationVersion` / `fromVersions` 参数，默认取当前 active g 或 identity，诊断时才允许 all。
- ReliabilityReport diagnostics 应包含版本分布，避免 sampleCount 失去解释力。
- 纵向 `runRecompeteSnapshot()` 应把所用 `calibrationVersion` 或版本过滤条件写入 payload。
- 增加测试：同一 bin 中 identity 样本和 `iso-v1` 样本混合时，默认 ECE 只取目标版本；显式 all 才返回混合报表，并在 diagnostics 标明 mixed。

### EGR-CR-030 · P1 · S28 usage 取样先过滤 clean outcome，导致最新 `corrected/partial` 覆盖不了旧 adopted/refuted

**证据**

- `packages/engram-core/src/calibration/fit-from-usage.ts:69-87`：`gatedSamples()` 声称同一 `(byRole, taskId)` 后到覆盖先到，最新结局才算数。
- `packages/engram-core/src/calibration/fit-from-usage.ts:98-120`：实际 SQL 在进入 `gatedSamples()` 前已经过滤 `outcome in ('adopted','refuted')`。
- `packages/engram-core/src/calibration/fit-from-usage.ts:122-135`：循环里只会看到 clean outcome，所以没有机会把同身份后来的 `corrected/partial` 覆盖成“不计样本”。
- `packages/engram-core/src/harvest/usage-correct.ts:112-136`：f4 路径的同类去重口径明确让 `corrected/partial/未知` 覆盖旧 adopted/refuted 为 `null`，防止旧票继续计数。
- `packages/engram-core/src/__tests__/calibration-isotonic.test.ts:202-217`：现有反刷单测试只覆盖同身份 repeated adopted/refuted 折叠，没有覆盖 latest 为 corrected/partial 的身份退出拟合样本。

**问题**

S28 首次拟合 g 的取样口径需要“最新使用真值”。但当前实现先把 `corrected/partial` 从 SQL 结果里丢掉，再做 latest-by-identity。于是：

```text
same identity: adopted(0.9) -> corrected
```

最终仍会留下旧的 adopted(0.9) 作为校准样本。这等于把用户后续纠错从 g 拟合里抹掉，方向和 f4 的 usage-correct 口径相反。

坏结果是校准门槛也可能被误触发：199 个真实有效样本 + 1 个“已被 corrected 覆盖的旧 adopted”会被算成 200 个，`fitAndMaybeRecalibrate()` 提前拟合 g。

**建议**

- `collectUsageCalibrationSamples()` 应先读取该版本下所有 usage_truth outcome，再按 identity 取 latest，最后只把 latest 为 adopted/refuted 且有 predictedConfidence 的身份转成 sample。
- 逻辑可以直接复用/抽象 `usage-correct.ts` 的 latest-by-identity 口径，避免 f4 和 g 拟合漂移。
- 增加测试：同一 `(byRole, taskId)` 先 adopted 后 corrected/partial，`collectUsageCalibrationSamples()` 不返回该身份；199 个有效样本 + 这个身份不能触发 fit。

### EGR-CR-031 · P2 · 空白 query 在 reflux 中被当作可重放问题和 L5 候选

**证据**

- `packages/engram-core/src/spi/report-usage.ts:145-152`：`query` 原样保存为 `ctx.query ?? null`，空串和空白串不会归一化为 null，也不会被拒绝。
- `packages/engram-core/src/spi/reflux.ts:86-100`：L5 候选入队只判断 `f.query != null`，所以 `''` / `'   '` 会被当成有效问题。
- `packages/engram-core/src/spi/reflux.ts:165-190`：replay 只把 `query == null` 判为 unreplayable；空串会调用 `recallClaims()`，并返回 `replayable: true`。
- `packages/engram-core/src/spi/recall-claims.ts:112-123`：`recallClaims()` 对空串直接返回 `[]`。
- `packages/engram-core/src/__tests__/reflux.test.ts:218-226`：现有测试只覆盖省略 query/null 不入 L5，没有覆盖空串/空白串。
- `packages/engram-core/src/__tests__/reflux.test.ts:314-334`：replay 的 narrow pass 语义会把“未召回失败 claim”算 pass；空串天然召回空集，容易误判成已修复。

**问题**

用户或 adapter 如果上报：

```ts
reportUsage(db, claimId, 'refuted', {
  byRole: 'human:judge',
  kbLacksAnswer: true,
  query: '',
})
```

`refluxFailures()` 会把它放入 regression_pool，并且还会 queue 一个没有真实问题文本的 L5 candidate。之后 replay 会把空 query 视为可重放，`recallClaims('', ...)` 返回空集，于是 `pass=true`。这不是“失败已修复”，只是没有问题可问。

**建议**

- 在 `reportUsage()` 写入前把 `query.trim().length === 0` 归一化为 null，或者直接拒绝 blank query。
- `refluxFailures()` 的 L5 条件改为 `typeof query === 'string' && query.trim().length > 0`。
- `replayRegressionItem()` 同样把 blank query 判为 unreplayable。
- 增加测试：blank query 的 human kbLacksAnswer 不入 L5，replay 为 `unreplayable` 而不是 pass。

### EGR-CR-032 · P1 · Arbiter runtime 抛错时不会执行 pending pair 的人审兜底

**证据**

- `packages/engram-workers/src/arbiter.ts:298-305`：`deps.runtime.run()` 直接裸 `await`，抛错会跳出 `arbitrateConflicts()`。
- `packages/engram-workers/src/arbiter.ts:307-322`：把未裁 pending pair 升级给主编的兜底逻辑在 runtime 成功返回之后才执行。
- `packages/engram-workers/src/runtime/dispatcher.ts:162-176`：dispatcher 会吞掉 worker handler 的异常并记录 failure，级联主干继续。
- `packages/engram-workers/src/__tests__/arbiter.test.ts:305-330`：已有测试覆盖 maxTurns/budget exhaustion 返回非 done 时会升级 pending pair。
- `packages/engram-workers/src/__tests__/arbiter.test.ts:379-382`、`packages/engram-workers/src/__tests__/arbiter.test.ts:420-441`：`throwingRuntime` 只用于证明 loop 不该进入的路径，没有覆盖“有 active pair 且 runtime 抛错”时仍应升级。

**问题**

Arbiter 的设计承诺是有界 loop：裁不动、耗尽预算或异常时，冲突不能无限挂起，必须交人。但 runtime 真抛错时，当前函数会 reject；dispatcher 继续吞异常，外层看起来“系统没崩”，而该 active↔active pair 既没 resolved，也没进 editor queue。

这比 maxTurns 更危险：模型/API/runtime 故障是生产常态，正是需要 fail-safe escalation 的情况。

**建议**

- 用 `try/catch` 包住 `deps.runtime.run()`。catch 时构造 `{ reason: 'error' }` 或等价 loop result，然后复用同一段 pending escalation。
- 升级 reason 里写入 runtime error 摘要，便于主编知道是系统故障而非证据并列。
- 增加测试：active↔active pair + runtime 抛错，`arbitrateConflicts()` resolved=false、escalated=1，`getEditorConflictQueue()` 可见该 pair。

### EGR-CR-033 · P1 · governance cycle 的 fail-silent 不是原子 no-op，Standards 写失败会留下半提交 policy

**证据**

- `packages/engram-core/src/governance/controller.ts:72-85`：`runGovernanceCycle()` 先读 metrics/active policy，再 `writeGovernanceState()` append 新 policy row。
- `packages/engram-core/src/governance/controller.ts:87-95`：随后才读取 active Standards，并在需要抬 gate 时调用 `setStandards()`。
- `packages/engram-core/src/governance/controller.ts:107-112`：外层 catch 把任何异常返回成 `ran:false`、`degraded silently`。
- `packages/engram-core/src/governance/governance-state.ts:53-72`：`writeGovernanceState()` 是独立 insert，没有事务参数。
- `packages/engram-core/src/config/standards.ts:82-104`：`setStandards()` 也是独立 insert，没有和 governance row 绑定在同一事务。
- `packages/engram-core/src/__tests__/governance.test.ts:385-438`：现有 fail-silent 测试用 dead DB，在第一步就失败，断言没有 governance/standards row；没有覆盖 policy 写成功后 Standards 写失败的半提交。

**问题**

如果本轮 controller 先写入 policy row，然后 `getActiveStandards()` / `setStandards()` / `getActiveStandards()` 任何一步失败，函数会返回：

```text
ran=false: governance cycle degraded silently
```

但 `governance_state` 已经 append 了新 active policy。下一轮 `getActivePolicy()` 会把这个半提交 policy 当基线；真实 recall gate/active Standards 却没有同步。

这不是 no-op，也不是 fail-silent。它会制造一个“控制面以为已经抬严/改变，数据面没变”的裂缝。EGR-CR-021 是 rollback 不回 Standards；这一条是 normal cycle 也能半提交。

**建议**

- 把 `writeGovernanceState()`、必要的 `setStandards()`、以及最后的 active standards read 放进一个事务；失败则整体回滚。
- 或者显式建 `partial` 状态并禁止 `getActivePolicy()` 读取 partial rows，不能用 `ran=false` 掩盖副作用。
- 增加测试：注入 DB/proxy 让 governance_state insert 成功后 standards insert 抛错；期望返回失败后 active policy/history 不变，或明确进入 partial 状态且不会成为 active baseline。

### EGR-CR-034 · P1 · Verifier 对无 exact/supporting evidence 的 claim 仍调用 judge，pass 后可晋升 active

**证据**

- `packages/engram-core/src/spi/append-claim.ts:62-75`：core append 只要求 provenance 数组非空；没有要求至少一条 `exact/supporting`。
- `packages/engram-core/src/db/schema.ts:130-138`：`claim_provenance.relevance` 允许 `tangential/irrelevant`。
- `packages/engram-workers/src/verifier.ts:153-166`：`loadEvidence()` 会过滤掉 tangential/irrelevant；若一条 claim 只有这些 provenance，`evidence` 为空。
- `packages/engram-workers/src/verifier.ts:326-335`：即使 `evidence` 为空，Verifier 仍调用 `deps.judge.judge({ evidence })`。
- `packages/engram-workers/src/verifier.ts:242-248`：draft claim 只要 entailment `pass` 就尝试 `draft → active`。
- `packages/engram-core/src/verifier/fake-entailment-judge.ts:1-18`：测试 fake judge 默认一律 pass。
- `packages/engram-core/src/verifier/dashscope-entailment-judge.ts:26-31`：生产 judge 只是 prompt 里提示 no evidence unsupported，没有 deterministic hard guard。

**问题**

一条只有 tangential/irrelevant provenance 的 draft 满足 D1“有出处”，但没有任何能推出 claim 的证据。当前 Verifier 会把空 evidence 交给 judge；只要 judge 错判或 fake/default path 返回 pass，就会进入 `transitionClaim(... active, entailmentPass:true)`。

这破坏 forced provenance 的实际语义：active claim 不只是“有任意 source_id”，还必须能从 exact/supporting evidence 推出。否则 tangential source 也能给 active claim 背书。

**建议**

- `loadEvidence()` 返回空时不要调用 LLM，确定性写 patrol `fail` / `no_supporting_provenance`，draft 保持 draft，active 则走收紧。
- 这个 guard 应在 Verifier 里硬执行，不依赖 prompt 或 fake judge 默认。
- 增加测试：tangential-only draft + pass judge，期望 judge 未被调用、claim 不晋升；active tangential-only claim 应被 flagged 或至少产生 fail verdict。

### EGR-CR-035 · P1 · Distiller runtime 抛异常时不会进入 promised 的 human_pending 降级路径

**证据**

- `packages/engram-workers/src/distiller.ts:82-85`：函数注释承诺 kind 不支持 / loop 非正常收尾会标 source 人工待处理并返回 `human_pending`。
- `packages/engram-workers/src/distiller.ts:190-196`：`deps.runtime.run(...)` 是裸 `await`，没有 `try/catch`。
- `packages/engram-workers/src/distiller.ts:198-205`：只有 runtime 正常返回且 `reason !== 'done'` 时才调用 `markSourceHumanPending()`。
- `packages/engram-workers/src/runtime/dispatcher.ts:162-180`：dispatcher 会吞掉 worker 抛错并只记录 failure trace，继续派发其它工种。
- `packages/engram-workers/src/__tests__/distiller.test.ts:101-107`：已有 throwing runtime，但只用于证明某些路径不会进入 loop。
- `packages/engram-workers/src/__tests__/distiller.test.ts:292-303`：现有错误降级测试覆盖的是 runtime 返回 `{ reason: 'error' }`，不是 runtime 直接 throw。

**问题**

生产 runtime / 模型 API 出错时，更常见的是 promise reject 或抛异常，而不是规整返回 `{ reason: 'error' }`。当前 `runDistiller()` 在这种情况下会直接 reject；外层 dispatcher 又会吞掉 worker failure，所以 ingestion 主干看起来继续跑了，但该 source 既没有成功蒸馏，也没有进入 `source_human_pending` 队列。

这和 Distiller 文件头写的“有界：耗尽/源畸形/kind 不支持/读不出块 → 标人工待处理，不无限重试、不阻塞 ingestion”不等价。异常路径被 dispatcher 变成了静默丢 source。

**建议**

- 用 `try/catch` 包住 `deps.runtime.run()`；catch 时复用同一条 `markSourceHumanPending()` 路径，reason 写入 `runtime_error:<message>` 或等价摘要。
- 如果 catch 前已有 `commit_claim` 成功，保留 `committed` 计数和已提交 claim，返回 `status:'human_pending'`。
- 增加测试：`source.ingested` + runtime throw，期望 `getHumanPendingSources()` 可见该 source；dispatcher trace 可以记录失败或由 Distiller 自行消化，但不能让 source 从人审队列消失。

### EGR-CR-036 · P2 · `recordImmunityScore()` 接受 NaN/Infinity/小数，免疫维度可被坏读数污染

**证据**

- `packages/engram-core/src/spi/redteam-generation.ts:148-164`：只检查 `input.injected < 0 || input.detected < 0 || input.detected > input.injected`，没有 `Number.isFinite()` / integer guard；`NaN` 比较全部为 false。
- `packages/engram-core/src/spi/redteam-generation.ts:164-179`：随后直接计算并写入 `detectionRate`、`injected`、`detected`。
- `packages/engram-core/src/db/schema.ts:451-454`：DB 层是 integer + double precision，但没有 check constraint 保证非负、有限、`detected <= injected`。
- `packages/engram-core/src/eval/system-dimensions.ts:253-261`：system dimensions 直接累加所有 immunity score row，再计算 `detected / injected`。
- `packages/engram-core/src/spi/dimension-events.ts:80-95`：同类维度读数明确用 `[0,1]` guard 拦住 NaN。
- `packages/engram-core/src/eval/longitudinal-recompete.ts:128-135`：纵向复考也显式拒绝非 finite delta。
- `packages/engram-core/src/__tests__/system-dimensions.test.ts:453-459`：已有 `recordDimension` 坏值测试，但没有对应的 `recordImmunityScore` 坏计数测试。

**问题**

红队免疫分虽然不进入 calibration g，也不进入在线判据，但它是 L3/system dimensions 的正式读数。当前 guard 对 `NaN`、`Infinity`、`1.5` 这类非法计数不 fail-loud；TypeScript 的 `number` 还能把小数传给 integer column，行为取决于 driver/DB 转换。

结果是一个坏 writer 或测试 helper 可以写入非物理计数，让 `computeSystemDimensions().immunity` 变成 `NaN` / `Infinity` 或被小数读数污染。A3 红线强调红队分不能喂 g，但不代表红队报告可以接受坏数；维度口径必须同样硬。

**建议**

- `recordImmunityScore()` 要求 `injected` / `detected` 都是 `Number.isSafeInteger()`，且 `0 <= detected <= injected`。
- 给 DB 增加 check constraint：`injected >= 0 AND detected >= 0 AND detected <= injected`；`detection_rate` 也应在 `[0,1]`。
- 增加测试：`NaN`、`Infinity`、负数、`detected > injected`、小数全部拒写；`computeSystemDimensions()` 对空分行仍返回 `null`，对合法 `0/0` 按当前设计返回 0。

### EGR-CR-037 · P1 · 空 batch 事件会退化成全库 cron 扫描

**证据**

- `packages/engram-workers/src/runtime/dispatcher.ts:32-39`：`batch_appended` / `report_usage` / `claim.draft` / `claim.flagged` 的 payload 都是 `claimIds: string[]`，事件总线没有运行时校验非空。
- `packages/engram-workers/src/verifier.ts:116-128`：`claimIds.length > 0` 时才限定 `IN (...)`。
- `packages/engram-workers/src/verifier.ts:129-135`：否则走 cron 语义，扫描所有 `PATROL_STATUSES` claim。
- `packages/engram-workers/src/harvester.ts:124-137`：`claimIds.length > 0` 时才限定 `IN (...)`。
- `packages/engram-workers/src/harvester.ts:138-147`：否则走全库 usage_truth claim 扫描。
- `packages/engram-workers/src/runner/engram-runner.ts:116-123`：public `harvestUsage([])` 会发布空 `report_usage` batch。

**问题**

空 batch 是一个应该 no-op 的数据面事件，但当前语义把“带空 claimIds 的 batch”解释成“没有传 claimIds”，从而退化为 cron 全库扫描。对 Harvester 来说这会重算全库 f4；对 Verifier 来说，如果未来任何路径或测试直接派发 `claim.draft` 空 batch，会触发全库巡查，产生额外 judge 调用和潜在状态收紧。

这破坏了 batch 触发和 cron 触发的边界：空精确队列不是“全部队列”。

**建议**

- `verifyEnqueued()` / `harvestBatch()` 对空数组直接返回零处理结果，不调用 cron 选择器。
- `EventDispatcher.runToConvergence()` 或 worker wrapper 也应对 batch payload 做运行时 cardinality 校验，防止坏事件进入工种。
- 增加测试：`harvestUsage([])` 不触发 Harvester 全库重算；`claim.draft` 空 batch 不调用 Verifier judge、不写 patrol、不迁移状态。

### EGR-CR-038 · P2 · `maxEvents` 不是硬上限，同一事件多 worker 命中时会越界派发

**证据**

- `packages/engram-workers/src/runtime/dispatcher.ts:97-107`：`dispatched` 的语义是 “事件 × 命中的工种”。
- `packages/engram-workers/src/runtime/dispatcher.ts:152-156`：只在每次从队列取事件前检查 `result.dispatched >= maxEvents`。
- `packages/engram-workers/src/runtime/dispatcher.ts:158-181`：同一事件命中多个 worker 时，`for (const w of hits)` 内没有再次检查上限。

**问题**

`maxEvents` 被描述为有界 loop 防护，但它不是硬上限。若 `maxEvents=1` 且同一事件命中两个 worker，dispatcher 会实际派发两次；如果两个 worker 都不再入队，循环结束时甚至不会把 `truncated` 置为 true。

这让调用方看到的有界性报告失真，也削弱了用 `maxEvents` 防环 / 防爆炸级联的能力。

**建议**

- 在 worker 派发循环内每次处理前都检查 `result.dispatched >= maxEvents`；超过则 `truncated=true` 并停止当前事件剩余 worker。
- 明确 `maxEvents` 是“worker dispatch 次数”还是“event 出队次数”；代码和字段说明保持一致。
- 增加测试：两个 worker 监听同一 event，`maxEvents: 1` 时只调用一个 worker，返回 `truncated=true`。

### EGR-CR-039 · P2 · dispatcher 吞异常后的失败信号没有 durable audit / dead-letter

**证据**

- `packages/engram-workers/src/runtime/dispatcher.ts:14-15`：文件头把 handler 抛错描述为会被吞掉并“附原因”。
- `packages/engram-workers/src/runtime/dispatcher.ts:97-107`：失败计数和 trace 只存在 `RunToConvergenceResult` 返回对象里。
- `packages/engram-workers/src/runtime/dispatcher.ts:171-180`：catch 只递增 `failures` 并写入内存 `traces`。
- `packages/engram-core/src/db/schema.ts:70-76`：`metrics_event_kind` 没有 dispatcher failure / dead-letter 事件类型。

**问题**

吞异常本身符合“单点失效不掀翻级联”的设计，但生产可恢复性不能只靠返回值。当前如果 caller 没有可靠持久化 `RunToConvergenceResult`，worker 失败会随进程内存或日志丢失；后续无法告警、补偿、重放，也无法让 editor/ops 看到某个工种持续失败。

EGR-CR-035 是 Distiller 具体 runtime throw 没把 source 升级人审；这一条是总线层的通用审计缺口。

**建议**

- 给 dispatcher failure 增加 durable dead-letter / worker_failure 事件，至少记录 workerName、eventType、payload 摘要、error、createdAt。
- 或要求 `EngramRunner` 在每次 `runToConvergence()` 后持久化 failure traces；不能只把它作为返回对象交给调用方。
- 增加测试：注入抛错 handler，跑 runner/dispatcher 后能在 DB 里查到 durable failure audit；同时原级联仍不中断。

### EGR-CR-040 · P2 · `source_human_pending` 人审队列读写没有 payload 验证，会产生空待办

**证据**

- `packages/engram-core/src/spi/worker-audit.ts:35-49`：`markSourceHumanPending()` 直接写入 caller 给的 `sourceId` / `reason` / `byRole`，没有非空校验，也不校验 source 存在。
- `packages/engram-core/src/db/schema.ts:271-281`：`metrics_events.payload` 是通用 `jsonb`，DB 不约束 `source_human_pending` payload 形状。
- `packages/engram-core/src/spi/worker-audit.ts:60-69`：`getHumanPendingSources()` 对 payload 做 cast，缺字段时返回空字符串，而不是 fail-loud 或隔离坏事件。

**问题**

人审队列是 Distiller 降级后的承接面。当前坏 writer、手工迁移或未来代码路径可以写出 `sourceId:''` / `reason:''` 的待办；reader 会正常返回这些空待办，让队列计数看起来有工作，但人无法定位 source，也不会暴露数据损坏。

这和 `report_usage` reader 对非法 outcome fail-loud 的口径不一致，也会让“降级到人”这条 fail-safe 链路变成假待办。

**建议**

- `markSourceHumanPending()` 拒绝空白 `sourceId`、空白 `reason`、空白 `byRole`，并校验 source 存在。
- `getHumanPendingSources()` 对 malformed payload fail-loud 或返回单独 `invalid` 诊断队列，不能静默补空字符串。
- 增加测试：直接插入 malformed `{}` payload 时 reader 不返回空待办；通过 SPI 写空 source/reason/byRole 时拒写。

### EGR-CR-041 · P1 · calibration pilot 绕过正式写入 SPI，伪造 active/confidence，不能证明“真闭环”

**证据**

- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:1-5`：文件头说 `seedCorpus → generateUsage(真 recall + 标签 oracle)`，目标是证明校准闭环在真 usage 上闭合。
- `packages/engram-workers/src/eval/calibration-pilot/corpus.ts:7-15`：文档承认 `rawTarget` / 成熟度是模拟的，但仍声称召回、使用、拟合、ECE “全是真的”。
- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:47-51`：`seedCorpus()` 注释说直接 seed active claim，并把 5 个因子全设到 `rawTarget`。
- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:70-99`：代码直接 `db.insert(schema.claim)`，设置 `status:'active'`、`confidence`、`confidenceRaw`、`confidenceFactors`、`createdBy:'agent:distiller'`。
- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:100-108`：随后另一次 insert 写 `claim_provenance`，没有和 claim insert 放进同一事务。
- `packages/engram-core/src/spi/append-claim.ts:157-200`：正式 `appendClaim()` 会经 `computeConfidenceFromProvenances()` 计算 confidence，并写入 `status:'draft'`。
- `packages/engram-core/src/spi/transition.ts:132-149`：正式 draft→active 还会按钉住的 calibration version 重算 g，并要求 `conf >= PROMOTE_CONFIDENCE_FLOOR` 和 `entailmentPass:true`。

**问题**

这个 pilot 不再走 Consumer SPI / appendClaim / transitionClaim。它直接把 claim 写成 active，并伪造 humanReview、entailment、indepSupport、usageCorrect 等 confidence factors。这样测试通过只能说明“手工塞进一组带标签的 active rows 后，recall/reportUsage/fit 这半边能算出一条 g”，不能证明 PRD 里强调的“评测=消费，同走 Consumer SPI”。

更坏的是 claim 和 provenance 分两次写，没有事务。`claim` insert 成功后如果 `claim_provenance` insert 失败，会留下 active orphan claim。正式写路径至少把 claim/provenance/confidence 的写入放在一个事务边界里。

**建议**

- 如果目标是证明端到端闭环，seed 必须回到正式 `appendClaim()` + `transitionClaim()`，成熟度用真实 patrol/usage/human review 事件或明确的 test-only builder 生成。
- 如果目标只是“校准数学 pilot”，文件名、输出和测试名要降级为 synthetic fixture，不要宣称“真闭环”或“全是真的”。
- `seedCorpus()` 至少要用事务包住 claim/provenance 写入，并显式标记为 synthetic，不要伪装成 `agent:distiller` 产物。
- 增加回归测试：spy/adapter 断言 pilot seed 调用正式 write SPI；或者故障注入让 provenance insert 失败，断言不会留下 active claim。

### EGR-CR-042 · P2 · DashScope calibration pilot 即使样本不足或 ECE 未改善也会打印成功并以 0 退出

**证据**

- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:221-247`：`measureFromSamples()` 对 `samples.length`、`heldout.length`、`identity.ece`、`eceDrop` 都没有最低门槛；空样本或极小样本也会 fit 并返回报告。
- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:272-290`：`runCalibrationPilot()` 返回 `usage` / `measurement` / `persistedSamples`，但不执行 pass/fail gate。
- `packages/engram-workers/src/eval/calibration-pilot/run.ts:85-88`：真实 DashScope 入口会打印 `✓ g 把校准误差压下了` 或 `✗ 未改善`，但无论哪种都继续打印 `[m2] 校准 pilot 跑通 ✓`。
- `packages/engram-workers/src/eval/__tests__/calibration-pilot.test.ts:70-86`：CI fake 端口测试有若干本地断言，但这些通过条件没有抽成 `run.ts` 和真实入口复用的 gate。

**问题**

真实 pilot 的价值是证明“真 Qwen embedding + 真 usage 回路下 g 能压低 ECE”。但如果真实嵌入召回失败、样本太少、heldout 为空，或者 isotonic 在留出集上没有改善，当前 CLI 仍会成功退出并打印“跑通”。这会把“诊断失败”包装成“pilot 通过”，尤其容易误导 M2/M3 的交付判断。

**建议**

- 把 CI 测试里的成功门抽成 `assertCalibrationPilotPass()`，`run.ts` 和测试共用。
- 真实入口应在 `recallHits === 0`、`totalSamples` 低于门槛、`heldoutCount === 0`、`identity.ece` 不足、或 `eceDrop <= 0` 时抛错并非零退出。
- 增加测试：构造空样本 / 无改善样本，断言 CLI-level pass gate fail-loud，而不是只在输出里写 `✗ 未改善`。

### EGR-CR-043 · P2 · `bidding-adapter` 生产代码穿透 core schema，Consumer SPI 边界不成立

**证据**

- `docs/adapters/README.md:43-57`：adapter 文档把 Consumer SPI 描述为唯一对外缝，并明确“评测=消费，无旁路”。
- `packages/bidding-adapter/src/index.ts:4-8`：文件头也宣称适配器“只用 @engram/core 导出的 SPI 面”，业务身份通过 `source.meta.source_type` 收紧。
- `packages/bidding-adapter/src/index.ts:12-20`：生产代码从 `@engram/core` import 了 `schema` 和 `DB`。
- `packages/bidding-adapter/src/index.ts:29-44`：`readSourceTypes()` 直接查询 `schema.source.meta`，把 source row 的 `meta.source_type` 转成业务身份。
- `packages/bidding-adapter/src/index.ts:81-88`：`biddingTighten()` 的公开路径要求 caller 传入 `db`，先读 source table，再调用 `applyAdapter()`。
- `packages/engram-core/src/spi/adapter.ts:16-17`：`RecallAdapter` 只接收 `RecallResult[]`。
- `packages/engram-core/src/spi/adapter.ts:21-30`：`applyAdapter()` 的 provenance equality 只比较 `sourceId` / `locator` / `relevance`，没有任何可供 adapter 消费的 source metadata。

**问题**

当前 adapter 的关键业务收紧逻辑无法从 Consumer SPI 返回值里完成，只能靠 `DB + schema.source.meta` 旁路再查一次 source table。也就是说，文档宣称的“SPI 三动作是唯一对外缝”在首个生产 adapter 上已经不成立：非 core consumer 必须知道 core 表结构和 `source.meta` 存储位置，才能实现官方数据手册加权。

这不是 `source_type` 是否该由 bidding 解读的问题；bidding 解读业务 key 是正确方向。问题是 core 没给出一个受约束的 metadata seam，导致领域 adapter 只能直接穿透 schema。后续任何 consumer 都会复制这个模式：先把 recall 当半成品，再拿 DB/schema 做私有补全。这样评测也很难真正做到“消费同缝”，因为测试可以绕过 recall result 的合同，直接读内部表。

**建议**

- 在 `RecallResult.provenances` 里增加受限、只读、不可改写的 source metadata 摘要；或新增 `getSourceMetadata(sourceIds)` Consumer SPI，只返回 adapter 被允许消费的不透明 metadata。
- `@engram/bidding-adapter` 生产代码移除 `schema` import；测试可以用 core SPI seed，但 adapter 主路径只能吃 recall result / metadata SPI。
- 文档若暂时不实现 metadata seam，应明确当前 adapter 是 schema-coupled prototype，不能声称 Consumer SPI-only。
- 增加边界测试或 lint：`packages/*-adapter/src/**/*.ts` 生产文件不得 import `schema`；`biddingTighten()` 能在没有 raw DB/schema access 的情况下完成 source_type 收紧。

### EGR-CR-044 · P1 · 校准换图缺 CAS，过期验收也能覆盖当前 active g

**证据**

- `packages/engram-core/src/calibration/recalibrate.ts:57-76`：`evaluateAndMaybeSwap()` 先读 `current` / standards / policy，再基于这个快照跑 Advisor 和 acceptance gate。
- `packages/engram-core/src/calibration/recalibrate.ts:78-95`：验收通过后直接调用 `commitCalibrationMap()`，没有带上 expected active calibration id/version。
- `packages/engram-core/src/calibration/calibration-store.ts:94-103`：`commitCalibrationMap()` 只在事务里 append 一行 calibration map；活动版本由“最新行”隐式决定。
- `packages/engram-core/src/calibration/calibration-store.ts:120-142`：active g 的读取口径就是 `createdAt desc, id desc limit 1`。

**问题**

A.8 的语义是“候选 g 必须相对当前活动 g 过验收门”。当前代码把“读当前 g”和“提交新活动 g”拆成两个无 CAS 的步骤。两个 recalibration 并发时，第二个任务可能基于旧 `current` 通过验收，然后在第一个任务已经激活新 g 后继续 append，变成最新活动行。

这会把 acceptance gate 从“相对当前活动态”降级成“相对某个旧快照”。尤其是净放松 / 越门翻转这类验收项，必须和提交瞬间的 active g 绑定，否则后提交者可以覆盖已经收紧或修正过的 g。

**建议**

- `evaluateAndMaybeSwap()` 记录读到的 active calibration row id/version/createdAt，并把它作为 expected active 传给提交路径。
- 提交时在同一事务里重新读取 active row；如果不等于 expected active，则 HOLD/retry，不写新 map。
- 增加并发回归测试：两个 `evaluateAndMaybeSwap()` 基于同一旧 g 启动；第一个提交成功后，第二个只相对旧 g 过门时必须失败或重试，不能覆盖第一个 active g。

### EGR-CR-045 · P1 · Verifier 先写 scoring patrol 再迁移状态，后半失败会留下通用半裁决

**证据**

- `packages/engram-workers/src/verifier.ts:340-351`：Verifier 先构造并写入 `PatrolVerdict`，该 verdict 会进入 `claim_verification(kind='patrol')`。
- `packages/engram-workers/src/verifier.ts:352`：写 patrol 后立刻把 `result.patrolled` 加 1。
- `packages/engram-workers/src/verifier.ts:356-363`：状态迁移在 patrol 写入之后才调用 `applyTransition()`。
- `packages/engram-workers/src/verifier.ts:373-382`：后半段抛错时只把本条记为 skipped，前面已经写入的 patrol 不会回滚，也没有重试任务标记。
- `packages/engram-core/src/spi/recall-claims.ts:168-169`：recall 会把候选 claim 最新 patrol 裁决实时接入 f2。

**问题**

EGR-CR-001 只覆盖 NC-exact refused 的特例；这里是更通用的半提交边界。任何 transition 阶段的 DB 冲突、约束失败或 runtime error，都可能让 claim 状态保持旧值，但最新 patrol 已经影响 f2 和 recall。调用方看到 `patrolled += 1`，但状态处置其实失败了。

这会制造“裁决已生效、状态未处置”的裂缝：active claim 可以因为半条 fail patrol 掉出 recall，却没有对应的 flagged/quarantined 状态；draft 也可能得到 pass patrol 但晋升失败，后续又被最新 f2 当成已巡查通过。

**建议**

- 单 claim 的 `writePatrolVerdict()` 与 `applyTransition()` 放入同一事务；若 transition 失败，scoring patrol 也不应落地。
- 或把 patrol 写成 pending verdict，只有状态处置成功后才标记为 scoring；失败时写 durable retry/audit event。
- 增加测试：故障注入让 transition 阶段抛错，断言没有影响 f2 的孤儿 patrol；或存在明确 retry/dead-letter，且 recall 不读取未处置 verdict。

### EGR-CR-046 · P2 · `immuneLag` 永远返回 0 且不标 degraded，恒温器把未知当健康

**证据**

- `packages/engram-core/src/governance/metric-readers.ts:10-12`：文件头承认当前 schema 没有状态翻转时戳，`immuneLag` 无可靠数据源，应返回中性 0 并标 degraded。
- `packages/engram-core/src/governance/metric-readers.ts:86-91`：`readImmuneLag()` 实际只是 `return 0`，没有任何 degraded 信号。
- `packages/engram-core/src/governance/metric-readers.ts:137-148`：`readMetrics()` 只有 reader 抛错或返回非有限数时才把指标加入 `degraded`。
- `packages/engram-core/src/governance/control-law.ts:110-115`：`immuneLag` 直接驱动 `patrolFrequency` target；0 表示无延迟压力。
- `packages/engram-core/src/governance/controller.ts:77-85`：degraded 只进 reason 文本；当前 immuneLag 不会出现在 degraded 里。

**问题**

这里不是“lag 很低”，而是“系统根本没有测 lag 的数据源”。当前实现把未知状态伪装成健康 0，控制器会认为免疫延迟没有压力，审计记录也不会显示本轮使用了降级指标。

这破坏了治理控制面的可解释性。恒温器可以 fail-silent，但 silent-safe 的前提是 audit 诚实说明哪些传感器坏了；否则后续调参会把假 0 当真实健康信号。

**建议**

- 把 metric reader 返回类型升级成 `{ value, degraded, reason }`，让“有意中性降级”不必靠抛错表达。
- 或让 `readImmuneLag()` 抛 typed degraded，由 `readMetrics()` 记录 `immuneLag` 并退回中性值。
- 增加测试：默认 `readMetrics()` 在状态迁移事件表未落地前应返回 `metrics.immuneLag === 0` 且 `degraded` 包含 `immuneLag`。

### EGR-CR-047 · P2 · `entailRejectRate` 用全历史 patrol 驱动当前治理门限

**证据**

- `packages/engram-core/src/governance/metric-readers.ts:52-78`：`readEntailRejectRate()` 读取所有 `claim_verification(kind='patrol')`，只按每个 claim 最新一条 entailment 折叠。
- `packages/engram-core/src/governance/metric-readers.ts:56-67`：查询没有时间窗口，没有 join claim 状态，也不排除 `superseded` / `quarantined` 等历史坏账。
- `packages/engram-core/src/governance/control-law.ts:103-109`：`entailRejectRate` 直接变成 `promotionGateLevel` target。
- `packages/engram-core/src/governance/controller.ts:87-95`：gate target 收紧时会写入新的 active Standards。

**问题**

治理恒温器应该读 live health，而不是把全历史事故永久算进当前压力。当前实现对每个 claim 取最新 patrol，但这个 claim 可能早已被 supersede、quarantine、reject 或不再参与消费；它的旧 fail 仍会进入当前拒绝率，持续推高 promotion gate。

结果是历史坏账可以把系统锁在更严的门限里，哪怕近期 active/draft 流量已经恢复健康。反过来，旧 pass 也可能稀释近期事故。两边都说明这个指标不是“当前健康度”。

**建议**

- 给 `entailRejectRate` 增加时间窗口或最近 N 次 patrol 口径，并把窗口参数写进 governance state metrics。
- join `claim` 表，只统计当前仍处于可治理/可消费相关状态的 claim；对 superseded/quarantined 历史坏账另出追踪指标。
- 增加测试：seed 旧 fail 后 supersede/quarantine，再 seed 近期 pass；`readEntailRejectRate()` 应反映近期/当前状态，而不是全历史 fail。

### EGR-CR-048 · P2 · calibration pilot 忽略 recall miss，会在幸存样本上证明“真闭环”

**证据**

- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:134-160`：`generateUsage()` 对每个 fact 做真 recall；没命中时只递增 `recallMisses` 并 `continue`。
- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:249-255`：`fitAndMeasure()` 只从已写入的 `usage_truth` 收集样本，recall miss 的 fact 不进入测量集。
- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:272-290`：`runCalibrationPilot()` 返回 `usage`、`measurement` 和 `persistedSamples`，但不校验 `recallMisses`、`usageRows` 与测量样本是否覆盖全部 promoted facts。
- `packages/engram-workers/src/eval/calibration-pilot/run.ts:73-88`：真实入口只打印 miss 数，仍继续输出 `[m2] 校准 pilot 跑通 ✓`。
- `packages/engram-workers/src/eval/__tests__/calibration-pilot.test.ts:70-86`：CI 测试断言 `recallHits > 0`、`persistedSamples === measurement.totalSamples`、ECE 下降等，但没有断言 `recallMisses === 0` 或 `measurement.totalSamples === usage.usageRows`。

**问题**

pilot 名义上要证明“真 recall + 真 usage 回路”闭合，但当前成功样本只来自 recall 命中的幸存子集。若真实嵌入或 query 口径导致一批事实 miss，系统会静默丢掉这些事实，只在剩下的命中样本上拟合 g 并证明 ECE 下降。

这会把 recall coverage failure 包装成 calibration success。对 M2/M3 交付来说，`usage.recallMisses > 0` 不是旁枝诊断，而是“真回路是否覆盖语料”的硬门。

**建议**

- pilot pass gate 要求 `recallMisses === 0`，或至少要求 miss rate 低于显式阈值并在报告中降级为 partial pass。
- 校验 `usage.usageRows === usage.recallHits`，并要求 `measurement.totalSamples === usage.usageRows === persistedSamples`。
- 增加测试：构造一个 fact query 必 miss，断言 `runCalibrationPilot()` 或 CLI pass gate fail-loud，而不是只在幸存样本上继续打印成功。

### EGR-CR-049 · P2 · `runRedTeamGeneration()` 每条前清库但结束不清，调用后残留最后一条对抗样本

**证据**

- `packages/engram-workers/src/eval/redteam-injector.ts:513-516`：函数注释说每条样本前 `resetDb`，每条对抗样本互不串扰。
- `packages/engram-workers/src/eval/redteam-injector.ts:517-529`：实现是在 `for (const item of items)` 的每次迭代开头调用 `await resetDb()`，然后注入并断言该 item。
- `packages/engram-workers/src/eval/redteam-injector.ts:530-542`：聚合 scores 后直接返回，没有在最后一条 item 之后再清理 work tables。
- `packages/engram-workers/src/eval/__tests__/redteam-immunity.test.ts:128-132`、`242-246`、`333-334`：测试多处直接调用 `runRedTeamGeneration()`；当前断言只看 score signature，没有断言调用结束后 claim / relation / claim_verification 等工作表为空。

**问题**

per-item 隔离只保证“下一条样本开始前”清掉上一条，但整个 generation 跑完后，最后一条 red-team 样本的 claim、source、relation、patrol / escalation 等工作表仍留在 caller 的 DB 里。这个函数是公开 eval 入口，调用方很自然会在同一个 DB 里随后跑 system dimensions、calibration 或下一段评测；此时最后一条对抗样本会污染后续 recall、governance metrics 或人审队列。

这不是 A3 直接污染 g 的结构通道，但它破坏了“红队样本临时 seed、每条独立注入”的评测隔离。前置清库不是后置清理，不能证明调用结束后 DB 回到干净状态。

**建议**

- 在 `runRedTeamGeneration()` 的 `try/finally` 里保证最后也调用一次 `resetDb()`，或者把函数契约明确改成“调用后 DB 保留最后一个样本供调试”，并要求 caller 显式清理。
- 如果保留最后样本用于诊断，应把这一点写进返回值和测试，避免后续 eval 误用同一 DB。
- 增加测试：跑完 `runRedTeamGeneration()` 后查询 `claim` / `relation` / `claim_verification` 等 work tables，断言为空；或若选择保留调试态，则后续 `computeSystemDimensions()` 前必须由 wrapper 清理。

### EGR-CR-050 · P2 · near-dup poison 的 detection 不要求 claim 被 flag，draft 也能算“检出”

**证据**

- `packages/engram-workers/src/eval/redteam-injector.ts:451-454`：near-dup poison 的定义写的是 Reconciler 判 poison 后 `flag + 升级信号`，并且 `detected = 记了带 anchorId 的 escalation ∧ claim 被 flag`。
- `packages/engram-workers/src/eval/redteam-injector.ts:463-467`：被审 claim 晋升 active 失败时 catch 后继续执行，注释说 draft 不能 flag，但 escalation 仍会记。
- `packages/engram-workers/src/reconciler.ts:333-355`：Reconciler 对 `poison` 会先记 `recordReconcileEscalation()`；只有 `a.status === 'active'` 才尝试 `transitionClaim(..., 'flagged')`，draft 不会被收紧。
- `packages/engram-workers/src/eval/redteam-injector.ts:470-476`：`runNearDupPoison()` 的 `detected` 只要求 `escalatedToAnchor && poisonPair !== undefined`，没有要求 `finalStatus === 'flagged'` 或 `res.flagged > 0`。
- `packages/engram-workers/src/eval/__tests__/redteam-immunity.test.ts:172-181`：正常 fixture 断言 `reaction.flagged === true`，但没有覆盖“晋升失败 / draft 仍被计 detected=false”的负例。

**问题**

near-dup poison 的免疫定义是“发现并收紧”：至少要把活跃投毒 claim flag，或者明确把未能收紧作为 partial detection。当前实现会把 draft poison 的 escalation 也算作 detected。只要晋升 active 因 D2 floor、状态竞争或 promotion 口径变化失败，Reconciler 仍可能产出 poison verdict 和 escalation，score 仍会把这条计入 detected，检测率虚高。

这和 false 类刚加的晋升硬断言口径不一致：false 类已经要求先 active，避免“draft 兜底”掩盖 Verifier 回归；near-dup poison 仍保留这个弱判据。

**建议**

- `runNearDupPoison()` 应像 `runFalse()` 一样先断言被审 claim 确实晋升 active；晋升失败应 fail-loud 或把该 item 标成未检出并记录 `promotionFailed`。
- `detected` 至少应要求 `poisonPair !== undefined && escalatedToAnchor && finalStatus === 'flagged'`，除非设计上另拆 `escalatedOnly` 维度。
- 增加测试：构造一个 near-dup poison item 使被审 claim 无法晋升 active；期望 detection 为 false 或函数抛错，不能只凭 escalation 计 detected。

### EGR-CR-051 · P2 · `freezeRedTeamGeneration()` 冻结前不校验 item shape / ID 唯一，坏敌手会被不可改写地固化

**证据**

- `packages/engram-core/src/spi/redteam-generation.ts:33-56`：`RedTeamItem` 要求稳定 `id`、四类之一的 `redteamClass`、`claimText`、`evidence`、`sourceKind`，并在 contradiction / near-dup-poison 类使用 `anchor`。
- `packages/engram-core/src/spi/redteam-generation.ts:86-108`：`freezeRedTeamGeneration()` 运行时只校验 `version` 非空和 `items.length > 0`，随后把 caller 传入的 `items` 原样写进 JSONB。
- `packages/engram-core/src/db/schema.ts:402-417`：表注释把 `items` 定义为纵向比较的冻结锚，但 DB 层只是 `jsonb('items').notNull()`，没有 shape 或唯一性约束。
- `packages/engram-workers/src/eval/redteam-injector.ts:500-508`：scorer 只在注入时按 `item.redteamClass` switch，未知 class 会在世代已冻结后才抛 `unknown redteam class`。
- `packages/engram-workers/src/eval/__tests__/redteam-immunity.test.ts:289-306`、`packages/engram-workers/src/eval/__tests__/red-blue-round.test.ts:502-520`：现有冻结测试覆盖同 version 重写和空 items，但没有覆盖重复 id、未知 class、缺 `claimText/evidence/sourceKind`、缺 anchor 等 malformed item。

**问题**

“冻结红队代际”的价值在于同一代敌手不可改写且可纵向对齐；稳定 item id 是这个对齐锚。现在任意 caller 可以冻结两个相同 `id` 的 item、未知 `redteamClass`、缺原文或缺 anchor 的 contradiction / near-dup 样本。由于 version unique 一旦写入后同名不能重写，这类坏 generation 会被永久保留，只能另起版本绕开。

后果有两类：一是 scorer 到运行时才爆炸，红队代际已不可修；二是重复 id / 缺字段让 breach attribution、重打分差异和 per-item 纵向比较失去语义。A1 “题=毒株”要求题本身先过免疫流水线才晋升 golden，红队 generation 也至少要先过 schema-level admission，不能把坏题冻成审计锚。

**建议**

- 在 `freezeRedTeamGeneration()` 前做 runtime validator：item id 非空且世代内唯一，`redteamClass` 必须属于 `REDTEAM_CLASSES`，`claimText/evidence/sourceKind` 非空，`asOf` 若存在必须是可解析 ISO。
- 对 contradiction / near-dup-poison 增加 class-specific validator：必须有非空 `anchor.claimText/evidence/sourceKind`，以及能用于 same-fact / conflict 的 subject/predicate/object 约束。
- malformed generation 应在 insert 前 fail-loud，保证 DB 里没有半冻结坏版本。
- 增加测试：重复 id、未知 class、缺 evidence、near-dup 缺 anchor 都应 reject，且 `getRedTeamGeneration()` 查不到该 version。

### EGR-CR-052 · P2 · immunity 维度把同一 generation 的历史重打分全量相加，当前读数会被旧分数稀释

**证据**

- `packages/engram-core/src/db/schema.ts:431-463`：`redteam_immunity_scores` 是 append-only；注释说“每类一行”，索引是 `(generation_version, redteam_class)`，但没有 unique / run id / active marker。
- `packages/engram-core/src/spi/redteam-generation.ts:148-180`：`recordImmunityScore()` 每次调用都会 insert 新行，既不去重，也不标记这是同一 frozen generation / class 的第几次重打分。
- `packages/engram-core/src/spi/redteam-generation.ts:196-212`：`getImmunityScores()` 按时间升序返回所有匹配行，没有按 `(generationVersion, redteamClass)` 取最新。
- `packages/engram-core/src/eval/system-dimensions.ts:253-261`：`computeSystemDimensions()` 直接把所有 score 行的 `injected` / `detected` 相加。
- `packages/engram-core/src/__tests__/system-dimensions.test.ts:258-292`：测试只覆盖同 generation 下两个不同 class 各一行，没覆盖同一 class 重打分或同一 generation 多次评分。

**问题**

免疫维度是“当前系统面对固定敌手的检出率”。固定敌手可以被重打分，尤其是在修复或回归后同一 frozen generation 反复跑。但当前聚合口径会把同一 `(generationVersion, redteamClass)` 的历史 score 行全部加进分子分母。

结果是旧读数会稀释当前读数：同一 generation/class 第一次 `10/10`、第二次回归到 `0/10`，当前 immunity 会显示 `10/20 = 0.5`，而不是最新系统的 `0/10 = 0`。反过来，先坏后好也会低估修复效果。append-only 没问题，但“当前维度”不能默认把历史尝试当成当前样本池。

**建议**

- 给 immunity score 增加 `runId` / `evaluationRunId`，或在聚合时按 `(generationVersion, redteamClass)` 只取最新一行。
- `computeSystemDimensions({ immunityGeneration })` 至少应对该 generation 的每个 class 取最新 score；跨 generation 聚合也应明确是“latest per generation/class”还是“all history cumulative”。
- diagnostics 里报告参与聚合的 generation/class key 和 discarded stale rows，避免看板读数不可解释。
- 增加测试：对同一 generation/class 连续写 `10/10` 后 `0/10`，`computeSystemDimensions(..., { immunityGeneration })` 应反映最新 `0`，而不是历史平均 `0.5`。

### EGR-CR-053 · P2 · `recordDimension()` 不校验 dimension 白名单，ELO / win-rate / reward 这类坏标签可写进评测脊柱

**证据**

- `packages/engram-core/src/spi/dimension-events.ts:42-46`：代码定义了七个合法 `DIMENSION_NAMES`。
- `packages/engram-core/src/spi/dimension-events.ts:72-78`：`RecordDimensionInput.dimension` 只是 TypeScript `DimensionName` 类型，运行时不会存在。
- `packages/engram-core/src/spi/dimension-events.ts:84-105`：`recordDimension()` 只校验 `runId` 非空和 `value ∈ [0,1]`，没有检查 `input.dimension` 是否属于 `DIMENSION_NAMES`。
- `packages/engram-core/src/db/schema.ts:480-488`：`dimension_events.dimension` 是裸 `text`，没有 DB check constraint。
- `packages/engram-core/src/eval/system-dimensions.ts:370-383`：`aggregateLatest()` 读事件后把 `e.dimension as DimensionName` 强转，未知标签会进入返回对象。
- `packages/engram-core/src/__tests__/system-dimensions.test.ts:453-470`：当前坏读数测试覆盖 out-of-range value 和空 runId，但没有覆盖未知 dimension。

**问题**

S30 的维度集合在代码和测试里被写成“七维稳定标签”，但实际写入口只靠 TypeScript 类型挡坏标签。任何 JS caller、`as any`、迁移脚本或直接 DB 写都能追加 `elo`、`win_rate`、`reward`、`downstream_ab` 这类非白名单维度。

这不一定会进入校准 g，但会污染 `dimension_events` 这条“评测脊柱”和 `getDimensionSeries()` / `aggregateLatest()` 的读侧语义。A3 红线明确禁止 ELO / 胜负率 / reward 进入校准和纵向趋势；这里至少需要和 `recordRecompete()` 一样在 runtime 物理拒绝非白名单标签，否则“七维集合”只是编译期口头约束。

**建议**

- 增加 `isDimensionName()` runtime guard，`recordDimension()` 在 insert 前拒绝不属于 `DIMENSION_NAMES` 的标签。
- DB 层加 check constraint，或至少读侧对未知 `dimension_events.dimension` fail-loud 并报警。
- `aggregateLatest()` 不应对未知 string 直接 `as DimensionName`，应先校验。
- 增加测试：`recordDimension(db, { dimension: 'elo' as any, ... })`、`'win_rate' as any`、`'reward' as any` 均 reject，且 `getDimensionSeries()` / `aggregateLatest()` 不返回未知维度。

### EGR-CR-054 · P2 · `computeSystemDimensions({ k })` 不拒绝非正 k，recall limit 和 P@k 分母会各算各的

**证据**

- `packages/engram-core/src/eval/system-dimensions.ts:199-211`：`computeSystemDimensions()` 直接取 `const k = opts.k ?? DEFAULT_K`，随后传给 `runGoldenItem()`。
- `packages/engram-core/src/eval/system-dimensions.ts:154-160`：`runGoldenItem()` 把 `limit: k` 传给真 `recallClaims()`。
- `packages/engram-core/src/spi/recall-claims.ts:128-129`：`recallClaims()` 对 `ctx.limit <= 0` 会静默回退到 `DEFAULT_RECALL_LIMIT`。
- `packages/engram-core/src/eval/system-dimensions.ts:226-244`：P@k 分母仍用原始 `Math.min(k, o.recalled.length)`。
- `packages/engram-core/src/__tests__/system-dimensions.test.ts:176-192`：P@k 分母测试钉住了合法 `k=5`，没有覆盖 `k=0`、负数或非整数。

**问题**

`k` 是评测定义的一部分，必须是正整数。现在 `k=0` 时，recall 实际会按默认 limit 召回结果，coverage / recall / grounding / staleness 都可能基于这些结果变化；但 P@k 的 `retrievedTotal` 因 `Math.min(0, recalled.length)` 变成 0，precision 被算成 0。`k=-1` 时分母甚至可能变负，`computeSystemDimensions()` 能返回负 precision，直到 `runSystemDimensions()` 落 `dimension_events` 时才被 `[0,1]` guard 拦住。

这会让同一次评测里“召回了多少条”和“P@k 用哪个 k 归一”不一致。坏参数不应该被下游 recall 默认值悄悄修正，也不应该在一半维度里生效、一半维度里失真。

**建议**

- `computeSystemDimensions()` / `runGoldenItem()` 入口要求 `k` 是正整数；非法值直接 throw。
- 如果要允许缺省，只允许 `opts.k === undefined`，不要把 `0` / 负数 / 小数交给 recall 兜底。
- 增加测试：`k=0`、`k=-1`、`k=0.5`、`k=NaN` 都应 fail-loud，且不会写任何 `dimension_events`。

### EGR-CR-055 · P2 · `recordImmunityScore()` 不校验 redteamClass，伪造类别会进入 immunity 聚合

**证据**

- `packages/engram-core/src/spi/redteam-generation.ts:19-27`：红队类别白名单只有四类 `false` / `contradiction` / `stale` / `near_dup_poison`。
- `packages/engram-core/src/spi/redteam-generation.ts:148-180`：`recordImmunityScore()` 的 `redteamClass` 只是 TypeScript `RedTeamClass`，运行时只校验 injected / detected 计数，没有校验类别白名单。
- `packages/engram-core/src/db/schema.ts:441-450`：`redteam_immunity_scores.redteam_class` 是裸 `text`，没有 check constraint。
- `packages/engram-core/src/spi/redteam-generation.ts:196-212`：`getImmunityScores()` 默认返回所有 class 的 score 行。
- `packages/engram-core/src/eval/system-dimensions.ts:253-261`：`computeSystemDimensions()` 把所有返回行的 `injected` / `detected` 相加，未知 class 也会贡献 immunity。
- 当前 `rg` 只找到合法 `recordImmunityScore()` 测试，没有 unknown class reject 测试。

**问题**

免疫维度的语义是四类红队敌手的检出率。现在任何绕过 TS 的调用方都能写 `redteamClass: 'sql_injection' as any`、`'reward' as any` 或其他类别，并让它进入 `computeSystemDimensions().immunity` 的分子分母。

这和 EGR-CR-051 的 generation shape 问题是同一类边界缺失在 score 表上的体现：冻结题集可以有坏 class，免疫分也可以有坏 class。即使它不进 g，报告维度也会被伪造类别污染，看板不再表示那四类标准敌手的当前免疫力。

**建议**

- 复用 `REDTEAM_CLASSES` 做 `isRedTeamClass()` runtime guard，`recordImmunityScore()` 在 insert 前拒绝未知 class。
- DB 层加 check constraint 或引入受控 lookup，避免 plain SQL 写入未知类别。
- `computeSystemDimensions()` 读到未知 class 应 fail-loud 或明确跳过并记录 degraded，而不是静默聚合。
- 增加测试：`recordImmunityScore(... redteamClass: 'sql_injection' as any ...)` reject，且 immunity 读数不被未知类别改变。

### EGR-CR-056 · P2 · `runSystemDimensions()` 允许同一 runId 重跑，series 出重复点而 aggregate 隐藏冲突

**证据**

- `packages/engram-core/src/eval/system-dimensions.ts:291-295`：注释明确说同一 `runId` 重跑会再落一批新行，函数不做去重。
- `packages/engram-core/src/eval/system-dimensions.ts:296-362`：`runSystemDimensions()` 每次都会对同一 runId 追加 6/7 条 `dimension_events`。
- `packages/engram-core/src/spi/dimension-events.ts:131-149`：`getDimensionSeries()` 按 `(dimension, created_at)` 返回所有点，不按 runId 去重。
- `packages/engram-core/src/eval/system-dimensions.ts:365-383`：`aggregateLatest()` 对同一 runId 读出的多批事件只按最后写入覆盖同维度。
- `packages/engram-core/src/__tests__/system-dimensions.test.ts:342-355`：幂等测试只重复 aggregate 同一 event log，没有覆盖同一 `runId` 被 `runSystemDimensions()` 重跑后 series / aggregate 语义分裂。
- `packages/engram-core/src/__tests__/system-dimensions.test.ts:369-388`：time-series 测试只覆盖 `r0/r1/r2` 三个唯一 runId，没覆盖 retry / replay。

**问题**

append-only 可以保留原始事件，但 `runId` 是一次评测 run 的身份。当前设计允许同一个 `runId` 在不同 KB 状态下重跑并追加第二批维度。读侧会出现两种互相冲突的语义：`getDimensionSeries()` 会把同一 runId 画成多个时间点，`aggregateLatest({ runId })` 则只返回最后一批，掩盖这个 run 已经不唯一。

这对 CI retry、worker 重放、人工重复执行同一 runId 都危险。看板曲线会多一个重复 run 点，离线聚合又会像“一切正常，只是最后值赢了”。如果要保留 append-only 审计，至少需要 attempt 身份；如果 runId 语义是一轮评测，就应拒绝同 runId 重跑或要求新 runId。

**建议**

- 明确 run identity：要么 `(runId, dimension)` unique，重跑必须使用新 runId；要么引入 `attemptId`，series 默认按 latest attempt per run 聚合。
- `runSystemDimensions()` 在写第一条前检查已有 runId；若已存在则 fail-loud，避免半批 append。
- 如果保留同 runId 多 attempt，`getDimensionSeries()` / `aggregateLatest()` 的 API 名称和 payload 必须暴露 attempt，不能一个返回全历史、一个静默 last-wins。
- 增加测试：同一 runId 在 KB 增长后重跑，期望拒绝；或若支持 attempt，则 series 只出现一个 logical run 点，audit API 才返回两个 attempt。

### EGR-CR-057 · P1 · `reflux_regression` 归因把“错 claim 曾被 Arbiter 判输”当成 Arbiter 裁错，极性反了

**证据**

- `packages/engram-core/src/eval/attribution-spine.ts:139-147`：`wasAdjudicatedLoser()` 只要 resolved conflict 的 `loserId === claimId` 就返回 true，注释说这是 Arbiter 裁错。
- `packages/engram-core/src/eval/attribution-spine.ts:167-173`：`loopCandidatesForClaim()` 遇到 `wasAdjudicatedLoser` 就加入 `arbiter_mis_adjudicate`。
- `packages/engram-core/src/eval/attribution-spine.ts:181-197`：`reflux_regression` 的 claim 来自 `regression_pool`，也就是 usage truth 已经把这个 claim 记成 refuted / corrected 的失败 claim。
- `packages/engram-core/src/__tests__/attribution-spine.test.ts:162-183`：测试把一个被 usage refuted 的 `loser` claim 作为 regression failure，然后断言它归因到 `arbiter_mis_adjudicate`。
- `packages/engram-core/src/spi/conflict-arbiter.ts:164-189`：`resolveConflict()` 的 payload 同时持久化 `winnerId` 和 `loserId`，足够区分“失败 claim 被判赢”与“失败 claim 被判输”。

**问题**

对 `reflux_regression` 来说，失败 claim 是被消费后证明错的那条 claim。如果 Arbiter 曾经把这条错 claim 判为 `loser`，那 Arbiter 的方向反而是对的；真正可疑的是这条错 claim 曾被 Arbiter 判成 `winner`，或者它虽被判输但仍被消费召回，问题应落在 consumption/conflictDecay/recall gate，而不是 Arbiter 裁错。

当前实现和测试把 `loserId === failedClaim` 固化为 Arbiter 责任，会把正确裁决错归因给 Arbiter，并掩盖“败者仍越过消费门”这类真正问题。归因脊柱的价值是派工单，极性反了会把修复任务派给错误工种。

**建议**

- 对 `reflux_regression`，`arbiter_mis_adjudicate` 应该由 `winnerId === failedClaim` 触发；`loserId === failedClaim` 应作为 consumption / conflictDecay 方向的诊断，或至少不归因到 Arbiter。
- human overturn 类如果要复用同一 claim 证据表，也需要按 failure kind 明确 `winner/loser` 极性，不能用一个 `wasAdjudicatedLoser()` 套所有失败来路。
- 增加回归测试：构造错 claim 被 Arbiter 判输后仍被消费 refuted，期望不归因 Arbiter；构造错 claim 被 Arbiter 判赢后 refuted，才归因 Arbiter。

### EGR-CR-058 · P1 · M3-A 多源路径用假 `contentHash` 把同一文本伪装成独立印证

**证据**

- `packages/engram-workers/src/eval/realworld-ece/harness.ts:43-45`：`sourcesPerFact` 被描述成每条 fact 的独立印证源数，且注释说 `>=2` 才可能过 `indepSupport`。
- `packages/engram-workers/src/eval/realworld-ece/harness.ts:86-90`：循环内每个 source 都使用同一个 `f.docText`，但人为设置不同 `contentHash: rw:<fact>:s<k>`。
- `packages/engram-core/src/same-fact/independent.ts:45-53`：独立印证第一步按 `contentHash` 去重；同 hash 只计一次。
- `packages/engram-core/src/__tests__/same-fact.test.ts:127-143`：现有测试明确把 same content hash 作为非独立印证折叠。
- `packages/engram-core/src/spi/append-claim.ts:267-285`：`addSource()` 把 `contentHash` 当作 source 幂等身份；撞 hash 会复用既有 source。

**问题**

M3-A 的默认 `sourcesPerFact=1` 只测 extraction-only 空集，这条路暂时不触发。但同一个 harness 已经暴露 `sourcesPerFact >= 2` 作为“多源印证 + Verifier”下一步入口。现在这个入口并没有提供多份真实独立文档，而是把同一段 `docText` 写多次，再通过伪造不同 `contentHash` 绕开 core 的同源去重。

这会把“重复引用同一源文本”误算成 independent support，直接抬高 f3/raw。后续一旦把 `sourcesPerFact` 加大或配上 `entailmentPass=true`，M3-A 曲线会在假独立来源上产生 active/usage 样本，甚至让错误 claim 通过晋升门。校准实验会看起来像用了多源真实世界证据，实际只是在刷同一源。

**建议**

- `contentHash` 必须由 source content 的规范化 hash 派生，不能为了评测目标人工伪造。
- 若要模拟独立印证，语料应为每个 fact 提供不同 `docText` / 不同来源 lineage，并且这些来源不是互相 derived。
- `ingestCorpus()` 的 `sourcesPerFact > 1` 路径应断言每个 source 的 content hash 与内容一致，或暂时拒绝重复 `docText`。
- 增加测试：`sourcesPerFact=2` 且两份 source content 相同，claim 的 independent support 不应上升；只有两份内容不同且无 derived lineage 的 source 才能抬高 f3。

### EGR-CR-059 · P2 · M3-A 真 Qwen 冒烟检测到偏差仍会 0 退出

**证据**

- `packages/engram-workers/src/eval/realworld-ece/run.ts:84-85`：CLI 计算每个 fact 抽出的 claim 数，并统计 `faithful`。
- `packages/engram-workers/src/eval/realworld-ece/run.ts:116-120`：当 `faithful !== facts.length` 或 `promo.promoted !== 0` 时，只把 `verdict` 字符串改成 warning 文案。
- `packages/engram-workers/src/eval/realworld-ece/run.ts:43-49` 与 `:138-141`：只有缺少 `DASHSCOPE_API_KEY` 或抛异常时才设置 `process.exitCode = 1`。
- 当前 `rg` 只找到 `realworld-ece.test.ts` 覆盖 fake 端口的 0 晋升空集，没有覆盖 `run.ts` 的失败退出语义。

**问题**

这个入口的唯一价值是 env-gated 真 Qwen smoke：确认“一文档恰一条”“0 晋升”这些实证不变量。如果真模型漏抽、裂成多条、或意外晋升，代码已经检测到了，但进程仍然会成功退出。CI、脚本或人工流水线只看退出码时会把失败 smoke 当成通过。

这和 calibration pilot 的硬门问题同类：打印“出现偏差需人看”不是 gate。M3-A 还在证明“extraction-only 测空集是设计使然”，如果偏差仍 0 退出，后续报告很容易把未满足前提的运行当成证据。

**建议**

- 在 `faithful !== facts.length`、`promo.promoted !== 0`、`promo.noClaim > 0`、或 `ingest.distillHumanPending > 0` 时设置 `process.exitCode = 1`。
- 输出仍可保留诊断文本，但机器 gate 必须 fail-loud。
- 增加 CLI 级测试或把 verdict 计算抽成纯函数测试：非忠实抽取 / 意外晋升时返回 failure verdict，并会驱动非零退出。

### EGR-CR-060 · P2 · `runRealWorldEce()` 的 measurement 读整库 `usage_truth`，会把历史样本混进本次 M3-A

**证据**

- `packages/engram-workers/src/eval/realworld-ece/harness.ts:239-255`：`runRealWorldEce()` ingest / promotion / usage 之后直接调用 `collectFactSamples(deps.db)`，没有传本次 facts、run id 或 namespace。
- `packages/engram-workers/src/eval/realworld-ece/harness.ts:218-222`：本次 M3-A usage 写入只带 `taskId: f.id` 和 `byRole: agent:eval-consumer`，没有唯一 eval run id。
- `packages/engram-workers/src/eval/calibration-pilot/pilot.ts:163-180`：`collectFactSamples()` 读取整张 `claim_verification` 中所有 `kind='usage_truth'` 行，只按 verdict shape 过滤；`taskId` 缺失时还会变成空字符串。
- `packages/engram-workers/src/eval/__tests__/realworld-ece.test.ts:59-69`：当前测试每次创建新临时 DB，所以不会暴露非空库污染。
- `packages/engram-workers/src/eval/realworld-ece/run.ts:54-66`：真 CLI 也用临时 DB，因此同样没有覆盖可复用 harness 在共享 DB 下的行为。

**问题**

在 fresh DB 中 `sampleCount === 本次 usageRows`，所以 lean 空集测试能过。但 `runRealWorldEce()` 是 exported harness，函数名和返回值都像一个可复用评测入口；一旦在已有 usage_truth 的开发库、集成库或复合 eval 里调用，`measurement` 会混入 M2 pilot、旧 M3-A 或其他 consumer 的历史 usage。

结果是本次 realworld corpus 可能 0 usage，却因为库里已有样本而返回非 null `measurement`；也可能本次样本少，但 ECE 被历史样本主导。这个错误比单纯“样本不足”更危险，因为它会制造看似有数据的曲线。

**建议**

- 给 M3-A run 生成 `evalRunId` / `namespace`，写入 `reportUsage` verdict，`collectFactSamples` 只读本次 namespace。
- 或者至少在 `runRealWorldEce()` 内按 `facts.map(f.id)` 过滤 `taskId`，并断言 `sampleCount === usage.usageRows`。
- 增加回归测试：先写一条无关 `usage_truth` 到同一 DB，再跑 `runRealWorldEce({ sourcesPerFact: 1 })`；期望 `sampleCount` 仍为 0、`measurement` 仍为 null。

### EGR-CR-061 · P2 · `promoteEligible()` 把所有 transition 异常都算成预期 blocked，能掩盖状态机/DB 故障

**证据**

- `packages/engram-workers/src/eval/realworld-ece/harness.ts:170-180`：`promoteEligible()` 对 `transitionClaim()` 的任何 throw 都 `blocked += 1`，并把错误字符串拼成 `reason: blocked:<msg>`。
- `packages/engram-core/src/spi/transition.ts:103-113`：`transitionClaim()` 会抛 `claim not found`、no-op、illegal transition 等非晋升门错误。
- `packages/engram-core/src/spi/transition.ts:135-143`：缺失/不可解析 calibration map 或真实 confidence gate 不达标都在同一调用路径内发生；只有 `conf < 0.5` 这一类才是 M3-A lean 预期的 blocked。
- `packages/engram-workers/src/eval/realworld-ece/run.ts:109-120`：CLI verdict 只看 `promo.promoted === 0`，不区分 expected gate block 和 unexpected transition failure。
- `packages/engram-workers/src/eval/__tests__/realworld-ece.test.ts:116-121`：测试只断言 fake 端口的 blocked reason 包含 `< 0.5`，没有覆盖 `run.ts` 或 non-gate error 分类。

**问题**

M3-A 的实证命题是“新鲜 extraction-only claim 被 confidence gate 拦住”，不是“任何状态迁移失败都算成功拦住”。现在 claim 不存在、claim 已经不是 draft、非法状态迁移、calibration map 读坏、DB/runtime 异常，都能被 `promoteEligible()` 统计成 `blocked`。CLI 又只看 `promo.promoted === 0`，所以一类严重接线故障会被包装成“0 晋升，设计使然”。

这会削弱真 Qwen smoke 的诊断价值：本该 fail-loud 的状态机/配置问题，会在 free-form reason 里埋掉；只要没有 claim 被 active，最终 verdict 可能仍显示成立。

**建议**

- 把 promotion outcome 分成 `expectedBlocked` / `unexpectedError` / `promoted` / `noClaim`，只把已知的 confidence gate error 当作预期 blocked。
- 遇到 `claim not found`、illegal/no-op transition、calibration map failure、DB error 等非 gate 错误时 rethrow，或至少让 `run.ts` 非零退出。
- CLI 成功条件应检查所有 blocked reason 都是预期的 `conf < 0.5`，且 `blocked === facts.length`、`noClaim === 0`。
- 增加测试：把某个 claim 预先改成 `active` 或删除 claim 后调用 `promoteEligible()`，期望返回 unexpected/fail-loud，而不是把它算进正常 blocked。

## Regression Test Map

test-review gate 要求每个高优 finding 至少有一条回归测试：

- EGR-CR-001：在 `verifier.test.ts` 或 `verifier-f2.test.ts` 断言 NC-exact refused `not_co_true` 不影响 recall 的 f2/value。
- EGR-CR-002 / EGR-CR-006：新增 authz/actor 测试，伪造 `human:*` display role 不能触发 red-edge 放松；若宣称 DB role isolation，需要集成测试证明非 human role 写不了 human-only 路径。
- EGR-CR-003：`report-usage.test.ts` / calibration usage 测试要求 usage truth 绑定 recall snapshot/token，caller 自报 confidence/version 不进入 calibration。
- EGR-CR-004：`engram-runner.test.ts` 不预置 `reportUsage()`，明确 runner `usage` 是写 truth 还是只 harvest 已写 truth。
- EGR-CR-005：`embedding.test.ts` / `same-fact.test.ts` 验证 stale `embeddingVersion` 不参与 recall/commit，reembed 后才恢复。
- EGR-CR-009：calibration store 测试验证同 version 不可被不同 knots 重定义，历史 claim value 不被同名新 row 改写。
- EGR-CR-010：recall/embedding 测试验证 `ctx.minSimilarity` 只能抬高，不能低于 embedder/default baseline。
- EGR-CR-011：bidding-adapter 测试和 adapter README 警告 source meta/authority first-writer-wins 风险。
- EGR-CR-012：append source 测试验证同 hash 不同 content 必须 fail-loud 或显式 conflict。
- EGR-CR-013：adapter 测试验证改写 claim 本体或 confidence 解释字段会被 `applyAdapter()` 拦截。
- EGR-CR-014：Reconciler 测试验证“弱化但可同真”的 near-dup 不写 `not_co_true`；只有真实不可同真才 f2=0 并进入 NC-exact/conflict 路。
- EGR-CR-015：conflict-arbiter 测试验证 human resolve 同一 pair 后，editor queue 不再返回旧 escalated 事件。
- EGR-CR-016：L5 migration + scoring 测试验证已迁出题不进入默认生产评分分母；L3/L5 默认 scoring golden 要能追到 A1 audit 或显式豁免。
- EGR-CR-017：red-blue round 测试验证 admitted cohort 的 `golden_questions` / `promotion_audit` 在回合结束后仍可审计。
- EGR-CR-018：red-blue admission 测试验证结构化反 object item 被 A1 self-contradiction gate block。
- EGR-CR-019：redteam scorer 测试验证未 A1-admitted item 不能通过公开 `runRedTeamGeneration()` 计分。
- EGR-CR-020：exam-immunity 并发测试验证同一 candidate 不会出现 golden row + rejected status。
- EGR-CR-021：governance rollback 测试验证 policy rollback 后 active Standards gate 也同步回到目标，或 API 明确拒绝 policy-only rollback 冒充一键回退。
- EGR-CR-022：distiller 测试验证模型提交未知 locator / 不匹配 excerpt 时拒写 claim，并留下 human_pending 或明确 audit 信号。
- EGR-CR-023：append/supersede/transition 测试验证空白 locator 被 core guard 和 DB check 拒绝，不能成为 recallable provenance。
- EGR-CR-024：independent-support 测试验证两个 supports 源共享同一个未引用 ancestor 时只计一次独立印证；DB-backed append/commit f3 同步覆盖。
- EGR-CR-025：transition/verifier 测试验证 draft→active agent promote 用实时 conflictDecay；已有 active 矛盾导致 live conf<0.5 时不得晋升。
- EGR-CR-026：runner/choreography 测试验证 Reconciler/Verifier 写出的 `conflictsWith` patrol 信号会触发 Arbiter，即使没有 `contradicts` relation。
- EGR-CR-027：calibration/system-dimensions/longitudinal 测试验证同一 `(byRole, taskId)` 重复 usage_truth 不会改变 gated ECE 或 ΔECE。
- EGR-CR-028：longitudinal-recompete 测试验证 `outer T0 -> mid T0 -> outer T1` 时 outer delta 只引用上一条 outer 值。
- EGR-CR-029：calibration usage 测试验证 ECE 默认按 `calibrationVersion` 分段，不把 identity 和非 identity 样本混进同一报表。
- EGR-CR-030：calibration-isotonic 测试验证同一 identity 最新为 corrected/partial 时旧 adopted/refuted 不进入 S28 sample，不能凑够 200。
- EGR-CR-031：reflux 测试验证 blank query 不入 L5，replay 判 unreplayable。
- EGR-CR-032：arbiter/runner 测试验证 runtime 抛错时 pending pair 仍升级 editor queue，而不是被 dispatcher 吞掉后消失。
- EGR-CR-033：governance 测试验证 state 写后 standards 写失败不会留下 active policy 半提交。
- EGR-CR-034：verifier 测试验证无 exact/supporting evidence 时不调用 judge、不晋升 active。
- EGR-CR-035：distiller/dispatcher 测试验证 runtime throw 时 source 仍进入 human_pending，已提交 claim 不回滚。
- EGR-CR-036：redteam/system-dimensions 测试验证 immunity score 的 NaN/Infinity/小数/非法计数全部拒写，合法聚合保持有限值。
- EGR-CR-037：runner/choreography 测试验证空 batch 是 no-op，不退化成 cron 全库扫描。
- EGR-CR-038：dispatcher 测试验证 `maxEvents` 是 worker-dispatch 硬上限，同事件多 worker 命中也不会越界。
- EGR-CR-039：dispatcher/runner 测试验证 worker throw 后有 durable failure audit/dead-letter，同时级联不中断。
- EGR-CR-040：worker-audit 测试验证 source pending payload 非空且 source 存在；malformed payload 不返回空待办。
- EGR-CR-041：calibration-pilot 测试验证 seed 走正式 SPI 或故障时不会留下 active orphan claim；synthetic seed 不能冒充真闭环。
- EGR-CR-042：calibration-pilot CLI/pass-gate 测试验证样本不足、heldout 空、ECE 未改善时 fail-loud / 非零退出。
- EGR-CR-043：adapter boundary 测试 / lint 验证领域 adapter 生产代码不能 import core `schema`，source metadata 必须由 recall result 或受控 Consumer SPI 提供。
- EGR-CR-044：calibration recalibrate 并发测试验证提交时 CAS active calibration row；过期验收不能覆盖已激活的新 g。
- EGR-CR-045：verifier 故障注入测试验证 transition 失败不会留下 scoring patrol 半裁决，或会留下可重试 durable audit。
- EGR-CR-046：governance metric-reader 测试验证默认 `immuneLag` 因无数据源被标 degraded，而不是静默健康 0。
- EGR-CR-047：governance metric-reader 测试验证 `entailRejectRate` 按近期/当前状态聚合，不被 superseded/quarantined 历史坏账永久驱动。
- EGR-CR-048：calibration-pilot pass-gate 测试验证 recall miss 触发 fail-loud，且 `measurement.totalSamples` 与 usage coverage 对齐。
- EGR-CR-049：redteam generation 测试验证函数返回后不会残留最后一条对抗样本污染 work tables，或 wrapper 在后续 eval 前强制清理。
- EGR-CR-050：near-dup poison 测试验证未晋升 active / 未 flag 的样本不能计入 detected，只能作为 escalation-only 诊断。
- EGR-CR-051：redteam generation 冻结测试验证重复 item id、未知 class、缺 evidence/sourceKind/anchor 都在写库前拒绝，且不会留下冻结坏 version。
- EGR-CR-052：system-dimensions 测试验证同一 `(generationVersion, redteamClass)` 重打分只取最新，旧 score 行不稀释当前 immunity。
- EGR-CR-053：dimension-events 测试验证 `recordDimension()` 拒绝 `elo` / `win_rate` / `reward` 等非白名单 dimension，读侧不强转未知标签。
- EGR-CR-054：system-dimensions 测试验证 `k=0` / 负数 / 小数 / NaN 全部 fail-loud，且不写半批 dimension_events。
- EGR-CR-055：redteam immunity 测试验证 `recordImmunityScore()` 拒绝未知 redteam class，伪造类别不进入 immunity 聚合。
- EGR-CR-056：system-dimensions 测试验证同一 runId 重跑会 fail-loud，或 attempt-aware series/aggregate 不会让同一 logical run 同时变成重复点和 last-wins。
- EGR-CR-057：attribution-spine 测试验证 refuted claim 曾是 conflict loser 不归因 Arbiter；只有 refuted claim 曾是 conflict winner 才算 Arbiter mis-adjudicate。
- EGR-CR-058：realworld-ece 测试验证重复 `docText` 即使写成多个 source 也不能抬高 independent support；多源曲线只能用真实不同 source/lineage。
- EGR-CR-059：realworld-ece CLI verdict 测试验证真模型漏抽/裂解/意外晋升时返回非零退出或 failure verdict。
- EGR-CR-060：realworld-ece 测试预置无关 `usage_truth` 后再跑 extraction-only，断言本次 `sampleCount=0` 且 `measurement=null`。
- EGR-CR-061：realworld-ece promotion 测试验证非 confidence-gate 的 transition error 不计入正常 blocked，而是 fail-loud / unexpected。

## 持续审查队列

下面还没作为确定 bug 关闭，需要继续看：

- `engram-runner.ts` 的 `allContradictsPairs()` 当前扫全量 relation，随着 claim 边增长会变成 O(E) runner 成本；代码已有 TODO，后续需要边界测试或增量队列设计。
- real model / real LLM / real data E2E 仍缺，现有测试主要是 fake judge、fake embedder、DB integration。
- server/API 边界尚未出现，因此所有 caller-provided actor 字段暂时还没被真实认证链路约束。
- PRD Story 13 写“主编三动作只投 confidence 因子、不直接写 status”，但 A.4 和当前 `editor-action.ts` 允许 Approve/Reject 通过状态机推动 status；这更像架构口径冲突，需要先裁决而不是直接改实现。
- README / adapter 文档口径仍需跟当前实现重新对齐，但 `README.md` 当前不在 tracked diff 中；本记录只引用它作为文档口径风险。
- `linus-review` / `test-review` 已完成；后续可追加第三方 review，但本台账已纳入两份报告的确认项。

## 本轮结论

当前实现已经不是“只有写半边能跑”的 S1 骨架，core/SPI/workers/self-loop 的实现面明显推进了。但在上生产承重前，最需要先修的是这些边界：

1. 红线判负必须保证“拒判不产生 scoring side effect”。
2. human-only / judge-athlete 隔离必须从字符串口径升级成真实 actor/DB 边界。
3. calibration input 必须绑定真实 recall snapshot，不能由 consumer 自报。
4. calibration version 必须不可变，否则历史 confidence 快照不是快照。
5. Consumer SPI 的请求态参数必须统一执行“只能收紧”，不能让 minSimilarity 这类旁门放松召回。
6. provenance 和 adapter 收紧都要锁住“事实本体”：hash 不能由 caller 任意锚，adapter 也不能改 claim 文本。
7. Reconciler 的 `fail` / `not_co_true` 语义必须拆开，不能把“不能推出锚事实”当成“不可同真”。
8. append-only 事件日志和待处理队列视图要分开，主编 resolve 后不能继续显示旧 escalation。
9. A1 不能只是单个 helper；所有公开 scoring 入口都要强制走已晋升、可审计、未迁出的 cohort。
10. 治理回滚必须回到真实生效面：active policy、active Standards、以及 recall gate 不能脱节。
11. Distiller provenance 必须绑定到 reader 产出的真实 segment；非空 locator 不是强出处。
12. core provenance 也必须要求非空可钻回 locator；只靠 `source_id NOT NULL` 还不够。
13. 独立印证要按完整 source lineage 折叠；只看当前 claim 引用集合会漏掉同祖先 sibling。
14. promote / recall / inbox 的 confidence 口径必须统一，不能让 draft→active 继续吃存档 conflict 快照。
15. pairwise conflict 信号不能只写进 patrol 行；runner 必须把 `conflictsWith` 转成 Arbiter 可消费事件。
16. ECE/纵向趋势必须和 g 拟合同样防刷单、按 `calibrationVersion` 分段；否则“越用越好”会被重复 usage 或混版样本伪造。
17. 纵向复考的三环 delta 要按 ring 隔离，不能让中环/内环读数污染外环 release 曲线。
18. 校准取样要先按 identity 取最新 truth 再过滤 clean outcome；否则 corrected/partial 覆盖不了旧票。
19. 回流 replay / L5 候选必须拒绝 blank query，不能把“没有问题文本”算成回归通过或缺口题。
20. 所有有界 loop 的异常路径都要和 budget exhaustion 一样安全降级到人审，不能靠 dispatcher 吞异常冒充安全。
21. 控制面写多张 active 表时必须原子；fail-silent 只能表示无副作用或显式 partial，不能半提交。
22. Verifier 要把“无 exact/supporting evidence”作为确定性 fail，而不是交给 judge 自由发挥。
23. Distiller 也必须把 runtime throw 视为有界 loop 非正常收尾并升级人审，不能让 dispatcher 吞掉后丢 source。
24. 红队免疫分虽不进 g，也必须拒绝非有限/非整数/越界计数；报告维度不能被坏读数污染。
25. Batch 事件的空集合必须保持 no-op，不能被解释成 cron 全库扫描。
26. dispatcher 的有界上限要按它声明的派发计数硬执行，不能在同事件多 worker 时越界。
27. 被吞掉的 worker 异常需要 durable audit/dead-letter，否则生产中无法告警、补偿或重放。
28. 人审 pending 队列必须 fail-loud 地守 payload 形状；空字符串待办不是可执行的人审任务。
29. calibration pilot 若绕过正式写入 SPI，只能叫 synthetic math fixture，不能用来证明“评测=消费”的真闭环。
30. pilot 的 CLI 成功条件必须和测试门一致；真实 embedding 下无样本或 ECE 未改善应失败，而不是打印“跑通”。
31. 首个领域 adapter 不能靠 `DB + schema` 旁路补 source metadata；否则 Consumer SPI 不是最高测试缝，只是文档里的口径。
32. active calibration g 的验收和提交要有 CAS；过期快照不能在并发下成为最新活动版本。
33. Verifier 的 patrol verdict 和状态迁移必须共享原子边界或显式 retry/audit；半条 scoring 裁决会污染 recall。
34. governance 传感器缺数据源必须进入 degraded 审计；未知不是健康 0。
35. 治理拒绝率必须读当前窗口/当前状态，不能用全历史 patrol 坏账驱动 live Standards。
36. calibration pilot 必须把 recall miss 当硬门，否则只是在幸存样本上证明校准数学。
37. 红队 generation 的临时注入必须有调用后清理边界；最后一个样本残留会污染后续评测。
38. 免疫 detection 口径必须对应真实收紧效果；near-dup poison 不能只凭 escalation 把未 flag 的 draft 算检出。
39. 冻结红队世代前必须校验题本 shape 和 item id 唯一；坏敌手不能先入库再等 scorer 爆炸。
40. immunity 当前维度要按 frozen generation/class 的最新重打分聚合；append-only 历史不能自动变成当前样本池。
41. 维度事件和免疫分的 text 标签都要有 runtime / DB 白名单；TypeScript 类型不是承重边界。
42. 评测参数 `k` 必须入口拒坏值，不能让 recall limit 和 P@k 分母使用两套解释。
43. 评测 run 的身份要么唯一、要么 attempt-aware；同一 runId 重跑不能让 series 和 aggregate 给出两套解释。
44. 归因脊柱的 winner/loser 极性必须按 failure kind 定义；把错 claim 被判输归因 Arbiter 会派错工单。
45. M3-A 的多源实证必须使用真实独立来源；伪造 `contentHash` 刷 f3 会把重复文本当成印证。
46. env-gated 真模型 smoke 发现偏差必须非零退出；warning 文案不是评测门。
47. realworld-ece measurement 必须按本次 run/corpus 取样；整库 `usage_truth` 会把历史幸存样本伪造成当前曲线。
48. promotion 统计必须区分 expected confidence gate block 和 unexpected transition failure；“0 晋升”不能吞掉状态机故障。
