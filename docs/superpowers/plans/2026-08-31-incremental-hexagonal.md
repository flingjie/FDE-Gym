# Incremental Hexagonal (Phase 2a) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CLI a thin adapter — `commands.ts` stops importing `executeCommandTransaction`, `prepare*`, scenario capsules, and the store; it parses args, calls an application use case, and renders. Introduce a `ports/` layer and an `application/` layer without moving existing directories.

**Architecture:** Incremental hexagonal. Four structural port interfaces (`EventStorePort`, `ModelRuntime` = existing `AgentRuntime`, `ScenarioRepositoryPort`, `ProfileRepositoryPort`); one use case per command in `src/application/`; the existing concrete modules (`event-store.ts`, `direct-runtime.ts`, `bundle.ts`, `fs-store.ts`) satisfy the ports structurally — no adapter is modified.

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-incremental-hexagonal-design.md`

## Global Constraints

- **Behavior-preserving refactor.** The 705-test suite, golden replay byte-stability, and every committed event/score stay IDENTICAL. Verify `npm run typecheck` and `npm test` after every task; `npm run release:gate` at the end.
- `executeCommandTransaction` stays in `src/core/command-transaction.ts` and is called directly by use cases — do NOT wrap it in a `Transaction` port.
- Source imports use `.js`; test imports are extensionless.
- No `CommandBus`/`PersistenceAdapter` runtime abstraction beyond the plain port interfaces; no `RoleAgentFactory`, feature flag, or dual path.
- Ports are **structural types only** — do not modify the concrete modules to "implement" anything; TypeScript structural typing accepts them as-is.

---

### Task 1: Ports + `ApplicationDeps` + shared run/scenario loaders

**Files:**
- Create: `src/ports/event-store.ts`, `src/ports/model-runtime.ts`, `src/ports/scenario-repository.ts`, `src/ports/profile-repository.ts`
- Create: `src/application/deps.ts`
- Create: `src/application/run-load.ts`
- Modify: `src/cli/commands.ts` (delete the now-duplicated `loadRunState`/`resolveScenario`/`stripEnvelope`/`LoadedRun`/`ResolvedScenario`; import them from `application/run-load.js` instead)

**Interfaces:**
- Produces (consumed by Tasks 2–4): `EventStorePort`, `ScenarioRepositoryPort`, `ProfileRepositoryPort`, `ApplicationDeps`, `buildDeps`, `loadRun`, `resolveScenario`, `stripEnvelope`, `RunScenario`, `LoadedRun`.

- [ ] **Step 1: Create the four port interfaces** (signatures mirror the concrete modules verbatim)

`src/ports/event-store.ts`:

```ts
import type { RecordedEvent, RunEvent, RunState } from "../core/domain.js";

/** Structural port over the concrete `src/core/event-store.ts` functions. */
export interface EventStorePort {
  loadRun(runId: string, options?: { baseDir?: string }): Promise<RunState>;
  loadEvents(runId: string, options?: { baseDir?: string }): Promise<RecordedEvent[]>;
  appendEvents(runId: string, events: RunEvent[], options?: { baseDir?: string }): Promise<void>;
  readHead(runId: string, options?: { baseDir?: string }): Promise<{ seq: number; hash: string } | null>;
}
```

`src/ports/model-runtime.ts`:

```ts
export type { AgentRuntime, AgentInvocationResult, AgentInvokeOptions } from "../agents/agent-runtime.js";
```

`src/ports/scenario-repository.ts`:

```ts
import type { ScenarioBundle, ScenarioLoadOptions } from "../scenarios/bundle.js";

export interface ScenarioRepositoryPort {
  loadScenarioBundle(id: string, options: ScenarioLoadOptions): ScenarioBundle;
}
```

`src/ports/profile-repository.ts`:

```ts
import type { AttemptReview, LearnerProfile } from "../profile/learner-profile.js";

export interface ProfileRepositoryPort {
  loadLearnerProfile(options?: { baseDir?: string }): Promise<LearnerProfile | null>;
  saveLearnerProfile(profile: LearnerProfile, options?: { baseDir?: string }): Promise<void>;
  applyProfileAttemptEffect(effectId: string, runId: string, review: AttemptReview, options?: { baseDir?: string }): Promise<LearnerProfile>;
}
```

- [ ] **Step 2: Create `src/application/deps.ts`** (the dependency bundle + factory)

```ts
import type { AgentRuntime } from "../agents/agent-runtime.js";
import {
  appendEvents, loadEvents, loadRun, readHead,
} from "../core/event-store.js";
import { loadScenarioBundle } from "../scenarios/bundle.js";
import {
  applyProfileAttemptEffect, loadLearnerProfile, saveLearnerProfile,
} from "../storage/fs-store.js";
import type { EventStorePort } from "../ports/event-store.js";
import type { ScenarioRepositoryPort } from "../ports/scenario-repository.js";
import type { ProfileRepositoryPort } from "../ports/profile-repository.js";
import type { CustomerCapsule, EvaluatorCapsule, PublicScenario, ScenarioEventCandidate } from "../scenarios/schema.js";

export interface PreloadedScenario {
  public: PublicScenario;
  customer: CustomerCapsule;
  evaluator: EvaluatorCapsule;
  events: ScenarioEventCandidate[];
}

/** Everything an application use case needs to coordinate domain + ports. */
export interface ApplicationDeps {
  runtime: AgentRuntime;
  store: EventStorePort;
  scenarios: ScenarioRepositoryPort;
  profiles: ProfileRepositoryPort;
  baseDir?: string;
  compiledRoot?: string;
  scenario?: PreloadedScenario;
}

export interface BuildDepsInput {
  runtime: AgentRuntime;
  baseDir?: string;
  compiledRoot?: string;
  scenario?: PreloadedScenario;
}

/** Wire the concrete modules into the ports. The concrete modules satisfy the
 *  ports structurally — no adapter change. */
export function buildDeps(input: BuildDepsInput): ApplicationDeps {
  return {
    runtime: input.runtime,
    store: { loadRun, loadEvents, appendEvents, readHead },
    scenarios: { loadScenarioBundle },
    profiles: { loadLearnerProfile, saveLearnerProfile, applyProfileAttemptEffect },
    baseDir: input.baseDir,
    compiledRoot: input.compiledRoot,
    scenario: input.scenario,
  };
}
```

- [ ] **Step 3: Create `src/application/run-load.ts`** — move `stripEnvelope`, `LoadedRun`, `loadRunState` (rename `loadRun`), `ResolvedScenario` (rename `RunScenario`), and `resolveScenario` from `commands.ts`, changing `ctx: CommandContext` to explicit `deps` parameters.

```ts
import { foldRunAggregate } from "../replay/projector.js";
import { loadScenarioBundle, defaultCompiledRoot } from "../scenarios/bundle.js";
import { ScenarioBundleMismatchError } from "../core/errors.js";
import type { RecordedEvent, Locale, RunEvent, RunPhase } from "../core/domain.js";
import type { ScenarioEventCandidate } from "../scenarios/schema.js";
import type { ApplicationDeps, PreloadedScenario } from "./deps.js";

export function stripEnvelope(recorded: RecordedEvent): RunEvent {
  const { seq: _seq, logicalTime: _lt, previousHash: _ph, hash: _hash, ...event } = recorded;
  return event as RunEvent;
}

export interface LoadedRun {
  events: RunEvent[];
  scenarioId: string;
  locale: Locale;
  phase: RunPhase | null;
  aggregate: ReturnType<typeof foldRunAggregate>;
  scenarioBundleDigest: string | undefined;
}

export async function loadRun(deps: ApplicationDeps, runId: string): Promise<LoadedRun> {
  const recorded = await deps.store.loadEvents(runId, { baseDir: deps.baseDir });
  const events = recorded.map(stripEnvelope);
  const started = events.find((event) => event.type === "run.started");
  const scenarioId = started && started.type === "run.started" ? started.scenarioId : "";
  const locale = started && started.type === "run.started" ? started.locale : "zh-CN";
  const scenarioBundleDigest =
    started && started.type === "run.started" ? started.scenarioBundleDigest : undefined;
  const aggregate = foldRunAggregate(events, scenarioId, locale);
  return { events, scenarioId, locale, phase: aggregate.phase, aggregate, scenarioBundleDigest };
}

export interface RunScenario extends PreloadedScenario {
  bundleDigest: string | undefined;
}

export function resolveScenario(
  deps: ApplicationDeps,
  scenarioId: string,
  expectedBundleDigest?: string,
): RunScenario {
  if (deps.scenario) {
    return { ...deps.scenario, bundleDigest: undefined };
  }
  const bundle = deps.scenarios.loadScenarioBundle(scenarioId, {
    compiledRoot: deps.compiledRoot ?? defaultCompiledRoot(),
  });
  if (expectedBundleDigest !== undefined && bundle.bundleDigest !== expectedBundleDigest) {
    throw new ScenarioBundleMismatchError(scenarioId);
  }
  return {
    public: bundle.publicScenario,
    customer: bundle.customerCapsule,
    evaluator: bundle.evaluatorCapsule,
    events: [...bundle.eventCandidates],
    bundleDigest: bundle.bundleDigest,
  };
}
```

(Note: `resolveScenario` no longer uses `ctx.scenario` — it uses `deps.scenario`. Delete the old helpers from `commands.ts` and re-import from `application/run-load.js`; adjust call sites to pass `deps`.)

- [ ] **Step 4: Verify + commit**

```bash
npm run typecheck && npm test   # 705 still green — helpers are pure moves
git add -A && git commit -m "refactor: introduce ports and application deps/loaders"
```

---

### Task 2: Mutating use cases, part 1 (start, frame, ask, repairEvidence, hint, clarify)

**Files:**
- Create: `src/application/use-cases/discovery.ts` (start, frame, ask, repairEvidence, hint, clarify)
- Modify: `src/cli/commands.ts` (each `*Command` calls the use case)

**Interfaces:**
- Consumes: `ApplicationDeps`, `loadRun`, `resolveScenario`, `stripEnvelope`, `distinctInjectedChallengeIds` (move this too), `prepare*` from `orchestrator.js`, `executeCommandTransaction`.
- Produces: `startRun`, `frame`, `ask`, `repairEvidence`, `requestHint`, `clarify` — each `(deps, args) => Promise<Data>`.

**Pattern (mechanical, behavior-preserving):** for each command, move its `guard(...)` body verbatim into a use-case function taking `(deps, args)`, replacing `ctx.baseDir`/`ctx.compiledRoot`/`ctx.scenario`/`ctx.runtime` with the corresponding `deps` fields and the local `loadRunState(ctx, id)`/`resolveScenario(ctx, ...)` with `loadRun(deps, id)`/`resolveScenario(deps, ...)`. The use case returns the raw `Data` (e.g. `AskData`); the CLI command becomes:

```ts
export async function askCommand(ctx: CommandContext, args: AskArgs): Promise<CliResult<AskData>> {
  const deps = buildDeps(ctx);
  return guard(args.locale ?? "zh-CN", async () => {
    const loaded = await loadRun(deps, args.runId);   // or the use case does this internally
    return ok(args.runId, loaded.phase, loaded.locale, await ask(deps, args));
  });
}
```

(Choose the cleanest consistent shape: either the use case returns the full `{ data, runId, phase, locale }` so the command just wraps it in `ok`, or the command calls `loadRun` for the envelope fields. The spec leaves this to the implementer; pick one and keep all 16 consistent. `guard` and `ok` stay in `commands.ts`.)

- [ ] **Step 1: Extract `startRun`** — move `startCommand`'s body (resolveScenario → `executeCommandTransaction({ prepare: buildRunStartedEvents/... })`). Verify the start e2e still passes.
- [ ] **Step 2: Extract `frame`** — move `frameCommand`'s body (`assertCommandPhase` + `buildPhaseChangedEvent`).
- [ ] **Step 3: Extract `ask`** — move `askCommand`'s body (`prepareDiscoveryTurn` → transaction → `AskData`).
- [ ] **Step 4: Extract `repairEvidence`** — move `repairEvidenceCommand`'s body (`prepareRepairPendingEvidence`).
- [ ] **Step 5: Extract `requestHint`** — move `hintCommand`'s body (`requestHint` from simulation + transaction).
- [ ] **Step 6: Extract `clarify`** — move `clarifyCommand`'s body (`prepareClarification`).
- [ ] **Step 7: Verify + commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "refactor: extract discovery/framing use cases"
```

---

### Task 3: Mutating use cases, part 2 (submitBrief, submitDesign, respondChallenge, submitPitch, review, retry)

**Files:**
- Create: `src/application/use-cases/framing-review.ts` (submitBrief, submitDesign, respondChallenge, submitPitch, review)
- Create: `src/application/use-cases/retry.ts` (retry)
- Modify: `src/cli/commands.ts`

**Interfaces:** same pattern as Task 2. `submitBrief`, `submitDesign`, `respondChallenge`, `submitPitch`, `review`, `retry`.

- [ ] **Step 1–6: extract each use case** (submitBrief → `prepareFramingGate`; submitDesign → `prepareSolutionDesign` + `prepareChallengeInjection`; respondChallenge → `prepareRespondToChallenge`; submitPitch → `preparePitch`; review → `prepareReview` + profile effect; retry → `prepareRetry` with parent/child events + `retry.ensure-child` effect).
- [ ] **Step 7: Verify + commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "refactor: extract framing/review/retry use cases"
```

---

### Task 4: Read-only use cases (replay, status, profile, list)

**Files:**
- Create: `src/application/use-cases/read.ts`
- Modify: `src/cli/commands.ts`

**Interfaces:** `replay`, `status`, `profile`, `list` — no transaction, just load + project.

- [ ] **Step 1–4: extract each** (replay → `loadEvents` + `projectReplay`; status → `loadRun` + fold counts; profile → `deps.profiles.loadLearnerProfile`; list → `readdir` over the store runs dir).
- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "refactor: extract read-only use cases"
```

---

### Task 5: Thin CLI + boundary contract test

**Files:**
- Modify: `src/cli/commands.ts` (remove now-unused imports: `executeCommandTransaction`, `prepare*`, `loadEvents`, `loadScenarioBundle`, `loadLearnerProfile`, `foldRunAggregate`, `projectReplay`, `ScenarioBundleMismatchError`, `createRng`, `requestHint`, `assertCommandPhase`, `buildPhaseChangedEvent`, `buildRunStartedEvents`, etc. — whatever the use cases now own)
- Create: `tests/contracts/cli-boundary.test.ts`

**Interfaces:** the CLI imports only `buildDeps`/`loadRun` from `application/`, the use-case functions, `guard`/`ok`/`localize`, and type-only imports.

- [ ] **Step 1: Write the boundary test (TDD — fails before cleanup)**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const COMMANDS_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "commands.ts");

describe("CLI boundary — commands.ts is a thin adapter", () => {
  it("does not import the transaction, prepare*, or concrete store/scenario modules", () => {
    const src = readFileSync(COMMANDS_SRC, "utf8");
    for (const forbidden of [
      "executeCommandTransaction",
      "command-transaction",
      "prepareDiscoveryTurn", "prepareFramingGate", "prepareClarification",
      "prepareSolutionDesign", "prepareChallengeInjection", "prepareRespondToChallenge",
      "preparePitch", "prepareRetry", "prepareReview", "prepareRepairPendingEvidence",
      "loadScenarioBundle", "loadLearnerProfile", "foldRunAggregate", "projectReplay",
    ]) {
      expect(src, `commands.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails** (commands.ts still imports these).

- [ ] **Step 3: Strip the unused imports from `commands.ts`** so only `buildDeps`, the use cases, `guard`/`ok`/`localize`, and type-only imports remain. Keep `CommandContext` and all the `*Args`/`*Data` types (the CLI still owns arg parsing + DTO shapes).

- [ ] **Step 4: Verify + full gate + commit**

```bash
npm run typecheck && npm test
npm run release:gate     # golden replay must stay byte-stable
git add -A && git commit -m "refactor: thin CLI — commands.ts delegates to application use cases"
```

---

## Execution order summary

| Task | Deliverable | Depends on |
|---|---|---|
| 1 | Ports + deps + run/scenario loaders | — |
| 2 | Discovery/framing mutating use cases | 1 |
| 3 | Framing/review/retry mutating use cases | 1 |
| 4 | Read-only use cases | 1 |
| 5 | Thin CLI + boundary test + full gate | 2–4 |

**Recommended serial order:** 1 → 2 → 3 → 4 → 5.

## Verification checklist

- [ ] 705 tests green throughout; golden replay byte-stable; no committed event/score change.
- [ ] `commands.ts` imports neither `executeCommandTransaction` nor `prepare*` (boundary test green).
- [ ] The four ports exist as structural interfaces; use cases depend on `deps`, not concrete module paths.
- [ ] `npm run release:gate` green at the end.
