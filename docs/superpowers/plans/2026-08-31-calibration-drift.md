# Scenario Difficulty Calibration + Model-Version Drift (Phase 3d) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pure, tested difficulty/drift statistics and a measurement script that runs a scenario N times against a real model and reports the distribution.

**Architecture:** `src/scoring/calibration.ts` (pure `computeDifficulty` + `computeDrift`); `scripts/calibrate.mjs` (a gated harness using `DirectModelRuntime`).

**Tech Stack:** TypeScript (Node ≥ 22), Vitest. No new deps.

**Spec:** `docs/superpowers/specs/2026-08-31-calibration-drift-design.md`

## Global Constraints

- Pure functions deterministic (no Math.random/wall-clock) and unit-tested.
- The script is a measurement harness, gated on explicit `FDE_GYM_MODEL_BASE_URL`+`FDE_GYM_MODEL` (NOT `resolveDirectModelConfig`'s config.toml fallback — reuse the contract suite's gating), not in CI/release:gate.
- Source `.js`; test extensionless; no new deps.

---

### Task 1: `src/scoring/calibration.ts` + unit tests

**Files:**
- Create: `src/scoring/calibration.ts`
- Create: `tests/unit/calibration.test.ts`

- [ ] **Step 1: Implement `calibration.ts`.**

```ts
export interface DifficultyStats {
  n: number;
  mean: number;
  stdDev: number; // population
  min: number;
  max: number;
}

export function computeDifficulty(scores: readonly number[]): DifficultyStats {
  if (scores.length === 0) return { n: 0, mean: 0, stdDev: 0, min: 0, max: 0 };
  const n = scores.length;
  const mean = scores.reduce((s, x) => s + x, 0) / n;
  const variance = scores.reduce((s, x) => s + (x - mean) * (x - mean), 0) / n;
  let min = Infinity;
  let max = -Infinity;
  for (const x of scores) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { n, mean, stdDev: Math.sqrt(variance), min, max };
}

export interface DriftStats {
  baselineMean: number;
  currentMean: number;
  meanDiff: number;    // currentMean - baselineMean
  meanAbsDiff: number; // mean |current_i - baseline_i| over paired scores
  n: number;           // min(baseline.length, current.length)
}

export function computeDrift(baseline: readonly number[], current: readonly number[]): DriftStats {
  const n = Math.min(baseline.length, current.length);
  if (n === 0) return { baselineMean: 0, currentMean: 0, meanDiff: 0, meanAbsDiff: 0, n: 0 };
  const baselineMean = baseline.reduce((s, x) => s + x, 0) / baseline.length;
  const currentMean = current.reduce((s, x) => s + x, 0) / current.length;
  let absSum = 0;
  for (let i = 0; i < n; i++) absSum += Math.abs(current[i] - baseline[i]);
  return {
    baselineMean,
    currentMean,
    meanDiff: currentMean - baselineMean,
    meanAbsDiff: absSum / n,
    n,
  };
}
```

- [ ] **Step 2: Unit tests.** `tests/unit/calibration.test.ts`: `computeDifficulty` empty/single/spread; `computeDrift` empty/identical/shifted/unequal-length.

- [ ] **Step 3: Verify + commit.** `npm run typecheck && npm test`.

```bash
git add -A && git commit -m "feat: add difficulty + drift statistics"
```

---

### Task 2: `scripts/calibrate.mjs`

**Files:**
- Create: `scripts/calibrate.mjs`

- [ ] **Step 1: Write the script.** Gate on explicit env vars (same as the contract suite); run a compiled scenario `N` times (default 3) via the CLI/use cases with `DirectModelRuntime`; print per-run `final` score and the `computeDifficulty` stats; if `--baseline <json>` is given, print `computeDrift(baseline, current)`. Exit 0 with a "no endpoint configured" message when the env vars are absent. Not wired into any npm script (it is a manual measurement tool).

- [ ] **Step 2: Verify + commit.** `npm run typecheck && npm test` — unchanged (746 + new unit tests green). Confirm the script exits cleanly with no endpoint (`node scripts/calibrate.mjs` prints the no-endpoint message and exits 0).

```bash
git add -A && git commit -m "feat: add calibration/drift measurement script"
```

---

## Execution order

1 → 2.

## Verification checklist

- [ ] `npm run release:gate` green (script excluded; new unit tests green).
- [ ] `computeDifficulty`/`computeDrift` deterministic and tested.
- [ ] `scripts/calibrate.mjs` exits cleanly with no endpoint, runs + reports with one.
