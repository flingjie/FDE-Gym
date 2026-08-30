# Architecture

FDE Gym is a **deterministic control plane** around a **role-scoped model
runtime**. The control plane (phases, event store, evidence graph, scoring,
firewall) is pure and deterministic; the only non-determinism is the model
prose each role produces, which is confined behind strict, schema-validated
boundaries and never touches the control plane's decisions.

## The three role contexts

Exactly three logical model roles exist (`AGENT_ROLES`):

| Role | Sees (allowlist) | Never sees |
|---|---|---|
| `customer` | `locale`, the pending question, `stakeholderId`, the **customer capsule** (`stakeholders`, `disclosureUnits`, `disclosedDisclosureUnitIds`, `responsePolicies`). | The evaluator capsule (rubric, expected evidence, hint ladders, pass gates, critical contradictions), the learner's score/profile, the evidence graph, hints. |
| `evidence_tracker` | `locale`, the latest public transcript `turn`, the public evidence `graph`. | **Any** capsule (customer or evaluator) — ground truth, expected evidence, disclosure units, canaries. |
| `coach_evaluator` | `locale`, the public brief/proposal/pitch/challenge responses/graph/transcript/hint ledger, plus the **evaluator capsule** (for the active task: `hint` → hint ladders; `brief-validation` → brief+graph+transcript; `final-review` → brief+proposal+pitch+responses+graph+transcript+hint ledger). | The customer capsule (hidden facts, stakeholders, disclosure units), the learner's score/profile, ground truth. |

Each role runs through the same `AgentRuntime` interface
(`invoke(role, input, { freshContext, tools: "disabled", outputSchema })`). A
single implementation exists: `DirectModelRuntime` — one structured
chat-completions call with **no tools, no MCP, and no session**. When no model
endpoint is discoverable, the CLI resolves an `UnconfiguredModelRuntime` that
fails closed with `MODEL_ENDPOINT_REQUIRED` on the first role invocation
(read-only commands are unaffected). See `docs/architecture-decisions.md`
(ADR-0001).

## The three scenario partitions

A scenario compiles from one bilingual YAML source into three **structurally
independent** JSON files under `scenarios/compiled/<id>/`:

- `public.json` (`PublicScenario`) — learner-visible: opening request, visible
  context/constraints, deliverables, learner rules, question budget. No hidden
  facts, no canary, no rubric.
- `customer.json` (`CustomerCapsule`) — hidden: stakeholders, disclosure units
  (hidden facts), response policies, private conflicts, and a customer canary.
- `evaluator.json` (`EvaluatorCapsule`) — hidden: expected evidence (weighted),
  rubric, critical contradictions, hint ladders, pass gates, and an evaluator
  canary.

`manifest.json` records `id`/`schemaVersion`/`locale`/file names and never
carries canary values. All four files carry `schemaVersion: 1` (the frozen
version — see `src/scenarios/schema.ts`).

## State transitions (the RunPhase path)

`RUN_PHASES` (see `src/core/domain.ts`) and the gated path:

```
SCENARIO --accept--> DISCOVERY --frame--> PROBLEM_FRAMING
    |                                          |
    |                 (submit-brief passes)    | (submit-brief fails → clarify → DISCOVERY)
    |                                          v
    |                                    SOLUTION_DESIGN
    |                                          | (submit-design)
    |                                          v
    |                                       CHALLENGE
    |                                          | (respond-challenge × all mandatory)
    |                                          v
    |                                         PITCH
    |                                          | (submit-pitch)
    |                                          v
    |                                        REVIEW
    |                                          | (review → review.completed + score.computed)
    |                                          v
    |                             (retry) RETRY_READY --start-retry--> DISCOVERY (new run)
    |                                          |
    |                                          +-- (complete) --> COMPLETED
    +----- (abort, from any active phase) ----> ABORTED
```

Cross-phase commands are rejected with `INVALID_PHASE_COMMAND` and emit no
event. Phase legality lives in `assertCommandPhase` (`src/core/state-machine.ts`);
event authorship lives in the `prepare*` functions. The structural gates
(`submit-brief`, `submit-design`, `respond-challenge`, `submit-pitch`) each
validate their artifact and only then emit their
`*.submitted`/`*.responded` event plus a `phase.changed` when the gate passes.

## The `AgentRuntime` boundary + context firewall

`src/security/context-firewall.ts` is the security boundary between the internal
**run aggregate** (which may legitimately hold hidden fields) and each role's
strict input schema. `buildRoleInput(role, state, capsule)` constructs the role
input **field-by-field from an explicit per-role allowlist** — it never spreads
the aggregate or a capsule. Three properties make it fail-closed:

1. `.strict()` role input schemas reject any extra key.
2. An unrecognized aggregate field causes `FIREWALL_UNRECOGNIZED_FIELD`
   (never silently ignored).
3. Handing a role the wrong capsule throws `FIREWALL_CAPSULE_FORBIDDEN`
   (customer↔evaluator capsules are structurally discriminated).

`src/integrations/direct/direct-runtime.ts` re-validates the role input against
`roleInputSchema(role)` before calling the model, and re-validates raw output
against the role's strict output schema after stripping prohibited keys and
scanning for canaries (see `docs/security-model.md`).

## The event-sourced store (hash chain + determinism)

`src/core/event-store.ts` persists runs as an append-only JSONL
(`runs/<run-id>/events.jsonl`) plus a `manifest.json` carrying
`schemaVersion: 1`. Each recorded event is a domain `RunEvent` layered with an
envelope `{ seq, logicalTime, previousHash, hash }` where `hash` is
`SHA-256(canonicalJson({ ...domainEvent, seq, logicalTime, previousHash }))`
and `previousHash` chains to the prior event (empty for the first). `loadRun` /
`loadEvents` re-verify the chain and reject a mismatch with
`EVENT_CHAIN_INVALID`.

Durable commits never call `appendEvents` directly. Every mutating command runs
through `executeCommandTransaction` (`src/core/command-transaction.ts`) — the
single write-ahead journal path. It writes a per-command journal
(`runs/<run-id>/commands/<commandId>.json`) atomically *before* any event or
effect is applied, recording the canonical request hash, the complete event
batch, the learner-safe result snapshot, and the idempotent effects; only then
does it append the batch through `appendEvents` (the hash-chained JSONL) and
apply effects. This makes command-id dedup and result replay deterministic: a
`prepared` (interrupted) journal is finished by appending its events and
applying its effects without re-invoking a model, and a `committed` journal with
a matching request hash returns the stored result; a different hash raises
`COMMAND_ID_CONFLICT`.

Determinism is the product's core invariant. Four claims are precise, and the
verification suite asserts each one:

1. **Same committed events → same state.** Phase legality is enforced by
   `assertCommandPhase` and event authorship by the `prepare*` functions;
   `reduce` remains a minimal, pure phase fold over the committed events (no
   wall-clock, no `Math.random`), so folding the same event log always rebuilds
   the same aggregate.
2. **Same scenario bundle digest + seed + trigger context → same scheduled
   event order.** The only randomness is a seeded `mulberry32` PRNG
   (`src/simulation/rng.ts`), consumed solely to order the deterministic
   scenario-event wave; the run seed defaults to a deterministic FNV-1a hash of
   the run id. Scenario events are selected by a pure scheduler
   (`src/simulation/event-scheduler.ts`): filter → sort by id → seeded shuffle,
   so the digest + seed + trigger context fully determine the scheduled order.
3. **Same event log → byte-stable recorded replay.** `projectReplay` is a pure
   projection of the committed events (see `docs/replay.md`).
4. **A fresh model invocation does NOT guarantee identical prose or judgment.**
   Only the control plane (state and ordering) is deterministic; role prose is
   confined behind schema-validated boundaries and never drives the control
   plane's decisions.

"**MVP v1 frozen**" means the specification and acceptance baseline are frozen,
**not** that the product is release-ready (see `docs/mvp-acceptance.md`).

Resume is just replay: `foldRunAggregate` rebuilds the full internal aggregate
(phase, transcript, evidence graph, disclosure ledger, hints, brief, proposal,
pitch, challenge responses) from the committed events; everything else (score,
profile, chain-of-thought) starts empty.
