import { SUPPORT_RATIO_THRESHOLD } from "../evidence/brief-validator.js";
import type {
  PassGateResults,
  QuestionEfficiencyBreakdown,
  ScoreBreakdown,
} from "../core/domain.js";
import { RAW_STAGE_WEIGHTS, type RubricStageId } from "./rubric.js";
import type { StageStates } from "./provenance.js";

export { FORMULA_VERSION } from "./provenance.js";

/**
 * FDE Gym — exact scoring formulas.
 *
 * These are implemented VERBATIM from the brief; they are the authority and
 * must not be "improved". Everything is deterministic: integer/float math only,
 * no `Math.random()`, no `Date.now()`, and rounding ONLY where the brief says
 * `round` (the Final score).
 *
 * Unit contract (the one place the brief's reuse of the word "coverage" is
 * resolved, so every formula stays self-consistent):
 *
 *   - `coverage` is a RATIO on `0..1`: revealed expected-evidence weight /
 *     total expected-evidence weight (question-driven revelation + automatic
 *     event disclosure).
 *   - `gq` / per-question information gain consume the SAME ratio but count
 *     ONLY question-driven revelation (`newlyRevealedWeight`). Automatic event
 *     disclosure contributes to `coverage` (and therefore QE / Discovery) but
 *     NEVER to a question's `gq` / `IGq`.
 *   - `QE = 100 × coverage × (0.6 + 0.4 × averageForm) × BudgetFactor` consumes
 *     the ratio directly (its leading `100 ×` turns it into a 0..100 score).
 *   - `Discovery = .35×coverage + .25×QE + .20×stakeholderCoverage + .20×contradictionHandling`
 *     uses the PERCENTAGE form of coverage (`100 × coverage`) so all four terms
 *     are commensurate 0..100 contributions whose weights sum to 1.
 *   - `stakeholderCoverage` and `contradictionHandling` are PERCENTAGES 0..100.
 *
 * All outputs clamp to 0..100; `final` is additionally rounded (half-up, JS
 * `Math.round`).
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One learner question's deterministic inputs (from the Evidence Tracker + the disclosure ledger). */
export interface QuestionScoreInput {
  /** Expected-evidence weight newly revealed BY THIS QUESTION (question-driven only; excludes automatic disclosure). */
  newlyRevealedWeight: number;
  atomicity: number;
  neutrality: number;
  relevance: number;
  redundancy: number;
}

export interface StageScores {
  framing: number;
  solution: number;
  challenge: number;
  pitch: number;
  process: number;
}

export interface HintCounts {
  /** Count of granted hints at level 1. */
  l1: number;
  l2: number;
  l3: number;
}

export interface ScoreInput {
  /** Final coverage ratio 0..1 (question-driven revelation + automatic event disclosure). */
  coverage: number;
  /** Sum of every expected-evidence weight in the evaluator capsule (strictly positive). */
  totalExpectedWeight: number;
  /** The scenario's question budget (strictly positive). */
  questionBudget: number;
  /** Per-question inputs, in asked order. `questionCount` is derived as its length. */
  questions: readonly QuestionScoreInput[];
  /** Percentage 0..100. */
  stakeholderCoverage: number;
  /** Percentage 0..100. */
  contradictionHandling: number;
  /** Already-computed stage scores, each a percentage 0..100. */
  stageScores: StageScores;
  hintCounts: HintCounts;
  /** Count of critical claims whose entailment is unsupported. */
  criticalUnsupported: number;
  /** Count of critical contradictions left unacknowledged. */
  unacknowledgedCriticalContradictions: number;
  /** Weighted brief support ratio 0..1 (see brief-validator). */
  briefSupport: number;
  pitchExplicitAsk: boolean;
  leakGuardViolation: boolean;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
//
// The three output shapes (`QuestionEfficiencyBreakdown`, `PassGateResults`,
// `ScoreBreakdown`) are defined in `core/domain.ts` (imported above) so the
// `score.computed` event's Zod schema and `calculateScore`'s return type can
// never drift.

// ---------------------------------------------------------------------------
// Clamps
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clamp100(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Per-question math
// ---------------------------------------------------------------------------

function computeQuestion(
  input: QuestionScoreInput,
  totalExpectedWeight: number,
  questionBudget: number,
): QuestionEfficiencyBreakdown {
  const gq = totalExpectedWeight > 0 ? input.newlyRevealedWeight / totalExpectedWeight : 0;
  const informationGain = 100 * Math.min(1, questionBudget * gq);
  const form =
    clamp01(input.atomicity) *
    clamp01(input.neutrality) *
    clamp01(input.relevance) *
    (1 - clamp01(input.redundancy));
  const efficiency = informationGain * form;
  return { gq, informationGain, form, efficiency };
}

// ---------------------------------------------------------------------------
// The scoring function
// ---------------------------------------------------------------------------

export function calculateScore(input: ScoreInput): ScoreBreakdown {
  const coverage = clamp01(input.coverage);
  const totalExpectedWeight = Math.max(0, input.totalExpectedWeight);
  const questionBudget = input.questionBudget;

  const questions = input.questions.map((question) =>
    computeQuestion(question, totalExpectedWeight, questionBudget),
  );
  const questionCount = questions.length;

  const averageForm =
    questionCount === 0 ? 0 : questions.reduce((sum, q) => sum + q.form, 0) / questionCount;

  const budgetFactor = Math.min(1, questionBudget / Math.max(questionCount, 1));

  const questionEfficiency = clamp100(
    100 * coverage * (0.6 + 0.4 * averageForm) * budgetFactor,
  );

  const coveragePercent = 100 * coverage;
  const stakeholderCoverage = clamp100(input.stakeholderCoverage);
  const contradictionHandling = clamp100(input.contradictionHandling);

  const discovery = clamp100(
    0.35 * coveragePercent +
      0.25 * questionEfficiency +
      0.2 * stakeholderCoverage +
      0.2 * contradictionHandling,
  );

  const framing = clamp100(input.stageScores.framing);
  const solution = clamp100(input.stageScores.solution);
  const challenge = clamp100(input.stageScores.challenge);
  const pitch = clamp100(input.stageScores.pitch);
  const process = clamp100(input.stageScores.process);

  const raw = clamp100(
    (RAW_STAGE_WEIGHTS.discovery / 100) * discovery +
      (RAW_STAGE_WEIGHTS.framing / 100) * framing +
      (RAW_STAGE_WEIGHTS.solution / 100) * solution +
      (RAW_STAGE_WEIGHTS.challenge / 100) * challenge +
      (RAW_STAGE_WEIGHTS.pitch / 100) * pitch +
      (RAW_STAGE_WEIGHTS.process / 100) * process,
  );

  const hintPenalty = Math.min(
    12,
    input.hintCounts.l1 + 3 * input.hintCounts.l2 + 6 * input.hintCounts.l3,
  );

  const integrity = Math.min(
    10,
    2 * input.criticalUnsupported + 5 * input.unacknowledgedCriticalContradictions,
  );

  const final = Math.round(clamp100(raw - hintPenalty - integrity));

  const passes: PassGateResults = {
    finalScore: final >= 75,
    briefSupport: input.briefSupport >= SUPPORT_RATIO_THRESHOLD,
    noUnacknowledgedCriticalContradiction: input.unacknowledgedCriticalContradictions === 0,
    pitchExplicitAsk: input.pitchExplicitAsk === true,
    noLeakGuardViolation: input.leakGuardViolation === false,
  };

  return {
    coverage,
    coveragePercent,
    averageForm,
    budgetFactor,
    questionEfficiency,
    discovery,
    framing,
    solution,
    challenge,
    pitch,
    process,
    raw,
    hintPenalty,
    integrity,
    final,
    questions,
    passes,
  };
}

// ---------------------------------------------------------------------------
// Measured-only capability (display time)
// ---------------------------------------------------------------------------

/**
 * The five rubric stages in canonical order. `discovery` is not a rubric stage
 * (it is coverage-derived) and is always treated as measured, so it is excluded
 * from this list and handled separately in `computeMeasuredCapability`.
 */
const RUBRIC_STAGES: readonly RubricStageId[] = [
  "framing",
  "solution",
  "challenge",
  "pitch",
  "process",
];

/**
 * A display-time capability figure that aggregates ONLY `measured` stages, so a
 * proxy or unscorable number is never mistaken for a real Coach measurement.
 * The committed `score.computed` bytes (`raw`/`final`/`ScoreBreakdown`) are
 * untouched — this is derived alongside them, never persisted in their place.
 *
 * Declared as a `type` alias (not an `interface`) so it stays assignable to the
 * command-transaction's strict `JsonValue` bound, exactly like the Zod-inferred
 * `ScoreBreakdown`/`FinalReviewResult` shapes it ships beside.
 */
export type MeasuredCapability = {
  /** Re-normalized 0–100 capability over discovery + measured stages only. */
  value: number;
  measuredStages: RubricStageId[];
  proxyStages: RubricStageId[];
  unscorableStages: RubricStageId[];
};

export function computeMeasuredCapability(
  score: ScoreBreakdown,
  stageStates: StageStates,
): MeasuredCapability {
  // discovery is always measured (coverage-derived, no rubric stage).
  let appliedWeight = RAW_STAGE_WEIGHTS.discovery;
  let weightedSum = (RAW_STAGE_WEIGHTS.discovery / 100) * score.discovery;
  const measured: RubricStageId[] = [];
  const proxy: RubricStageId[] = [];
  const unscorable: RubricStageId[] = [];
  for (const stage of RUBRIC_STAGES) {
    const state = stageStates[stage] ?? "measured"; // legacy: absent = measured
    const w = RAW_STAGE_WEIGHTS[stage];
    const s = score[stage];
    if (state === "measured") {
      measured.push(stage);
      appliedWeight += w;
      weightedSum += (w / 100) * s;
    } else if (state === "proxy") {
      proxy.push(stage);
    } else {
      unscorable.push(stage);
    }
  }
  const normalized = appliedWeight > 0 ? (weightedSum / (appliedWeight / 100)) : 0;
  // Clamp AFTER subtracting the run-level penalties (mirrors `final` in
  // `calculateScore`), so the figure stays in 0..100 and never goes negative.
  const value = Math.round(clamp100(normalized - score.hintPenalty - score.integrity));
  return { value, measuredStages: measured, proxyStages: proxy, unscorableStages: unscorable };
}
