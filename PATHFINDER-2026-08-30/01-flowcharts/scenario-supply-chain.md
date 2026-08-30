# Flow: scenario-supply-chain

## Happy path

```mermaid
flowchart TD
  YAML["Author bilingual YAML<br/>scenarios/source/*.yaml"] --> COMP["compileScenario<br/>src/scenarios/compiler.ts"]
  COMP --> DISC["hint-discipline gate<br/>src/scenarios/hint-discipline.ts"]
  DISC --> PART["Emit 4 partitions<br/>public/customer/evaluator/events"]
  PART --> MAN["manifest + SHA-256 digest<br/>src/scenarios/compiler.ts"]
  MAN --> DISK["scenarios/compiled/id/*"]
  DISK --> LOAD["loadScenarioBundle<br/>src/scenarios/bundle.ts"]
  LOAD --> VER["re-verify digest + schema<br/>src/scenarios/bundle.ts"]
  VER --> CLI["CLI resolveScenario<br/>src/cli/commands.ts:253"]
```

## Side effects
- Compile writes files under `scenarios/compiled/`
- Runtime load is read-only + hash verify
- Digest mismatch → `SCENARIO_BUNDLE_MISMATCH`

## External deps
- Consumed by CLI start/ask/review paths
- Capsules fed to firewall / orchestrator only via resolved partitions

## Notes
- ADR-0004 froze five AI-agent production ids
- Tools exist only as authored facts; gym never executes CRM/SQL/Git/OCR
