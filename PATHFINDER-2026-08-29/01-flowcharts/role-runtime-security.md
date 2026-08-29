# 角色运行时与安全边界

```mermaid
flowchart TD
  A["RunAggregate + role capsule<br/>src/security/context-firewall.ts:87-120"] --> B["field-by-field allowlist<br/>src/security/context-firewall.ts:214-367"]
  B --> C{"role wrapper"}
  C --> D["Customer<br/>src/agents/customer.ts:94-126"]
  C --> E["Evidence Tracker<br/>src/agents/evidence-tracker.ts:91-126"]
  C --> F["Coach/Evaluator<br/>src/agents/coach.ts:140-241"]
  D --> G["CodexAgentRuntime.invoke<br/>src/integrations/codex/codex-runtime.ts:104-134"]
  E --> G
  F --> G
  G --> H["fresh ephemeral read-only process<br/>src/integrations/codex/codex-runtime.ts:136-184"]
  H --> I["raw stdout/stderr canary scan<br/>src/integrations/codex/codex-runtime.ts:199-221"]
  I --> J["strip prohibited keys + strict schema<br/>src/security/sanitizer.ts:74-110"]
  J --> K["typed role output only<br/>src/agents/agent-runtime.ts:11-16"]
  I -. malformed .-> L["one fresh repair<br/>src/integrations/codex/codex-runtime.ts:117-133"]
  I -. leak .-> M["one fresh retry / stable failure<br/>src/integrations/codex/codex-runtime.ts:121-133"]
```

- Process boundary: each role attempt gets a unique workdir and ephemeral Codex session.
- Trust boundary: customer/evaluator capsules are discriminated and cross-role delivery fails closed.
- Dependency: capability probe defines the child process runner and environment sanitizer.
