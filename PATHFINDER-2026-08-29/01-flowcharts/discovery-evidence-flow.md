# 发现回合与证据图

```mermaid
flowchart TD
  A["askCommand<br/>src/cli/commands.ts:390-425"] --> B["prepareDiscoveryTurn<br/>src/core/orchestrator.ts:200-306"]
  B --> C["decide question.asked<br/>src/core/state-machine.ts:59-69"]
  C --> D["Customer firewall input<br/>src/security/context-firewall.ts:247-270"]
  D --> E["Customer invocation<br/>src/agents/customer.ts:94-126"]
  E --> F["customer.replied<br/>src/core/orchestrator.ts:226-236"]
  F --> G["Evidence Tracker public input<br/>src/security/context-firewall.ts:273-292"]
  G --> H["extractEvidence<br/>src/agents/evidence-tracker.ts:91-126"]
  H --> I["applyEvidencePatch<br/>src/evidence/graph.ts:210-280"]
  I --> J["evidence.patched + question.assessed<br/>src/core/orchestrator.ts:252-267"]
  H -. failure .-> K["evidence.pending<br/>src/core/orchestrator.ts:268-296"]
  K --> L["frame blocked<br/>src/core/orchestrator.ts:142-149"]
  L --> M["repairPendingEvidence<br/>src/core/orchestrator.ts:326-379"]
  M --> I
```

- Side effects: two isolated model invocations; accepted events journaled as one command plan.
- The customer reply survives tracker failure; only evidence progression is blocked.
- Dependency: role runtime/security, evidence graph reducer, event transaction.
