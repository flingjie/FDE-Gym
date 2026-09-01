# Wave 0 Integration Record — FDE-Gym Agent Graph Migration

> Barrier: W0 · generated against HEAD `d7b84b7` (plan-referenced baseline `1410441c…` is an ancestor).

This record reconciles the four Wave 0 artifacts (`baseline.md`,
`current-phase-matrix.{md,json}`, `current-node-catalog.md`,
`current-edge-catalog.md`) and the read-only architecture review. It is the
Lead/Integration agent's W0 deliverable: it unifies Node/Edge IDs, confirms the
feedback loops, resolves command-classification conflicts, and carries the
findings that Wave 1+ must honor.

## 1. Barrier verdict

**PASS.** All five owned outputs are present, no shared-file writes conflicted,
`docs/graph/` is the only tree delta, and the CI baseline is clean:

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS — 753 passed / 1 skipped |
| `npm run release:gate` | PASS — exit 0 |
| Cross-catalog consistency | PASS — Phase/Node/Edge catalogs agree on phases, commands, events, and the dead-command set |

## 2. Unified command classification (resolved)

Four catalogs converged on the same 15 commands. The authoritative split:

| Classification | Commands |
|---|---|
| **DomainCommand** (learner CLI, mutating) | `start`, `ask`, `frame`, `hint`, `submit-brief`, `clarify`, `submit-design`, `respond-challenge`, `submit-pitch`, `review`, `retry` (11) |
| **InternalAction** — auto-issued | `accept` (folded into `start`/`retry` as `${commandId}:accept`) |
| **InternalAction** — declared, unwired | `start-retry`, `complete`, `abort` |

Corollaries that resolve the cross-catalog conflicts:

1. **`accept` is InternalAction, not DomainCommand.** No CLI route; its own
   `phase.changed` is `SCENARIO → DISCOVERY`. The `SCENARIO → SCENARIO` anchor is
   authored by `start` via `buildRunStartedEvents` (`state-machine.ts:103-125`).
2. **`repair-evidence` is a wired CLI command OUTSIDE the domain union.** It is
   fully functional (`CLI → use-case → prepareRepairPendingEvidence`) but is
   neither in `RunCommandSchema` nor `assertCommandPhase`. Classify it as a
   **guard-gated re-entrant InternalAction** (no phase edge), pending a Wave 1
   decision to promote it into the domain contract or keep it ad-hoc.
3. **`start-retry`, `complete`, `abort` are ghosts**: schema + phase-legality
   exist, but no use case, `prepare*`, CLI route, or event producer.
   `run.completed` / `run.aborted` are never authored. Consequently
   `RETRY_READY`, `COMPLETED`, `ABORTED` are unreachable phases. This is the
   single most important finding carried into Wave 1.

## 3. Canonical Node ID reconciliation

The Node Catalog used the plan's seed vocabulary as temporary names. Integration
resolves these over-specifications:

| Seed / temporary ID | Integration decision |
|---|---|
| `evidence.patch.guard` + `evidence.patch.apply` | **One function** (`applyEvidencePatch`, `src/evidence/graph.ts`). Keep **one node** `evidence.patch.apply`; treat the guard as a failure policy on that node, not a separate stage. |
| `customer.project` | Spans two modules (sanitize/validate tail of `answerDiscoveryQuestion` + replay-time `projectPublic`/`projectReplay`). Canonical node = `customer.invoke` (agent); the sanitize+validate concern is the shared `judgment.guard`; replay projection is `replay.project`, not a node. |
| `judgment.guard` | **Cross-cutting**, per-role (`sanitizer.ts` + `output-validation.ts`), not a pipeline stage. Model it in the graph as a Node `kind: "guard"` policy applied to every agent node, not as a distinct graph node. |
| `challenge.select` + `challenge.inject` + `solution.accept` | Share one `submit-design` transaction. Keep as distinct nodes but mark `challenge.inject` an **automatic sub-action** (no learner command, inline phase guard). |
| `brief.structure.guard` / `coach.brief.invoke` / `brief.support.guard` | All sub-steps of `prepareFramingGate`; keep distinct nodes for the graph but they share one command transaction. |
| `run.complete` / `run.abort` / `run.start-retry` | `not-yet` — reserved for the Wire-or-Freeze decision (§5). |

## 4. Feedback loops (confirmed)

| Loop | Entry | Self-loop | Exit |
|---|---|---|---|
| **Discovery** | `SCENARIO→DISCOVERY` (accept) / `PROBLEM_FRAMING→DISCOVERY` (clarify) | `ask` stays DISCOVERY | `frame` → PROBLEM_FRAMING |
| **Problem-framing** | `DISCOVERY→PROBLEM_FRAMING` (frame) | `submit-brief` fail stays PROBLEM_FRAMING; `clarify` round-trips | `submit-brief` pass → SOLUTION_DESIGN |
| **Challenge** | `SOLUTION_DESIGN→CHALLENGE` (submit-design) | `respond-challenge` partial stays CHALLENGE | all mandatory answered → PITCH |

**Discrepancy (P1):** `docs/architecture.md:71` shows a fourth, retry outer loop
(`REVIEW → RETRY_READY → new DISCOVERY` and `REVIEW → complete → COMPLETED`). The
code does neither: `retry` requires `REVIEW`, emits only `retry.started` on the
parent (which stays REVIEW), and spawns a fresh child via the `retry.ensure-child`
effect. The architecture diagram must be reconciled with the code — or `complete`/
`start-retry` wired — before the Phase Spec (G05-01) can claim terminal semantics.

## 5. Findings that gate Wave 1 (risk register)

**Wire-or-Freeze decision — RESOLVED (human owner, 2026-09-01): WIRE.** Implement
`complete`/`abort`/`start-retry` so `run.completed`/`run.aborted` are authored,
terminal phases `COMPLETED`/`ABORTED` become reachable, and the `architecture.md`
retry loop (`REVIEW → retry → RETRY_READY → start-retry → new DISCOVERY`) is
restored. This is net-new product behavior and touches `orchestrator.ts`,
use-cases, CLI, the reducer/projector, and golden replay; it is planned and
sequenced as its own implementation task (see §6), preceding the G05-01 Phase
Spec encoding so the Spec models the *wired* reality rather than a stale one.

**P0 — phase continuity is not enforced at fold/reduce time.** `reduce`
(`reducer.ts:29`) and `foldRunAggregate` (`projector.ts:196-203`) set
`phase = event.to` without checking `event.from === currentPhase`. Today the
safety comes only from the hardcoded `from`/`to` literals in each `prepare*`.
A data-driven graph (Wave 1+) must make this explicit, or illegal logs become
replayable. This is the direct motivation for G1-01/G1-02.

**P0 — two reducers over one event stream.** `reduce` (store `loadRun`) folds only
`runId`+`phase`+`seq`; `foldRunAggregate` folds the full aggregate. A transition
added to one and not the other silently diverges `status`/`phase`. Must be unified
or mechanically derived in Wave 1.

**P0 — `orchestrator.ts` (~1244 lines) is the conflation target.** Each `prepare*`
bundles phase guard + model I/O + event authorship + state mutation. This is the
file Phase 2/3 decomposition must split first.

**P0 — any new `RunEvent` must update five sites or it leaks/fails-closed:**
`RunEventSchema` (`domain.ts:883`), `projectPublic` (`public-projection.ts:59`),
`foldRunAggregate` (`projector.ts:188`), `projectReplay` (`projector.ts:326`),
and the golden hidden-marker assertions.

**P1 — duplicated phase guards:** `hint` (`state-machine.ts:48-52` vs
`discovery.ts:281-283`) and `retry` (`state-machine.ts:72-73` vs
`orchestrator.ts:987-989`) are each defined in two places; they can drift silently.

**P1 — `RunCommandSchema` is never parsed.** `executeCommandTransaction` only hashes
the request; legality is enforced solely by the `assertCommandPhase` switch, which
`start`/`accept`/`hint`/`repair-evidence` bypass.

**P1 — asymmetric `ask` durability:** Customer failure aborts before any event
persists (question lost); Evidence-Tracker failure is caught and persists
`evidence.pending`. A graph failure-policy model (G3-05) must encode this asymmetry.

## 6. Next wave

Wave 1 (Phase 0.5) — the minimal Graph Spec — is unblocked **except** for the
Wire-or-Freeze decision (§5), which G05-01 explicitly depends on ("明确 complete、
abort、retry 的产品语义"). Recommend the human owner resolve that single decision,
then Wave 1 proceeds with the Contract Slice → Phase Spec → Event Protocol →
Challenge State → adversarial skeleton, as scheduled.
