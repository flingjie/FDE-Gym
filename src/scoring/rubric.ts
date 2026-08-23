/**
 * FDE Gym — canonical FDE-capability scoring rubric.
 *
 * This is the SINGLE source of truth for the stage/criterion weights and the
 * Raw stage weights used by `formulas.ts` and any future task that turns Coach
 * criterion judgments into a stage score. It is DISTINCT from the scenario-
 * authored `rubric` on the `EvaluatorCapsule` (which describes scenario-specific
 * deliverable quality): this table is the fixed capability-dimension weighting
 * from the brief and never varies per scenario.
 *
 * Labels are English-only: the brief specifies these names verbatim in English
 * and provides no bilingual copy, so we do not invent translations here.
 * Localization of these labels (for learner-facing coaching) is a later concern.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const RUBRIC_STAGE_IDS = ["framing", "solution", "challenge", "pitch", "process"] as const;
export type RubricStageId = (typeof RUBRIC_STAGE_IDS)[number];

/** A single criterion and its weight in percentage points (0..100) within its stage. */
export interface RubricCriterion {
  id: string;
  label: string;
  weight: number;
}

// ---------------------------------------------------------------------------
// Stage / criterion weights (verbatim from the brief)
// ---------------------------------------------------------------------------

/** Problem Framing = 40% Evidence Support + 25% Goal Clarity + 20% Constraints/Trade-offs + 15% Unknown/Risk Handling. */
export const FRAMING_CRITERIA: readonly RubricCriterion[] = [
  { id: "evidence-support", label: "Evidence Support", weight: 40 },
  { id: "goal-clarity", label: "Goal Clarity", weight: 25 },
  { id: "constraints-tradeoffs", label: "Constraints/Trade-offs", weight: 20 },
  { id: "unknown-risk-handling", label: "Unknown/Risk Handling", weight: 15 },
];

/** Solution Design = 30% Traceability + 25% Feasibility + 20% Trade-offs + 15% Validation + 10% Scope Discipline. */
export const SOLUTION_CRITERIA: readonly RubricCriterion[] = [
  { id: "traceability", label: "Traceability", weight: 30 },
  { id: "feasibility", label: "Feasibility", weight: 25 },
  { id: "tradeoffs", label: "Trade-offs", weight: 20 },
  { id: "validation", label: "Validation", weight: 15 },
  { id: "scope-discipline", label: "Scope Discipline", weight: 10 },
];

/** Challenge = 40% Adaptation + 30% Valid Invariants + 30% New Evidence. */
export const CHALLENGE_CRITERIA: readonly RubricCriterion[] = [
  { id: "adaptation", label: "Adaptation", weight: 40 },
  { id: "valid-invariants", label: "Valid Invariants", weight: 30 },
  { id: "new-evidence", label: "New Evidence", weight: 30 },
];

/** Pitch = 25% Audience Fit + 25% Problem/Evidence + 20% Recommendation + 15% Risks/Ask + 15% Concision/Structure. */
export const PITCH_CRITERIA: readonly RubricCriterion[] = [
  { id: "audience-fit", label: "Audience Fit", weight: 25 },
  { id: "problem-evidence", label: "Problem/Evidence", weight: 25 },
  { id: "recommendation", label: "Recommendation", weight: 20 },
  { id: "risks-ask", label: "Risks/Ask", weight: 15 },
  { id: "concision-structure", label: "Concision/Structure", weight: 15 },
];

/** Process = 40% Evidence Hygiene + 25% Fact/Assumption Separation + 20% Contradictions + 15% Stage Discipline. */
export const PROCESS_CRITERIA: readonly RubricCriterion[] = [
  { id: "evidence-hygiene", label: "Evidence Hygiene", weight: 40 },
  { id: "fact-assumption-separation", label: "Fact/Assumption Separation", weight: 25 },
  { id: "contradictions", label: "Contradictions", weight: 20 },
  { id: "stage-discipline", label: "Stage Discipline", weight: 15 },
];

/** The full stage → criterion table, keyed by stable stage id. */
export const RUBRIC: Readonly<Record<RubricStageId, readonly RubricCriterion[]>> = {
  framing: FRAMING_CRITERIA,
  solution: SOLUTION_CRITERIA,
  challenge: CHALLENGE_CRITERIA,
  pitch: PITCH_CRITERIA,
  process: PROCESS_CRITERIA,
};

// ---------------------------------------------------------------------------
// Raw stage weights (verbatim from the brief)
// ---------------------------------------------------------------------------

/**
 * Raw = 25% Discovery + 20% Framing + 20% Solution + 10% Challenge
 *     + 15% Pitch + 10% Process.
 *
 * Values are percentage points (sum = 100). `discovery` is not a rubric stage
 * but contributes to Raw, so it lives here alongside the five stage weights.
 */
export const RAW_STAGE_WEIGHTS: Readonly<Record<"discovery" | RubricStageId, number>> = {
  discovery: 25,
  framing: 20,
  solution: 20,
  challenge: 10,
  pitch: 15,
  process: 10,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp100(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Weight a set of per-criterion scores (0..100) into a stage score (0..100):
 *
 *   StageScore = Σ (criterion.weight × criterionScore) / 100
 *
 * Criterion scores are keyed by criterion id; a missing id scores 0. Because
 * each stage's weights sum to 100, the result is a weighted mean on 0..100.
 * Deterministic: no randomness, no wall-clock.
 */
export function computeStageScore(
  stageId: RubricStageId,
  criterionScores: Readonly<Record<string, number>>,
): number {
  const criteria = RUBRIC[stageId];
  let total = 0;
  for (const criterion of criteria) {
    total += criterion.weight * (criterionScores[criterion.id] ?? 0);
  }
  return clamp100(total / 100);
}
