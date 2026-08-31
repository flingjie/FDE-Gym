import { describe, expect, it } from "vitest";

import {
  calculateScore,
  computeMeasuredCapability,
  type ScoreBreakdown,
  type ScoreInput,
} from "../../src/scoring/formulas";
import type { StageStates } from "../../src/scoring/provenance";
import {
  RAW_STAGE_WEIGHTS,
  RUBRIC,
} from "../../src/scoring/rubric";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    coverage: 0.75,
    totalExpectedWeight: 10,
    questionBudget: 10,
    questions: [
      { newlyRevealedWeight: 2.5, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
      { newlyRevealedWeight: 0.5, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0.5 },
    ],
    stakeholderCoverage: 60,
    contradictionHandling: 40,
    stageScores: { framing: 90, solution: 85, challenge: 75, pitch: 80, process: 70 },
    hintCounts: { l1: 0, l2: 0, l3: 0 },
    criticalUnsupported: 0,
    unacknowledgedCriticalContradictions: 0,
    briefSupport: 0.8,
    pitchExplicitAsk: true,
    leakGuardViolation: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// exact full breakdown
// ---------------------------------------------------------------------------

describe("calculateScore: exact full breakdown", () => {
  it("computes every sub-score, penalty, and Final from known inputs", () => {
    const result = calculateScore(baseInput());

    // Per-question: Q1 gq=2.5/10=0.25 → IG=100 (budget-saturated); form=1.
    expect(result.questions[0].gq).toBe(0.25);
    expect(result.questions[0].informationGain).toBe(100);
    expect(result.questions[0].form).toBe(1);
    expect(result.questions[0].efficiency).toBe(100);

    // Q2 gq=0.5/10=0.05 → IG=100×min(1, 0.5)=50; form=1×1×1×0.5=0.5.
    expect(result.questions[1].gq).toBeCloseTo(0.05, 12);
    expect(result.questions[1].informationGain).toBeCloseTo(50, 12);
    expect(result.questions[1].form).toBe(0.5);
    expect(result.questions[1].efficiency).toBeCloseTo(25, 12);

    // Aggregate discovery inputs.
    expect(result.coverage).toBe(0.75);
    expect(result.coveragePercent).toBe(75);
    expect(result.averageForm).toBe(0.75);
    expect(result.budgetFactor).toBe(1);
    // QE = 100 × 0.75 × (0.6 + 0.4×0.75) × 1 = 100 × 0.75 × 0.9 = 67.5.
    expect(result.questionEfficiency).toBeCloseTo(67.5, 10);

    // Discovery = 0.35×75 + 0.25×67.5 + 0.20×60 + 0.20×40 = 26.25 + 16.875 + 12 + 8 = 63.125.
    expect(result.discovery).toBeCloseTo(63.125, 10);

    // Stage passthrough.
    expect(result.framing).toBe(90);
    expect(result.solution).toBe(85);
    expect(result.challenge).toBe(75);
    expect(result.pitch).toBe(80);
    expect(result.process).toBe(70);

    // Raw = 0.25×63.125 + 0.20×90 + 0.20×85 + 0.10×75 + 0.15×80 + 0.10×70
    //     = 15.78125 + 18 + 17 + 7.5 + 12 + 7 = 77.28125.
    expect(result.raw).toBeCloseTo(77.28125, 10);

    expect(result.hintPenalty).toBe(0);
    expect(result.integrity).toBe(0);
    // Final = round(clamp(77.28125)) = 77.
    expect(result.final).toBe(77);

    // Pass gates.
    expect(result.passes).toEqual({
      finalScore: true,
      briefSupport: true,
      noUnacknowledgedCriticalContradiction: true,
      pitchExplicitAsk: true,
      noLeakGuardViolation: true,
    });
  });
});

// ---------------------------------------------------------------------------
// automatic disclosure vs question information gain
// ---------------------------------------------------------------------------

describe("calculateScore: automatic disclosure is separate from question IG", () => {
  it("lets coverage (auto-disclosure) drive QE while question IG stays 0", () => {
    // coverage = 0.5 comes entirely from automatic event disclosure; the single
    // question reveals nothing new (newlyRevealedWeight = 0).
    const result = calculateScore(
      baseInput({
        coverage: 0.5,
        questions: [
          { newlyRevealedWeight: 0, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
        ],
      }),
    );

    // Coverage reflects the auto-disclosed weight.
    expect(result.coverage).toBe(0.5);
    expect(result.coveragePercent).toBe(50);
    // The question contributed NO information gain.
    expect(result.questions[0].gq).toBe(0);
    expect(result.questions[0].informationGain).toBe(0);
    // QE is still driven by coverage: 100 × 0.5 × (0.6 + 0.4×1) × 1 = 50.
    expect(result.averageForm).toBe(1);
    expect(result.questionEfficiency).toBeCloseTo(50, 10);
  });
});

// ---------------------------------------------------------------------------
// hint penalty
// ---------------------------------------------------------------------------

describe("calculateScore: hint penalty", () => {
  it("computes L1 + 3×L2 + 6×L3 when below the cap", () => {
    const result = calculateScore(baseInput({ hintCounts: { l1: 2, l2: 1, l3: 0 } }));
    // 2 + 3×1 + 6×0 = 5.
    expect(result.hintPenalty).toBe(5);
  });

  it("caps the hint penalty at 12", () => {
    const result = calculateScore(baseInput({ hintCounts: { l1: 5, l2: 5, l3: 5 } }));
    // 5 + 15 + 30 = 50 → min(12, 50) = 12.
    expect(result.hintPenalty).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// integrity
// ---------------------------------------------------------------------------

describe("calculateScore: integrity", () => {
  it("computes 2×criticalUnsupported + 5×unacknowledged below the cap", () => {
    const result = calculateScore(
      baseInput({ criticalUnsupported: 1, unacknowledgedCriticalContradictions: 1 }),
    );
    // 2×1 + 5×1 = 7.
    expect(result.integrity).toBe(7);
  });

  it("caps integrity at 10", () => {
    const result = calculateScore(
      baseInput({ criticalUnsupported: 5, unacknowledgedCriticalContradictions: 5 }),
    );
    // 10 + 25 = 35 → min(10, 35) = 10.
    expect(result.integrity).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// clamping
// ---------------------------------------------------------------------------

describe("calculateScore: clamping to 0..100", () => {
  it("clamps Final to 0 when penalties exceed Raw", () => {
    const result = calculateScore(
      baseInput({
        coverage: 0,
        questions: [],
        stakeholderCoverage: 0,
        contradictionHandling: 0,
        stageScores: { framing: 0, solution: 0, challenge: 0, pitch: 0, process: 0 },
        hintCounts: { l1: 0, l2: 0, l3: 100 }, // penalty 12
        criticalUnsupported: 100,
        unacknowledgedCriticalContradictions: 100, // integrity 10
      }),
    );
    expect(result.raw).toBe(0);
    expect(result.discovery).toBe(0);
    // clamp(0 - 12 - 10) = 0.
    expect(result.final).toBe(0);
  });

  it("clamps Final to 100 and clamps over-range inputs", () => {
    const result = calculateScore(
      baseInput({
        coverage: 1.5, // clamped to 1
        questions: [
          { newlyRevealedWeight: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
        ],
        stakeholderCoverage: 100,
        contradictionHandling: 100,
        stageScores: { framing: 200, solution: 100, challenge: 100, pitch: 100, process: 100 },
      }),
    );
    expect(result.coverage).toBe(1);
    expect(result.framing).toBe(100); // 200 clamped to 100
    expect(result.discovery).toBe(100);
    expect(result.raw).toBe(100);
    expect(result.final).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// budget factor + IG saturation
// ---------------------------------------------------------------------------

describe("calculateScore: budget factor and information gain", () => {
  it("scales QE by min(1, budget / questionCount) when the budget is exhausted", () => {
    const result = calculateScore(
      baseInput({
        coverage: 1,
        questionBudget: 4,
        questions: Array.from({ length: 10 }, () => ({
          newlyRevealedWeight: 1,
          atomicity: 1,
          neutrality: 1,
          relevance: 1,
          redundancy: 0,
        })),
      }),
    );
    // 10 questions, budget 4 → BudgetFactor = 4/10 = 0.4.
    expect(result.budgetFactor).toBeCloseTo(0.4, 12);
    // QE = 100 × 1 × (0.6 + 0.4×1) × 0.4 = 40.
    expect(result.averageForm).toBe(1);
    expect(result.questionEfficiency).toBeCloseTo(40, 10);
  });

  it("saturates per-question IG at 100 once questionBudget × gq ≥ 1", () => {
    const result = calculateScore(
      baseInput({
        questions: [
          { newlyRevealedWeight: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 }, // gq 0.1 → IG 100
          { newlyRevealedWeight: 5, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 }, // gq 0.5 → IG 100
          { newlyRevealedWeight: 0.1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 }, // gq 0.01 → IG 10
        ],
      }),
    );
    expect(result.questions[0].informationGain).toBe(100);
    expect(result.questions[1].informationGain).toBe(100);
    expect(result.questions[2].informationGain).toBeCloseTo(10, 12);
  });

  it("reduces efficiency for a repeated question (redundancy + zero new weight)", () => {
    const result = calculateScore(
      baseInput({
        questions: [
          { newlyRevealedWeight: 5, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 }, // fresh
          { newlyRevealedWeight: 0, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 1 }, // repeat
        ],
      }),
    );
    expect(result.questions[0].efficiency).toBe(100);
    expect(result.questions[1].informationGain).toBe(0);
    expect(result.questions[1].efficiency).toBe(0);
    expect(result.questions[1].efficiency).toBeLessThan(result.questions[0].efficiency);
  });
});

// ---------------------------------------------------------------------------
// rubric source of truth
// ---------------------------------------------------------------------------

describe("rubric: stage/criterion and raw weights are the brief's exact values", () => {
  it("exposes the five stage tables with weights summing to 100", () => {
    const expectedStageWeights: Record<string, number[]> = {
      framing: [40, 25, 20, 15],
      solution: [30, 25, 20, 15, 10],
      challenge: [40, 30, 30],
      pitch: [25, 25, 20, 15, 15],
      process: [40, 25, 20, 15],
    };
    for (const [stage, weights] of Object.entries(expectedStageWeights)) {
      const criteria = RUBRIC[stage as keyof typeof RUBRIC];
      expect(criteria.map((c) => c.weight)).toEqual(weights);
      expect(criteria.reduce((sum, c) => sum + c.weight, 0)).toBe(100);
    }
  });

  it("exposes the Raw stage weights summing to 100", () => {
    expect(RAW_STAGE_WEIGHTS).toEqual({
      discovery: 25,
      framing: 20,
      solution: 20,
      challenge: 10,
      pitch: 15,
      process: 10,
    });
    expect(Object.values(RAW_STAGE_WEIGHTS).reduce((sum, w) => sum + w, 0)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// measured-only capability (display time)
// ---------------------------------------------------------------------------

describe("computeMeasuredCapability: measured-only aggregation", () => {
  it("measured-only capability excludes proxy and unscorable stages", () => {
    const score = {
      discovery: 80,
      framing: 90,
      solution: 50,
      challenge: 100,
      pitch: 0,
      process: 100,
      raw: 60,
      final: 50,
      hintPenalty: 0,
      integrity: 0,
    } as ScoreBreakdown;
    const states: StageStates = {
      framing: "measured",
      solution: "proxy",
      challenge: "unscorable",
      pitch: "proxy",
      process: "measured",
    };
    const cap = computeMeasuredCapability(score, states);
    expect(cap.measuredStages).toEqual(["framing", "process"]);
    expect(cap.proxyStages).toEqual(["solution", "pitch"]);
    expect(cap.unscorableStages).toEqual(["challenge"]);
    // discovery(25) + framing(20) + process(10) = 55 weight; weighted sum =
    // .25*80 + .20*90 + .10*100 = 20+18+10 = 48; normalized = 48 / 0.55 = 87.27 → 87.
    expect(cap.value).toBe(87);
  });

  it("all-unscorable rubric stages still yields discovery-only value", () => {
    const score = {
      discovery: 80,
      framing: 0,
      solution: 0,
      challenge: 0,
      pitch: 0,
      process: 0,
      raw: 20,
      final: 20,
      hintPenalty: 0,
      integrity: 0,
    } as ScoreBreakdown;
    const states: StageStates = {
      framing: "unscorable",
      solution: "unscorable",
      challenge: "unscorable",
      pitch: "unscorable",
      process: "unscorable",
    };
    expect(computeMeasuredCapability(score, states).value).toBe(80);
  });

  it("clamps after subtracting penalties so value never goes negative", () => {
    const score = {
      discovery: 20,
      framing: 20,
      solution: 0,
      challenge: 0,
      pitch: 0,
      process: 0,
      raw: 5,
      final: 0,
      hintPenalty: 12,
      integrity: 10,
    } as ScoreBreakdown;
    const states: StageStates = {
      framing: "measured",
      solution: "unscorable",
      challenge: "unscorable",
      pitch: "unscorable",
      process: "unscorable",
    };
    // discovery-only: normalized = 20; 20 - 12 - 10 = -2 → clamped to 0.
    expect(computeMeasuredCapability(score, states).value).toBe(0);
  });
});
