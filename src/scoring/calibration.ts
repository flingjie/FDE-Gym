/**
 * FDE Gym — difficulty calibration + model-version drift statistics.
 *
 * Pure, deterministic leaf module: no Math.random, no wall-clock, no imports.
 * `computeDifficulty` summarizes a batch of task scores; `computeDrift`
 * compares a baseline score series against a current one to surface
 * model-version regressions.
 */

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
