# 后续 /make-plan 提示词

每个块可直接贴给 `/make-plan`。按 `03-unified-proposal.md` 顺序执行。

---

## 1. 单一持久化路径

```text
/make-plan 收敛 FDEGym 生产变更为单一持久化路径。

目标：保留 src/core/command-transaction.ts 的 executeCommandTransaction 为唯一提交入口；删除或移入 tests/ helper 以下 orchestrator 直接 appendEvents 包装：
- runDiscoveryTurn (orchestrator.ts ~313)
- repairPendingEvidence (~373)
- runFramingGate (~490)
- submitSolutionDesign (~641)
- runChallengeInjection (~780)
- respondToChallenge (~857)
- submitPitch (~916)
- createRetry (~1069)

CLI 调用点 src/cli/commands.ts 必须继续走 prepare* + executeCommandTransaction，保持 journal/effect/canary 语义。

参考：PATHFINDER-2026-08-30/01-flowcharts/orchestration-and-decide.md 、02-duplication-report.md A2、03-unified-proposal.md 提案2。

约束：不要新增 transaction adapter；不要 feature flag 双路径；测试用 prepare* + transaction test helper。先写/改测试再删 API。
```

---

## 2. 删除 model-hint 死路径

```text
/make-plan 按 ADR-0003 删除 FDEGym 非生产 hint 路径，只保留确定性 ladder。

保留：src/simulation/hints.ts requestHint；src/cli/commands.ts hintCommand。

删除或停止导出：
- src/agents/coach.ts requestHint 及仅为其服务的 prompt 分支
- src/security/context-firewall.ts coachTask "hint" arm 与相关 schema 若无其它消费者
- src/agents/contracts.ts CoachHintInput/Output（确认无引用后）
- src/core/state-machine.ts hint 分支的 placeholder 文案事件（若提案1尚未做，可与本任务合并）

更新测试：tests/contracts/coach-agent.test.ts、context-firewall hint cases、凡 import coach.requestHint 者。

参考：PATHFINDER-2026-08-30/01-flowcharts/evidence-and-simulation.md 、02-duplication-report.md A3、docs/architecture-decisions.md ADR-0003。

约束：不要引入“可配置 hint backend”；不要保留 model-hint behind flag。
```

---

## 3. decide 降级为 phase assert

```text
/make-plan 将 FDEGym 的 decide() 从“假事件源”降级为 phase 合法性断言，承认 orchestrator prepare* 为唯一事件组装权威。

目标形态：
- assertCommandPhase(phase, commandType) 只负责 INVALID_PHASE_COMMAND
- prepare* 显式构造全部领域事件（含 ask 的 question.asked）
- 删除 state-machine hintPlaceholder 与无条件 phase.changed 成功坍缩（submit-brief/design/respond-challenge/submit-pitch/review）

改写 orchestrator 中 decide 丢弃调用点：~432,623,831,898,1131；ask 路径 ~211 改为显式事件。
CLI start/frame/clarify 等仍可用薄 helper 生成 run.started/phase.changed。

参考：PATHFINDER-2026-08-30/01-flowcharts/orchestration-and-decide.md 、02-duplication-report.md A1、03-unified-proposal.md 提案1a。

约束：不要把模型 I/O 放进纯函数 decide；不要 decide 与 prepare 双写同一事件；同步修正 docs/architecture.md 中“decide 是控制面核心”的表述。
先保证 unit/state-machine 与 contracts/orchestrator 测试语义迁移。
```

---

## 4. RunAggregate 归位

```text
/make-plan 将 RunAggregate 从安全模块移到核心领域层。

- 新建 src/core/aggregate.ts（或等价），迁出 src/security/context-firewall.ts:87 的 RunAggregate 与其 Zod
- context-firewall 仅 import 类型并 buildRoleInput
- 审计并删除未被 foldRunAggregate/projector 填充的敏感占位字段（groundTruth、chainOfThought、customerPrompt、customerSessionId、rawCustomerOutput 等），同步防火墙未识别字段测试
- 更新所有 import

参考：PATHFINDER-2026-08-30/02-duplication-report.md A4、03-unified-proposal.md 提案4。

约束：不要借机做抽象层；不要保留“将来用”的 unknown 槽位。
```

---

## 5. 文档与验收对齐 ADR-0002

```text
/make-plan 将文档与验收基线对齐 direct-only runtime（ADR-0002）。

- docs/mvp-acceptance.md：移除 doctor、CodexAgentRuntime、FDE_GYM_CODEX_HOME、live doctor canary 行；改为 release:gate 与 DirectModelRuntime/UnconfiguredModelRuntime
- README.md：命令表补 repair-evidence；确认无 doctor
- 标注 obsolete 或移档 docs/superpowers/specs/2026-08-29-codex-strict-mode-* 与过时 PATHFINDER-2026-08-29 提案 A
- 确认 skills/fde-gym 文案无 doctor 指引

参考：docs/architecture-decisions.md ADR-0002、PATHFINDER-2026-08-30/02-duplication-report.md C。

约束：只改文档/验收描述，不改运行时行为。
```
