import { FINAL_REVIEW_OUTPUT_SCHEMA_VERSION } from "../../../agents/contracts.js";
import { runFinalReview, sampleFinalReview } from "../../../agents/coach.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { CommandEffect } from "../../../core/command-transaction.js";
import {
  ScoreBreakdownSchema,
  type FinalReviewResult,
  type RunEvent,
  type ScoreBreakdown,
} from "../../../core/domain.js";
import type { JudgmentProvenance } from "../../../core/judgment.js";
import type { AttemptReview } from "../../../profile/learner-profile.js";
import { calculateScore, computeMeasuredCapability } from "../../../scoring/formulas.js";
import { aggregateReviews } from "../../../scoring/review-aggregation.js";
import { buildScoreInput, deriveAttemptReview } from "../../../scoring/score-input.js";
import { judgmentValid } from "../../guards.js";
import type { NodeHandler } from "../node.js";
import {
  GuardRejectionError,
  type BuiltScoreInput,
  type CoachReviewInvocation,
  type CoachReviewInvokeInput,
  type ComputedScore,
  type JudgmentGuardInput,
  type ProfileEffectPrepareInput,
  type ReviewCommitInput,
  type ReviewInputBuildInput,
  type ScoreComputeInput,
} from "./types.js";

/**
 * FDE Gym — review subgraph node handlers (Phase 3, G3-04).
 *
 * The review pipeline decomposed into six nodes. Each handler is an independent,
 * self-contained `NodeHandler` that mirrors a slice of `prepareReview`
 * (`src/core/orchestrator.ts`) WITHOUT importing it; the graph runtime (a later
 * integration) wires one node's extra output fields into the next node's input.
 * No handler performs durable I/O — `review.commit` returns the events and the
 * transaction commits them.
 *
 * The declared `handlers` order follows the plan's node flow:
 *   review.input.build → coach.review.invoke → judgment.guard
 *   → score.compute → profile.effect.prepare → review.commit
 */

/** `review.input.build` — deterministic: `buildScoreInput` (input + provenance + stage states). */
const reviewInputBuild = {
  definition: {
    id: "review.input.build",
    phase: "REVIEW",
    kind: "deterministic",
  },
  async run(input: ReviewInputBuildInput) {
    const built = buildScoreInput({
      events: input.events,
      aggregate: input.state,
      customerCapsule: input.customerCapsule,
      evaluatorCapsule: input.evaluatorCapsule,
      publicScenario: input.publicScenario,
      criterionScores: input.criterionScores,
      evaluatorInvocationId: input.evaluatorInvocationId ?? null,
      modelId: input.modelId ?? null,
      scenarioBundleSha256: input.scenarioBundleSha256 ?? null,
    });
    return { events: [], updatedState: input.state, built };
  },
} satisfies NodeHandler<ReviewInputBuildInput>;

/** `coach.review.invoke` — agent: `runFinalReview` (single) or `sampleFinalReview` + `aggregateReviews` (N). */
const coachReviewInvoke = {
  definition: {
    id: "coach.review.invoke",
    phase: "REVIEW",
    kind: "agent",
    contextPolicy: { role: "coach_evaluator", capsule: "evaluator" },
    failurePolicy: { failureClass: "INVALID_MODEL_OUTPUT", retry: true, maxAttempts: 1 },
  },
  async run(input: CoachReviewInvokeInput) {
    const state: RunAggregate = { ...input.state, coachTask: "final-review" };
    const timeoutMs = input.timeoutMs ?? 60_000;
    const canaries = input.canaries ?? [input.capsule.canary];
    const samples = input.samples ?? 1;
    // Reject 0, negative, fractional, and NaN sample counts (the spec's "validate >= 1").
    if (!Number.isInteger(samples) || samples < 1) {
      throw new Error("samples must be a positive integer");
    }

    let review: FinalReviewResult;
    let confidence: number | null;
    let evaluatorInvocationId: string | null;
    let modelId: string | null;
    let judgment: JudgmentProvenance | undefined;

    if (samples === 1) {
      const inv = await runFinalReview({
        runtime: input.runtime,
        state,
        capsule: input.capsule,
        invocationId: `${input.commandId}:coach`,
        timeoutMs,
        canaries,
      });
      review = inv.review;
      confidence = null;
      evaluatorInvocationId = inv.invocationId;
      modelId = inv.modelId;
      judgment = {
        judgmentId: `${input.commandId}:coach`,
        invocationId: inv.invocationId,
        modelId: inv.modelId,
        promptDigest: inv.promptDigest,
        schemaVersion: FINAL_REVIEW_OUTPUT_SCHEMA_VERSION,
        scenarioDigest: input.scenarioBundleSha256 ?? "",
        rawOutputDigest: inv.rawOutputDigest,
      };
    } else {
      const invocations = await sampleFinalReview(input.runtime, state, input.capsule, {
        samples,
        commandId: input.commandId,
        timeoutMs,
        canaries,
      });
      const aggregated = aggregateReviews(invocations);
      review = aggregated.review;
      confidence = aggregated.confidence;
      evaluatorInvocationId = invocations[0]?.invocationId ?? null;
      modelId = invocations[0]?.modelId ?? null;
      judgment = undefined;
    }

    const invocation: CoachReviewInvocation = {
      review,
      confidence,
      evaluatorInvocationId,
      modelId,
      judgment,
    };
    return { events: [], updatedState: input.state, review: invocation };
  },
} satisfies NodeHandler<CoachReviewInvokeInput>;

/** `judgment.guard` — guard: `judgmentValid` (sanitize + leak-guard + schema). Rejects with a stable code. */
const judgmentGuard = {
  definition: {
    id: "judgment.guard",
    phase: "REVIEW",
    kind: "guard",
    failurePolicy: { failureClass: "INVALID_MODEL_OUTPUT", retry: true, maxAttempts: 1 },
  },
  async run(input: JudgmentGuardInput) {
    const result = judgmentValid(input.role, input.result, input.outputSchema, input.canaries);
    if (!result.ok) {
      throw new GuardRejectionError(result.code, result.evidence);
    }
    return { events: [], updatedState: input.state };
  },
} satisfies NodeHandler<JudgmentGuardInput>;

/** `score.compute` — deterministic: `calculateScore` + `computeMeasuredCapability`; carries the provenance through. */
const scoreCompute = {
  definition: {
    id: "score.compute",
    phase: "REVIEW",
    kind: "deterministic",
  },
  async run(input: ScoreComputeInput) {
    const built: BuiltScoreInput = input.built;
    const score = calculateScore(built.input);
    // Defense-in-depth: the persisted score must satisfy the domain schema.
    ScoreBreakdownSchema.parse(score);
    const measuredCapability = computeMeasuredCapability(score, built.stageStates);
    const computed: ComputedScore = {
      score,
      measuredCapability,
      provenance: built.provenance,
      stageStates: built.stageStates,
    };
    return { events: [], updatedState: input.state, score: computed };
  },
} satisfies NodeHandler<ScoreComputeInput>;

/** `profile.effect.prepare` — deterministic: `deriveAttemptReview` into the `profile.apply-attempt` effect. */
const profileEffectPrepare = {
  definition: {
    id: "profile.effect.prepare",
    phase: "REVIEW",
    kind: "deterministic",
  },
  async run(input: ProfileEffectPrepareInput) {
    const attempt = deriveAttemptReview(
      input.scoreInput,
      input.score,
      input.events,
      input.state,
      input.comparabilityKey,
      input.stageStates,
    );
    const attemptReview: AttemptReview = { ...attempt, retryFocuses: input.retryFocuses };
    const effect: CommandEffect = {
      type: "profile.apply-attempt",
      effectId: `${input.state.runId}:${input.commandId}:profile`,
      runId: input.state.runId,
      review: attemptReview,
    };
    return { events: [], updatedState: input.state, effect };
  },
} satisfies NodeHandler<ProfileEffectPrepareInput>;

/** `review.commit` — deterministic: assemble `review.completed` + `score.computed`. */
const reviewCommit = {
  definition: {
    id: "review.commit",
    phase: "REVIEW",
    kind: "deterministic",
  },
  async run(input: ReviewCommitInput) {
    const reviewEvent: RunEvent = {
      type: "review.completed",
      runId: input.state.runId,
      commandId: input.commandId,
      review: input.review,
      ...(input.judgment !== undefined ? { judgment: input.judgment } : {}),
    };
    const scoreEvent: RunEvent = {
      type: "score.computed",
      runId: input.state.runId,
      commandId: input.commandId,
      score: input.score,
      provenance: input.provenance,
    };
    return {
      events: [reviewEvent, scoreEvent],
      updatedState: input.state,
      reviewEvent,
      scoreEvent,
    };
  },
} satisfies NodeHandler<ReviewCommitInput>;

/** The review subgraph's handlers, in the plan's declared node-flow order. */
export const handlers: readonly NodeHandler[] = [
  reviewInputBuild,
  coachReviewInvoke,
  judgmentGuard,
  scoreCompute,
  profileEffectPrepare,
  reviewCommit,
];

export {
  coachReviewInvoke,
  judgmentGuard,
  profileEffectPrepare,
  reviewCommit,
  reviewInputBuild,
  scoreCompute,
};
