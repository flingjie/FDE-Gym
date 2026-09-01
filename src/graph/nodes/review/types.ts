import type { z } from "zod";

import type { AgentRuntime } from "../../../agents/agent-runtime.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type {
  AgentRole,
  CriterionScores,
  FinalReviewResult,
  LocalizedText,
  RunEvent,
  ScoreBreakdown,
} from "../../../core/domain.js";
import type { JudgmentProvenance } from "../../../core/judgment.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
} from "../../../scenarios/schema.js";
import type { MeasuredCapability, ScoreInput } from "../../../scoring/formulas.js";
import type { ScoreProvenance, StageStates } from "../../../scoring/provenance.js";
import type { RawAgentResult } from "../../../security/sanitizer.js";

/**
 * FDE Gym — review subgraph input/output types (Phase 3, G3-04).
 *
 * Each node in the review pipeline (`review.input.build` → `coach.review.invoke`
 * → `judgment.guard` → `score.compute` → `profile.effect.prepare` →
 * `review.commit`) has a self-contained input type; a later integration wires
 * one node's extra output fields into the next node's input. These mirror
 * `prepareReview` in `src/core/orchestrator.ts` WITHOUT importing it.
 */

/** `review.input.build` — the deterministic derivation of the score input, its provenance, and the per-stage states. */
export interface ReviewInputBuildInput {
  state: RunAggregate;
  events: readonly RunEvent[];
  customerCapsule: CustomerCapsule;
  evaluatorCapsule: EvaluatorCapsule;
  publicScenario: PublicScenario;
  /** The Coach's per-criterion scores from final-review; absent → deterministic fallback. */
  criterionScores?: CriterionScores;
  evaluatorInvocationId?: string | null;
  modelId?: string | null;
  scenarioBundleSha256?: string | null;
}

/** The result of `review.input.build` (`buildScoreInput`): input + provenance + stage states. */
export interface BuiltScoreInput {
  input: ScoreInput;
  provenance: ScoreProvenance;
  stageStates: StageStates;
}

/** `coach.review.invoke` — run the Coach final-review (single or N samples). */
export interface CoachReviewInvokeInput {
  runtime: AgentRuntime;
  state: RunAggregate;
  capsule: EvaluatorCapsule;
  commandId: string;
  timeoutMs?: number;
  /** Number of independent Coach final-review invocations (defaults to 1). */
  samples?: number;
  canaries?: readonly string[];
  /** The verified scenario-bundle digest recorded at run start (judgment provenance only). */
  scenarioBundleSha256?: string | null;
}

/** The Coach final-review result plus the aggregation/provenance metadata the rest of the pipeline needs. */
export interface CoachReviewInvocation {
  review: FinalReviewResult;
  /** Cross-sample aggregation confidence; null for the single-invocation path. */
  confidence: number | null;
  evaluatorInvocationId: string | null;
  modelId: string | null;
  /** The per-invocation judgment envelope; undefined for the aggregated path. */
  judgment: JudgmentProvenance | undefined;
}

/**
 * `judgment.guard` — sanitize/validate a raw role payload via `judgmentValid`.
 * Carries `state` only so the handler can pass the aggregate through unchanged
 * in `NodeExecution.updatedState` (guards produce no events and no state change).
 */
export interface JudgmentGuardInput {
  state: RunAggregate;
  role: AgentRole;
  result: RawAgentResult;
  outputSchema: z.ZodType;
  canaries?: readonly string[];
}

/** `score.compute` — the built score input plus provenance carried from the build node. */
export interface ScoreComputeInput {
  state: RunAggregate;
  built: BuiltScoreInput;
}

/** The deterministic score + display-time measured capability + provenance for `score.computed`. */
export interface ComputedScore {
  score: ScoreBreakdown;
  measuredCapability: MeasuredCapability;
  provenance: ScoreProvenance;
  stageStates: StageStates;
}

/** `profile.effect.prepare` — derive the attempt review and build the `profile.apply-attempt` effect. */
export interface ProfileEffectPrepareInput {
  state: RunAggregate;
  commandId: string;
  events: readonly RunEvent[];
  scoreInput: ScoreInput;
  score: ScoreBreakdown;
  stageStates: StageStates;
  /** `provenance.comparabilityKey` (guards the profile EMA against silent blending). */
  comparabilityKey: string;
  /** `review.nextFocus` — the current attempt's focus summaries (0..3). */
  retryFocuses: LocalizedText[];
}

/** `review.commit` — assemble the `review.completed` + `score.computed` events. */
export interface ReviewCommitInput {
  state: RunAggregate;
  commandId: string;
  review: FinalReviewResult;
  judgment?: JudgmentProvenance;
  score: ScoreBreakdown;
  provenance: ScoreProvenance;
}

/**
 * A guard rejection: a stable machine-readable `code` plus minimal learner-safe
 * evidence (ids/paths only, never the rejected payload). The review subgraph's
 * guard node throws this instead of persisting anything.
 */
export class GuardRejectionError extends Error {
  readonly code: string;
  readonly evidence?: unknown;
  constructor(code: string, evidence?: unknown) {
    super(`judgment.guard rejected output: ${code}`);
    this.name = "GuardRejectionError";
    this.code = code;
    if (evidence !== undefined) this.evidence = evidence;
  }
}
