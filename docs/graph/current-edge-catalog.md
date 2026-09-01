# Current Edge Catalog (G0-04)

An **Edge** is an `Action + Guard` that permits a Node → Node jump, with a Phase
effect and an ordered Event Protocol. This catalog enumerates every real
transition in the current TypeScript code (`src/core/*`, `src/application/*`,
`src/cli/*`, `src/replay/*`) plus its failure edges, and audits command
classification across the three surfaces (domain schema, state-machine legality,
CLI exposure).

Audited revision: `d7b84b7` (main). All file references are absolute-relative to
repo root `/Users/lingjiefan/underway/FDEGym`.

---

## 1. Node vocabulary used

Candidate names from the Wave-0 plan, plus additions marked **(added)**. Canonical
IDs must be reconciled against the parallel Node/Phase catalogues (see
Integration notes).

| Candidate node | Real code location (file:function) |
|---|---|
| `run.start` **(added)** | `src/core/state-machine.ts:buildRunStartedEvents` |
| `discovery.accept` **(added)** | folded into `start` (`src/application/use-cases/discovery.ts:startRun`) and `retry` (`src/core/orchestrator.ts:prepareRetry`) |
| `frame.accept` **(added)** | `src/application/use-cases/discovery.ts:frame` |
| `discovery.question.accept` | `src/core/orchestrator.ts:prepareDiscoveryTurn` (the `ask` command) |
| `customer.invoke` | `src/agents/customer.ts:answerDiscoveryQuestion` |
| `customer.project` | `src/core/orchestrator.ts:foldReply` + runtime sanitizer (`src/security/sanitizer.ts`) |
| `evidence.invoke` | `src/agents/evidence-tracker.ts:extractEvidence` |
| `evidence.patch.guard` | `src/evidence/graph.ts:applyEvidencePatch` (throws on domain-invalid patch) |
| `evidence.patch.apply` | `src/evidence/graph.ts:applyEvidencePatch` |
| `evidence.repair` **(added)** | `src/core/orchestrator.ts:prepareRepairPendingEvidence` |
| `hint.grant` **(added)** | `src/application/use-cases/discovery.ts:requestHint` + `src/simulation/hints.ts:requestHint` |
| `brief.structure.guard` | `src/evidence/brief-validator.ts:validateBriefStructure` |
| `coach.brief.invoke` | `src/agents/coach.ts:validateProblemBrief` |
| `brief.support.guard` | `src/evidence/brief-validator.ts:calculateSupportRatio` (>= `SUPPORT_RATIO_THRESHOLD` 0.75) |
| `clarify.budget.guard` **(added)** | `src/core/orchestrator.ts:prepareClarification` |
| `solution.accept` | `src/core/orchestrator.ts:prepareSolutionDesign` (`submit-design`) |
| `challenge.select` | `src/simulation/event-scheduler.ts:selectScenarioEvents` |
| `challenge.inject` | `src/core/orchestrator.ts:prepareChallengeInjection` |
| `challenge.response.guard` | `src/core/orchestrator.ts:prepareRespondToChallenge` |
| `challenge.all-answered.guard` | `src/core/orchestrator.ts:prepareRespondToChallenge` (`mandatoryChallengeIds.every`) |
| `pitch.structure.guard` | `src/core/orchestrator.ts:preparePitch` (`PitchArtifactSchema.parse`) |
| `coach.review.invoke` | `src/agents/coach.ts:runFinalReview` / `sampleFinalReview` |
| `score.compute` | `src/scoring/formulas.ts:calculateScore` |
| `profile.apply` | `src/core/command-transaction.ts` effect `profile.apply-attempt` |
| `retry.spawn` **(added)** | `src/core/orchestrator.ts:prepareRetry` + effect `retry.ensure-child` |

---

## 2. Edge catalog

Legend: `→` = a real jump with an authored `phase.changed`; `⭯` = self-loop
(no phase change). "Command id" in the Event Protocol is the id of the event's
`commandId` field; `<cid>` = the learner-supplied command id, and
`<cid>:suffix` a derived internal id.

### 2.1 `null → DISCOVERY` via `start` (with `accept` folded in)

| Field | Value |
|---|---|
| From → To | (unstarted) `run.start` → `discovery.accept` → DISCOVERY |
| Action | `start` (DomainCommand) + implicit `accept` |
| Guard | No `assertCommandPhase` in `startRun`; the journal `requestHash` + store boundary reject a persisted re-`start` with `RUN_ALREADY_EXISTS` (`src/core/state-machine.ts:33-37`, `src/core/event-store.ts` append). |
| Phase effect | phase = DISCOVERY (SCENARIO is never a stopping point) |
| Event Protocol | 1. `run.started` (scenarioId, locale, optional digest) 2. `phase.changed` SCENARIO→SCENARIO (anchor, `<cid>`) 3. `phase.changed` SCENARIO→DISCOVERY (`<cid>:accept`) |
| Failure edges | `RUN_ALREADY_EXISTS` (re-start); `INVALID_RESOURCE_ID` (unsafe run/command id); `SCENARIO_NOT_FOUND` (resolveScenario); `SCENARIO_BUNDLE_MISMATCH`; `RUN_VERSION_CONFLICT`; `COMMAND_ID_CONFLICT`. Run stays unstarted. |

### 2.2 `DISCOVERY → PROBLEM_FRAMING` via `frame`

| Field | Value |
|---|---|
| From → To | DISCOVERY `frame.accept` → PROBLEM_FRAMING |
| Action | `frame` (DomainCommand) |
| Guard | `assertFrameAllowed` (`src/core/orchestrator.ts:170`) — throws `FRAME_BLOCKED` if `pendingEvidence` set; then `assertCommandPhase(DISCOVERY, "frame")` (`src/core/state-machine.ts:45`). |
| Phase effect | PROBLEM_FRAMING |
| Event Protocol | 1. `phase.changed` DISCOVERY→PROBLEM_FRAMING |
| Failure edges | `FRAME_BLOCKED` — run **stays** DISCOVERY (evidence pending); `INVALID_PHASE_COMMAND`. Nothing persisted. |

### 2.3 `DISCOVERY ⭯ DISCOVERY` via `ask` (discovery turn)

| Field | Value |
|---|---|
| From → To | DISCOVERY `discovery.question.accept` ⭯ DISCOVERY |
| Action | `ask` (DomainCommand) |
| Guard | `assertCommandPhase(DISCOVERY, "ask")` (`src/core/state-machine.ts:42`); Customer/Evidence outputs sanitized by runtime leak guard (`src/security/sanitizer.ts`, `src/integrations/direct/direct-runtime.ts:186`); evidence patch validated by `applyEvidencePatch` (`src/evidence/graph.ts`). |
| Phase effect | stays DISCOVERY |
| Event Protocol (success) | 1. `question.asked` (`<cid>`) 2. `customer.replied` (`<cid>`) 3. `evidence.patched` (`<cid>:evidence`) 4. `question.assessed` (`<cid>:evidence`) |
| Event Protocol (evidence failure) | 1. `question.asked` 2. `customer.replied` 3. `evidence.pending` (`<cid>:evidence-pending`, failureCode = `EVIDENCE_EXTRACTION_FAILED`) |
| Failure edges | **Customer model failure** (leak guard / `AGENT_OUTPUT_INVALID` / `MODEL_ENDPOINT_REQUIRED` / runtime failure): `prepareDiscoveryTurn` throws before any event is authored → whole `ask` aborts, **nothing persisted** (learner question lost). **Evidence Tracker failure**: caught (`orchestrator.ts:310-339`), reply retained, `evidence.pending` persisted, run **stays** DISCOVERY and `frame` becomes blocked (`FRAME_BLOCKED`). Also `INVALID_PHASE_COMMAND`. |

### 2.4 `DISCOVERY ⭯ DISCOVERY` via `repair-evidence` (pending repair)

| Field | Value |
|---|---|
| From → To | DISCOVERY `evidence.repair` ⭯ DISCOVERY |
| Action | `repair-evidence` (**InternalAction** — see §3) |
| Guard | Pending-marker presence (`src/application/use-cases/discovery.ts:223`) → throws `{ code: "NOTHING_TO_REPAIR" }` if none. **No phase assert.** |
| Phase effect | stays DISCOVERY |
| Event Protocol | 1. `evidence.patched` (`<askCid>:evidence`) 2. `question.assessed` (`<askCid>:evidence`) 3. `evidence.resolved` (`<askCid>:evidence`) |
| Failure edges | `NOTHING_TO_REPAIR` (no pending marker); extraction re-failure → re-throws `EVIDENCE_EXTRACTION_FAILED`/leak-guard, turn **stays** pending, `frame` stays blocked. |

### 2.5 `DISCOVERY|PROBLEM_FRAMING ⭯` via `hint`

| Field | Value |
|---|---|
| From → To | DISCOVERY / PROBLEM_FRAMING `hint.grant` ⭯ same phase |
| Action | `hint` (DomainCommand) |
| Guard | Phase legality checked **inline** in `requestHint` (`src/application/use-cases/discovery.ts:281-283`), NOT via `assertCommandPhase`; level validated at CLI (`src/cli/hint-level.ts`). |
| Phase effect | stays in phase |
| Event Protocol | 1. `hint.granted` (topic, level, hint) |
| Failure edges | `INVALID_PHASE_COMMAND` (inline throw); `HINT_INVALID_LEVEL` (CLI). |

### 2.6 `PROBLEM_FRAMING → SOLUTION_DESIGN` via `submit-brief` (gate passes)

| Field | Value |
|---|---|
| From → To | PROBLEM_FRAMING `brief.structure.guard` → `coach.brief.invoke` → `brief.support.guard` → SOLUTION_DESIGN |
| Action | `submit-brief` (DomainCommand) |
| Guard | (a) `assertCommandPhase(PROBLEM_FRAMING)`; (b) `ProblemBriefSchema.parse`; (c) `validateBriefStructure` (`src/evidence/brief-validator.ts:105`); (d) `validateProblemBrief` (`src/agents/coach.ts:155`) skipped on dangling-evidence-reference; (e) `calculateSupportRatio` >= `SUPPORT_RATIO_THRESHOLD` (0.75). |
| Phase effect | SOLUTION_DESIGN (only if passed) |
| Event Protocol (pass) | 1. `brief.submitted` 2. `brief.validated` (passed=true) 3. `phase.changed` PROBLEM_FRAMING→SOLUTION_DESIGN |
| Event Protocol (fail) | 1. `brief.submitted` 2. `brief.validated` (passed=false) — **no** `phase.changed` |
| Failure edges | Gate fail → run **stays** PROBLEM_FRAMING (events still persisted); Zod-invalid brief → `INVALID_ARTIFACT`, **nothing persisted**; `INVALID_PHASE_COMMAND`. |

### 2.7 `PROBLEM_FRAMING → DISCOVERY` via `clarify`

| Field | Value |
|---|---|
| From → To | PROBLEM_FRAMING `clarify.budget.guard` → DISCOVERY |
| Action | `clarify` (DomainCommand) |
| Guard | `assertCommandPhase(PROBLEM_FRAMING, "clarify")` + clarification budget (`src/core/orchestrator.ts:594-604`, default 3). |
| Phase effect | DISCOVERY |
| Event Protocol | 1. `phase.changed` PROBLEM_FRAMING→DISCOVERY |
| Failure edges | `CLARIFICATION_BUDGET_EXCEEDED` — run **stays** PROBLEM_FRAMING, nothing persisted; `INVALID_PHASE_COMMAND`. |

### 2.8 `SOLUTION_DESIGN → CHALLENGE` via `submit-design` (+ challenge wave)

| Field | Value |
|---|---|
| From → To | SOLUTION_DESIGN `solution.accept` → CHALLENGE, then `challenge.select` → `challenge.inject` ⭯ CHALLENGE |
| Action | `submit-design` (DomainCommand) + internal `challenge-inject` |
| Guard | `assertCommandPhase(SOLUTION_DESIGN)`; `SolutionProposalSchema.parse`; challenge injection guards `phase === CHALLENGE` inline (`src/core/orchestrator.ts:760`). |
| Phase effect | CHALLENGE |
| Event Protocol | 1. `design.submitted` 2. `phase.changed` SOLUTION_DESIGN→CHALLENGE 3. for each selected candidate: `challenge.injected` (`<cid>:inject`) then `customer.replied` (`<cid>:inject`, reply = scenario prompt) |
| Failure edges | `INVALID_ARTIFACT` (Zod) → **nothing persisted**; `INVALID_PHASE_COMMAND`; injection is deterministic (seeded rng, no model) so it has no independent failure edge. |

### 2.9 `CHALLENGE → PITCH` via `respond-challenge` (all answered)

| Field | Value |
|---|---|
| From → To | CHALLENGE `challenge.response.guard` → `challenge.all-answered.guard` → PITCH |
| Action | `respond-challenge` (DomainCommand) |
| Guard | `assertCommandPhase(CHALLENGE)`; `ChallengeResponseSchema.parse`; `mandatoryChallengeIds.every(answered)` (`src/core/orchestrator.ts:855-857`). |
| Phase effect | PITCH (only when all mandatory ids answered) |
| Event Protocol (all answered) | 1. `challenge.responded` 2. `phase.changed` CHALLENGE→PITCH |
| Event Protocol (partial) | 1. `challenge.responded` only — **no** `phase.changed` |
| Failure edges | Partial → run **stays** CHALLENGE (response still recorded); `INVALID_ARTIFACT` (invalid response) → nothing persisted; `INVALID_PHASE_COMMAND`. |

### 2.10 `PITCH → REVIEW` via `submit-pitch`

| Field | Value |
|---|---|
| From → To | PITCH `pitch.structure.guard` → REVIEW |
| Action | `submit-pitch` (DomainCommand) |
| Guard | `assertCommandPhase(PITCH)`; `PitchArtifactSchema.parse`. |
| Phase effect | REVIEW |
| Event Protocol | 1. `pitch.submitted` 2. `phase.changed` PITCH→REVIEW |
| Failure edges | `INVALID_ARTIFACT` → nothing persisted; `INVALID_PHASE_COMMAND`. |

### 2.11 `REVIEW ⭯ REVIEW` via `review` (final review + score + profile fold)

| Field | Value |
|---|---|
| From → To | REVIEW `coach.review.invoke` → `score.compute` → `profile.apply` ⭯ REVIEW |
| Action | `review` (DomainCommand) |
| Guard | `assertCommandPhase(REVIEW)`; `samples` integer >= 1 (`src/core/orchestrator.ts:1127-1129`); Coach output sanitized (leak guard). |
| Phase effect | **stays REVIEW** (no `phase.changed` authored) |
| Event Protocol | 1. `review.completed` 2. `score.computed` (+ transaction effect `profile.apply-attempt`) |
| Failure edges | Coach/runtime failure → `LEAK_GUARD_TRIGGERED` / `AGENT_OUTPUT_INVALID` / `MODEL_ENDPOINT_REQUIRED` / `INTERNAL_ERROR`; `INVALID_PHASE_COMMAND`. Nothing persisted on failure. |

### 2.12 `REVIEW → child DISCOVERY` via `retry`

| Field | Value |
|---|---|
| From → To | REVIEW `retry.spawn` → new run DISCOVERY (parent **stays** REVIEW) |
| Action | `retry` (DomainCommand) |
| Guard | `prepareRetry`: `parentRun.phase === REVIEW` else `InvalidPhaseCommandError` (`src/core/orchestrator.ts:987-989`); focus summaries length 2..3 else `INVALID_RETRY_FOCUS` (`:990-995`). |
| Phase effect | parent unchanged (REVIEW); child fresh DISCOVERY |
| Event Protocol (parent) | 1. `retry.started` (newRunId) |
| Event Protocol (child, via effect `retry.ensure-child`) | 1. `run.started` 2. `phase.changed` SCENARIO→SCENARIO 3. `retry.focus` 4. `phase.changed` SCENARIO→DISCOVERY (`<cid>:accept`) |
| Failure edges | `INVALID_PHASE_COMMAND` (not in REVIEW); `INVALID_RETRY_FOCUS`; `RUN_VERSION_CONFLICT`; `COMMAND_ID_CONFLICT`. |

### 2.13 Declared-but-unwired terminal edges (ghosts — no prepare, no CLI)

These exist in `RunCommandSchema` + `assertCommandPhase` but have **no** use-case,
**no** CLI command, **no** prepare function, and **no** event authoring:

| From → To | Action | Legality (`state-machine.ts`) | Event that would be needed | Status |
|---|---|---|---|---|
| REVIEW → COMPLETED | `complete` | `:78` (REVIEW) | `run.completed` | **ghost** — `run.completed` never authored |
| any ACTIVE → ABORTED | `abort` | `:81` (active phases) | `run.aborted` | **ghost** — `run.aborted` never authored |
| RETRY_READY → ? | `start-retry` | `:75` (RETRY_READY) | (retry child boot) | **ghost** — `RETRY_READY` is never produced by any `phase.changed` |

Consequently the phases `RETRY_READY`, `COMPLETED`, `ABORTED` are declared in
`RUN_PHASES` (`src/core/domain.ts:60-71`) but are **unreachable** in the current
event-authoring code.

---

## 3. Command classification & asymmetry audit

Classification across the three surfaces:

- **schema** = present in `RunCommandSchema` (`src/core/domain.ts:590-606`)
- **legality** = handled in `assertCommandPhase` (`src/core/state-machine.ts:28-92`)
- **CLI** = listed in `COMMAND_NAMES` + dispatched in `src/cli/main.ts`
- **use-case/prepare** = has a handler in `src/application/use-cases/*` and a `prepare*` in `src/core/orchestrator.ts` (or inline)

| Command | schema | legality | CLI | use-case/prepare | Class |
|---|---|---|---|---|---|
| `start` | ✓ | ✓ | ✓ | ✓ (inline `startRun` + `buildRunStartedEvents`) | DomainCommand |
| `accept` | ✓ (`:484`) | ✓ (`:39`) | ✗ | ✗ (folded into `start`/`retry` as `<cid>:accept`) | DomainCommand — **ghost exposure** |
| `ask` | ✓ | ✓ | ✓ | ✓ `prepareDiscoveryTurn` | DomainCommand |
| `frame` | ✓ | ✓ | ✓ | ✓ (inline + `assertFrameAllowed`) | DomainCommand |
| `hint` | ✓ | ✓ | ✓ | ✓ (inline `requestHint`, phase check duplicated) | DomainCommand |
| `submit-brief` | ✓ | ✓ | ✓ | ✓ `prepareFramingGate` | DomainCommand |
| `clarify` | ✓ | ✓ | ✓ | ✓ `prepareClarification` | DomainCommand |
| `submit-design` | ✓ | ✓ | ✓ | ✓ `prepareSolutionDesign` + `prepareChallengeInjection` | DomainCommand |
| `respond-challenge` | ✓ | ✓ | ✓ | ✓ `prepareRespondToChallenge` | DomainCommand |
| `submit-pitch` | ✓ | ✓ | ✓ | ✓ `preparePitch` | DomainCommand |
| `review` | ✓ | ✓ | ✓ | ✓ `prepareReview` | DomainCommand |
| `retry` | ✓ | ✓ | ✓ | ✓ `prepareRetry` + effect `retry.ensure-child` | DomainCommand |
| `start-retry` | ✓ (`:568`) | ✓ (`:75`) | ✗ | ✗ | **ghost** (dead — `RETRY_READY` unreachable) |
| `complete` | ✓ (`:575`) | ✓ (`:78`) | ✗ | ✗ | **ghost** (`run.completed` never authored) |
| `abort` | ✓ (`:582`) | ✓ (`:81`) | ✗ | ✗ | **ghost** (`run.aborted` never authored) |
| `repair-evidence` | ✗ | ✗ | ✓ (`main.ts:56,258`) | ✓ `prepareRepairPendingEvidence` | **InternalAction** (handled, missing from schema/legality) |
| challenge injection | ✗ (no type) | ✗ (inline phase check `orchestrator.ts:760`) | ✗ (folded into `submit-design`) | ✓ `prepareChallengeInjection` | InternalAction |
| `profile.apply-attempt` | ✗ | ✗ | ✗ | ✓ (transaction effect) | InternalAction (effect) |
| `retry.ensure-child` | ✗ | ✗ | ✗ | ✓ (transaction effect) | InternalAction (effect) |
| `list`, `status`, `replay`, `profile`, `install-skill` | ✗ | ✗ | ✓ | read-only, no transaction | CLI-only read commands |

### 3.1 Asymmetries found (with file:line evidence)

1. **`accept` is schema+legality but has no CLI or standalone handler.** It is
   silently folded into `start` (`src/application/use-cases/discovery.ts:143-145`)
   and into the retry child (`src/core/orchestrator.ts:1013-1014`), each emitting
   `phase.changed` SCENARIO→DISCOVERY with a derived `commandId` of
   `"<cid>:accept"`. The learner can never issue `accept`; SCENARIO is never an
   observable stopping phase.

2. **`repair-evidence` is wired end-to-end but is not a DomainCommand.** It has a
   CLI command (`src/cli/main.ts:56,258-264`), a use-case
   (`src/application/use-cases/discovery.ts:218-262`), and a prepare
   (`src/core/orchestrator.ts:355-408`), yet is absent from `RunCommandSchema`
   (`src/core/domain.ts:590-606`) and `assertCommandPhase`
   (`src/core/state-machine.ts`). Its journal request is the raw literal
   `{ type: "repair-evidence" }` (`discovery.ts:234`) — never schema-validated.
   Its phase legality is enforced only by a pending-marker presence check
   (`discovery.ts:223`, throws `{ code: "NOTHING_TO_REPAIR" }`), not a phase assert.

3. **`complete`, `abort`, `start-retry` are ghost commands.** All three are in the
   schema (`src/core/domain.ts:568-588`) and the legality table
   (`src/core/state-machine.ts:75-86`), but have no use-case, no CLI entry, no
   prepare function, and no event authoring. Their target phases
   `COMPLETED`/`ABORTED`/`RETRY_READY` and the `run.completed`/`run.aborted`
   events are declared but never produced anywhere in `src/`.

4. **`RETRY_READY` is unreachable, making `start-retry` dead.** `retry` requires
   REVIEW (`src/core/orchestrator.ts:987`), while `start-retry` requires
   RETRY_READY (`src/core/state-machine.ts:76`), but no `phase.changed` ever emits
   `to: "RETRY_READY"`. The actual retry flow (`retry`) spawns the child run
   directly in DISCOVERY without moving the parent.

5. **`review` never advances phase.** `prepareReview` emits `review.completed` +
   `score.computed` but no `phase.changed` (`src/core/orchestrator.ts:1216-1223`),
   so a reviewed run stays in REVIEW. The intended REVIEW→COMPLETED transition
   (`complete`) is unwired (see #3).

6. **`hint` phase legality is duplicated.** `assertCommandPhase` has a `hint` case
   (`src/core/state-machine.ts:48-53`), but `requestHint` re-implements the same
   DISCOVERY/PROBLEM_FRAMING check inline (`src/application/use-cases/discovery.ts:281-283`)
   and re-folds the aggregate instead of calling `assertCommandPhase`. Divergence
   risk if the table ever changes.

7. **`RunCommandSchema` is never parsed at the boundary.** `executeCommandTransaction`
   accepts `request: JsonValue` and only hashes it for the journal
   (`src/core/command-transaction.ts:287-307`); no `.parse(RunCommandSchema)` exists
   anywhere. The command union is therefore a type-level contract enforced only by
   the `assertCommandPhase` switch — and that switch is bypassed entirely for
   `start`, `accept`, `hint`, and `repair-evidence`.

8. **`hint` request carries `level: null`.** `requestHint` passes
   `request: { type: "hint", topic, level: args.level ?? null }`
   (`src/application/use-cases/discovery.ts:273`), but `HintCommandSchema` requires
   a 1|2|3 level (`src/core/domain.ts:506-513`). Latent only because requests are
   never schema-validated (see #7); the request hash would diverge from a
   schema-valid `hint` command.

9. **Asymmetric failure persistence in the discovery turn.** A Customer-model
   failure in `ask` throws before any event is authored
   (`src/core/orchestrator.ts:249-257`), so the learner's `question.asked` is lost
   and nothing is journaled. An Evidence-Tracker failure is caught
   (`src/core/orchestrator.ts:310-339`), retaining `question.asked` +
   `customer.replied` and persisting `evidence.pending`. Two adjacent role calls
   in the same edge have opposite durability semantics.

10. **Challenge injection is an internal fold, not a command.** It runs inside
    `submit-design` (`src/application/use-cases/framing-review.ts:184-191`) with a
    derived command id `<cid>:inject`; there is no learner-visible challenge
    command beyond `respond-challenge`.

---

## 4. Integration notes

- **Node ID reconciliation needed.** This catalogue maps candidate names to
  `file:function` (§1). The parallel Node catalogue must reconcile: (a) whether
  `accept` and `start` are one edge (`run.start` → `discovery.accept`) or two; (b)
  whether the challenge wave (`challenge.select` → `challenge.inject`) is a
  separate edge or a sub-sequence of `solution.accept`; (c) whether `profile.apply`
  / `retry.ensure-child` (transaction effects, not events) are graph edges or
  terminal side-effects.
- **Ghost commands need a disposition.** `complete`/`abort`/`start-retry` and the
  `repair-evidence` InternalAction are the highest-value targets for either wiring
  (implement handlers) or spec freeze (document as reserved). Do not treat the
  schema/legality presence as evidence they work today.
- **`RETRY_READY` semantics unresolved.** The phase exists but no transition
  produces it; decide whether `retry` should move the parent to RETRY_READY before
  spawning (making `start-retry` reachable) or whether `RETRY_READY`/`start-retry`
  should be removed from the frozen vocabulary.
- **Terminal phases (`COMPLETED`, `ABORTED`) unreachable.** A run can never reach a
  terminal state in the current code; `list`/`status` will show REVIEW indefinitely
  after review.
