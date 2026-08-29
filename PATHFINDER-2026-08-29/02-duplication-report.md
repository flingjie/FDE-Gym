# 跨模块重复与分化报告

## 值得统一

### 1. Strict Codex 参数策略被复制

- 生产运行时：`src/integrations/codex/codex-runtime.ts:73-82`
- 能力探测：`src/integrations/codex/capability-probe.ts:443-453`
- **风险**：doctor 可能验证一套参数，而生产执行另一套；目前两处都独立维护 `DISABLE_TOOLS`。
- **判断**：偶然重复，应有单一事实源。不要引入 registry/factory；一个导出的纯参数构造函数即可。

### 2. 编排器同时暴露 prepare 与直接持久化入口

- 发现：`src/core/orchestrator.ts:200-319`
- 证据修复：`src/core/orchestrator.ts:326-379`
- framing：`src/core/orchestrator.ts:423-494`
- 设计/挑战/响应/提案/重试：`src/core/orchestrator.ts:614-1077`
- CLI 生产路径统一使用 `prepare*` + `executeCommandTransaction`：`src/cli/commands.ts:400-422`, `567-590`, `610-638`, `655-675`, `692-708`, `783-817`
- **风险**：调用者若直接使用 `run*`/`submit*`/`createRetry`，会绕过 command journal、结果重放和部分 effect 语义。
- **判断**：值得收敛 API 表面。保留纯 `prepare*` 作为唯一编排入口；直接 append 包装器若仅供测试，应移到测试 helper 或明确标为非生产。

## 合法特化，不建议统一

### 3. 三个角色包装器共享 invoke 骨架

- Customer：`src/agents/customer.ts:94-126`
- Evidence Tracker：`src/agents/evidence-tracker.ts:91-126`
- Coach：`src/agents/coach.ts:140-241`
- **共同点**：firewall → prompt → runtime.invoke → sanitize → domain validation。
- **差异**：capsule 信任模型、prompt 包装、输出后置验证和 Coach 的三任务输入均不同。
- **判断**：这是安全边界的显式重复，保留可读性优于抽象。通用 helper 容易把角色 allowlist 变成动态配置，反而削弱 fail-closed 性质。

### 4. 运行时与角色包装器都做输出清洗

- 运行时：`src/integrations/codex/codex-runtime.ts:199-245`
- 角色层：`src/agents/customer.ts:117-125`, `src/agents/evidence-tracker.ts:114-125`, `src/agents/coach.ts:160-196`
- **判断**：有意的 defense-in-depth，不应删除任一层。运行时覆盖原始 stdout/stderr/output file，角色层覆盖接口替代实现（如 Fixture runtime）。

### 5. 最小 RunState reducer 与完整 aggregate fold

- 最小状态：`src/core/reducer.ts:15-30`
- 完整恢复：`src/replay/projector.ts:182-282`
- **判断**：用途不同。前者服务纯状态机门控，后者服务持久化恢复/重放；不应强行合并，但事件新增时应由测试确保两者契约不漂移。

## 轻量重复

- learner prose boundary：`src/agents/customer.ts:46-48` 与 `src/agents/evidence-tracker.ts:44-46`。可复用导出函数，但收益很小，不值得单独改动。
- `prepare*` 后接 `appendEvents` 的薄包装在 orchestrator 多次出现；应随“单一事务入口”一起处理，而不是新增抽象层。
