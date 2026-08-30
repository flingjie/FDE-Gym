# 跨模块重复与架构张力报告

> 证据基线：2026-08-30。每条 claim ≥2 处 `file:line`。
> 分类：**应收敛** / **死路径或空壳** / **合法特化（保留）** / **文档漂移**。

---

## A. 应收敛（偶然重复 / 双权威）

### A1. 决策权威分裂：`decide()` 空壳 vs orchestrator 真门控

| 位置 | 行为 |
|---|---|
| `src/core/state-machine.ts:90-105` | `submit-brief` / `submit-design` / `respond-challenge` / `submit-pitch` **无条件** `phase.changed` |
| `src/core/state-machine.ts:110-112` | `review` 返回 `[]`（placeholder） |
| `src/core/state-machine.ts:75-88` | `hint` 发出 **placeholder** 文案 |
| `src/core/orchestrator.ts:432` | `decide(...)` **丢弃返回值**，仅作 phase throw |
| `src/core/orchestrator.ts:623,831,898,1131` | 同上 discard 模式 |
| `src/core/orchestrator.ts:823-846` | respond-challenge **有条件**进 PITCH（mandatory 全答完） |
| `src/core/orchestrator.ts:423+` | framing：结构门 + Coach entailment 后才 `phase.changed` |

- **为何分化**：Task 4 先落了「纯 phase 机」；Tasks 5–11 把结构门叠在 orchestrator，但未回写 `decide`。
- **判断**：偶然空壳。文档（`docs/architecture.md`）仍把 `decide()` 说成控制面核心，实现上它大多是 `requirePhase` + 被丢弃的假事件。
- **风险**：新贡献者以为改 `decide` 即改门控；或直接调 `decide` 产出事件写入 store，绕过真实 gate。
- **建议**：二选一——(1) 把真实门控收进对 `RunAggregate` 的 `decide`，或 (2) 把 `decide` 降级为 `assertPhaseLegal` 并删除假事件/placeholder。

### A2. 双持久化路径

| 生产路径（正确） | 旁路路径（危险） |
|---|---|
| CLI `executeCommandTransaction`：`src/cli/commands.ts:316+` 等 | `runDiscoveryTurn` → `appendEvents`：`orchestrator.ts:313-318` |
| | `repairPendingEvidence`：`373-378` |
| | `runFramingGate`：`490-494` |
| | `submitSolutionDesign`：`641-646` |
| | `runChallengeInjection`：`780-785` |
| | `respondToChallenge`：`857-862` |
| | `submitPitch`：`916-919` |
| | `createRetry`：`1069-1075`（双 run append，无 journal） |

- **判断**：旁路绕过 write-ahead journal、幂等 result replay、canary journal scan、部分 effects。
- **建议**：删除或移入 `tests/` helper；生产 API 只导出 `prepare*`。

### A3. Hint 三路径

| 路径 | 位置 | 生产使用 |
|---|---|---|
| 确定性 ladder | `src/simulation/hints.ts:72` | **是** — `cli/commands.ts:494` |
| Coach 模型生成 | `src/agents/coach.ts:140` | **否** — 仅 `tests/contracts/coach-agent.test.ts` |
| decide placeholder | `src/core/state-machine.ts:160` | **否** — 若有人用 decide 的 hint 事件会写入假文案 |
| Firewall coachTask=hint | `src/security/context-firewall.ts:311` | 仅为死路径保活 |

- **判断**：ADR-0003 已裁定「runtime generation of hints is not a supported path」。Coach/firewall hint 是死代码税。
- **建议**：删除 `coach.requestHint` + firewall `hint` task arm（或标 `@internal test-only` 并断生产导出）；`decide` 不再发 hint 事件。

### A4. `RunAggregate` 归属错位

| 定义 | 折叠 | 消费 |
|---|---|---|
| `src/security/context-firewall.ts:87-120` | `src/replay/projector.ts:182` | orchestrator、CLI、scoring、agents |

- 安全模块承载**领域聚合**；firewall 本应只消费聚合。
- 敏感占位字段（`groundTruth`, `chainOfThought`, `customerPrompt`, …：`context-firewall.ts:111-119`）在 fold 中基本不填充 —— 前向声明税。
- **建议**：`RunAggregate` → `src/core/aggregate.ts`（或 `domain`）；firewall 只 import 类型。

### A5. CLI 命令样板膨胀

- `src/cli/commands.ts` ~893 行：每个 mutating command 重复 `loadRunState` → `guard` → `executeCommandTransaction` → `prepare*` → `ok`。
- `hintCommand`（`477-521`）甚至在 transaction 内外各 fold 一次 aggregate。
- **建议**：小型 `withRunCommand({ runId, commandId, request, canaries, prepare })` 辅助，不引入框架。

---

## B. 合法特化（不要统一）

### B1. 三角色 wrapper 共享 invoke 骨架

- `customer.ts:94-126`、`evidence-tracker.ts:91-126`、`coach.ts:170-241`
- 共同点：firewall → prompt → invoke → sanitize → validate
- 差异：capsule 信任模型、输出后置、Coach 多 task
- **保留显式重复** — 动态角色注册会削弱 fail-closed

### B2. 双重 sanitize

- Direct runtime 出口 + 角色 wrapper 再 sanitize
- Defense-in-depth：runtime 防原始 HTTP；wrapper 防 Fixture/替代实现
- **保留**

### B3. 最小 `RunState` reduce vs 完整 `foldRunAggregate`

- `reducer.ts:25-30`：仅 phase/seq（给 decide 用）
- `projector.ts:182`：全聚合恢复
- 高度不同；但若 A1 把 decide 升到 RunAggregate，最小 reduce 可能自然消失

### B4. Public projection field-by-field

- `public-projection.ts` 与 firewall 同构「永不 spread」
- 意图相同、数据方向相反（出 vs 入）— 保留两处显式 allowlist

---

## C. 文档 / 验收漂移

| 文档 | 问题 |
|---|---|
| `docs/mvp-acceptance.md` | 仍写 `npm run doctor`、`CodexAgentRuntime`、live canary probe FAIL |
| `docs/superpowers/specs/2026-08-29-codex-strict-mode-*.md` | 已实现并删除的路径仍占 docs 权重 |
| `PATHFINDER-2026-08-29` | 提案 A（StrictCodexPolicy）**已作废**（ADR-0002） |
| README 命令表 | 缺 `repair-evidence`（`main.ts` 有） |

---

## D. 轻量 / 可延后

- `hashSeed` FNV-1a 仅在 `cli/commands.ts:207`；可下沉 `simulation/rng.ts` 但不急。
- `domain.ts` 915 行神袋 — 可按 command/event/artifact 拆文件，纯可维护性。
- Score legacy fallback（`score-input.ts` + `versioning.ts` + `LEGACY_COMPARABILITY_KEY`）— 若无生产 legacy run，可设日落日期删除。**与 runtime stage fallback 是合法特化**（缺 Coach 分数 vs 磁盘旧事件），不要合并。
- Coach `requestHint` 测试可改测 brief/final-review only。
- **`loadRun`/`reduce` 生产恢复从未使用**：CLI resume 一律 `loadEvents` + `foldRunAggregate`（`commands.ts:226-235`）；`event-store.loadRun` 仅测试。可标 test-only 或弃用。
- **`decide` 的 `complete`/`abort`/`retry`/`start-retry` 无生产 CLI 调用者**（retry 走 `prepareRetry`+start/accept）。与 A1 一并清理 hollow command surface。
- **`dist/` 残留已删源码产物**：`dist/integrations/codex/codex-runtime.js` 等 — `npm run build` 干净重建即可；`src/` 无 doctor/codex-runtime。

---

## 优先级（影响 × 成本）

| # | 项 | 影响 | 成本 | 类型 |
|---|---|---|---|---|
| 1 | A1 决策权威单一化 | 高（正确性/心智） | 中 | 架构 |
| 2 | A2 删除直接 append 包装 | 高（journal 不变量） | 低 | 删除 |
| 3 | A3 删除 model-hint 死路径 | 中（复杂度/ADR 对齐） | 低 | 删除 |
| 4 | A4 RunAggregate 归位 | 中（边界清晰） | 低 | 移动 |
| 5 | C 文档/验收对齐 ADR-0002 | 中（信任） | 低 | 文档 |
| 6 | A5 CLI 样板 | 低-中 | 低 | 整理 |
| 7 | domain 拆分 / legacy score 日落 | 低 | 中 | 可维护性 |
