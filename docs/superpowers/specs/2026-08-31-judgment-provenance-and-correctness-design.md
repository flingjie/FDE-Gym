# Phase 1 Correctness: Judgment Provenance, Optimistic Concurrency, Score States, Profile Lock

**Date:** 2026-08-31
**Status:** Approved for implementation planning
**Scope:** FDEGym control plane — Phase 1 "修正确性" (four items)

## Context

The control plane's determinism contract was corrected in commit `4a1068e`
(`docs/architecture.md`, `README.md`): the system is a **deterministic-replay**
control plane, not a "deterministic control plane." Model *prose* never drives
control flow; model *judgments* (schema-validated structured outputs —
`question.assessed`, `brief.validated`, `criterionScores`) do drive phase
transitions and scoring, and are committed as immutable events. First-time
judgment generation is non-deterministic; what is deterministic is the replay
of committed judgments.

This spec makes that corrected definition *true in the code*, not just the docs.
It covers four items, all correctness-focused:

1. **P0-2 — Judgment provenance** (`JudgmentEnvelope`): every judgment that
   affects state carries full provenance, so "who judged, with which model and
   prompt, and why a score changed when the model changed" is answerable.
2. **P0-4 — Optimistic concurrency**: move the model call out of the run lock
   and re-verify the event-log head at commit, closing a latent TOCTOU and
   removing "model retry time = transaction time."
3. **P0-5 — Score three-states**: stop presenting deterministic behavior proxies
   as capability scores; separate `measured` / `proxy` / `unscorable`.
4. **P0-3 — Profile lock**: make the cross-run profile fold atomic so concurrent
   reviews cannot lose updates.

**Out of scope** (later phases, explicitly not here): hexagonal
`application/ports/adapters` split, type-level `PublicRunView`/private-state
separation, `RuntimeCapabilities` negotiation, per-role model config, semantic
leak detection, SQLite/event-store snapshots, `EvaluationIdentity` content
addressing, and the profile-as-event-stream redesign.

## Non-negotiable cross-cutting constraints

- **Incremental and forward-compatible.** No committed event is rewritten or
  re-folded. Existing events that predate a new field simply lack that field;
  new code treats absence as "historical / unprovenanced," never as an error.
- **Golden replay byte-stability is preserved.** `tests/golden/manufacturing-replay.test.ts`
  must stay green with no fixture regeneration.
- **Single event log = single source of truth.** The hash chain keeps covering
  every judgment's content (hence inline envelopes, not a side store).
- **No new model I/O inside phase asserts or transaction commit.** `assertCommandPhase`
  stays pure; the model call happens exactly once per command, outside the lock.
- **Source imports use `.js` extension; test imports are extensionless.** Verify
  `npm run typecheck` and `npm test` after every task.

## P0-2 — Judgment provenance (`JudgmentEnvelope`)

### Current state (verified)

- `AgentInvocationResult` (`src/agents/agent-runtime.ts:11`) carries only
  `invocationId`, `output`, `modelId`. No raw-output digest, no prompt digest,
  no model revision.
- Judgment-bearing events are authored by `prepare*` functions in
  `src/core/orchestrator.ts` (e.g. `question.assessed` at `:271`/`:348`,
  `brief.validated` at `:454`; `criterionScores` at `:1079`).
- `executeCommandTransaction` already journals a canonical `requestHash`.
- `ScoreProvenance` (`src/scoring/score-input.ts`) already records
  model-vs-fallback per stage.

### Design

Introduce an inline envelope, additive to judgment events:

```ts
interface JudgmentEnvelope<T> {
  judgmentId: string;      // deterministic, e.g. `${commandId}:${role}` or a content hash
  invocationId: string;    // already produced per invocation
  modelId: string | null;  // already produced
  modelRevision?: string;  // new, from runtime config
  promptDigest: string;    // sha256 of the rendered role prompt
  schemaVersion: number;
  scenarioDigest: string;  // already recorded in run.started
  temperature?: number;    // runtime config, when known
  rawOutputDigest: string; // sha256 of the pre-validation raw output
  value: T;                // the schema-validated judgment
}
```

- Add an **optional** `judgment: JudgmentEnvelope<...>` field to each
  judgment-bearing event. Existing committed events keep their shape (absent
  `judgment` = historical, unprovenanced).
- Extend `AgentInvocationResult` with `rawOutputDigest` (digest computed before
  output validation; the raw text itself is never persisted). The runtime
  returns it; the orchestrator assembles `promptDigest`, `scenarioDigest`,
  `schemaVersion`, `temperature`, `modelRevision` from what it already holds.
- `value` is the schema-validated output — the same value the event already
  carries; the envelope wraps it with provenance rather than replacing it.

### Anti-patterns

- No separate `judgments` store or `judgmentId` foreign-key indirection (would
  break the single-log invariant).
- Do not persist raw model output — only its digest.
- Do not require provenance on every event; provenance is optional on events,
  present on all *new* judgment-bearing events.

## P0-4 — Optimistic concurrency

### Current state (verified)

- `executeCommandTransaction` (`src/core/command-transaction.ts:276`) calls
  `withRunLock` and invokes `options.prepare()` (which performs the model call)
  *inside* the lock.
- `withRunLock` (`src/storage/run-lock.ts:36`) already has stale-lock recovery
  (dead-PID cleanup + one retry, `:116`), so stale locks are handled.
- The latent defect is a **TOCTOU**: command state is loaded outside the lock
  (CLI reads `loadRun`), `prepare()` asserts phase on that snapshot, and the
  transaction never re-checks that the committed head still matches the snapshot
  the plan was built against.

### Design

Restructure `executeCommandTransaction` to optimistic commit:

1. Read `headSeq`/`headHash` (the current log head) under a short lock, release.
2. Run `options.prepare()` (model call) **without** the lock.
3. Re-acquire the short lock; re-read the head.
4. If the head is unchanged from step 1 → write prepared journal, append events,
   apply effects, write committed journal (all idempotent as today).
5. If the head changed → throw a new `RUN_VERSION_CONFLICT` error. **Do not**
   auto-re-run the model (regeneration is non-deterministic and wasteful); the
   caller re-issues the command.

Phase validity needs no separate re-check: phase is a pure function of the
committed events, so an unchanged head implies an unchanged phase — the
`assertCommandPhase` run inside `prepare()` is still authoritative.

### Anti-patterns

- No auto-retry of the model call on conflict.
- No second transaction adapter or flag to select old-vs-new commit semantics.

## P0-5 — Score three-states

### Current state (verified)

- `deriveStageScores` (`src/scoring/score-input.ts:117`) already returns a
  per-stage `stageProvenance` with `source: "model" | "fallback"`.
- `fallbackStageScores` (`:87`) awards `100` for mere structural presence
  (`solution = proposalPresent ? 100 : 0`, `pitch = explicitAsk ? 100 : 0`,
  `challenge = completion ratio`, `framing = supportRatio`).

### Design

Map each stage to one of three states, surfaced separately:

| State | Meaning | Enters capability total? |
|---|---|---|
| `measured` | a real Coach criterion judgment exists | yes |
| `proxy` | no model judgment, but a deterministic behavior proxy exists | no — shown as a separate "behavioral proxy" metric |
| `unscorable` | no model judgment and no meaningful signal (includes the vacuous "no challenges → 100") | no — shown N/A |

- The 0–100 capability total aggregates **only** `measured` stages.
- `proxy` stages are presented as a distinct, clearly-labeled metric (never
  mixed into the capability number).
- `unscorable` stages are excluded and displayed as N/A.
- **Forward-compatible**: classification derives from committed events
  (proposal presence, mandatory-challenge count, hint reliance) *plus* the
  existing `stageProvenance`; no historical score is recomputed, and golden
  replay is untouched.

### Anti-patterns

- Do not award a capability score for "completed the action."
- Do not mix proxy and measured values into one 0–100 number.

## P0-3 — Profile lock

### Current state (verified)

- The profile fold (`src/storage/fs-store.ts`) is read-modify-write:
  `atomicWriteFile` prevents torn writes; `appliedEffectIds` prevents duplicate
  application; there is **no lock**, so two runs folding reviews concurrently
  both read the same base and the later write wins (lost update).

### Design

- Add a `profile.lock` acquired for the whole profile fold, reusing the
  `run-lock.ts` pid/stale-lock machinery keyed by learner (not run).
- Document the profile-as-event-stream
  (`profiles/<learner-id>/events.jsonl`, folded from `attempt.reviewed` events)
  as the intended longer-term direction in `docs/architecture.md`; do not
  implement it here.

### Anti-patterns

- No `ProfileRepository` abstraction yet (that is Phase 2 hexagonal work).

## Dependency order (for the implementation plan)

1. **P0-2** first — it is the provenance foundation and P0-5 depends on it.
2. **P0-4** — transaction restructure; highest risk, isolated to the commit path.
3. **P0-5** — three-state scoring, built on the provenance now recorded.
4. **P0-3** — profile lock; most independent, can land last (or any time).

## Testing

Each item adds focused tests without regressing the existing 681:

- **P0-2**: envelope assembly (all provenance fields populated; digest fields
  are digests not raw text); a judgment event round-trips through journal +
  replay with its envelope intact.
- **P0-4**: head-unchanged commits; head-changed raises `RUN_VERSION_CONFLICT`
  (and does not re-invoke the runtime — assert a single `invoke` call).
- **P0-5**: each stage classified `measured`/`proxy`/`unscorable`; the
  capability total excludes `proxy` and `unscorable`; vacuous "no challenges"
  is `unscorable`, not 100.
- **P0-3**: concurrent profile folds serialize; no lost update (the loser's
  effect still lands via `appliedEffectIds`).

## Success criteria

- `npm run release:gate` green; golden replay byte-stable; no committed event
  rewritten.
- Every new judgment-bearing event carries a `JudgmentEnvelope`; a query can
  answer "which model + prompt produced this score."
- The capability score no longer silently reports a proxy as a measured score.
- The transaction no longer holds the run lock across the model call.
