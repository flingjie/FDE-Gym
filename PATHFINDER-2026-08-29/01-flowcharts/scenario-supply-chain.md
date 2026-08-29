# 场景供应链

```mermaid
flowchart TD
  A["Bilingual YAML<br/>scenarios/source/*.yaml"] --> B["parse + strict schema<br/>src/scenarios/compiler.ts:202-210"]
  B --> C["public partition<br/>src/scenarios/compiler.ts:215-226"]
  B --> D["customer capsule + canary<br/>src/scenarios/compiler.ts:228-237"]
  B --> E["evaluator capsule + canary<br/>src/scenarios/compiler.ts:239-249"]
  B --> F["event candidates<br/>src/scenarios/compiler.ts:251"]
  C --> G["artifact descriptors + root digest<br/>src/scenarios/compiler.ts:253-278"]
  D --> G
  E --> G
  F --> G
  G --> H["staging verify + atomic publish<br/>src/scenarios/compiler.ts:151-191"]
  H --> I["manifest-root load<br/>src/scenarios/bundle.ts:107-160"]
  I --> J["hash/bytes/id/schema verify<br/>src/scenarios/bundle.ts:161-233"]
  J --> K["immutable ScenarioBundle<br/>src/scenarios/bundle.ts:235-242"]
```

- Side effects: build-time file reads/writes, atomic directory rename.
- Fail-closed branches: manifest digest mismatch, traversal, missing/extra artifacts, schema/version mismatch.
- Dependency: Zod schemas and canonical JSON hashing.
