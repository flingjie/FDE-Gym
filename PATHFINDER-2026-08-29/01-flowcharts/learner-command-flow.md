# 学习者命令流

```mermaid
flowchart TD
  A["Learner intent<br/>skills/fde-gym/SKILL.md:1"] -->|one safe command| B["parseArgs + stdin JSON<br/>src/cli/main.ts:128-176"]
  B --> C{"command switch<br/>src/cli/main.ts:177-374"}
  C --> D["command handler<br/>src/cli/commands.ts:318-909"]
  D --> E["load verified run/bundle<br/>src/cli/commands.ts:234-288"]
  E --> F["execute transaction<br/>src/core/command-transaction.ts:256-317"]
  F --> G["learner-safe CliResult<br/>src/cli/commands.ts:189-212"]
  G --> H["JSON or human render<br/>src/cli/main.ts:376-383"]
```

- Side effects: stdin read, run/bundle file reads, transaction writes, stdout.
- Error branch: all handler errors collapse through `guard`/`toFailure` (`src/cli/commands.ts:298-305`).
- Dependency: control-plane orchestrator, transaction store, Codex runtime.
