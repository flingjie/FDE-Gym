# Phase 2b — Type-Level Security Boundary (PublicView vs Sensitive State)

**Date:** 2026-08-31
**Status:** Approved for implementation planning
**Scope:** FDEGym Phase 2 "降耦合" — type-level security split (minimal)

## Context

The role-context firewall (`src/security/context-firewall.ts` `buildRoleInput`) is the
security boundary between the internal run aggregate and the strict role input schemas.
It constructs each role input field-by-field and never spreads the aggregate — but that
safety is **behavioral**, not **typed**. `RunAggregate` (`src/core/aggregate.ts`) mixes
the learner-safe public fields with four `unknown`-typed sensitive fields (`score`,
`learnerProfile`, `previousAttemptReview`, `rubric`), so a future edit that accidentally
spreads the aggregate or reads a sensitive field inside the firewall compiles silently and
leaks at runtime.

This sub-project makes the boundary a **compile-time** guarantee by splitting the aggregate
into a public view and a sensitive state, and narrowing the firewall's input type to the
public view.

## Goal

- `buildRoleInput`'s parameter type is `PublicRunView`, not `RunAggregate`. The four
  sensitive fields are therefore not even in scope inside the firewall — reading `agg.score`
  there is a TypeScript error, not a runtime convention.
- Callers (the agent functions in `src/agents/*`) keep passing the full `RunAggregate`;
  structural subtyping accepts it unchanged, so **no caller edit** and **no behavior change**.

## Non-negotiable constraints

- **Behavior-preserving.** 705 tests (the current suite), golden replay byte-stability, and
  every committed event/score stay identical. No runtime change.
- Structural subtyping only — do NOT modify the concrete modules beyond the aggregate
  type/schema split and the firewall's parameter type.
- Source imports `.js`; test imports extensionless; no new deps.
- The four sensitive fields stay `unknown`-typed and stay in `RunAggregate` (they are not
  moved or retyped) — only their exclusion from `PublicRunView` is new.

## The split (`src/core/aggregate.ts`)

`PublicRunView` = every aggregate field except the four sensitive fields:

```ts
export interface PublicRunView {
  runId: string;
  scenarioId: string;
  locale: Locale;
  phase: RunPhase | null;
  transcript: TranscriptTurn[];
  graph: EvidenceGraph;
  disclosedDisclosureUnitIds: string[];
  grantedHints: HintLedgerEntry[];
  pendingQuestion: { question: string; stakeholderId: string } | null;
  coachTask: CoachTask;
  brief: ProblemBrief | null;
  proposal: SolutionProposal | null;
  pitch: PitchArtifact | null;
  challengeResponses: ChallengeResponse[];
  pendingEvidence: { turnId: string; code: string } | null;
  clarificationBudgetUsed: number;
}

export interface SensitiveRunState {
  score?: unknown;
  learnerProfile?: unknown;
  previousAttemptReview?: unknown;
  rubric?: unknown;
}

export type RunAggregate = PublicRunView & SensitiveRunState;
```

**`RunAggregateSchema` stays UNCHANGED** (the single strict object over all fields,
still rejecting unknown keys — fail-closed). The split is **type-only**: the runtime
validation must keep accepting the full aggregate (which legitimately carries the four
sensitive fields). No `PublicRunViewSchema`/`SensitiveRunStateSchema` is introduced — a
strict public-only schema would wrongly reject a full aggregate carrying `score`, breaking
fail-closed. The `COACH_TASKS`/`CoachTask`/`CoachTaskSchema` exports stay as-is.

## Firewall change (`src/security/context-firewall.ts`)

- Change the three `buildRoleInput` overloads' `state` parameter from `RunAggregate` to
  `PublicRunView`.
- Keep the runtime check `RunAggregateSchema.safeParse(state)` (fail-closed over the full
  aggregate).
- After the parse, narrow the local: `const agg: PublicRunView = parsed.data;` so the
  `switch` body's `agg` is typed `PublicRunView` — reading `agg.score` etc. there becomes a
  TypeScript error.
- No other change. The field-by-field construction stays; only the type narrows.

## Out of scope (later sub-projects / explicitly not here)

- The fuller `InternalRunState = { public, customerPrivate, evaluatorPrivate }` model and
  folding the capsules into it (the customer/evaluator private data already lives in the
  separate `CustomerCapsule`/`EvaluatorCapsule` types).
- Adopting `PublicRunView` as the projection output type (`projectPublic`/`projectReplay`
  return their own learner-safe types; they are not retyped here).

## Testing

- The existing 705-test suite passes unchanged (behavior-preserving).
- Add one compile-time-guard contract test asserting the negative: a `buildRoleInput`
  call that passes an object carrying a sensitive field does NOT type-check. (This is a
  type-level test — the standard pattern is `@ts-expect-error` on the offending line, e.g.
  `buildRoleInput("customer", { ...validPublic, score: "LEAK" } as never, capsule)` — assert
  the firewall's parameter type excludes the field. Implement as a `.test-d.ts` style or a
  `// @ts-expect-error` comment in a unit test that Vitest runs as a no-op body.)

## Success criteria

- `npm run release:gate` green; golden replay byte-stable; no committed event/score change.
- Inside `context-firewall.ts`, `agg.score`/`agg.learnerProfile`/`agg.previousAttemptReview`/
  `agg.rubric` are TypeScript errors (the parameter is `PublicRunView`).
- `buildRoleInput` callers (agent functions) are unmodified and still type-check.
