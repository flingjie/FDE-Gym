import { createHash } from "node:crypto";
import { z } from "zod";

import {
  CAPABILITY_RUBRIC_ID,
  CAPABILITY_RUBRIC_VERSION,
  capabilityRubricSha256,
  type RubricStageId,
} from "./rubric.js";

/**
 * FDE Gym — score provenance (Task 8).
 *
 * Every persisted `score.computed` carries a `ScoreProvenance` that records the
 * identity of the scoring function that produced it (score schema, formula,
 * capability rubric id/version/content, output schema, model family) plus a
 * per-stage source (`model` vs `deterministic-fallback`). A `comparabilityKey`
 * hashes the comparability-relevant identity so scores from different rubrics /
 * models / formulas are never silently blended.
 *
 * The provenance holds ONLY learner-safe metadata: version integers, stable ids,
 * content hashes, and per-stage source tags. It never carries prompts, canaries,
 * raw model payload, or hidden scenario rubric contents.
 */

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

/** The persisted score schema version (the `score.computed` shape). */
export const SCORE_SCHEMA_VERSION = 1 as const;
/** The exact scoring formula version (`src/scoring/formulas.ts`). */
export const FORMULA_VERSION = 1 as const;
/** The Coach final-review output schema version that produced the criterion scores. */
export const OUTPUT_SCHEMA_VERSION = 1 as const;

/**
 * Comparability key assigned to legacy (pre-Task 8) scores that predate
 * provenance. It is a non-hash sentinel so it can never collide with a real
 * comparability key, and always marks the score non-comparable.
 */
export const LEGACY_COMPARABILITY_KEY = "legacy-v1-non-comparable" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The source of one stage's score. */
export interface StageScoreProvenance {
  source: "model" | "deterministic-fallback";
  /** Why the deterministic fallback was used (only present when it was). */
  fallbackReason?: string;
}

export const StageScoreProvenanceSchema = z
  .object({
    source: z.enum(["model", "deterministic-fallback"]),
    fallbackReason: z.string().min(1).optional(),
  })
  .strict();

export interface ScoreProvenance {
  scoreSchemaVersion: typeof SCORE_SCHEMA_VERSION;
  formulaVersion: typeof FORMULA_VERSION;
  capabilityRubricId: typeof CAPABILITY_RUBRIC_ID;
  capabilityRubricVersion: typeof CAPABILITY_RUBRIC_VERSION;
  capabilityRubricSha256: string;
  scenarioBundleSha256: string | null;
  outputSchemaVersion: typeof OUTPUT_SCHEMA_VERSION;
  evaluatorInvocationId: string | null;
  modelId: string | null;
  stages: Record<RubricStageId, StageScoreProvenance>;
  comparabilityKey: string;
}

const StagesSchema = z
  .object({
    framing: StageScoreProvenanceSchema,
    solution: StageScoreProvenanceSchema,
    challenge: StageScoreProvenanceSchema,
    pitch: StageScoreProvenanceSchema,
    process: StageScoreProvenanceSchema,
  })
  .strict();

export const ScoreProvenanceSchema = z
  .object({
    scoreSchemaVersion: z.literal(SCORE_SCHEMA_VERSION),
    formulaVersion: z.literal(FORMULA_VERSION),
    capabilityRubricId: z.literal(CAPABILITY_RUBRIC_ID),
    capabilityRubricVersion: z.literal(CAPABILITY_RUBRIC_VERSION),
    capabilityRubricSha256: z.string().regex(/^[0-9a-f]{64}$/),
    scenarioBundleSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    outputSchemaVersion: z.literal(OUTPUT_SCHEMA_VERSION),
    evaluatorInvocationId: z.string().min(1).nullable(),
    modelId: z.string().min(1).nullable(),
    stages: StagesSchema,
    comparabilityKey: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Comparability
// ---------------------------------------------------------------------------

/** The identity that determines whether two scores may be compared/blended. */
export interface ComparabilityIdentity {
  scoreSchemaVersion: number;
  formulaVersion: number;
  capabilityRubricId: string;
  capabilityRubricVersion: number;
  capabilityRubricSha256: string;
  outputSchemaVersion: number;
  /** The configured model identifier (the model FAMILY, not a per-run instance). */
  modelId: string | null;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic comparability key over the scoring identity. Excludes
 * `scenarioBundleSha256` (the fixed rubric is scenario-independent),
 * `evaluatorInvocationId`, and per-stage sources (run-specific, not identity).
 */
export function computeComparabilityKey(identity: ComparabilityIdentity): string {
  return sha256Hex(
    JSON.stringify({
      scoreSchemaVersion: identity.scoreSchemaVersion,
      formulaVersion: identity.formulaVersion,
      capabilityRubricId: identity.capabilityRubricId,
      capabilityRubricVersion: identity.capabilityRubricVersion,
      capabilityRubricSha256: identity.capabilityRubricSha256,
      outputSchemaVersion: identity.outputSchemaVersion,
      modelFamily: identity.modelId,
    }),
  );
}

// ---------------------------------------------------------------------------
// Stage provenance derivation
// ---------------------------------------------------------------------------

/** Per-stage criterion maps as passed to `buildScoreInput` (structural, no domain import). */
export type CriterionScoreMap = Readonly<Record<string, number>>;
export type PerStageCriterionScores = Readonly<Partial<Record<RubricStageId, CriterionScoreMap>>>;

const STAGE_FALLBACK_REASON = "missing coach criterion scores" as const;

/**
 * Derive each stage's provenance source: a stage with at least one criterion
 * score is model-derived; otherwise it used the deterministic fallback.
 */
export function deriveStageProvenance(
  criterionScores: PerStageCriterionScores | undefined,
): Record<RubricStageId, StageScoreProvenance> {
  const source = (stage: RubricStageId): StageScoreProvenance => {
    const map = criterionScores?.[stage];
    if (map !== undefined && Object.keys(map).length > 0) return { source: "model" };
    return { source: "deterministic-fallback", fallbackReason: STAGE_FALLBACK_REASON };
  };
  return {
    framing: source("framing"),
    solution: source("solution"),
    challenge: source("challenge"),
    pitch: source("pitch"),
    process: source("process"),
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildScoreProvenanceInput {
  stageProvenance: Record<RubricStageId, StageScoreProvenance>;
  evaluatorInvocationId: string | null;
  modelId: string | null;
  scenarioBundleSha256: string | null;
}

/** Assemble the full provenance for a newly-computed score and stamp its comparability key. */
export function buildScoreProvenance(input: BuildScoreProvenanceInput): ScoreProvenance {
  const rubricSha = capabilityRubricSha256();
  return ScoreProvenanceSchema.parse({
    scoreSchemaVersion: SCORE_SCHEMA_VERSION,
    formulaVersion: FORMULA_VERSION,
    capabilityRubricId: CAPABILITY_RUBRIC_ID,
    capabilityRubricVersion: CAPABILITY_RUBRIC_VERSION,
    capabilityRubricSha256: rubricSha,
    scenarioBundleSha256: input.scenarioBundleSha256,
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    evaluatorInvocationId: input.evaluatorInvocationId,
    modelId: input.modelId,
    stages: input.stageProvenance,
    comparabilityKey: computeComparabilityKey({
      scoreSchemaVersion: SCORE_SCHEMA_VERSION,
      formulaVersion: FORMULA_VERSION,
      capabilityRubricId: CAPABILITY_RUBRIC_ID,
      capabilityRubricVersion: CAPABILITY_RUBRIC_VERSION,
      capabilityRubricSha256: rubricSha,
      outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
      modelId: input.modelId,
    }),
  });
}

/** The non-comparable provenance assigned to legacy (pre-Task 8) v1 scores at upcast time. */
export function legacyScoreProvenance(): ScoreProvenance {
  return {
    scoreSchemaVersion: SCORE_SCHEMA_VERSION,
    formulaVersion: FORMULA_VERSION,
    capabilityRubricId: CAPABILITY_RUBRIC_ID,
    capabilityRubricVersion: CAPABILITY_RUBRIC_VERSION,
    capabilityRubricSha256: capabilityRubricSha256(),
    scenarioBundleSha256: null,
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    evaluatorInvocationId: null,
    modelId: null,
    stages: deriveStageProvenance(undefined),
    comparabilityKey: LEGACY_COMPARABILITY_KEY,
  };
}
