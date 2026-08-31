# Evaluator Repeated Sampling + Confidence (Phase 3b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `review` run the Coach final-review N times, aggregate the N samples into one result, and derive a confidence figure from cross-sample agreement — surfaced alongside the capability score and three-state classification.

**Architecture:** A pure `aggregateReviews` (mean criterion scores + majority verdict + confidence), a `sampleFinalReview` (N invocations with distinct ids), wired into `prepareReview` behind a `samples` parameter (default 1 = today's byte-identical behavior).

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-evaluator-sampling-confidence-design.md`

## Global Constraints

- **Behavior-preserving at `samples === 1`.** 733 tests green; golden replay byte-stable; no event/score change when sampling is off.
- **Deterministic** (no `Math.random`, no wall-clock); testable with `FixtureAgentRuntime`.
- Source `.js`; test extensionless; no new deps.

---

### Task 1: `aggregateReviews` (pure) + unit tests

**Files:**
- Create: `src/scoring/review-aggregation.ts`
- Create: `tests/unit/review-aggregation.test.ts`

- [ ] **Step 1: Implement `src/scoring/review-aggregation.ts`.**

```ts
import type { CriterionScores, FinalReviewResult } from "../core/domain.js";
import type { FinalReviewInvocation } from "../agents/coach.js";

export interface AggregatedReview {
  review: FinalReviewResult;
  confidence: number | null; // null when samples === 1
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, x) => s + x, 0) / values.length;
}

/** Population std dev. */
function stdDev(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, x) => s + (x - m) * (x - m), 0) / values.length);
}

/** Mean criterion scores across samples, per stage, per criterion id present in any sample. */
function meanCriterionScores(samples: readonly FinalReviewInvocation[]): CriterionScores {
  const out: CriterionScores = {};
  const stages = ["framing", "solution", "challenge", "pitch", "process"] as const;
  for (const stage of stages) {
    const byCriterion = new Map<string, number[]>();
    for (const s of samples) {
      const map = s.review.criterionScores?.[stage];
      if (!map) continue;
      for (const [id, score] of Object.entries(map)) {
        const arr = byCriterion.get(id) ?? [];
        arr.push(score);
        byCriterion.set(id, arr);
      }
    }
    if (byCriterion.size > 0) {
      out[stage] = {};
      for (const [id, arr] of byCriterion) out[stage]![id] = mean(arr);
    }
  }
  return out;
}

/** Mean absolute distance from the mean scores — used to break a verdict tie. */
function distanceToMean(s: FinalReviewInvocation, meanScores: CriterionScores): number {
  let total = 0;
  let count = 0;
  const stages = ["framing", "solution", "challenge", "pitch", "process"] as const;
  for (const stage of stages) {
    const map = s.review.criterionScores?.[stage];
    const meanMap = meanScores[stage];
    if (!map || !meanMap) continue;
    for (const [id, score] of Object.entries(map)) {
      const m = meanMap[id];
      if (m === undefined) continue;
      total += Math.abs(score - m);
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

export function aggregateReviews(reviews: readonly FinalReviewInvocation[]): AggregatedReview {
  if (reviews.length === 0) throw new Error("cannot aggregate zero reviews");
  const criterionScores = meanCriterionScores(reviews);

  // Majority verdict; on a tie, the review closest to the mean scores.
  let pass = 0;
  let fail = 0;
  for (const r of reviews) {
    if (r.review.verdict === "pass") pass += 1; else fail += 1;
  }
  let verdict: FinalReviewResult["verdict"];
  if (pass !== fail) verdict = pass > fail ? "pass" : "fail";
  else {
    let best = reviews[0];
    let bestDist = Infinity;
    for (const r of reviews) {
      const d = distanceToMean(r, criterionScores);
      if (d < bestDist) { bestDist = d; best = r; }
    }
    verdict = best.review.verdict;
  }

  // Prose fields from the first sample.
  const first = reviews[0].review;
  const review: FinalReviewResult = {
    verdict,
    strengths: first.strengths,
    weaknesses: first.weaknesses,
    missedOpportunities: first.missedOpportunities,
    decisionDivergencePoints: first.decisionDivergencePoints,
    nextFocus: first.nextFocus,
    criterionScores,
  };

  // Confidence: null for a single sample; else 1 - meanStdDev/100 over all criteria.
  let confidence: number | null = null;
  if (reviews.length > 1) {
    const byCriterion = new Map<string, number[]>();
    for (const s of reviews) {
      for (const stage of ["framing", "solution", "challenge", "pitch", "process"] as const) {
        const map = s.review.criterionScores?.[stage];
        if (!map) continue;
        for (const [id, score] of Object.entries(map)) {
          const arr = byCriterion.get(id) ?? [];
          arr.push(score);
          byCriterion.set(id, arr);
        }
      }
    }
    const deviations = [...byCriterion.values()].map((arr) => stdDev(arr));
    confidence = clamp01(1 - mean(deviations) / 100);
  }

  return { review, confidence };
}
```

- [ ] **Step 2: Unit tests.** `tests/unit/review-aggregation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aggregateReviews } from "../../src/scoring/review-aggregation";

function review(verdict: "pass" | "fail", solution: number): any {
  return { review: { verdict, strengths: [], weaknesses: [], missedOpportunities: [], decisionDivergencePoints: [], nextFocus: [], criterionScores: { solution: { c1: solution } } }, invocationId: "x", modelId: null, rawOutputDigest: "a".repeat(64), promptDigest: "b".repeat(64) };
}

describe("aggregateReviews", () => {
  it("single sample → null confidence, passthrough", () => {
    const { review, confidence } = aggregateReviews([review("pass", 80)]);
    expect(confidence).toBeNull();
    expect(review.criterionScores.solution.c1).toBe(80);
  });
  it("means criterion scores and reports 1.0 confidence for identical samples", () => {
    const { review, confidence } = aggregateReviews([review("pass", 80), review("pass", 80), review("pass", 80)]);
    expect(review.criterionScores.solution.c1).toBe(80);
    expect(confidence).toBe(1);
  });
  it("divergent samples → confidence < 1 and mean score", () => {
    const { review, confidence } = aggregateReviews([review("pass", 60), review("pass", 80)]);
    expect(review.criterionScores.solution.c1).toBe(70);
    expect(confidence).toBeLessThan(1);
  });
  it("majority verdict wins", () => {
    const { review } = aggregateReviews([review("pass", 80), review("fail", 40), review("pass", 75)]);
    expect(review.verdict).toBe("pass");
  });
});
```

- [ ] **Step 3: Verify + commit.** `npm run typecheck && npm test` (733 + 4 new).

```bash
git add -A && git commit -m "feat: add aggregateReviews (mean criterion scores + confidence)"
```

---

### Task 2: `sampleFinalReview` (sampling loop) + test

**Files:**
- Modify: `src/agents/coach.ts`
- Modify: `tests/contracts/coach-agent.test.ts` (or a new test)

- [ ] **Step 1: Implement `sampleFinalReview`** in `src/agents/coach.ts` (next to `runFinalReview`):

```ts
export interface SampleFinalReviewOptions {
  samples: number;
  commandId: string;
  timeoutMs: number;
  canaries: readonly string[];
}

export async function sampleFinalReview(
  runtime: AgentRuntime,
  state: RunAggregate & { coachTask: "final-review" },
  capsule: EvaluatorCapsule,
  options: SampleFinalReviewOptions,
): Promise<FinalReviewInvocation[]> {
  if (!Number.isInteger(options.samples) || options.samples < 1) {
    throw new CoachError(COACH_OUTPUT_REJECTED, "samples must be a positive integer");
  }
  const out: FinalReviewInvocation[] = [];
  for (let i = 1; i <= options.samples; i++) {
    out.push(await runFinalReview({
      runtime,
      state,
      capsule,
      invocationId: `${options.commandId}:coach:${i}`,
      timeoutMs: options.timeoutMs,
      canaries: options.canaries,
    }));
  }
  return out;
}
```

(Import `RunAggregate` from `../core/aggregate.js` and `AgentRuntime`/`CoachError`/`COACH_OUTPUT_REJECTED` as already available in `coach.ts`.)

- [ ] **Step 2: Test.** Use `FixtureAgentRuntime` with per-invocation-id fixtures: assert `sampleFinalReview` with `samples: 3` makes 3 invocations (`id:coach:1/2/3`) and returns 3 results with distinct fixture outputs.

- [ ] **Step 3: Verify + commit.** `npm run typecheck && npm test`.

```bash
git add -A && git commit -m "feat: add sampleFinalReview (N final-review invocations)"
```

---

### Task 3: Wire `samples` into `prepareReview` + surface `confidence`

**Files:**
- Modify: `src/core/orchestrator.ts` (`SubmitReviewInput.samples`, `PreparedReview.confidence`)
- Modify: `src/cli/commands.ts` (`ReviewData.confidence`, `reviewCommand` + `--samples` arg)
- Modify: `src/cli/main.ts` (parse `--samples` if adding a CLI flag)

- [ ] **Step 1: `orchestrator.ts`.** Add `samples?: number` to `SubmitReviewInput`. In `prepareReview`, when `(input.samples ?? 1) <= 1`, keep the single `runFinalReview` call (unchanged, `confidence: null`). When `> 1`, call `sampleFinalReview` then `aggregateReviews`, and use `aggregated.review` for `buildScoreInput` + the `review.completed` event. `PreparedReview` gains `confidence: number | null`.

- [ ] **Step 2: `commands.ts`.** `ReviewData` gains `confidence: number | null`; `reviewCommand` threads it (from `prepareReview`) and, if you add a `--samples` flag, `ReviewArgs` gains `samples?: number` parsed from a flag.

- [ ] **Step 3: e2e (fixture-driven).** In the review e2e test, add a `samples: 2` case with per-sample fixtures; assert the aggregated `score` + a `confidence` in `(0, 1]`.

- [ ] **Step 4: Full gate + commit.** `npm run release:gate` — green, golden replay byte-stable (sampling off).

```bash
git add -A && git commit -m "feat: review --samples N with aggregated score + confidence"
```

---

## Execution order

1 → 2 → 3 (serial).

## Verification checklist

- [ ] `npm run release:gate` green; golden replay byte-stable at `samples === 1`.
- [ ] `samples > 1` → mean-aggregated score + confidence; `samples === 1` → byte-identical (null confidence).
- [ ] Confidence is deterministic and tested (identical samples → 1.0; divergent → < 1; single → null).
