import { describe, expect, it } from "vitest";
import { computeDifficulty, computeDrift } from "../../src/scoring/calibration";

describe("computeDifficulty", () => {
  it("empty scores → all-zero stats", () => {
    expect(computeDifficulty([])).toEqual({ n: 0, mean: 0, stdDev: 0, min: 0, max: 0 });
  });

  it("single score → mean/min/max equal, zero stdDev", () => {
    expect(computeDifficulty([5])).toEqual({ n: 1, mean: 5, stdDev: 0, min: 5, max: 5 });
  });

  it("spread scores → population stdDev, min, and max", () => {
    // mean = 5; squared deviations sum to 32; population stdDev = sqrt(32/8) = 2.
    const stats = computeDifficulty([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(stats.n).toBe(8);
    expect(stats.mean).toBe(5);
    expect(stats.stdDev).toBe(2);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(9);
  });
});

describe("computeDrift", () => {
  it("empty series → all-zero stats", () => {
    expect(computeDrift([], [])).toEqual({ baselineMean: 0, currentMean: 0, meanDiff: 0, meanAbsDiff: 0, n: 0 });
  });

  it("identical series → zero drift", () => {
    const drift = computeDrift([1, 2, 3], [1, 2, 3]);
    expect(drift).toEqual({ baselineMean: 2, currentMean: 2, meanDiff: 0, meanAbsDiff: 0, n: 3 });
  });

  it("shifted series → meanDiff and meanAbsDiff reflect the shift", () => {
    const drift = computeDrift([1, 2, 3], [4, 5, 6]);
    expect(drift.baselineMean).toBe(2);
    expect(drift.currentMean).toBe(5);
    expect(drift.meanDiff).toBe(3);
    expect(drift.meanAbsDiff).toBe(3);
    expect(drift.n).toBe(3);
  });

  it("unequal lengths → n is the min, means over full series, abs over paired prefix", () => {
    const drift = computeDrift([1, 2, 3, 4], [10, 20]);
    expect(drift.n).toBe(2);
    expect(drift.baselineMean).toBe(2.5); // (1+2+3+4)/4
    expect(drift.currentMean).toBe(15);   // (10+20)/2
    expect(drift.meanDiff).toBe(12.5);
    expect(drift.meanAbsDiff).toBe(13.5); // (|10-1| + |20-2|)/2
  });
});
