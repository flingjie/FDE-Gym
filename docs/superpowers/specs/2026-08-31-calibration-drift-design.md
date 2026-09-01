# Phase 3d — Scenario Difficulty Calibration + Model-Version Drift

**Date:** 2026-08-31
**Status:** Approved for implementation planning
**Scope:** FDEGym Phase 3 "评测可信度" — final sub-project (measurement tools)

## Context

With the Evaluation Identity (3a) and confidence (3b) in place, the last piece is measuring
how a scenario's scores distribute (difficulty) and how scores shift across model versions
(drift). Difficulty tells a scenario author whether their scenario is too easy/hard; drift
tells whether a model change meaningfully moved the evaluation.

## Goal

- A pure, tested `src/scoring/calibration.ts` with difficulty + drift statistics.
- A `scripts/calibrate.mjs` that runs a scenario N times against a real model and reports the
  difficulty; and compares two score sets for drift.

## Non-negotiable constraints

- Pure statistics are deterministic (no `Math.random`, no wall-clock) and unit-tested.
- The script is a measurement harness (like the real-model contract suite) — gated on the
  explicit model env vars, NOT part of CI/release:gate, and skips/exits cleanly when absent.
- No new deps; source `.js`; test extensionless.

## 1. `src/scoring/calibration.ts` (pure)

```ts
export interface DifficultyStats {
  n: number;
  mean: number;
  stdDev: number;   // population
  min: number;
  max: number;
}

export function computeDifficulty(scores: readonly number[]): DifficultyStats;
// n === 0 → { n: 0, mean: 0, stdDev: 0, min: 0, max: 0 }

export interface DriftStats {
  baselineMean: number;
  currentMean: number;
  meanDiff: number;        // currentMean - baselineMean (signed)
  meanAbsDiff: number;     // mean |current - baseline| over paired scores
  n: number;               // min(baseline.length, current.length)
}

export function computeDrift(baseline: readonly number[], current: readonly number[]): DriftStats;
// pairs scores positionally up to the shorter length; if either is empty → n 0 and zeros
```

## 2. `scripts/calibrate.mjs`

Runs a compiled scenario `N` times (default 3) through the CLI/use cases with
`DirectModelRuntime` and reports, per run, the `final` score, and across runs the
`computeDifficulty` stats. When `--baseline <json>` is supplied (a JSON array of prior
scores), it also reports `computeDrift(baseline, current)`.

Gated on `FDE_GYM_MODEL_BASE_URL` + `FDE_GYM_MODEL` (explicit env, like the contract suite);
exits 0 with a clear "no endpoint configured" message otherwise. Not wired into CI.

## Out of scope

- Multi-model benchmark harness beyond the drift comparator (this is a measurement primitive).
- Auto-tuning scenario difficulty (the output informs authors; it does not rewrite scenarios).

## Testing

- Unit tests for `computeDifficulty` (empty, single, spread) and `computeDrift` (empty,
  identical, shifted, unequal lengths).

## Success criteria

- `npm run release:gate` green; the script is not part of it.
- `computeDifficulty`/`computeDrift` are deterministic and tested; `scripts/calibrate.mjs`
  runs against a live endpoint and reports the stats (skips cleanly without one).
