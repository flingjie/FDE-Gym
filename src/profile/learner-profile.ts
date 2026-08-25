import { z } from "zod";

import { FDE_SCHEMA_VERSION, LocalizedTextSchema, type LocalizedText } from "../core/domain.js";

/**
 * FDE Gym — learner profile with the six-competency EMA.
 *
 * `updateLearnerProfile` applies the brief's EMA to each competency:
 *
 *   new competency = clamp(0, 100, 0.7 × previous + 0.3 × current attempt)
 *
 * The profile also persists attempts, hint reliance, repeated-question rate,
 * unsupported-claim rate, contradiction handling, the strongest/weakest
 * competency, and the latest three retry focuses.
 *
 * IMPORTANT: the profile affects COACHING RECOMMENDATIONS ONLY. It never
 * changes truth (ground truth, expected evidence, disclosure) or rubric
 * weights; nothing in this module mutates its inputs.
 */

// ---------------------------------------------------------------------------
// Competencies
// ---------------------------------------------------------------------------

export const COMPETENCY_KEYS = [
  "discovery",
  "problemFraming",
  "evidenceReasoning",
  "solutionDesign",
  "adaptability",
  "pitching",
] as const;
export type CompetencyKey = (typeof COMPETENCY_KEYS)[number];

/** Each competency is a score on 0..100. */
export type CompetencyScores = Record<CompetencyKey, number>;

export const CompetencyScoresSchema = z
  .object({
    discovery: z.number().min(0).max(100),
    problemFraming: z.number().min(0).max(100),
    evidenceReasoning: z.number().min(0).max(100),
    solutionDesign: z.number().min(0).max(100),
    adaptability: z.number().min(0).max(100),
    pitching: z.number().min(0).max(100),
  })
  .strict();

// ---------------------------------------------------------------------------
// Attempt review (current-attempt inputs)
// ---------------------------------------------------------------------------

export interface AttemptReview {
  /** Current-attempt competency scores, each 0..100. */
  competencies: CompetencyScores;
  /** 0..100. */
  hintReliance: number;
  /** 0..1. */
  repeatedQuestionRate: number;
  /** 0..1. */
  unsupportedClaimRate: number;
  /** 0..100. */
  contradictionHandling: number;
  /** The current attempt's focus summaries (0..3), used to build the retry-focus history. */
  retryFocuses: LocalizedText[];
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface LearnerProfile {
  /** Frozen schema version (Task 14). Load-time gated by `fs-store`. */
  schemaVersion: typeof FDE_SCHEMA_VERSION;
  competencies: CompetencyScores;
  attempts: number;
  hintReliance: number;
  repeatedQuestionRate: number;
  unsupportedClaimRate: number;
  contradictionHandling: number;
  strongestCompetency: CompetencyKey | null;
  weakestCompetency: CompetencyKey | null;
  /** Latest three retry focuses, NEWEST first. */
  retryFocuses: LocalizedText[];
  /** Effect ids already folded into this profile (exactly-once guard). */
  appliedEffectIds: string[];
  /** Run ids whose review has been folded into this profile. */
  appliedRunIds: string[];
}

export const LearnerProfileSchema = z
  .object({
    schemaVersion: z.literal(FDE_SCHEMA_VERSION),
    competencies: CompetencyScoresSchema,
    attempts: z.number().int().nonnegative(),
    hintReliance: z.number(),
    repeatedQuestionRate: z.number(),
    unsupportedClaimRate: z.number(),
    contradictionHandling: z.number(),
    strongestCompetency: z.enum(COMPETENCY_KEYS).nullable(),
    weakestCompetency: z.enum(COMPETENCY_KEYS).nullable(),
    retryFocuses: z.array(LocalizedTextSchema),
    appliedEffectIds: z.array(z.string().min(1)),
    appliedRunIds: z.array(z.string().min(1)),
  })
  .strict();

/** Neutral starting competency: the EMA's `previous` on the very first attempt. */
export const INITIAL_COMPETENCY = 50;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clamp100(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** A pristine profile with neutral competencies and zero attempts. */
export function createEmptyProfile(): LearnerProfile {
  const competencies = {} as CompetencyScores;
  for (const key of COMPETENCY_KEYS) competencies[key] = INITIAL_COMPETENCY;
  return {
    schemaVersion: FDE_SCHEMA_VERSION,
    competencies,
    attempts: 0,
    hintReliance: 0,
    repeatedQuestionRate: 0,
    unsupportedClaimRate: 0,
    contradictionHandling: 0,
    strongestCompetency: null,
    weakestCompetency: null,
    retryFocuses: [],
    appliedEffectIds: [],
    appliedRunIds: [],
  };
}

/**
 * Apply one attempt's review to the profile and return a NEW profile (inputs
 * are never mutated). Competencies follow the EMA; the remaining metrics store
 * the latest attempt's values; `attempts` increments; `strongest`/`weakest`
 * are recomputed (ties resolve to the first key in `COMPETENCY_KEYS` order);
 * `retryFocuses` keeps the latest three, newest first.
 */
export function updateLearnerProfile(
  profile: LearnerProfile,
  review: AttemptReview,
): LearnerProfile {
  const competencies = {} as CompetencyScores;
  let strongestScore = Number.NEGATIVE_INFINITY;
  let weakestScore = Number.POSITIVE_INFINITY;
  let strongestCompetency: CompetencyKey | null = null;
  let weakestCompetency: CompetencyKey | null = null;

  for (const key of COMPETENCY_KEYS) {
    const value = clamp100(0.7 * profile.competencies[key] + 0.3 * review.competencies[key]);
    competencies[key] = value;
    if (value > strongestScore) {
      strongestScore = value;
      strongestCompetency = key;
    }
    if (value < weakestScore) {
      weakestScore = value;
      weakestCompetency = key;
    }
  }

  const retryFocuses = [...review.retryFocuses, ...profile.retryFocuses].slice(0, 3);

  return {
    schemaVersion: FDE_SCHEMA_VERSION,
    competencies,
    attempts: profile.attempts + 1,
    hintReliance: clamp100(review.hintReliance),
    repeatedQuestionRate: clamp01(review.repeatedQuestionRate),
    unsupportedClaimRate: clamp01(review.unsupportedClaimRate),
    contradictionHandling: clamp100(review.contradictionHandling),
    strongestCompetency,
    weakestCompetency,
    retryFocuses,
    appliedEffectIds: profile.appliedEffectIds,
    appliedRunIds: profile.appliedRunIds,
  };
}
