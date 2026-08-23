import type { AgentRuntime } from "../agents/agent-runtime.js";
import {
  answerDiscoveryQuestion,
  type CustomerTurn,
} from "../agents/customer.js";
import {
  extractEvidence,
} from "../agents/evidence-tracker.js";
import { validateProblemBrief } from "../agents/coach.js";
import type { QuestionAssessment } from "../agents/contracts.js";
import type { CustomerCapsule, EvaluatorCapsule } from "../scenarios/schema.js";
import type { RunAggregate } from "../security/context-firewall.js";
import { applyEvidencePatch } from "../evidence/graph.js";
import {
  BRIEF_DANGLING_EVIDENCE_REFERENCE,
  SUPPORT_RATIO_THRESHOLD,
  calculateSupportRatio,
  validateBriefStructure,
} from "../evidence/brief-validator.js";
import { ProblemBriefSchema } from "./domain.js";
import type { BriefValidationResult, ProblemBrief, RunEvent, TranscriptTurn } from "./domain.js";
import { decide } from "./state-machine.js";
import { appendEvents, type StoreOptions } from "./event-store.js";
import type { RunState } from "./reducer.js";

/**
 * FDE Gym — discovery turn orchestrator (the wiring layer for Tasks 8–10).
 *
 * `runDiscoveryTurn` executes the FIXED discovery pipeline in exactly this
 * order:
 *
 *   record learner question → invoke Customer → sanitize/project customer reply
 *   → record reply → invoke Evidence Tracker on the public turn →
 *   validate/apply graph patch → compute deterministic per-question metrics →
 *   persist all accepted events.
 *
 * If the Evidence Tracker fails (invalid output, leak, timeout), the customer
 * reply is RETAINED and the turn is marked `EVIDENCE_PENDING`; `frame` must not
 * transition until `repairPendingEvidence` succeeds. The orchestrator is
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
export function assertFrameAllowed(pending: PendingEvidence | null): void {
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

export async function runDiscoveryTurn(
  input: RunDiscoveryTurnInput,
): Promise<DiscoveryTurnResult> {
  const { runtime, capsule, state, question, stakeholderId, commandId } = input;
  const runId = state.runId;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const canaries = input.canaries ?? [capsule.canary];
  const store = input.store;

  // Step 1: record learner question. `decide` enforces the DISCOVERY phase.
  // (decide only reads runId + phase; seq is not consulted for `ask`.)
  const runState: RunState = { runId, phase: state.phase, seq: 0 };
  const questionEvents = decide(runState, { type: "ask", commandId, question });
  const questionEvent = questionEvents[0];

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
  };
  const aggReply = foldReply(aggQuestion, turn, commandId);

  // Steps 4–5: invoke Evidence Tracker on the public turn, validate/apply patch.
  let evidenceEvent: RunEvent;
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
    aggPatched = { ...aggReply, graph: nextGraph };
    // Step 6: deterministic per-question metrics.
    metrics = computeDiscoveryMetrics(evidence.questionAssessment);
  } catch (error) {
    // Retain the customer reply; mark the turn EVIDENCE_PENDING and block frame.
    const failure = normalizeFailure(error);
    const pending: PendingEvidence = {
      turnId: `${commandId}:turn`,
      code: failure.code,
      message: failure.message,
    };
    await appendEvents(runId, [questionEvent, replyEvent], store);
    return {
      runId,
      acceptedEvents: [questionEvent, replyEvent],
      pendingEvidence: pending,
      metrics: null,
      updatedState: aggReply,
    };
  }

  // Step 7: persist all accepted events.
  await appendEvents(runId, [questionEvent, replyEvent, evidenceEvent], store);
  return {
    runId,
    acceptedEvents: [questionEvent, replyEvent, evidenceEvent],
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
export async function repairPendingEvidence(
  input: RepairPendingEvidenceInput,
): Promise<DiscoveryTurnResult> {
  const { runtime, state, commandId } = input;
  const runId = state.runId;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const canaries = input.canaries ?? [];
  const store = input.store;

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
  const updatedState: RunAggregate = { ...state, graph: nextGraph };

  await appendEvents(runId, [evidenceEvent], store);
  return {
    runId,
    acceptedEvents: [evidenceEvent],
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
export async function runFramingGate(input: FramingGateInput): Promise<FramingGateResult> {
  const { runtime, capsule, state, brief, commandId } = input;
  const runId = state.runId;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const canaries = input.canaries ?? [capsule.canary];
  const store = input.store;

  // Phase guard: `decide` enforces PROBLEM_FRAMING and throws otherwise. Its
  // phase-changed collapse is superseded by the multi-step gate below.
  const runState: RunState = { runId, phase: state.phase, seq: 0 };
  decide(runState, { type: "submit-brief", commandId, brief });

  // (a) Zod validation.
  ProblemBriefSchema.parse(brief);

  // (b) Deterministic structural gate.
  const structure = validateBriefStructure(brief, state.graph);

  // (c) Coach entailment classification (public brief + graph + transcript).
  // A dangling evidence reference would make the Coach's strict input schema
  // reject the brief, so classification is skipped in that already-failing case.
  let coachResult: BriefValidationResult | null = null;
  let entailments = structure.entailments;
  if (!structure.missingCategories.includes(BRIEF_DANGLING_EVIDENCE_REFERENCE)) {
    coachResult = await validateProblemBrief({
      runtime,
      state: { ...state, coachTask: "brief-validation", brief },
      capsule,
      invocationId: `${commandId}:coach`,
      timeoutMs,
      canaries,
    });
    entailments = coachResult.entailments;
  }

  // (d) Final deterministic gate: supportRatio >= threshold AND structure passed.
  const supportRatio = calculateSupportRatio(brief.claims, entailments);
  const passed = structure.passed && supportRatio >= SUPPORT_RATIO_THRESHOLD;

  const result = composeBriefValidationResult(structure, coachResult, passed);

  const events: RunEvent[] = [
    { type: "brief.submitted", runId, commandId, brief },
    { type: "brief.validated", runId, commandId, briefId: brief.id, result },
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

  await appendEvents(runId, events, store);

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
export async function requestClarification(
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
  const runState: RunState = { runId, phase: state.phase, seq: 0 };
  // Phase guard + the `phase.changed` event (PROBLEM_FRAMING -> DISCOVERY).
  const events = decide(runState, { type: "clarify", commandId });

  await appendEvents(runId, events, input.store);

  return {
    runId,
    acceptedEvents: events,
    updatedState: { ...state, phase: "DISCOVERY" },
    clarificationBudgetUsed: input.clarificationBudgetUsed + 1,
  };
}
