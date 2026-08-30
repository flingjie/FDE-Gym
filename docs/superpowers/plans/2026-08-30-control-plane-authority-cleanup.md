# Control-plane authority cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the control plane have **one decision authority** (`prepare*`), **one commit path** (`executeCommandTransaction`), and **one hint path** (deterministic ladder), then move `RunAggregate` to core and reconcile docs with ADR-0002/0003.

**Architecture:** Pathfinder 2026-08-30 proposals 1a → 2 → 3 → 4 → 5. Delete dual paths; do not add abstractions, registries, feature flags, or a second transaction adapter.

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod. No new dependencies.

**Sources of truth (read before each task):**

| Doc | Use for |
|---|---|
| `PATHFINDER-2026-08-30/03-unified-proposal.md` | Target shape + anti-patterns |
| `PATHFINDER-2026-08-30/02-duplication-report.md` | Evidence (A1–A4, C, D) |
| `PATHFINDER-2026-08-30/01-flowcharts/orchestration-and-decide.md` | decide vs prepare matrix |
| `PATHFINDER-2026-08-30/04-handoff-prompts.md` | Scope boundaries per slice |
| `docs/architecture-decisions.md` ADR-0002, ADR-0003 | Runtime + Socratic hints |
| `docs/architecture.md` | Invariants to keep true |
| `src/cli/commands.ts` askCommand ~382–416 | Copy-ready prepare+txn pattern |
| `src/core/command-transaction.ts:256-316` | Sole commit API |

---

## Phase 0 — Allowed APIs (do not invent)

### Persistence (sole production commit)

```ts
// src/core/command-transaction.ts:256
export async function executeCommandTransaction<T extends JsonValue>(options: {
  runId: string;
  commandId: string;
  request: JsonValue;
  store?: StoreOptions;
  canaries?: readonly string[];
  prepare: () => Promise<CommandPlan<T>>;
}): Promise<T>;

// CommandPlan: { events: RunEvent[]; result: T; effects?: CommandEffect[] }
```

### Orchestrator (keep these; they must stay I/O-free of durable writes)

| Keep | File |
|---|---|
| `prepareDiscoveryTurn` | `orchestrator.ts:200` |
| `prepareRepairPendingEvidence` | `:326` |
| `prepareFramingGate` | `:423` |
| `prepareClarification` | `:550` |
| `prepareSolutionDesign` | `:614` |
| `prepareChallengeInjection` | `:726` |
| `prepareRespondToChallenge` | `:823` |
| `preparePitch` | `:892` |
| `prepareRetry` | `:982` |
| `prepareReview` | `:1123` |
| `assertFrameAllowed`, `computeDiscoveryMetrics` | helpers |

### Orchestrator (delete after tests migrated)

| Delete | Lines (approx) | Calls `appendEvents` |
|---|---|---|
| `runDiscoveryTurn` | 313–318 | yes |
| `repairPendingEvidence` | 373–378 | yes |
| `runFramingGate` | 490–493 | yes |
| `requestClarification` | 576–581 | yes |
| `submitSolutionDesign` | 641–646 | yes |
| `runChallengeInjection` | 780–785 | yes |
| `respondToChallenge` | 857–862 | yes |
| `submitPitch` | 916–919 | yes |
| `createRetry` | 1069–1076 | yes (parent + child) |

### Hints

| Keep | Delete |
|---|---|
| `simulation/hints.ts` `requestHint(topic, level, ladders, ledger)` | `agents/coach.ts` `requestHint` |
| CLI `hintCommand` → simulation | firewall `coachTask: "hint"` arm |
| | `CoachHintInput/Output` schemas if unused |
| | `decide` hint + `hintPlaceholder` (Task 3) |

### Phase guard (Task 3 target)

```ts
// NEW in state-machine.ts (name may be assertCommandPhase)
export function assertCommandPhase(
  phase: RunPhase | null,
  commandType: RunCommand["type"],
): void; // throws InvalidPhaseCommandError | RunAlreadyExistsError
```

Do **not** put model I/O inside this function. Do **not** emit events from it.

### Aggregate (Task 4 target)

- Move `RunAggregate` + `RunAggregateSchema` from `security/context-firewall.ts:87-161` → `src/core/aggregate.ts`
- Firewall keeps `buildRoleInput` only; imports type from core

### Global constraints

- Node ≥ 22; source imports use `.js` extension; test imports extensionless
- No new transaction adapter; no feature flag dual paths; no RoleAgentFactory
- Do **not** remove: firewall field-by-field construction, dual sanitize, `install-skill`, DirectModelRuntime
- `docs/mvp-acceptance.md` is the v1 acceptance baseline — Task 5 may **reconcile runtime rows with ADR-0002** (doctor gone) but must not weaken security/determinism acceptance claims
- Verify: `npm run typecheck` and `npm test` after every task; commit at end of each task
- Clean rebuild clears stale `dist/integrations/codex/{codex-runtime,capability-probe,strict-policy}*` — no separate task needed beyond `npm run build`

### Anti-patterns (grep-fail if introduced)

- `appendEvents` called from `src/core/orchestrator.ts` after this plan (only transaction + event-store internals)
- Second `requestHint` export from `agents/coach.ts`
- `decide(` used for gated event batches that are discarded
- `featureFlag` / `USE_LEGACY_DECIDE` / dual commit paths
- Invented APIs: `CommandBus`, `PersistenceAdapter`, `HintBackend`

### Test callers that must migrate (Task 1)

| File | Symbols used today |
|---|---|
| `tests/contracts/orchestrator.test.ts` | `runDiscoveryTurn`, `repairPendingEvidence` |
| `tests/e2e/problem-framing.test.ts` | `runFramingGate`, `requestClarification` |
| `tests/e2e/solution-challenge-pitch.test.ts` | `submitSolutionDesign`, `runChallengeInjection`, `respondToChallenge`, `submitPitch` |
| `tests/e2e/retry.test.ts` | `createRetry` |

CLI e2e (`cli-flow`, `all-scenarios`, calibration) already use `*Command` → transaction — **do not break them**.

---

## Task 1: Single persistence path

**Files:**
- Create: `tests/helpers/commit-prepared.ts` (thin test helper)
- Modify: `tests/contracts/orchestrator.test.ts`
- Modify: `tests/e2e/problem-framing.test.ts`
- Modify: `tests/e2e/solution-challenge-pitch.test.ts`
- Modify: `tests/e2e/retry.test.ts`
- Modify: `src/core/orchestrator.ts` (delete run*/submit*/createRetry wrappers + `appendEvents` import if unused)
- Modify: any other import of deleted symbols (grep)

**Copy pattern — CLI production (do not change behavior):** `src/cli/commands.ts:382-416` (`askCommand`).

**Copy pattern — test helper (new):**

```ts
// tests/helpers/commit-prepared.ts
import {
  executeCommandTransaction,
  type CommandEffect,
  type JsonValue,
} from "../../src/core/command-transaction";
import type { RunEvent } from "../../src/core/domain";
import type { StoreOptions } from "../../src/core/event-store";

/** Journal + append a pre-built plan (tests only). prepare* stays pure of durable I/O. */
export async function commitPrepared<T extends JsonValue>(options: {
  runId: string;
  commandId: string;
  request: JsonValue;
  events: RunEvent[];
  result: T;
  store?: StoreOptions;
  canaries?: readonly string[];
  effects?: CommandEffect[];
}): Promise<T> {
  const { events, result, effects, runId, commandId, request, store, canaries } = options;
  return executeCommandTransaction({
    runId,
    commandId,
    request,
    store,
    canaries,
    prepare: async () => ({ events, result, effects }),
  });
}
```

Types come only from `CommandPlan` / `CommandEffect` at `command-transaction.ts:46-65` — do not invent parallel types.

- [ ] **Step 1: Add `tests/helpers/commit-prepared.ts`** using `executeCommandTransaction` only (signature at `command-transaction.ts:256-264`). No second adapter.

- [ ] **Step 2: Migrate `tests/contracts/orchestrator.test.ts`**

Replace every:

```ts
const result = await runDiscoveryTurn(runInput({ store: { baseDir } }));
```

with:

```ts
const input = runInput({ /* no store required on prepare */ });
const prepared = await prepareDiscoveryTurn(input);
const result = prepared;
await commitPrepared({
  runId: input.state.runId,
  commandId: input.commandId,
  request: { type: "ask", question: input.question, stakeholderId: input.stakeholderId },
  events: prepared.acceptedEvents,
  result: { runId: prepared.runId }, // JsonValue-safe snapshot; adjust if test asserts more
  store: { baseDir },
  canaries: [CANARY],
});
```

Same for `repairPendingEvidence` → `prepareRepairPendingEvidence` + `commitPrepared`.  
If a test only cares about in-memory `prepared` fields and never `loadEvents`, it may call `prepare*` alone with **no** commit — only tests that read the store need commit.

- [ ] **Step 3: Migrate e2e problem-framing / solution-challenge-pitch / retry** the same way (`prepare*` + `commitPrepared`). For `createRetry`: use CLI-shaped path — `prepareRetry` then transaction with parent events + `effects: [{ type: "retry.ensure-child", ... }]` as in `src/cli/commands.ts` `retryCommand` (~773–821). **Copy that effect shape**; do not dual-`appendEvents`.

- [ ] **Step 4: Delete the nine wrappers** from `orchestrator.ts` listed in Phase 0. Remove `appendEvents` import from orchestrator if unused. Update file header comment that still describes `runDiscoveryTurn` as the entry point (`orchestrator.ts:56-71`).

- [ ] **Step 5: Grep guards**

```bash
rg -n "runDiscoveryTurn|repairPendingEvidence|runFramingGate|requestClarification|submitSolutionDesign|runChallengeInjection|respondToChallenge\b|submitPitch\b|createRetry" src/ tests/ --type ts
# expect: zero hits (or only prepare* / *Command names)
rg -n "appendEvents" src/core/orchestrator.ts
# expect: zero hits
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck && npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "$(cat <<'EOF'
refactor: single persistence path via executeCommandTransaction

Remove orchestrator run*/submit* appendEvents wrappers. Tests commit
through prepare* + journal helper; CLI path unchanged.
EOF
)"
```

**Verification checklist**
- [ ] No `appendEvents` in `orchestrator.ts`
- [ ] CLI e2e still green
- [ ] Journal files appear under test `baseDir/runs/*/commands/` for migrated store tests

**Anti-patterns**
- Do not add `OrchestratorStore` / second transaction type
- Do not keep wrappers “for convenience” behind comments
- Do not call `appendEvents` directly from tests (use helper → transaction)

---

## Task 2: Delete model-hint dead path (ADR-0003)

**Files:**
- Modify: `src/agents/coach.ts` (remove `requestHint`)
- Modify: `src/security/context-firewall.ts` (remove `hint` from `COACH_TASKS` + switch arm; consider `hintRequest` field)
- Modify: `src/agents/contracts.ts` (remove `CoachHintInput/Output` if unused)
- Modify: `src/replay/projector.ts` emptyAggregate default `coachTask`
- Modify: `src/core/orchestrator.ts` prepareRetry default `coachTask: "hint"` → `"brief-validation"` or `"final-review"`
- Modify tests: `coach-agent`, `context-firewall`, `agent-contracts`, fixtures using `coachTask: "hint"`
- Keep: `src/simulation/hints.ts`, `hintCommand`, unit `hints.test.ts`

**ADR-0003 quote to honor:** runtime generation of hints is not a supported path; L1/L2/L3 are authored ladder text.

- [ ] **Step 1: Grep live production callers of coach `requestHint`**

```bash
rg -n "requestHint" src/ tests/ --type ts
```

Confirm only `simulation/hints` + CLI + coach definition + coach-agent test.

- [ ] **Step 2: Remove `requestHint` from `coach.ts`** and coach doc comment listing it (`coach.ts:34-35`, `140-167`). Keep `validateProblemBrief` and `runFinalReview`. Narrow `CoachPromptInput` to brief + final-review only.

- [ ] **Step 3: Firewall — remove hint task**

In `context-firewall.ts`:
- `COACH_TASKS`: drop `"hint"` → `["brief-validation", "final-review"]`
- Remove `case "hint"` branch (~304–318)
- If `hintRequest` only served hint task: remove field from `RunAggregate` + schema **or** keep nullable unused — prefer **remove** if fold never needs it for resume (granted hints live in `grantedHints` / events)

- [ ] **Step 4: Remove `CoachHintInputSchema` / `CoachHintOutputSchema`** from `contracts.ts` and `agent-contracts.test.ts` cases.

- [ ] **Step 5: Fix defaults**  
  `projector.ts:166`, `orchestrator.ts:1040`, and all test `aggregate()` helpers: `coachTask: "brief-validation"` (or `"final-review"`). Never leave `"hint"`.

- [ ] **Step 6: Delete coach-agent hint test** (`coach-agent.test.ts` ~282); keep brief-validation + final-review coverage.

- [ ] **Step 7: Grep + verify**

```bash
rg -n "CoachHint|coachTask: \"hint\"|requestHint" src/ tests/ --type ts
# simulation/hints + cli hintCommand + unit hints tests only
npm run typecheck && npm test
```

- [ ] **Step 8: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor: remove coach model-hint path; ladder-only hints

Align with ADR-0003. Production hintCommand already used simulation/hints.
EOF
)"
```

**Anti-patterns**
- Do not add configurable hint backend
- Do not keep coach hint behind `if (false)` / flag
- Do not change Socratic ladder content or `simulation/hints` escalation rules

---

## Task 3: Demote `decide()` to phase assert

**Files:**
- Modify: `src/core/state-machine.ts`
- Modify: `src/core/orchestrator.ts` (all decide call sites)
- Modify: `src/cli/commands.ts` (start/frame still need event builders — see below)
- Modify: `tests/unit/state-machine.test.ts` (rewrite expectations)
- Modify: `tests/unit/event-store.test.ts` if it drives journeys via `decide`
- Modify: `docs/architecture.md` (decide wording)

**Target API (copy shape of existing errors):**

```ts
// Prefer evolving state-machine.ts rather than a new file.
import type { RunCommand, RunPhase } from "./domain.js";
import { InvalidPhaseCommandError, RunAlreadyExistsError } from "./errors.js";

/** Phase legality only — no events. Gated batches are authored by prepare*. */
export function assertCommandPhase(
  phase: RunPhase | null,
  commandType: RunCommand["type"],
): void {
  // port the requirePhase / ACTIVE_PHASES / start-null checks from decide()
}
```

Keep a **small event helper** for simple CLI transitions that today correctly use decide returns:

| Command | Today | After |
|---|---|---|
| `start` + `accept` | `decide` events kept (CLI + prepareRetry) | explicit `buildStartEvents` / `buildAcceptEvents` helpers **or** thin `phaseTransitionEvents(...)` |
| `frame` | kept | same |
| `clarify` | kept in prepareClarification | prepare builds `phase.changed` explicitly |
| `ask` | first event from decide | prepareDiscoveryTurn builds `question.asked` explicitly |
| gated submit-* / review / hint | discarded or placeholder | **assert only**; prepare/CLI owns events |

Recommended minimal surface after cleanup:

```ts
export function assertCommandPhase(phase, commandType): void
export function buildRunStartedEvents(...): RunEvent[]  // optional helpers
export function buildPhaseChangedEvent(...): RunEvent
```

Delete: `hintPlaceholder`, unconditional success collapse for submit-brief/design/respond-challenge/submit-pitch, empty review branch as “event source”.

- [ ] **Step 1: Rewrite `tests/unit/state-machine.test.ts` first (TDD)**  
  - Illegal phase → `InvalidPhaseCommandError`  
  - `start` when phase non-null → `RunAlreadyExistsError`  
  - Remove expectations that gated commands return `phase.changed`  
  - If helpers emit start/accept/frame events, test those helpers separately

- [ ] **Step 2: Implement `assertCommandPhase` + any thin event helpers** in `state-machine.ts`. Remove old `decide` **or** make `decide` a deprecated wrapper that only calls assert and returns `[]` — prefer **delete `decide`** and fix call sites in one task to avoid dual API.

- [ ] **Step 3: Orchestrator call sites**

| Site | Change |
|---|---|
| `prepareDiscoveryTurn` ~211 | `assertCommandPhase(DISCOVERY,"ask")`; push explicit `question.asked` |
| `prepareFramingGate` ~432 | `assertCommandPhase(PF,"submit-brief")` only |
| `prepareClarification` ~565 | assert + explicit `phase.changed` events (copy prior decide output shape) |
| `prepareSolutionDesign` ~623 | assert only |
| `prepareRespondToChallenge` ~831 | assert only |
| `preparePitch` ~898 | assert only |
| `prepareReview` ~1131 | assert only |
| `prepareRetry` start/accept ~1003 | use helpers for start/accept events |

- [ ] **Step 4: CLI `startCommand` / `frameCommand`** (`commands.ts:328-366`) — replace `decide(...)` with the same helpers so event bytes stay stable (golden replay).

- [ ] **Step 5: `docs/architecture.md`** — replace “`decide()`/`reduce()` are pure folds” control-plane core wording with: phase legality via `assertCommandPhase`; event authorship via `prepare*`; `reduce` remains minimal phase fold if still used; full resume via `foldRunAggregate`.

- [ ] **Step 6: Grep + verify**

```bash
rg -n "\bdecide\b|hintPlaceholder" src/ tests/ --type ts
# zero production decide (tests only if intentionally kept — prefer zero)
npm run typecheck && npm test
```

- [ ] **Step 7: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor: demote decide to phase assert; prepare* owns events

Gated commands no longer emit unconditional phase.changed from decide.
EOF
)"
```

**Anti-patterns**
- Do not put Customer/Coach invokes inside assert/helpers
- Do not leave `decide` returning events that callers discard
- Do not break golden replay bytes for start/accept/frame journeys without updating fixtures deliberately

---

## Task 4: Move `RunAggregate` to core

**Files:**
- Create: `src/core/aggregate.ts`
- Modify: `src/security/context-firewall.ts` (import type; keep `buildRoleInput`)
- Modify all importers (grep list from Phase 0 discovery)
- Optionally remove unused sensitive placeholders after confirming fold never sets them

- [ ] **Step 1: Create `src/core/aggregate.ts`**  
  Move `RunAggregate`, `RunAggregateSchema`, and any types only needed for the aggregate (`CoachTask` if still present post-Task 2, etc.). Re-export from firewall **temporarily** only if needed for one-commit safety — prefer direct import updates in same task.

- [ ] **Step 2: Update imports** across `src/` and `tests/`:

```bash
rg -n "RunAggregate|RunAggregateSchema|CoachTask" src/ tests/ --type ts
```

- [ ] **Step 3: Remove unused sensitive placeholders** if still present and unset by `foldRunAggregate` (`projector.ts:182-282`):  
  `groundTruth`, `chainOfThought`, `customerPrompt`, `customerSessionId`, `rawCustomerOutput` — confirm with:

```bash
rg -n "groundTruth|chainOfThought|customerPrompt|customerSessionId|rawCustomerOutput" src/ tests/ --type ts
```

Keep `score` / `learnerProfile` / `previousAttemptReview` only if fold or firewall recognition tests require them; `previousAttemptReview` **is** folded from `retry.focus`.

- [ ] **Step 4: Firewall still fail-closed** on unrecognized aggregate fields — adjust `RunAggregateSchema` strictness tests in `tests/contracts/context-firewall.test.ts`.

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm test
git commit -m "$(cat <<'EOF'
refactor: move RunAggregate to src/core/aggregate.ts

Firewall consumes the domain aggregate; it no longer owns it.
EOF
)"
```

**Anti-patterns**
- Do not invent `AggregateRepository`
- Do not keep “future” unknown slots “just in case”

---

## Task 5: Docs + surface alignment

**Files:**
- Modify: `README.md` (add `repair-evidence`; ensure no `doctor`)
- Modify: `docs/architecture.md` — if Task 3 left gaps; also document that durable commits go through `executeCommandTransaction` (journal + hash chain), not bare `appendEvents` (architecture.md today is decide/event-store centric and omits the journal)
- Modify: `docs/mvp-acceptance.md` — **reconcile** doctor/CodexAgentRuntime rows with ADR-0002 (direct-only, `release:gate`). Do not drop security/determinism claims.
- Modify: `skills/fde-gym/**` if doctor still mentioned
- Annotate obsolete: top of `docs/superpowers/specs/2026-08-29-codex-strict-mode-security-design.md` with `> OBSOLETE — superseded by ADR-0002`
- Annotate `PATHFINDER-2026-08-29/03-unified-proposal.md` proposal A obsolete

- [ ] **Step 1: Grep docs/skills for stale runtime**

```bash
rg -n "doctor|CodexAgentRuntime|FDE_GYM_CODEX_HOME|capability-probe|strict-policy" README.md docs/ skills/ --glob '!**/.*/**'
```

- [ ] **Step 2: Apply doc edits** (no runtime code changes).

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: align acceptance and README with direct-only runtime

Mark pre-ADR-0002 Codex strict-mode specs obsolete.
EOF
)"
```

**Anti-patterns**
- Do not reintroduce doctor to release gate
- Do not claim model prose is deterministic

---

## Task 6: Final verification

- [ ] **Step 1: Anti-pattern greps**

```bash
rg -n "appendEvents" src/core/orchestrator.ts          # empty
rg -n "runDiscoveryTurn|createRetry|runFramingGate" src/ tests/  # empty
rg -n "requestHint" src/agents/coach.ts                # empty
rg -n "coachTask: \"hint\"|CoachHint" src/ tests/      # empty
rg -n "\bdecide\b|hintPlaceholder" src/                # empty (or only historical comments)
rg -n "from \"../security/context-firewall.js\".*RunAggregate|RunAggregate.*context-firewall" src/  # empty
rg -n "FeatureFlag|USE_LEGACY|CommandBus" src/         # empty
```

- [ ] **Step 2: Full gate**

```bash
npm run release:gate
```

- [ ] **Step 3: Spot-check invariants**
  - CLI mutating commands still enter `executeCommandTransaction` (`commands.ts`)
  - Hints only from `simulation/hints.ts`
  - Golden replay test still passes
  - Adversarial firewall/leak tests still pass

- [ ] **Step 4: Optional cleanup commit** if `dist/` stale Codex artifacts remain after build — they should vanish on clean `tsc` output only from current `src/`.

---

## Execution order summary

| Task | Risk | Depends on |
|---|---|---|
| 1 Single persistence | Medium (many tests) | — |
| 2 Delete model-hint | Low | — (parallelizable with 1 after rebase) |
| 3 decide → assert | Medium-High (state-machine + golden) | 2 helpful (hint branch gone) |
| 4 RunAggregate home | Low | 2 (coachTask enum stable) |
| 5 Docs | Low | 1–4 ideally done so docs match |
| 6 Verify | — | all |

**Recommended serial order:** 1 → 2 → 3 → 4 → 5 → 6.

**Out of scope (explicit non-goals):** CLI `withMutatingCommand` boilerplate DRY; splitting `domain.ts`; deleting score legacy fallbacks; RoleAgentFactory; upgrading decide to full aggregate event-sourcing (proposal 1b).

---

## Confidence & gaps

| Area | Confidence | Gap |
|---|---|---|
| Wrapper list + test files | High | Line numbers drift; re-grep at start of Task 1 |
| createRetry → effect path | Medium-High | Must copy CLI `retryCommand` effect shape exactly |
| Removing `hintRequest` field | Medium | Confirm no event fold depends on it |
| Golden replay after decide removal | Medium | May need fixture refresh if start/frame event ids change |
| mvp-acceptance edit vs freeze | Medium | Reconcile doctor rows only; keep security claims |

If any gap blocks a task, re-read the cited source file at the listed symbol rather than inventing APIs.
