# Phase 3b — Evaluator Repeated Sampling + Confidence

**Date:** 2026-08-31
**Status:** Approved for implementation planning
**Scope:** FDEGym Phase 3 "评测可信度" — evaluator repeated sampling → confidence

## Context

The Coach final-review runs ONCE per `review` command, so a single non-deterministic model
judgment becomes the score with no measure of its reliability. This sub-project adds optional
repeated sampling of the final review and derives a confidence figure from the agreement
across samples, surfaced alongside the capability score and the three-state classification.

## Goal

- `review` can run the Coach final-review N times (N configurable; default 1 = today).
- The N samples are aggregated into one `FinalReviewResult` (mean criterion scores) and one
  confidence figure (agreement across samples).
- `review.completed`/`score.computed` still commit exactly ONE aggregated result; golden
  replay and `samples === 1` behavior are byte-identical.

## Non-negotiable constraints

- **Behavior-preserving at `samples === 1`.** 733 tests green, golden replay byte-stable, no
  event/score change when sampling is off.
- **Deterministic.** The sampling loop is a fixed number of invocations; aggregation is pure
  math (no `Math.random`, no wall-clock). Testable with `FixtureAgentRuntime` (per-sample
  `invocationId` → different fixture).
- Source imports `.js`; test imports extensionless; no new deps.
- No change to `runFinalReview`'s input contract (it already takes an `invocationId`).

## 1. Sampling (`src/agents/coach.ts`)

```ts
export interface SampleFinalReviewOptions {
  samples: number;          // >= 1
  commandId: string;
  timeoutMs: number;
  canaries: readonly string[];
}

/** Run the final review `samples` times, each with a distinct invocation id. */
export async function sampleFinalReview(
  runtime: AgentRuntime,
  state: RunAggregate & { coachTask: "final-review" },
  capsule: EvaluatorCapsule,
  options: SampleFinalReviewOptions,
): Promise<FinalReviewInvocation[]>;
```

Each sample calls `runFinalReview({ runtime, state, capsule, invocationId: `${commandId}:coach:${i}`, timeoutMs, canaries })`. `samples` is validated `>= 1` (throw a domain error otherwise).

## 2. Aggregate + confidence (`src/scoring/review-aggregation.ts`)

```ts
export interface AggregatedReview {
  review: FinalReviewResult;
  /** 0..1 agreement, or `null` when `samples === 1` (variance unmeasurable). */
  confidence: number | null;
}

export function aggregateReviews(reviews: readonly FinalReviewInvocation[]): AggregatedReview;
```

- `criterionScores`: per stage, per criterion, the mean across samples.
- `verdict`: majority (`pass` vs `fail`); on a tie, the verdict of the review whose criterion
  scores are closest (mean absolute difference) to the mean scores.
- `strengths`/`weaknesses`/`missedOpportunities`/`decisionDivergencePoints`/`nextFocus`: take
  the first sample's values (prose; not aggregated).
- `confidence`: when `samples === 1`, `null`. When no sample carries any criterion
  score (agreement unmeasurable), `null`. Otherwise, per-criterion standard deviation
  (population) across samples, averaged over all present criteria, normalized:
  `confidence = clamp01(1 - meanStdDev / 50)` (scores are 0..100, so a criterion's
  population stdDev is at most 50 — a 0/100 split — hence the divisor 50 maps maximal
  divergence to 0).

## 3. Wire into `prepareReview` (`src/core/orchestrator.ts`)

- Add `samples?: number` to `SubmitReviewInput` (default 1).
- When `samples <= 1`: call `runFinalReview` once (unchanged).
- When `samples > 1`: call `sampleFinalReview`, then `aggregateReviews`, and use the aggregated
  `review` for `buildScoreInput` + `review.completed`.
- `PreparedReview` gains `confidence: number | null`.

## 4. Surfacing (`src/cli/commands.ts`)

`ReviewData` gains `confidence: number | null`; `reviewCommand` passes it through from
`prepareReview`. It sits alongside `measuredCapability` and `stageStates`.

## Out of scope

- Model-version drift detection and scenario-difficulty calibration (next sub-projects).
- End-to-end real-model contract suite.
- Persisting confidence into `score.computed` (it is display-time, like `measuredCapability`).

## Testing

- `aggregateReviews` unit tests: mean criterion scores; majority verdict; confidence is `null`
  for one sample, `1.0` for identical samples, `< 1` for divergent samples (use hand-computed
  fixtures).
- `sampleFinalReview` with `FixtureAgentRuntime` producing per-sample fixtures; assert N
  invocations with distinct ids.
- `review` e2e with `samples: 2` (fixture-driven) asserts the aggregated score + confidence.
- Full suite green; golden replay byte-stable (sampling off).

## Success criteria

- `npm run release:gate` green; golden replay byte-stable at `samples === 1`.
- `review --samples N` (N ≥ 2) produces a mean-aggregated score + a confidence figure derived
  from cross-sample agreement; `N === 1` is byte-identical to today.
