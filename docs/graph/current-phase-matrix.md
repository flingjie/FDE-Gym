# Current Phase Matrix (G0-02)

Ground-truth mapping of the phase/action migration surface, extracted directly from
the code at commit `d7b84b78340800194c26c83e4ec860715d703074`. Every value below is
verified against source; nothing here is speculative. The machine-readable twin of
this document is `docs/graph/current-phase-matrix.json` (same commit).

Sources read:

- `src/core/domain.ts` — `RunPhase`, `RunCommand`, `RunEvent` unions.
- `src/core/state-machine.ts` — `assertCommandPhase` (the authoritative phase→command
  legality table) plus `buildRunStartedEvents` / `buildPhaseChangedEvent`.
- `src/core/orchestrator.ts` — the `prepare*` event-authorship functions.
- `src/application/use-cases/{discovery,framing-review,retry}.ts` — command use cases.
- `src/cli/{main,commands}.ts` — the learner-facing CLI command surface.
- `src/replay/projector.ts` — `foldRunAggregate` (phase reconstruction).

---

## 1. Phases

`RUN_PHASES` (order as declared in `domain.ts:60-71`):

`SCENARIO → DISCOVERY → PROBLEM_FRAMING → SOLUTION_DESIGN → CHALLENGE → PITCH → REVIEW → RETRY_READY → COMPLETED → ABORTED`

The `reduce`/`foldRunAggregate` phase fold is driven **only** by `phase.changed`
events (`phase = event.to`). A phase is therefore only reachable if some `prepare*`
authors a `phase.changed` into it.

---

## 2. Command matrix

Classification legend:

- **DomainCommand** — a learner-exposed CLI command (has a `main.ts` route +
  `commands.ts` handler + a use case).
- **InternalAction** — an internal trigger or a declared-but-unwired command; no
  learner CLI route.

`phaseEffect: null` means the command authors **no** `phase.changed` (phase unchanged).
A `from: null` in a phase effect means the unstarted state (phase === `null`).

| # | Command type | CLI name | Classification | Allowed "from" phase(s) | Phase effect | Events authored (ordered) |
|---|---|---|---|---|---|---|
| 1 | `start` | `start` | DomainCommand | *(unstarted only — phase must be `null`)* | `null → DISCOVERY` | `run.started`, `phase.changed` (SCENARIO→SCENARIO anchor), `phase.changed` (SCENARIO→DISCOVERY auto-accept) |
| 2 | `accept` | — | InternalAction | `SCENARIO` | `SCENARIO → DISCOVERY` | `phase.changed` |
| 3 | `ask` | `ask` | DomainCommand | `DISCOVERY` | *(none — stays DISCOVERY)* | `question.asked`, `customer.replied`, `evidence.patched`, `question.assessed` |
| 4 | `frame` | `frame` | DomainCommand | `DISCOVERY` | `DISCOVERY → PROBLEM_FRAMING` | `phase.changed` |
| 5 | `hint` | `hint` | DomainCommand | `DISCOVERY`, `PROBLEM_FRAMING` | *(none)* | `hint.granted` |
| 6 | `submit-brief` | `submit-brief` | DomainCommand | `PROBLEM_FRAMING` | `PROBLEM_FRAMING → SOLUTION_DESIGN` (pass) | `brief.submitted`, `brief.validated` (+ `phase.changed` on pass) |
| 7 | `clarify` | `clarify` | DomainCommand | `PROBLEM_FRAMING` | `PROBLEM_FRAMING → DISCOVERY` | `phase.changed` |
| 8 | `submit-design` | `submit-design` | DomainCommand | `SOLUTION_DESIGN` | `SOLUTION_DESIGN → CHALLENGE` | `design.submitted`, `phase.changed` (+ injected `challenge.injected`, `customer.replied` per candidate) |
| 9 | `respond-challenge` | `respond-challenge` | DomainCommand | `CHALLENGE` | `CHALLENGE → PITCH` (all mandatory addressed) | `challenge.responded` (+ `phase.changed` when complete) |
| 10 | `submit-pitch` | `submit-pitch` | DomainCommand | `PITCH` | `PITCH → REVIEW` | `pitch.submitted`, `phase.changed` |
| 11 | `review` | `review` | DomainCommand | `REVIEW` | *(none — stays REVIEW)* | `review.completed`, `score.computed` (+ profile effect) |
| 12 | `retry` | `retry` | DomainCommand | `REVIEW` | *(parent stays REVIEW; child spawns at DISCOVERY)* | `retry.started` on parent (+ `retry.ensure-child` effect: `run.started`, `retry.focus`, `phase.changed` SCENARIO→SCENARIO, `phase.changed` SCENARIO→DISCOVERY) |
| 13 | `start-retry` | — | InternalAction | `RETRY_READY` | *(unwired)* | *(none)* |
| 14 | `complete` | — | InternalAction | `REVIEW` | *(unwired)* | *(none)* |
| 15 | `abort` | — | InternalAction | all `ACTIVE_PHASES` | *(unwired)* | *(none)* |

### Special cases (from `assertCommandPhase`)

- `start` — only legal when `phase === null`; a re-`start` throws
  `RunAlreadyExistsError` (the pure assert throws with an empty runId; the store
  boundary throws the real `RunAlreadyExistsError(runId)` on a persisted re-start).
- `hint` — legal in `DISCOVERY` **and** `PROBLEM_FRAMING` (explicit two-phase check).
- `abort` — legal in `ACTIVE_PHASES` = `{SCENARIO, DISCOVERY, PROBLEM_FRAMING,
  SOLUTION_DESIGN, CHALLENGE, PITCH, REVIEW, RETRY_READY}`. Terminal phases
  (`COMPLETED`, `ABORTED`) and the unstarted `null` state are excluded.
- `frame` — additionally gated by `assertFrameAllowed` in the use case: throws
  `FRAME_BLOCKED` while a turn is `EVIDENCE_PENDING`.
- `submit-brief` / `respond-challenge` — conditional phase effects (see §3).

---

## 3. Phase effects that are conditional or multi-step

- **`submit-brief`** (`prepareFramingGate`, orchestrator.ts): always emits
  `brief.submitted` + `brief.validated`. On gate pass (`supportRatio >= 0.75 && structure.passed`)
  it appends `phase.changed` `PROBLEM_FRAMING → SOLUTION_DESIGN`; on fail it **stays**
  in `PROBLEM_FRAMING` with no `phase.changed` (the rejection is the `brief.validated`
  with `passed:false`).
- **`respond-challenge`** (`prepareRespondToChallenge`): always emits
  `challenge.responded`. Only when **every** mandatory injected challenge id has a
  recorded response does it append `phase.changed` `CHALLENGE → PITCH`; otherwise the
  run stays in `CHALLENGE`.
- **`start`** (use case `startRun`): the single learner command bundles three events —
  `run.started`, the `SCENARIO → SCENARIO` anchor (from `buildRunStartedEvents`), then
  the auto-`accept` `phase.changed` `SCENARIO → DISCOVERY` (commandId `${commandId}:accept`).
  Net effect: unstarted → `DISCOVERY`.
- **`submit-design`** (use case `submitDesign`): `design.submitted` + `phase.changed`
  `SOLUTION_DESIGN → CHALLENGE` are followed, in the same write, by the deterministic
  challenge-injection batch (`challenge.injected` + `customer.replied` per selected
  candidate). Injection does **not** change phase.

---

## 4. Auto-transitions NOT reachable via a learner command

These are authored inside the orchestrator/use cases, or are declared domain commands
that no code path actually issues:

1. **`accept`** (`SCENARIO → DISCOVERY`) — auto-issued inside `startRun` (bundled with
   `start`) and inside `prepareRetry` (for the fresh child run). No standalone CLI command.
2. **Challenge injection** (`challenge.injected` + `customer.replied` interruption turns) —
   driven inside `submitDesign` immediately after `design.submitted`. No `phase.changed`:
   the run is already in `CHALLENGE`.
3. **`start-retry`** — declared (requires `RETRY_READY`) but no use case, orchestrator
   `prepare*`, or CLI route references it. Moreover nothing ever authors a
   `phase.changed` into `RETRY_READY`, so **`RETRY_READY` is unreachable** in the
   current code.
4. **`complete`** — declared (requires `REVIEW`; would emit `run.completed` →
   `COMPLETED`) but unwired. `review` stays in `REVIEW` and emits no `run.completed`,
   so **`COMPLETED` is unreachable**.
5. **`abort`** — declared (legal in `ACTIVE_PHASES`; would emit `run.aborted` →
   `ABORTED`) but unwired, so **`ABORTED` is unreachable**.

Net: of the ten declared phases, only seven are currently reachable —
`SCENARIO, DISCOVERY, PROBLEM_FRAMING, SOLUTION_DESIGN, CHALLENGE, PITCH, REVIEW`.
`RETRY_READY`, `COMPLETED`, and `ABORTED` have no `phase.changed` event pointing into
them.

### Adjacent CLI commands that are NOT in the `RunCommand` union

- `repair-evidence` (use case `repairEvidence` → `prepareRepairPendingEvidence`): a
  learner CLI command whose `request.type` is the ad-hoc string `"repair-evidence"`,
  not a `RunCommand` variant. It re-runs the Evidence Tracker on a retained pending
  turn and authors `evidence.patched`, `question.assessed`, `evidence.resolved`. It
  does not change phase.
- `list`, `status`, `replay`, `profile` — read-only projections (`read.ts` /
  `projector.ts`); no phase effect, no events authored.

---

## 5. The three feedback loops

The plan references three feedback loops. From the code they are:

### 5.1 Discovery loop (ask)

The learner asks many questions without leaving `DISCOVERY` (`ask` authors no
`phase.changed`).

- **Entry**: `SCENARIO → DISCOVERY` (auto-`accept` inside `start`/`retry`), or
  `PROBLEM_FRAMING → DISCOVERY` (`clarify`).
- **Self-loop**: `DISCOVERY → DISCOVERY` via `ask`.
- **Exit**: `DISCOVERY → PROBLEM_FRAMING` via `frame`.

### 5.2 Problem-framing loop (clarify / brief rejection)

The learner iterates on the problem brief.

- **Entry**: `DISCOVERY → PROBLEM_FRAMING` via `frame`.
- **Internal back-edge**: `PROBLEM_FRAMING → DISCOVERY` via `clarify` (budget-capped at
  `DEFAULT_CLARIFICATION_BUDGET = 3` per attempt), which then re-enters via `frame`.
- **Self-loop**: `PROBLEM_FRAMING → PROBLEM_FRAMING` via `submit-brief` on gate
  rejection (revision-in-place).
- **Exit**: `PROBLEM_FRAMING → SOLUTION_DESIGN` via `submit-brief` on gate pass.

### 5.3 Challenge loop (response)

The learner answers injected challenges.

- **Entry**: `SOLUTION_DESIGN → CHALLENGE` via `submit-design` (which also injects the
  deterministic challenge wave).
- **Self-loop**: `CHALLENGE → CHALLENGE` via `respond-challenge` while some mandatory
  challenge remains unaddressed.
- **Exit**: `CHALLENGE → PITCH` via `respond-challenge` once every mandatory challenge
  has a recorded response.

---

## 6. Discrepancies between the plan text and the code

- The plan described `accept` as a `SCENARIO → SCENARIO` anchor (and the example JSON
  classified it `DomainCommand`). In the code the `SCENARIO → SCENARIO` anchor is
  authored by `start` (`buildRunStartedEvents`), while `accept`'s `phase.changed` is
  `SCENARIO → DISCOVERY`, and `accept` is auto-issued (no CLI route) — i.e.
  `InternalAction`. This document follows the code.
- The plan's "three feedback loops" map to: **discovery** (ask self-loop),
  **problem-framing** (clarify + brief rejection), and **challenge** (response
  self-loop) — the "one more" loop is the challenge loop.
