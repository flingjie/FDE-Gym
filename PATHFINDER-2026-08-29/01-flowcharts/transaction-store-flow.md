# 命令事务与事件持久化

```mermaid
flowchart TD
  A["Mutating command<br/>src/cli/commands.ts:318-819"] --> B["executeCommandTransaction<br/>src/core/command-transaction.ts:256-317"]
  B --> C["validate resource ids + request hash<br/>src/core/command-transaction.ts:265-274"]
  C --> D["acquire run lock<br/>src/core/command-transaction.ts:276"]
  D --> E{"journal exists?<br/>src/core/command-transaction.ts:278-293"}
  E -- committed + same hash --> F["return stored result<br/>src/core/command-transaction.ts:284-286"]
  E -- prepared --> G["finish events/effects<br/>src/core/command-transaction.ts:287-292"]
  E -- absent --> H["prepare command plan<br/>src/core/command-transaction.ts:295-300"]
  H --> I["atomic journal: prepared<br/>src/core/command-transaction.ts:301-311"]
  I --> J["append hash-chain events<br/>src/core/event-store.ts:147-218"]
  J --> K["apply idempotent effects<br/>src/core/command-transaction.ts:207-240"]
  K --> L["atomic journal: committed<br/>src/core/command-transaction.ts:314"]
  E -. different hash .-> M["COMMAND_ID_CONFLICT<br/>src/core/command-transaction.ts:280-283"]
```

- Durable files: `commands/<commandId>.json`, `events.jsonl`, `manifest.json`, optional `profile.json`/child run.
- Recovery never re-invokes the model once a prepared plan is journaled.
- Dependency: atomic file replacement and lexicographically ordered locks.
