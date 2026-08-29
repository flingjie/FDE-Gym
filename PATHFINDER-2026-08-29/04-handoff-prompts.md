# 后续规划提示词

## 单一 Strict Codex Policy

```text
/make-plan 为 FDEGym 设计“单一 Strict Codex Policy”实施计划。目标组件为 `src/integrations/codex/strict-policy.ts`，单一入口为 `strictCodexArgs()`（名称可在计划中校准）。重写 `src/integrations/codex/codex-runtime.ts:73-82` 与 `src/integrations/codex/capability-probe.ts:443-453`，保证 doctor 与生产运行时使用完全相同的默认隔离参数。参考 `PATHFINDER-2026-08-29/01-flowcharts/role-runtime-security.md`。必须先处理未定义 node_repl 配置、任意用户 MCP server 与失败 probe 假阳性等约束；不要引入 registry、factory、feature flag，也不要保留两套参数数组。
```

## 单一持久化命令路径

```text
/make-plan 为 FDEGym 收敛“单一持久化命令路径”。保留 `src/core/command-transaction.ts:256-317` 的 `executeCommandTransaction` 作为生产变更的唯一提交入口；逐一审计并重写/删除 `src/core/orchestrator.ts:313-319`, `373-379`, `490-494`, `641-647`, `780-785`, `857-862`, `916-920`, `1069-1077` 的直接持久化包装器。CLI 当前调用点 `src/cli/commands.ts:318-819` 必须保持 journal/effect/canary 语义。参考 `PATHFINDER-2026-08-29/01-flowcharts/transaction-store-flow.md`。不要新增 transaction adapter，不要用 feature flag 保留双路径；测试需要时用纯 `prepare*` + 明确 test helper。
```
