import type { AgentRuntime } from "../agents/agent-runtime.js";
import {
  answerDiscoveryQuestion,
  type CustomerTurn,
} from "../agents/customer.js";
import {
  extractEvidence,
} from "../agents/evidence-tracker.js";
import {
  runFinalReview,
  validateProblemBrief,
  type BriefValidationInvocation,
} from "../agents/coach.js";
import {
  BRIEF_VALIDATION_OUTPUT_SCHEMA_VERSION,
  EVIDENCE_TRACKER_OUTPUT_SCHEMA_VERSION,
  FINAL_REVIEW_OUTPUT_SCHEMA_VERSION,
} from "../agents/contracts.js";
import type { QuestionAssessment } from "../agents/contracts.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
  ScenarioEventCandidate,
} from "../scenarios/schema.js";
import type { RunAggregate } from "./aggregate.js";
import { applyEvidencePatch, createEmptyEvidenceGraph } from "../evidence/graph.js";
import {
  BRIEF_DANGLING_EVIDENCE_REFERENCE,
  SUPPORT_RATIO_THRESHOLD,
  calculateSupportRatio,
  validateBriefStructure,
} from "../evidence/brief-validator.js";
import { selectScenarioEvents, type EventTriggerContext } from "../simulation/event-scheduler.js";
import type { Rng } from "../simulation/rng.js";
import { calculateScore } from "../scoring/formulas.js";
import { buildScoreInput, deriveAttemptReview } from "../scoring/score-input.js";
import { type AttemptReview, type LearnerProfile } from "../profile/learner-profile.js";
import {
  ChallengeResponseSchema,
  PitchArtifactSchema,
  ProblemBriefSchema,
  ScoreBreakdownSchema,
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
  ScoreBreakdown,
  SolutionProposal,
  TranscriptTurn,
} from "./domain.js";
import { InvalidPhaseCommandError } from "./errors.js";
import {
  assertCommandPhase,
  buildPhaseChangedEvent,
  buildRunStartedEvents,
} from "./state-machine.js";
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

export const FRAME_BLOCKED = "FRAME_BLOCKED" as const;
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

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

function foldReply(agg: RunAggregate, turn: CustomerTurn, commandId: string): RunAggregate {
  const question = agg.pendingQuestion?.question ?? "";
  const newTurn: TranscriptTurn = {
    turnId: `${commandId}:turn`,
    seq: agg.transcript.length,
    question,
    customerReply: turn.reply,
    stakeholderId: turn.stakeholderId,
  };
  return {
    ...agg,
    transcript: [...agg.transcript, newTurn],
    disclosedDisclosureUnitIds: dedupe([...agg.disclosedDisclosureUnitIds, ...turn.disclosedDisclosureUnitIds]),
    pendingQuestion: null,
  };
}

/** Reduce an unknown error to a stable, payload-free code + message. */
function normalizeFailure(error: unknown): { code: string; message: string } {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    if (typeof code === "string" && code.length > 0) {
      return { code, message: typeof message === "string" ? message : code };
    }
  }
  return { code: EVIDENCE_EXTRACTION_FAILED, message: "evidence extraction failed" };
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

  // Step 1: record learner question. `assertCommandPhase` enforces the
  // DISCOVERY phase; the `question.asked` event is authored here explicitly.
  assertCommandPhase(state.phase, "ask");
  const questionEvent: RunEvent = {
    type: "question.asked",
    runId,
    commandId,
    questionId: commandId,
    question,
  };

  const aggQuestion: RunAggregate = { ...state, pendingQuestion: { question, stakeholderId } };

  // Step 2: invoke Customer.
  const turn = await answerDiscoveryQuestion({
    runtime,
    state: aggQuestion,
    capsule,
    invocationId: `${commandId}:customer`,
    timeoutMs,
    canaries,
  });

  // Step 3: sanitize/project the customer reply and record it.
  const replyEvent: RunEvent = {
    type: "customer.replied",
    runId,
    commandId,
    questionId: commandId,
    reply: turn.reply,
    stakeholderId: turn.stakeholderId,
    disclosedDisclosureUnitIds: turn.disclosedDisclosureUnitIds,
  };
  const aggReply = foldReply(aggQuestion, turn, commandId);

  // Steps 4–5: invoke Evidence Tracker on the public turn, validate/apply patch.
  let evidenceEvent: RunEvent;
  let assessmentEvent: RunEvent;
  let aggPatched: RunAggregate;
  let metrics: DiscoveryTurnMetrics;
  try {
    const evidence = await extractEvidence({
      runtime,
      state: aggReply,
      invocationId: `${commandId}:evidence`,
      timeoutMs,
      canaries,
    });
    const nextGraph = applyEvidencePatch(aggReply.graph, evidence.patch);
    evidenceEvent = {
      type: "evidence.patched",
      runId,
      commandId: `${commandId}:evidence`,
      patch: evidence.patch,
    };
    assessmentEvent = {
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
    aggPatched = { ...aggReply, graph: nextGraph };
    // Step 6: deterministic per-question metrics.
    metrics = computeDiscoveryMetrics(evidence.questionAssessment);
  } catch (error) {
    // Retain the customer reply; mark the turn EVIDENCE_PENDING and block frame.
    const failure = normalizeFailure(error);
    const pending: PendingEvidence = {
      turnId: `${commandId}:turn`,
      // The thrown error's own `code` (e.g. LEAK_GUARD_TRIGGERED,
      // AGENT_OUTPUT_INVALID) is an internal failure-mode side-channel. The
      // in-memory `pending` object must carry only the stable, learner-visible
      // code — never the distinct internal one.
      code: EVIDENCE_EXTRACTION_FAILED,
      message: failure.message,
    };
    const pendingEvent: RunEvent = {
      type: "evidence.pending",
      runId,
      commandId: `${commandId}:evidence-pending`,
      turnId: `${commandId}:turn`,
      // Persist ONLY the stable code: the thrown error's own `code` (e.g.
      // LEAK_GUARD_TRIGGERED) is an internal failure-mode side-channel that
      // must never be projected to the learner.
      failureCode: EVIDENCE_EXTRACTION_FAILED,
    };
    return {
      runId,
      acceptedEvents: [questionEvent, replyEvent, pendingEvent],
      pendingEvidence: pending,
      metrics: null,
      updatedState: aggReply,
    };
  }

  return {
    runId,
    acceptedEvents: [questionEvent, replyEvent, evidenceEvent, assessmentEvent],
    pendingEvidence: null,
    metrics,
    updatedState: aggPatched,
  };
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

export const CLARIFICATION_BUDGET_EXCEEDED = "CLARIFICATION_BUDGET_EXCEEDED" as const;

/** Default cap on `clarify` returns to DISCOVERY per framing attempt. */
export const DEFAULT_CLARIFICATION_BUDGET = 3;

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

  // Phase guard: `assertCommandPhase` enforces PROBLEM_FRAMING and throws
  // otherwise. Event authorship is the multi-step gate below.
  assertCommandPhase(state.phase, "submit-brief");

  // (a) Zod validation.
  ProblemBriefSchema.parse(brief);

  // (b) Deterministic structural gate.
  const structure = validateBriefStructure(brief, state.graph);

  // (c) Coach entailment classification (public brief + graph + transcript).
  // A dangling evidence reference would make the Coach's strict input schema
  // reject the brief, so classification is skipped in that already-failing case.
  let coachInvocation: BriefValidationInvocation | null = null;
  let entailments = structure.entailments;
  if (!structure.missingCategories.includes(BRIEF_DANGLING_EVIDENCE_REFERENCE)) {
    coachInvocation = await validateProblemBrief({
      runtime,
      state: { ...state, coachTask: "brief-validation", brief },
      capsule,
      invocationId: `${commandId}:coach`,
      timeoutMs,
      canaries,
    });
    entailments = coachInvocation.result.entailments;
  }

  // (d) Final deterministic gate: supportRatio >= threshold AND structure passed.
  const supportRatio = calculateSupportRatio(brief.claims, entailments);
  const passed = structure.passed && supportRatio >= SUPPORT_RATIO_THRESHOLD;

  const result = composeBriefValidationResult(structure, coachInvocation?.result ?? null, passed);

  const validatedEvent: RunEvent = {
    type: "brief.validated",
    runId,
    commandId,
    briefId: brief.id,
    result,
    ...(coachInvocation !== null
      ? {
          judgment: {
            judgmentId: `${commandId}:coach`,
            invocationId: coachInvocation.invocationId,
            modelId: coachInvocation.modelId,
            promptDigest: coachInvocation.promptDigest,
            schemaVersion: BRIEF_VALIDATION_OUTPUT_SCHEMA_VERSION,
            scenarioDigest: input.scenarioBundleDigest ?? "",
            rawOutputDigest: coachInvocation.rawOutputDigest,
          },
        }
      : {}),
  };

  const events: RunEvent[] = [
    { type: "brief.submitted", runId, commandId, brief },
    validatedEvent,
  ];
  let phase = state.phase;
  if (passed) {
    events.push({
      type: "phase.changed",
      runId,
      commandId,
      from: "PROBLEM_FRAMING",
      to: "SOLUTION_DESIGN",
    });
    phase = "SOLUTION_DESIGN";
  }

  return {
    runId,
    passed,
    supportRatio,
    result,
    acceptedEvents: events,
    updatedState: { ...state, brief, phase },
  };
}

/**
 * Compose the deterministic structure result with the Coach's semantic result.
 * `passed` is the recomputed gate; `entailments` are the Coach's (semantic);
 * `missingCategories`/`unsupportedClaimIds` are the deduplicated union of both;
 * `feedback` is deterministic + ids-only when the structure gate failed, and the
 * Coach's (sanitized, public-only) feedback only when structure passed.
 */
function composeBriefValidationResult(
  structure: BriefValidationResult,
  coach: BriefValidationResult | null,
  passed: boolean,
): BriefValidationResult {
  const missingCategories = dedupe([
    ...structure.missingCategories,
    ...(coach?.missingCategories ?? []),
  ]);
  const unsupportedClaimIds = dedupe([
    ...structure.unsupportedClaimIds,
    ...(coach?.unsupportedClaimIds ?? []),
  ]);
  const feedback = structure.passed ? (coach?.feedback ?? structure.feedback) : structure.feedback;
  return {
    passed,
    entailments: coach?.entailments ?? structure.entailments,
    missingCategories,
    unsupportedClaimIds,
    feedback,
  };
}

export interface ClarificationInput {
  /** Aggregate; `phase` must be PROBLEM_FRAMING. */
  state: RunAggregate;
  commandId: string;
  /** Clarifications already consumed this framing attempt. */
  clarificationBudgetUsed: number;
  /** Defaults to `DEFAULT_CLARIFICATION_BUDGET`. */
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
 * separate small clarification budget (default `DEFAULT_CLARIFICATION_BUDGET`).
 * Throws `CLARIFICATION_BUDGET_EXCEEDED` when the budget is exhausted. The
 * budget is caller-managed (in-memory), mirroring `pendingEvidence`.
 */
export async function prepareClarification(
  input: ClarificationInput,
): Promise<ClarificationResult> {
  const { state, commandId } = input;
  const limit = input.clarificationBudgetLimit ?? DEFAULT_CLARIFICATION_BUDGET;
  if (input.clarificationBudgetUsed >= limit) {
    throw new OrchestratorError(
      CLARIFICATION_BUDGET_EXCEEDED,
      `clarification budget exhausted (limit ${limit})`,
    );
  }

  const runId = state.runId;
  // Phase guard + the explicit `phase.changed` event (PROBLEM_FRAMING -> DISCOVERY).
  assertCommandPhase(state.phase, "clarify");
  const events: RunEvent[] = [
    buildPhaseChangedEvent(runId, commandId, "PROBLEM_FRAMING", "DISCOVERY"),
  ];

  return {
    runId,
    acceptedEvents: events,
    updatedState: { ...state, phase: "DISCOVERY" },
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
  /** Challenge ids already injected by an earlier wave; skipped to avoid re-injection. */
  alreadyInjectedChallengeIds?: readonly string[];
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
 * Build the scheduler's trigger-context snapshot from the public aggregate +
 * the customer capsule. All ids are PUBLIC identifiers only:
 *   - `revealedEvidenceIds`    = the `evidenceId` of every disclosed disclosure unit;
 *   - `unresolvedContradictionIds` = ids of `active` `contradiction`-kind graph nodes;
 *   - `questionCount`          = number of public transcript turns;
 *   - `challengeResponseCount` = responses already recorded.
 */
function buildTriggerContext(state: RunAggregate, capsule: CustomerCapsule): EventTriggerContext {
  const disclosed = new Set(state.disclosedDisclosureUnitIds);
  const revealedEvidenceIds = dedupe(
    capsule.disclosureUnits
      .filter((unit) => disclosed.has(unit.id))
      .map((unit) => unit.evidenceId),
  );
  const unresolvedContradictionIds = state.graph.nodes
    .filter((node) => node.kind === "contradiction" && node.status === "active")
    .map((node) => node.id);
  return {
    phase: state.phase,
    questionCount: state.transcript.length,
    revealedEvidenceIds,
    unresolvedContradictionIds,
    challengeResponseCount: state.challengeResponses.length,
  };
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
    // `assertCommandPhase` has no `challenge.injected` command type; enforce
    // the phase here with the same stable error code the rest of the pipeline
    // uses.
    throw new OrchestratorError(
      "INVALID_PHASE_COMMAND",
      `challenge injection is not valid in phase ${state.phase ?? "UNSTARTED"}`,
    );
  }

  const context = buildTriggerContext(state, capsule);
  const selected = selectScenarioEvents(candidates, context, rng);

  const alreadyInjected = new Set(input.alreadyInjectedChallengeIds ?? []);
  const toInject = selected.filter((candidate) => !alreadyInjected.has(candidate.id));

  const stakeholderId = capsule.stakeholders[0]?.id ?? "customer";

  const events: RunEvent[] = [];
  const interruptions: ChallengeInterruption[] = [];
  for (const candidate of toInject) {
    const challengeId = candidate.id;
    const prompt = candidate.prompt;
    // 1. The authoritative injected record — persisted first.
    events.push({ type: "challenge.injected", runId, commandId, challengeId, prompt });
    // 2. The learner-visible customer interruption (text is the scenario's prompt).
    events.push({
      type: "customer.replied",
      runId,
      commandId,
      questionId: challengeId,
      reply: prompt,
      stakeholderId,
      disclosedDisclosureUnitIds: [],
    });
    interruptions.push({ challengeId, reply: prompt, stakeholderId });
  }

  return {
    runId,
    injectedChallengeIds: toInject.map((candidate) => candidate.id),
    interruptions,
    acceptedEvents: events,
    updatedState: { ...state },
  };
}

// ---------------------------------------------------------------------------
// Challenge response gate (Task 9): respond-challenge
// ---------------------------------------------------------------------------

export interface RespondToChallengeInput {
  /** Aggregate; `phase` must be CHALLENGE. */
  state: RunAggregate;
  response: ChallengeResponse;
  commandId: string;
  /** The injected challenge ids the learner must answer before advancing. */
  mandatoryChallengeIds: readonly string[];
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

  // Re-validate (structural gate). Throws before any event is emitted.
  ChallengeResponseSchema.parse(response);

  const responses = [...state.challengeResponses, response];
  const challengesAddressed = input.mandatoryChallengeIds.every((id) =>
    responses.some((entry) => entry.challengeId === id),
  );

  const events: RunEvent[] = [{ type: "challenge.responded", runId, commandId, response }];
  let phase = state.phase;
  if (challengesAddressed) {
    events.push({ type: "phase.changed", runId, commandId, from: "CHALLENGE", to: "PITCH" });
    phase = "PITCH";
  }

  return {
    runId,
    challengesAddressed,
    acceptedEvents: events,
    updatedState: { ...state, challengeResponses: responses, phase },
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
// Retry (Task 10): spawn a clean, isolated second attempt
// ---------------------------------------------------------------------------

export interface CreateRetryOptions {
  /** The new attempt's run id (deterministic, caller-supplied — no randomness). */
  newRunId: string;
  /** Idempotency key for both the parent's `retry.started` and the new run's `start`. */
  commandId: string;
  /** Defaults to the parent's scenario. */
  scenarioId?: string;
  /** Defaults to the parent's locale. */
  locale?: Locale;
  /** Carried through unchanged (the run seed is caller-owned; not in the aggregate). */
  seed?: number;
  /** Exactly 2 or 3 learner-visible focus summaries from the previous attempt. */
  focusSummaries: LocalizedText[];
  /** Verified scenario-bundle digest stamped onto the child run's `run.started` (Task 7). */
  scenarioBundleDigest?: string;
  store?: StoreOptions;
}

export interface CreateRetryResult {
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
  /** Events persisted to the PARENT run (the durable `retry.started` link). */
  parentEvents: RunEvent[];
}

export const INVALID_RETRY_FOCUS = "INVALID_RETRY_FOCUS" as const;

/**
 * Start a clean retry of a REVIEW-phase attempt.
 *
 * Semantics (verbatim from the brief):
 *   - NEW `runId`; the parent link is recorded durably as a `retry.started`
 *     event on the PARENT run (`run.started` has no parent field).
 *   - Scenario and locale default to the parent's; the seed is carried through
 *     options unchanged.
 *   - The Evidence Graph, disclosure ledger, transcript, and granted hints are
 *     CLEARED; the new run carries only the 2-3 learner-visible focus summaries
 *     (`previousAttemptReview`). The Customer and Evidence Tracker therefore
 *     receive NO previous transcript (their firewall inputs build only from the
 *     new run's empty transcript/graph).
 *   - The new run starts in DISCOVERY: `start` (SCENARIO) followed immediately
 *     by `accept` (SCENARIO → DISCOVERY).
 *
 * Deterministic: no randomness, no wall-clock. `newRunId` is caller-supplied so
 * the CLI (Task 11) controls the identity.
 */
export async function prepareRetry(
  parentRun: RunAggregate,
  options: CreateRetryOptions,
): Promise<CreateRetryResult> {
  if (parentRun.phase !== "REVIEW") {
    throw new InvalidPhaseCommandError("retry", parentRun.phase);
  }
  if (options.focusSummaries.length < 2 || options.focusSummaries.length > 3) {
    throw new OrchestratorError(
      INVALID_RETRY_FOCUS,
      "retry requires 2 or 3 focus summaries",
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
    pendingEvidence: null,
    clarificationBudgetUsed: 0,
    previousAttemptReview: { focusSummaries: options.focusSummaries },
  };

  const parentEvents: RunEvent[] = [
    { type: "retry.started", runId: parentRun.runId, commandId, newRunId },
  ];

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
    parentEvents,
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
  /** The attempt review to fold into the durable learner profile as a transaction effect. */
  effect: CommandEffect;
}

export async function prepareReview(input: SubmitReviewInput): Promise<PreparedReview> {
  const { runtime, capsule, customerCapsule, publicScenario, events, state, commandId } = input;
  const runId = state.runId;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const canaries = input.canaries ?? [capsule.canary];

  // Phase guard: `assertCommandPhase` enforces REVIEW (and emits nothing).
  assertCommandPhase(state.phase, "review");

  // 1. Coach final-review through the firewall (public-only input).
  const { review, invocationId, modelId, rawOutputDigest, promptDigest } = await runFinalReview({
    runtime,
    state: { ...state, coachTask: "final-review" },
    capsule,
    invocationId: `${commandId}:coach`,
    timeoutMs,
    canaries,
  });

  // The verified scenario-bundle digest recorded at run start (provenance only).
  const started = events.find((event) => event.type === "run.started");
  const scenarioBundleSha256 =
    started && started.type === "run.started" ? (started.scenarioBundleDigest ?? null) : null;

  // 2. Deterministic score + provenance.
  const { input: scoreInput, provenance } = buildScoreInput({
    events,
    aggregate: state,
    customerCapsule,
    evaluatorCapsule: capsule,
    publicScenario,
    criterionScores: review.criterionScores,
    evaluatorInvocationId: invocationId,
    modelId,
    scenarioBundleSha256,
  });
  const score = calculateScore(scoreInput);
  // Defense-in-depth: the persisted score must satisfy the domain schema.
  ScoreBreakdownSchema.parse(score);

  // 3. review.completed + score.computed (persisted by the transaction).
  const reviewEvent: RunEvent = {
    type: "review.completed",
    runId,
    commandId,
    review,
    judgment: {
      judgmentId: `${commandId}:coach`,
      invocationId,
      modelId,
      promptDigest,
      schemaVersion: FINAL_REVIEW_OUTPUT_SCHEMA_VERSION,
      scenarioDigest: scenarioBundleSha256 ?? "",
      rawOutputDigest,
    },
  };
  const scoreEvent: RunEvent = { type: "score.computed", runId, commandId, score, provenance };

  // 4. The profile fold becomes an idempotent transaction effect.
  const attempt = deriveAttemptReview(
    scoreInput,
    score,
    events,
    state,
    provenance.comparabilityKey,
  );
  const attemptReview: AttemptReview = { ...attempt, retryFocuses: review.nextFocus };
  const effect: CommandEffect = {
    type: "profile.apply-attempt",
    effectId: `${runId}:${commandId}:profile`,
    runId,
    review: attemptReview,
  };

  return { events: [reviewEvent, scoreEvent], review, score, effect };
}
