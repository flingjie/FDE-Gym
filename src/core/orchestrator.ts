import type { AgentRuntime } from "../agents/agent-runtime.js";
import {
  extractEvidence,
} from "../agents/evidence-tracker.js";
import { EVIDENCE_TRACKER_OUTPUT_SCHEMA_VERSION } from "../agents/contracts.js";
import type { QuestionAssessment } from "../agents/contracts.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
  ScenarioEventCandidate,
} from "../scenarios/schema.js";
import type { RunAggregate } from "./aggregate.js";
import { applyEvidencePatch, createEmptyEvidenceGraph } from "../evidence/graph.js";
import { runQuestionAccept } from "../graph/nodes/discovery/question-accept.js";
import { runCustomerInvoke } from "../graph/nodes/discovery/customer-invoke.js";
import { runCustomerProject } from "../graph/nodes/discovery/customer-project.js";
import { runEvidenceInvoke } from "../graph/nodes/discovery/evidence-invoke.js";
import { runEvidencePatchGuard } from "../graph/nodes/discovery/evidence-patch-guard.js";
import { runEvidencePatchApply } from "../graph/nodes/discovery/evidence-patch-apply.js";
import { runMetricsCompute } from "../graph/nodes/discovery/metrics-compute.js";
import { runEvidencePending } from "../graph/nodes/discovery/evidence-pending.js";
import { runBriefAccept } from "../graph/nodes/framing/brief-accept.js";
import { runBriefStructureGuard } from "../graph/nodes/framing/brief-structure-guard.js";
import { runCoachBriefInvoke } from "../graph/nodes/framing/coach-brief-invoke.js";
import { runBriefSupportGuard } from "../graph/nodes/framing/brief-support-guard.js";
import { runDiscoveryClarify } from "../graph/nodes/framing/discovery-clarify.js";
import { runChallengeSelect } from "../graph/nodes/challenge/select.js";
import { runChallengeInject } from "../graph/nodes/challenge/inject.js";
import { runResponseAccept } from "../graph/nodes/challenge/response-accept.js";
import { runResponseMembershipGuard } from "../graph/nodes/challenge/membership-guard.js";
import { runAllAnsweredGuard } from "../graph/nodes/challenge/all-answered-guard.js";
import { runChallengeWait } from "../graph/nodes/challenge/wait.js";
import { runPitchPrepare } from "../graph/nodes/challenge/pitch-prepare.js";
import {
  coachReviewInvoke,
  profileEffectPrepare,
  reviewCommit,
  reviewInputBuild,
  scoreCompute,
} from "../graph/nodes/review/handlers.js";
import type { Rng } from "../simulation/rng.js";
import type { MeasuredCapability } from "../scoring/formulas.js";
import type { StageStates } from "../scoring/provenance.js";
import type { LearnerProfile } from "../profile/learner-profile.js";
import {
  PitchArtifactSchema,
  SolutionProposalSchema,
} from "./domain.js";
import type {
  BriefValidationResult,
  ChallengeResponse,
  FinalReviewResult,
  Locale,
  LocalizedText,
  PitchArtifact,
  ProblemBrief,
  RunEvent,
  RunPhase,
  ScoreBreakdown,
  SolutionProposal,
  TranscriptTurn,
} from "./domain.js";
import {
  assertCommandPhase,
  buildPhaseChangedEvent,
  buildRunStartedEvents,
} from "./state-machine.js";
import { FRAME_BLOCKED } from "./errors.js";
import type { StoreOptions } from "./event-store.js";
import type { CommandEffect } from "./command-transaction.js";
import type { RunState } from "./reducer.js";

/**
 * FDE Gym — discovery turn orchestrator (the wiring layer for Tasks 8–10).
 *
 * `prepareDiscoveryTurn` computes the FIXED discovery pipeline in exactly this
 * order:
 *
 *   record learner question → invoke Customer → sanitize/project customer reply
 *   → record reply → invoke Evidence Tracker on the public turn →
 *   validate/apply graph patch → compute deterministic per-question metrics.
 *
 * The prepare functions are PURE of durable I/O: they return the accepted
 * events and an updated aggregate; the caller journals and appends them through
 * `executeCommandTransaction` (the sole commit API — see `command-transaction.ts`).
 *
 * If the Evidence Tracker fails (invalid output, leak, timeout), the customer
 * reply is RETAINED and the turn is marked `EVIDENCE_PENDING`; `frame` must not
 * transition until `prepareRepairPendingEvidence` succeeds. The orchestrator is
 * deterministic: no wall-clock, no randomness — it takes a passed-in
 * `AgentRuntime` and derives every id from `commandId`.
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DiscoveryTurnMetrics {
  questionAssessment: QuestionAssessment;
  /** Deterministic 0..1 aggregate: mean of atomicity, neutrality, relevance, and (1 - redundancy). */
  composite: number;
}

export interface PendingEvidence {
  turnId: string;
  /** Stable failure code (never payload or canary text). */
  code: string;
  /** Structural message (never payload or canary text). */
  message: string;
}

export interface DiscoveryTurnResult {
  runId: string;
  acceptedEvents: RunEvent[];
  pendingEvidence: PendingEvidence | null;
  metrics: DiscoveryTurnMetrics | null;
  updatedState: RunAggregate;
}

export interface RunDiscoveryTurnInput {
  runtime: AgentRuntime;
  capsule: CustomerCapsule;
  /** Aggregate before this turn; `phase` must be DISCOVERY. */
  state: RunAggregate;
  question: string;
  stakeholderId: string;
  /** Idempotency key + questionId; also seeds the invocation ids. */
  commandId: string;
  timeoutMs?: number;
  canaries?: readonly string[];
  store?: StoreOptions;
  /** The verified scenario-bundle digest recorded at run start (provenance only). */
  scenarioBundleDigest?: string;
}

export interface RepairPendingEvidenceInput {
  runtime: AgentRuntime;
  /** Post-reply aggregate whose LAST transcript turn is the pending turn. */
  state: RunAggregate;
  /** The pending turn's ask commandId. */
  commandId: string;
  timeoutMs?: number;
  canaries?: readonly string[];
  store?: StoreOptions;
  /** The verified scenario-bundle digest recorded at run start (provenance only). */
  scenarioBundleDigest?: string;
}

// ---------------------------------------------------------------------------
// Errors + helpers
// ---------------------------------------------------------------------------

export const EVIDENCE_EXTRACTION_FAILED = "EVIDENCE_EXTRACTION_FAILED" as const;

export class OrchestratorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

/** The gate the CLI/later tasks call before issuing `frame`. */
export function assertFrameAllowed(pending: { turnId: string; code: string } | null): void {
  if (pending !== null) {
    throw new OrchestratorError(
      FRAME_BLOCKED,
      `frame blocked: evidence pending for turn ${pending.turnId}`,
    );
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function computeDiscoveryMetrics(assessment: QuestionAssessment): DiscoveryTurnMetrics {
  const composite = clamp01(
    (assessment.atomicity + assessment.neutrality + assessment.relevance + (1 - assessment.redundancy)) / 4,
  );
  return { questionAssessment: assessment, composite };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function prepareDiscoveryTurn(
  input: RunDiscoveryTurnInput,
): Promise<DiscoveryTurnResult> {
  const { runtime, capsule, state, question, stakeholderId, commandId } = input;
  const runId = state.runId;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const canaries = input.canaries ?? [capsule.canary];

  // Steps 1–3 are the node handlers (the DISCOVERY subgraph) wired in place of
  // the previously-inlined pipeline. The `canaries` default mirrors the old
  // inline behaviour (the customer capsule's canary) and is passed explicitly so
  // the evidence node's own `[]` default never disables the leak guard.
  const accepted = await runQuestionAccept({ state, question, stakeholderId, commandId });
  const questionEvent = accepted.events[0];
  const aggQuestion = accepted.updatedState;

  const invoked = await runCustomerInvoke({ runtime, state: aggQuestion, capsule, commandId, timeoutMs, canaries });

  const projected = await runCustomerProject({ state: aggQuestion, capsule, turn: invoked.turn, commandId });
  const replyEvent = projected.events[0];
  const aggReply = projected.updatedState;

  try {
    const evidenceResult = await runEvidenceInvoke({ runtime, state: aggReply, commandId, timeoutMs, canaries });
    const evidence = evidenceResult.evidence;
    await runEvidencePatchGuard({ state: aggReply, evidence });
    const applied = await runEvidencePatchApply({ state: aggReply, evidence, commandId });
    const metricsResult = await runMetricsCompute({
      state: applied.updatedState,
      evidence,
      commandId,
      scenarioBundleDigest: input.scenarioBundleDigest,
    });
    return {
      runId,
      acceptedEvents: [questionEvent, replyEvent, applied.events[0], metricsResult.events[0]],
      pendingEvidence: null,
      metrics: metricsResult.metrics,
      updatedState: applied.updatedState,
    };
  } catch (error) {
    const pendingResult = await runEvidencePending({ state: aggReply, commandId, error });
    return {
      runId,
      acceptedEvents: [questionEvent, replyEvent, pendingResult.events[0]],
      pendingEvidence: pendingResult.pendingEvidence,
      metrics: null,
      updatedState: aggReply,
    };
  }
}

/**
 * Repair a turn left in EVIDENCE_PENDING: re-run the Evidence Tracker on the
 * retained public turn, apply the patch, persist `evidence.patched`, and clear
 * the pending marker. Throws (leaving the turn pending) if extraction fails.
 */
export async function prepareRepairPendingEvidence(
  input: RepairPendingEvidenceInput,
): Promise<DiscoveryTurnResult> {
  const { runtime, state, commandId } = input;
  const runId = state.runId;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const canaries = input.canaries ?? [];

  const evidence = await extractEvidence({
    runtime,
    state,
    invocationId: `${commandId}:evidence`,
    timeoutMs,
    canaries,
  });
  const nextGraph = applyEvidencePatch(state.graph, evidence.patch);
  const evidenceEvent: RunEvent = {
    type: "evidence.patched",
    runId,
    commandId: `${commandId}:evidence`,
    patch: evidence.patch,
  };
  const assessmentEvent: RunEvent = {
    type: "question.assessed",
    runId,
    commandId: `${commandId}:evidence`,
    questionId: commandId,
    assessment: evidence.questionAssessment,
    judgment: {
      judgmentId: `${commandId}:evidence`,
      invocationId: evidence.invocationId,
      modelId: evidence.modelId,
      promptDigest: evidence.promptDigest,
      schemaVersion: EVIDENCE_TRACKER_OUTPUT_SCHEMA_VERSION,
      scenarioDigest: input.scenarioBundleDigest ?? "",
      rawOutputDigest: evidence.rawOutputDigest,
    },
  };
  const resolvedEvent: RunEvent = {
    type: "evidence.resolved",
    runId,
    commandId: `${commandId}:evidence`,
    turnId: `${commandId}:turn`,
  };
  const updatedState: RunAggregate = { ...state, graph: nextGraph, pendingEvidence: null };

  return {
    runId,
    acceptedEvents: [evidenceEvent, assessmentEvent, resolvedEvent],
    pendingEvidence: null,
    metrics: computeDiscoveryMetrics(evidence.questionAssessment),
    updatedState,
  };
}

// ---------------------------------------------------------------------------
// Framing gate (Task 8): submit-brief + clarify
// ---------------------------------------------------------------------------

export interface FramingGateInput {
  runtime: AgentRuntime;
  capsule: EvaluatorCapsule;
  /** Aggregate before submit; `phase` must be PROBLEM_FRAMING. */
  state: RunAggregate;
  brief: ProblemBrief;
  commandId: string;
  timeoutMs?: number;
  canaries?: readonly string[];
  store?: StoreOptions;
  /** The verified scenario-bundle digest recorded at run start (provenance only). */
  scenarioBundleDigest?: string;
}

export interface FramingGateResult {
  runId: string;
  passed: boolean;
  supportRatio: number;
  result: BriefValidationResult;
  acceptedEvents: RunEvent[];
  updatedState: RunAggregate;
}

/**
 * Run the PROBLEM_FRAMING gate for a submitted Problem Brief, IN ORDER:
 *   (a) Zod validation of the brief (defense-in-depth);
 *   (b) deterministic `validateBriefStructure(brief, graph)`;
 *   (c) Coach entailment classification (`validateProblemBrief`, public-only);
 *   (d) final deterministic gate `supportRatio >= 0.75 && structure.passed`.
 *
 * On failure it emits `brief.submitted` + `brief.validated` (passed=false) and
 * STAYS in PROBLEM_FRAMING (no `phase.changed`). On success it additionally
 * emits `phase.changed` to SOLUTION_DESIGN. The gate never reveals hidden
 * evidence text: it holds only the public brief + graph + entailments.
 */
export async function prepareFramingGate(input: FramingGateInput): Promise<FramingGateResult> {
  const { runtime, capsule, state, brief, commandId } = input;
  const runId = state.runId;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const canaries = input.canaries ?? [capsule.canary];

  // The framing gate is the PROBLEM_FRAMING subgraph wired in place of the
  // previously-inlined structure → coach → support pipeline.
  const accepted = await runBriefAccept({ state, brief, commandId });
  const aggBrief = accepted.updatedState;

  const structureResult = await runBriefStructureGuard({ state: aggBrief });
  const structure = structureResult.structure;

  const coach = await runCoachBriefInvoke({ runtime, state: aggBrief, capsule, structure, commandId, timeoutMs, canaries });

  const supportResult = await runBriefSupportGuard({
    state: aggBrief,
    structure,
    coachResult: coach.coachResult,
    commandId,
    scenarioBundleDigest: input.scenarioBundleDigest,
  });

  return {
    runId,
    passed: supportResult.passed,
    supportRatio: supportResult.supportRatio,
    result: supportResult.result,
    acceptedEvents: [...accepted.events, ...supportResult.events],
    updatedState: supportResult.updatedState,
  };
}

export interface ClarificationInput {
  /** Aggregate; `phase` must be PROBLEM_FRAMING. */
  state: RunAggregate;
  commandId: string;
  /** Clarifications already consumed this framing attempt. */
  clarificationBudgetUsed: number;
  /** Defaults to the clarification-budget cap (see the `discovery.clarify` node). */
  clarificationBudgetLimit?: number;
  store?: StoreOptions;
}

export interface ClarificationResult {
  runId: string;
  acceptedEvents: RunEvent[];
  updatedState: RunAggregate;
  clarificationBudgetUsed: number;
}

/**
 * Return PROBLEM_FRAMING -> DISCOVERY for a clarification, tracked against a
 * separate small clarification budget (the `discovery.clarify` node's
 * `clarification-budget-available` guard). The budget is caller-managed
 * (in-memory), mirroring `pendingEvidence`.
 */
export async function prepareClarification(
  input: ClarificationInput,
): Promise<ClarificationResult> {
  const { state, commandId } = input;
  const runId = state.runId;

  const result = await runDiscoveryClarify({
    state,
    commandId,
    clarificationBudgetUsed: input.clarificationBudgetUsed,
    clarificationBudgetLimit: input.clarificationBudgetLimit,
  });

  return {
    runId,
    acceptedEvents: result.events,
    updatedState: result.updatedState,
    clarificationBudgetUsed: input.clarificationBudgetUsed + 1,
  };
}

// ---------------------------------------------------------------------------
// Solution gate (Task 9): submit-design
// ---------------------------------------------------------------------------

export interface SubmitSolutionDesignInput {
  /** Aggregate before submit; `phase` must be SOLUTION_DESIGN. */
  state: RunAggregate;
  proposal: SolutionProposal;
  commandId: string;
  store?: StoreOptions;
}

export interface SubmitSolutionDesignResult {
  runId: string;
  acceptedEvents: RunEvent[];
  updatedState: RunAggregate;
}

/**
 * Run the SOLUTION_DESIGN structural gate for a submitted Solution Proposal.
 * Emits `design.submitted` + `phase.changed` (SOLUTION_DESIGN -> CHALLENGE).
 *
 * The gate is deterministic and structural only: it re-validates the proposal
 * against `SolutionProposalSchema` (defense-in-depth — the command boundary
 * already parsed it), which enforces an objective, an evidence-linked approach
 * (`approachEvidenceIds` non-empty), assumptions, at least one alternative,
 * trade-offs, risks, a validation plan, and a rollout plan. A proposal that
 * fails validation THROWS (ZodError) and persists nothing — no `design.submitted`,
 * no `phase.changed`.
 */
export async function prepareSolutionDesign(
  input: SubmitSolutionDesignInput,
): Promise<SubmitSolutionDesignResult> {
  const { state, proposal, commandId } = input;
  const runId = state.runId;

  // Phase guard: `assertCommandPhase` enforces SOLUTION_DESIGN and throws
  // otherwise. Event authorship is our explicit events below.
  assertCommandPhase(state.phase, "submit-design");

  // Re-validate (structural gate). Throws before any event is emitted.
  SolutionProposalSchema.parse(proposal);

  const events: RunEvent[] = [
    { type: "design.submitted", runId, commandId, proposal },
    { type: "phase.changed", runId, commandId, from: "SOLUTION_DESIGN", to: "CHALLENGE" },
  ];

  return {
    runId,
    acceptedEvents: events,
    updatedState: { ...state, proposal, phase: "CHALLENGE" },
  };
}

// ---------------------------------------------------------------------------
// Challenge injection (Task 9): deterministic challenge wave
// ---------------------------------------------------------------------------

export type ChallengeInterruption = {
  challengeId: string;
  /** The learner-visible interruption text — exactly the scenario's `prompt`. */
  reply: LocalizedText;
  stakeholderId: string;
};

export interface ChallengeInjectionInput {
  /** Aggregate; `phase` must be CHALLENGE. */
  state: RunAggregate;
  capsule: CustomerCapsule;
  /** The scenario's authored event candidates (challenge/constraint changes). */
  candidates: readonly ScenarioEventCandidate[];
  rng: Rng;
  commandId: string;
  store?: StoreOptions;
}

export interface ChallengeInjectionResult {
  runId: string;
  injectedChallengeIds: string[];
  interruptions: ChallengeInterruption[];
  /** `challenge.injected` precedes its `customer.replied` for every injected challenge. */
  acceptedEvents: RunEvent[];
  updatedState: RunAggregate;
}

/**
 * Select and inject the deterministic challenge wave for the current run state.
 *
 * ORDER (structural — a challenge can never be erased by a later failure):
 *   1. Build the trigger context and `selectScenarioEvents` with the seeded rng.
 *   2. Drop candidates already injected in an earlier wave.
 *   3. For each selected candidate, emit `challenge.injected` (the authoritative
 *      record carrying the scenario's `prompt`), THEN render the learner-visible
 *      interruption as a `customer.replied` turn whose `reply` is verbatim the
 *      scenario's `prompt` (the Customer can never invent scoring criteria — the
 *      text is the scenario's), attributed to the capsule's first stakeholder.
 *
 * The injected events are appended before the interruption turns in the SAME
 * write, so the selected event is durable even if a future model-render step
 * were to fail. The run stays in CHALLENGE (no `phase.changed` here); the
 * learner addresses the injected challenges via `respond-challenge`.
 */
export async function prepareChallengeInjection(
  input: ChallengeInjectionInput,
): Promise<ChallengeInjectionResult> {
  const { state, capsule, candidates, rng, commandId } = input;
  const runId = state.runId;

  // Phase guard: only legal once the run has entered CHALLENGE.
  if (state.phase !== "CHALLENGE") {
    throw new OrchestratorError(
      "INVALID_PHASE_COMMAND",
      `challenge injection is not valid in phase ${state.phase ?? "UNSTARTED"}`,
    );
  }

  const selected = await runChallengeSelect({ state, capsule, candidates, rng });
  const injected = await runChallengeInject({ state, capsule, selected: selected.selected, commandId });

  return {
    runId,
    injectedChallengeIds: injected.injectedChallengeIds,
    interruptions: injected.interruptions,
    acceptedEvents: injected.events,
    updatedState: injected.updatedState,
  };
}

// ---------------------------------------------------------------------------
// Challenge response gate (Task 9): respond-challenge
// ---------------------------------------------------------------------------

export interface RespondToChallengeInput {
  /** Aggregate; `phase` must be CHALLENGE and `injectedChallenges` folded. */
  state: RunAggregate;
  response: ChallengeResponse;
  commandId: string;
  store?: StoreOptions;
}

export interface RespondToChallengeResult {
  runId: string;
  challengesAddressed: boolean;
  acceptedEvents: RunEvent[];
  updatedState: RunAggregate;
}

/**
 * Record a Challenge Response and determine whether the learner has addressed
 * every mandatory challenge. Emits `challenge.responded`; when (and only when)
 * every mandatory challenge id has a recorded response, it additionally emits
 * `phase.changed` (CHALLENGE -> PITCH).
 *
 * The gate is structural: the response is re-validated against
 * `ChallengeResponseSchema` (impact, keep/change decision, rationale, a new
 * risk-or-validation action). A learner MAY retain the design
 * (`decision: "keep"`) — that is structurally accepted; whether the rationale
 * is evidence-based is a coaching/quality concern deferred to scoring (Task 10),
 * not a structural gate here. An invalid response THROWS (ZodError) and persists
 * nothing.
 */
export async function prepareRespondToChallenge(
  input: RespondToChallengeInput,
): Promise<RespondToChallengeResult> {
  const { state, response, commandId } = input;
  const runId = state.runId;

  // Phase guard (discard the unconditional CHALLENGE -> PITCH collapse).
  assertCommandPhase(state.phase, "respond-challenge");

  // response.accept (structural gate) then response.membership.guard (validate
  // the target is injected + pending, and fold it answered).
  await runResponseAccept({ state, response });
  const membership = await runResponseMembershipGuard({ state, response, commandId });
  const folded = membership.folded;

  // all-answered.guard (branch) → challenge.wait (stay) | pitch.prepare (advance).
  const allAnswered = await runAllAnsweredGuard({ state, challenges: folded });
  if (allAnswered.ok) {
    const pitch = await runPitchPrepare({ state, commandId, folded, response });
    return {
      runId,
      challengesAddressed: true,
      acceptedEvents: pitch.events,
      updatedState: pitch.updatedState,
    };
  }
  const wait = await runChallengeWait({ state, response, commandId, folded });
  return {
    runId,
    challengesAddressed: false,
    acceptedEvents: wait.events,
    updatedState: wait.updatedState,
  };
}

// ---------------------------------------------------------------------------
// Pitch gate (Task 9): submit-pitch
// ---------------------------------------------------------------------------

export interface SubmitPitchInput {
  /** Aggregate; `phase` must be PITCH. */
  state: RunAggregate;
  pitch: PitchArtifact;
  commandId: string;
  store?: StoreOptions;
}

export interface SubmitPitchResult {
  runId: string;
  acceptedEvents: RunEvent[];
  updatedState: RunAggregate;
}

/**
 * Run the PITCH structural gate for a submitted Pitch Artifact. Emits
 * `pitch.submitted` + `phase.changed` (PITCH -> REVIEW).
 *
 * Deterministic and structural only: re-validates against `PitchArtifactSchema`
 * (audience, problem, recommendation, expected value, evidence ids, risks, an
 * explicit ask, and next steps). An invalid pitch THROWS (ZodError) and persists
 * nothing.
 */
export async function preparePitch(input: SubmitPitchInput): Promise<SubmitPitchResult> {
  const { state, pitch, commandId } = input;
  const runId = state.runId;

  // Phase guard.
  assertCommandPhase(state.phase, "submit-pitch");

  // Re-validate (structural gate). Throws before any event is emitted.
  PitchArtifactSchema.parse(pitch);

  const events: RunEvent[] = [
    { type: "pitch.submitted", runId, commandId, pitch },
    { type: "phase.changed", runId, commandId, from: "PITCH", to: "REVIEW" },
  ];

  return {
    runId,
    acceptedEvents: events,
    updatedState: { ...state, pitch, phase: "REVIEW" },
  };
}

// ---------------------------------------------------------------------------
// Retry (Task 10): two-step retry — `retry` marks ready, `start-retry` spawns
// ---------------------------------------------------------------------------

export interface RetryReadyOptions {
  /** Idempotency key for the parent's `retry.started` + `phase.changed`. */
  commandId: string;
  /** Defaults to the parent's scenario. */
  scenarioId?: string;
  /** Defaults to the parent's locale. */
  locale?: Locale;
  /** Exactly 2 or 3 learner-visible focus summaries from the previous attempt. */
  focusSummaries: LocalizedText[];
}

export interface RetryReadyResult {
  parentRunId: string;
  scenarioId: string;
  locale: Locale;
  focusSummaries: LocalizedText[];
  /** The parent's minimal state after the transition (RETRY_READY). */
  state: RunState;
  /** Events persisted to the PARENT run (`retry.started` + the REVIEW→RETRY_READY hop). */
  parentEvents: RunEvent[];
}

export interface StartRetryOptions {
  /** The new attempt's run id (deterministic, caller-supplied — no randomness). */
  newRunId: string;
  /** Idempotency key for the child run's `start`. */
  commandId: string;
  /** Defaults to the parent's scenario. */
  scenarioId?: string;
  /** Defaults to the parent's locale. */
  locale?: Locale;
  /** Carried through unchanged (the run seed is caller-owned; not in the aggregate). */
  seed?: number;
  /** Exactly 2 or 3 learner-visible focus summaries (from the parent's `retry.started`). */
  focusSummaries: LocalizedText[];
  /** Verified scenario-bundle digest stamped onto the child run's `run.started` (Task 7). */
  scenarioBundleDigest?: string;
}

export interface StartRetryResult {
  parentRunId: string;
  runId: string;
  scenarioId: string;
  locale: Locale;
  seed: number | undefined;
  focusSummaries: LocalizedText[];
  /** The new run's minimal state (DISCOVERY). */
  state: RunState;
  /** The new run's fresh aggregate: graph/ledger/transcript/sessions cleared. */
  aggregate: RunAggregate;
  /** Events persisted to the NEW run. */
  newRunEvents: RunEvent[];
}

export const INVALID_RETRY_FOCUS = "INVALID_RETRY_FOCUS" as const;

/**
 * Mark a REVIEW-phase attempt as ready to retry (step 1 of the two-step retry).
 * Moves the PARENT run to `RETRY_READY` and durably records the 2–3
 * learner-visible focus summaries on the parent (`retry.started`), so a later
 * `start-retry` can reconstruct the child's `previousAttemptReview` after a
 * process restart without re-invoking the parent's review model.
 *
 * No child is created here and no model is invoked — this is a pure transition.
 */
export function prepareRetry(
  parentRun: RunAggregate,
  options: RetryReadyOptions,
): RetryReadyResult {
  assertCommandPhase(parentRun.phase, "retry");
  if (options.focusSummaries.length < 2 || options.focusSummaries.length > 3) {
    throw new OrchestratorError(
      INVALID_RETRY_FOCUS,
      "retry requires 2 or 3 focus summaries",
    );
  }

  const scenarioId = options.scenarioId ?? parentRun.scenarioId;
  const locale = options.locale ?? parentRun.locale;
  const commandId = options.commandId;

  const parentEvents: RunEvent[] = [
    {
      type: "retry.started",
      runId: parentRun.runId,
      commandId,
      focusSummaries: options.focusSummaries,
    },
    buildPhaseChangedEvent(parentRun.runId, commandId, "REVIEW", "RETRY_READY"),
  ];

  return {
    parentRunId: parentRun.runId,
    scenarioId,
    locale,
    focusSummaries: options.focusSummaries,
    state: { runId: parentRun.runId, phase: "RETRY_READY", seq: parentEvents.length },
    parentEvents,
  };
}

/**
 * Spawn the clean, isolated second attempt (step 2 of the two-step retry).
 * Requires the parent to be in `RETRY_READY`; creates the child run in DISCOVERY
 * with the focus summaries carried in from the parent's `retry.started`.
 *
 * Semantics (verbatim from the brief):
 *   - NEW `runId`; the parent link is recorded durably as the child's
 *     `run.started.parentRunId`.
 *   - The Evidence Graph, disclosure ledger, transcript, and granted hints are
 *     CLEARED; the new run carries only the 2-3 learner-visible focus summaries
 *     (`previousAttemptReview`). The Customer and Evidence Tracker therefore
 *     receive NO previous transcript.
 *   - The new run starts in DISCOVERY: `start` (SCENARIO) followed immediately
 *     by `accept` (SCENARIO → DISCOVERY).
 *
 * Deterministic: no randomness, no model, no wall-clock. `newRunId` is
 * caller-supplied so the CLI controls the identity.
 */
export function prepareStartRetry(
  parentRun: RunAggregate,
  options: StartRetryOptions,
): StartRetryResult {
  assertCommandPhase(parentRun.phase, "start-retry");
  if (options.focusSummaries.length < 2 || options.focusSummaries.length > 3) {
    throw new OrchestratorError(
      INVALID_RETRY_FOCUS,
      "start-retry requires 2 or 3 focus summaries",
    );
  }

  const scenarioId = options.scenarioId ?? parentRun.scenarioId;
  const locale = options.locale ?? parentRun.locale;
  const newRunId = options.newRunId;
  const commandId = options.commandId;

  // Fresh run: `start` (SCENARIO) then `accept` (SCENARIO -> DISCOVERY).
  const startEvents = buildRunStartedEvents(newRunId, {
    type: "start",
    commandId,
    scenarioId,
    locale,
    parentRunId: parentRun.runId,
    ...(options.scenarioBundleDigest !== undefined
      ? { scenarioBundleDigest: options.scenarioBundleDigest }
      : {}),
  });
  const acceptEvents = [
    buildPhaseChangedEvent(newRunId, `${commandId}:accept`, "SCENARIO", "DISCOVERY"),
  ];
  // The retry focus summaries are committed to the CHILD so a process restart
  // can fold `previousAttemptReview` without re-invoking the parent's review
  // model. Grouped with the start command for idempotency.
  const focusEvent: RunEvent = {
    type: "retry.focus",
    runId: newRunId,
    commandId,
    focusSummaries: options.focusSummaries,
  };
  const newRunEvents: RunEvent[] = [...startEvents, focusEvent, ...acceptEvents];

  // Fresh aggregate: graph/ledger/transcript/sessions cleared.
  const aggregate: RunAggregate = {
    runId: newRunId,
    scenarioId,
    locale,
    phase: "DISCOVERY",
    transcript: [],
    graph: createEmptyEvidenceGraph(),
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: null,
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    injectedChallenges: [],
    pendingEvidence: null,
    clarificationBudgetUsed: 0,
    previousAttemptReview: { focusSummaries: options.focusSummaries },
  };

  return {
    parentRunId: parentRun.runId,
    runId: newRunId,
    scenarioId,
    locale,
    seed: options.seed,
    focusSummaries: options.focusSummaries,
    state: { runId: newRunId, phase: "DISCOVERY", seq: newRunEvents.length },
    aggregate,
    newRunEvents,
  };
}

// ---------------------------------------------------------------------------
// Terminal transitions: complete + abort
// ---------------------------------------------------------------------------

export interface TerminalResult {
  state: RunState;
  events: RunEvent[];
}

/**
 * Finalize a REVIEW-phase run: emit `run.completed` and move REVIEW → COMPLETED.
 * Pure — no model, no I/O. Legality (REVIEW only) is enforced by
 * `assertCommandPhase`.
 */
export function prepareComplete(parentRun: RunAggregate, commandId: string): TerminalResult {
  assertCommandPhase(parentRun.phase, "complete");
  return {
    state: { runId: parentRun.runId, phase: "COMPLETED", seq: 2 },
    events: [
      { type: "run.completed", runId: parentRun.runId, commandId },
      buildPhaseChangedEvent(parentRun.runId, commandId, "REVIEW", "COMPLETED"),
    ],
  };
}

/**
 * Terminate a run from any active phase: emit `run.aborted` (optional reason)
 * and move the current phase → ABORTED. Pure — no model, no I/O.
 */
export function prepareAbort(
  parentRun: RunAggregate,
  commandId: string,
  reason?: string,
): TerminalResult {
  assertCommandPhase(parentRun.phase, "abort");
  const from = parentRun.phase as RunPhase; // non-null: assertCommandPhase rejects the unstarted state
  const abortEvent: RunEvent =
    reason !== undefined
      ? { type: "run.aborted", runId: parentRun.runId, commandId, reason }
      : { type: "run.aborted", runId: parentRun.runId, commandId };
  return {
    state: { runId: parentRun.runId, phase: "ABORTED", seq: 2 },
    events: [abortEvent, buildPhaseChangedEvent(parentRun.runId, commandId, from, "ABORTED")],
  };
}

// ---------------------------------------------------------------------------
// Review (Task 11): final-review + score + profile
// ---------------------------------------------------------------------------

export interface SubmitReviewInput {
  runtime: AgentRuntime;
  /** Evaluator capsule (rubric/hint ladders/pass gates); the Coach's canary source. */
  capsule: EvaluatorCapsule;
  /** Customer capsule (disclosure units) — used only to derive the score's coverage. */
  customerCapsule: CustomerCapsule;
  /** Public scenario (question budget). */
  publicScenario: PublicScenario;
  /** The full run's committed events (needed for per-question score derivation). */
  events: readonly RunEvent[];
  /** Aggregate before review; `phase` must be REVIEW and brief+proposal+pitch set. */
  state: RunAggregate;
  commandId: string;
  timeoutMs?: number;
  /** Number of independent Coach final-review invocations to aggregate.
   *  Defaults to 1 (the single-invocation path, byte-identical to pre-sampling). */
  samples?: number;
  canaries?: readonly string[];
  store?: StoreOptions;
  profileStore?: { baseDir?: string };
  /** The learner profile BEFORE this attempt; defaults to the persisted/empty profile. */
  profile?: LearnerProfile;
}

/**
 * Run the REVIEW phase: invoke the Coach's `final-review` task, compute the
 * deterministic `ScoreBreakdown` via `calculateScore`, persist
 * `review.completed` + `score.computed` (with its score provenance), and fold
 * the attempt into the durable learner profile.
 *
 * Stage scores and per-question form metrics are sourced from the Coach's
 * criterion scores and the Evidence Tracker's persisted assessments; the
 * deterministic fallback (see `src/scoring/score-input.ts`) applies only when
 * that model judgment is explicitly missing (legacy runs or an absent stage).
 */
export interface PreparedReview {
  events: RunEvent[];
  review: FinalReviewResult;
  score: ScoreBreakdown;
  /** Per-stage three-state classification (measured/proxy/unscorable). */
  stageStates: StageStates;
  /** Display-time capability figure over discovery + measured stages only. */
  measuredCapability: MeasuredCapability;
  /** Cross-sample aggregation confidence (null for the single-invocation path). */
  confidence: number | null;
  /** The attempt review to fold into the durable learner profile as a transaction effect. */
  effect: CommandEffect;
}

export async function prepareReview(input: SubmitReviewInput): Promise<PreparedReview> {
  const { runtime, capsule, customerCapsule, publicScenario, events, state, commandId } = input;
  const runId = state.runId;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const canaries = input.canaries ?? [capsule.canary];
  const samples = input.samples ?? 1;
  // Reject 0, negative, fractional, and NaN sample counts rather than silently
  // coercing them to a single invocation (the spec's "validate >= 1").
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error("samples must be a positive integer");
  }

  // Phase guard: `assertCommandPhase` enforces REVIEW (and emits nothing).
  assertCommandPhase(state.phase, "review");

  // The verified scenario-bundle digest recorded at run start (provenance only).
  const started = events.find((event) => event.type === "run.started");
  const scenarioBundleSha256 =
    started && started.type === "run.started" ? (started.scenarioBundleDigest ?? null) : null;

  // The REVIEW subgraph, reconciled: the Coach runs FIRST because the score
  // input's stage scores depend on its `criterionScores` (the plan's
  // `review.input.build → coach.review.invoke` order was inverted). The
  // `judgment.guard` node is dropped here — sanitize+validate is embedded in
  // `runFinalReview`/`sampleFinalReview`.
  const coach = await coachReviewInvoke.run({
    runtime,
    state,
    capsule,
    commandId,
    timeoutMs,
    samples,
    canaries,
    scenarioBundleSha256,
  });

  const built = await reviewInputBuild.run({
    state,
    events,
    customerCapsule,
    evaluatorCapsule: capsule,
    publicScenario,
    criterionScores: coach.review.review.criterionScores,
    evaluatorInvocationId: coach.review.evaluatorInvocationId,
    modelId: coach.review.modelId,
    scenarioBundleSha256,
  });

  const computed = await scoreCompute.run({ state, built: built.built });

  const profile = await profileEffectPrepare.run({
    state,
    commandId,
    events,
    scoreInput: built.built.input,
    score: computed.score.score,
    stageStates: computed.score.stageStates,
    comparabilityKey: computed.score.provenance.comparabilityKey,
    retryFocuses: coach.review.review.nextFocus,
  });

  const commit = await reviewCommit.run({
    state,
    commandId,
    review: coach.review.review,
    judgment: coach.review.judgment,
    score: computed.score.score,
    provenance: computed.score.provenance,
  });

  return {
    events: commit.events,
    review: coach.review.review,
    score: computed.score.score,
    stageStates: computed.score.stageStates,
    measuredCapability: computed.score.measuredCapability,
    confidence: coach.review.confidence,
    effect: profile.effect,
  };
}
