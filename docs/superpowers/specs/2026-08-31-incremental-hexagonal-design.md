# Phase 2a — Incremental Hexagonal: Application Use Cases + Ports

**Date:** 2026-08-31
**Status:** Approved for implementation planning
**Scope:** FDEGym Phase 2 "降耦合" — first sub-project (incremental hexagonal)

## Context

Phase 1 corrected the determinism contract and moved `RunAggregate` to core. Phase 2
reduces coupling. Its first sub-project makes the CLI a thin adapter: the CLI stops
understanding scenario capsules, transactions, and domain events — it parses arguments,
calls an application use case, and renders the result.

This is an **incremental** hexagonal refactor, not a directory relocation. Existing
directories stay; we introduce a `ports/` layer (interfaces) and an `application/` layer
(use cases) above the existing concrete modules, which become adapters.

## Goal

- The CLI (`src/cli/commands.ts`) depends only on application use cases, not on
  `executeCommandTransaction`, scenario capsules, or the `prepare*` orchestration.
- Application use cases coordinate domain (`prepare*`, `assertCommandPhase`, events) with
  four explicit ports.
- Concrete modules (`event-store.ts`, `direct-runtime.ts`, `bundle.ts`+`loader.ts`,
  `fs-store.ts`) implement those ports.

## Non-negotiable constraints

- **Behavior-preserving refactor.** The 705-test suite, golden replay byte-stability, and
  every committed event/score stay identical. No behavior change, no new dependencies.
- **`executeCommandTransaction` stays in core** (`src/core/command-transaction.ts`) and is
  called directly by use cases — it is already the sole commit API; do NOT wrap it in a
  `Transaction` port.
- Source imports use `.js`; test imports are extensionless.
- No `CommandBus`, `PersistenceAdapter`, `ProfileRepository` **abstraction beyond the port
  interface itself** — the ports are plain TypeScript interfaces, not runtime registries.
- Do NOT introduce a `RoleAgentFactory`, feature flag, or dual path.

## The four ports (`src/ports/`)

Each is a `type`/`interface` bundling the existing concrete functions' signatures. The
concrete modules already export functions matching these; the port is a structural type
the use cases depend on (no adapter must be modified to "implement" it — TypeScript
structural typing accepts them).

```ts
// src/ports/event-store.ts
import type { RecordedEvent, RunEvent, RunState } from "../core/domain.js";
export interface EventStorePort {
  loadRun(runId: string, options?: { baseDir?: string }): Promise<RunState>;
  loadEvents(runId: string, options?: { baseDir?: string }): Promise<RecordedEvent[]>;
  appendEvents(runId: string, events: RunEvent[], options?: { baseDir?: string }): Promise<void>;
  readHead(runId: string, options?: { baseDir?: string }): Promise<{ seq: number; hash: string } | null>;
}

// src/ports/model-runtime.ts  — the existing AgentRuntime is already the port
export type { AgentRuntime, AgentInvocationResult, AgentInvokeOptions } from "../agents/agent-runtime.js";

// src/ports/scenario-repository.ts
import type { ScenarioBundle, ScenarioLoadOptions } from "../scenarios/bundle.js";
export interface ScenarioRepositoryPort {
  loadScenarioBundle(id: string, options: ScenarioLoadOptions): ScenarioBundle;
}

// src/ports/profile-repository.ts
import type { AttemptReview, LearnerProfile } from "../profile/learner-profile.js";
export interface ProfileRepositoryPort {
  loadLearnerProfile(options?: { baseDir?: string }): Promise<LearnerProfile | null>;
  saveLearnerProfile(profile: LearnerProfile, options?: { baseDir?: string }): Promise<void>;
  applyProfileAttemptEffect(effectId: string, runId: string, review: AttemptReview, options?: { baseDir?: string }): Promise<LearnerProfile>;
}
```

(Exact signatures are copied verbatim from the concrete modules at implementation time;
the implementer greps each concrete function and mirrors its type. Note `resolveScenario`
— the `commands.ts` helper that wraps `loadScenarioBundle` and returns
`{ bundle, bundleDigest }` — moves into the application layer, not into the port.)

## Application use cases (`src/application/`)

One use case per CLI command. Each signature is `useCase(args, deps): Promise<ResultData>`
where `deps` is a small bundle of the four ports plus `runtime` (the `AgentRuntime`), and
`ResultData` is the existing CLI `*Data` shape (so the CLI renders unchanged).

The use case owns the wiring the CLI currently does inline:

```
load aggregate (EventStorePort.loadRun/loadEvents)
→ resolve scenario (ScenarioRepositoryPort)
→ prepare* (orchestrator)
→ commit (executeCommandTransaction)
→ return result
```

Use cases to extract (matching the 16 `*Command` functions):

| Use case | Command |
|---|---|
| `startRun` | `startCommand` |
| `frame` | `frameCommand` |
| `ask` | `askCommand` |
| `repairEvidence` | `repairEvidenceCommand` |
| `requestHint` | `hintCommand` |
| `clarify` | `clarifyCommand` |
| `submitBrief` | `submitBriefCommand` |
| `submitDesign` | `submitDesignCommand` |
| `respondChallenge` | `respondChallengeCommand` |
| `submitPitch` | `submitPitchCommand` |
| `review` | `reviewCommand` |
| `replay` | `replayCommand` |
| `retry` | `retryCommand` |
| `status` | `statusCommand` |
| `profile` | `profileCommand` |
| `list` | `listCommand` |

Read-only commands (`replay`, `status`, `profile`, `list`) do not commit; their use cases
just load + project.

## CLI (thin)

Each `*Command` becomes: parse `args` → build `deps` from `ctx` → call the use case →
wrap the `ResultData` in the existing `CliResult` envelope (`ok`/`fail`). No
`loadScenarioBundle`, `executeCommandTransaction`, `prepare*`, or capsule handling remains
in `commands.ts`.

## Out of scope (later Phase-2 sub-projects)

- Full `domain/` `application/` `ports/` `adapters/` `projections/` directory relocation.
- Type-level security split (`PublicRunView` / private-state types).
- `RuntimeCapabilities` negotiation and per-role model config.
- SQLite event store + snapshots.

## Testing

- The existing 705 tests pass unchanged (behavior-preserving). No golden fixture changes.
- Add a thin contract test asserting the CLI no longer imports `executeCommandTransaction`
  or `prepare*` (a `grep`-style guard, or a type-level assertion that `commands.ts` only
  imports from `application/` and `render`). This pins the boundary.

## Success criteria

- `npm run release:gate` green; golden replay byte-stable; no committed event/score change.
- `commands.ts` contains no `executeCommandTransaction`, `prepare*`, `loadScenarioBundle`,
  or capsule references.
- The four ports exist as structural interfaces; use cases depend on ports, not on concrete
  module file paths.
