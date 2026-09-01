/**
 * G1-04 seed — adversarial graph fixtures.
 *
 * Reusable `RunEvent[]` batches that CONSTRUCT the illegal-event cases from the
 * Phase 1 adversarial matrix, plus a couple of legal controls. These are the
 * consumables for the Phase 1 batch validator (G1-01: reject an illegal batch
 * BEFORE journaling) and the fail-closed replay (G1-02: refuse to fold an
 * illegal log).
 *
 * Conventions:
 *   - ids (runId/commandId) are hard-coded and deterministic.
 *   - everything is typed `RunEvent`; the ONE fixture that is schema-invalid on
 *     purpose (`emptyChallengeResponse`) is cast through `unknown` and documented.
 *   - "schema-valid" below means `RunEventSchema` accepts each event TODAY. An
 *     illegal-but-schema-valid fixture is the interesting case: the domain
 *     schema cannot see the illegality, so the graph validator must.
 */

import type {
  BriefValidationResult,
  ChallengeDecision,
  ChallengeResponse,
  HintLevel,
  Locale,
  LocalizedText,
  ProblemBrief,
  RunEvent,
  RunPhase,
} from "../../src/core/domain.js";

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

/** Bilingual text helper (matches the adversarial-test idiom). */
export function text(zh: string, en: string): LocalizedText {
  return { "zh-CN": zh, "en-US": en };
}

export function buildRunStarted(
  runId: string,
  commandId: string,
  opts: { scenarioId?: string; locale?: Locale } = {},
): RunEvent {
  const { scenarioId = "scn-adversarial", locale = "zh-CN" } = opts;
  return { type: "run.started", runId, commandId, scenarioId, locale };
}

export function buildPhaseChanged(
  runId: string,
  commandId: string,
  from: RunPhase,
  to: RunPhase,
): RunEvent {
  return { type: "phase.changed", runId, commandId, from, to };
}

export function buildQuestionAsked(
  runId: string,
  commandId: string,
  questionId: string,
  question: string,
): RunEvent {
  return { type: "question.asked", runId, commandId, questionId, question };
}

export function buildCustomerReplied(
  runId: string,
  commandId: string,
  questionId: string,
  reply: LocalizedText,
  stakeholderId: string,
  disclosedDisclosureUnitIds: string[] = [],
): RunEvent {
  return { type: "customer.replied", runId, commandId, questionId, reply, stakeholderId, disclosedDisclosureUnitIds };
}

export function buildEvidencePatched(runId: string, commandId: string, patchId: string): RunEvent {
  return {
    type: "evidence.patched",
    runId,
    commandId,
    patch: { patchId, expectedVersion: 0, addNodes: [], addEdges: [], invalidateNodeIds: [] },
  };
}

export function buildQuestionAssessed(runId: string, commandId: string, questionId: string): RunEvent {
  return {
    type: "question.assessed",
    runId,
    commandId,
    questionId,
    assessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
  };
}

export function buildHintGranted(
  runId: string,
  commandId: string,
  topic: string,
  level: HintLevel = 1,
): RunEvent {
  return { type: "hint.granted", runId, commandId, topic, level, hint: text("提示", "hint") };
}

export function buildChallengeInjected(runId: string, commandId: string, challengeId: string): RunEvent {
  return { type: "challenge.injected", runId, commandId, challengeId, prompt: text("质疑", "challenge") };
}

export function buildChallengeResponded(
  runId: string,
  commandId: string,
  response: ChallengeResponse,
): RunEvent {
  return { type: "challenge.responded", runId, commandId, response };
}

export function buildRunCompleted(runId: string, commandId: string): RunEvent {
  return { type: "run.completed", runId, commandId };
}

export function buildRunAborted(runId: string, commandId: string, reason?: string): RunEvent {
  return reason !== undefined
    ? { type: "run.aborted", runId, commandId, reason }
    : { type: "run.aborted", runId, commandId };
}

export function challengeResponse(
  id: string,
  challengeId: string,
  decision: ChallengeDecision = "keep",
): ChallengeResponse {
  return {
    id,
    challengeId,
    impact: text("影响", "impact"),
    decision,
    rationale: text("理由", "rationale"),
    newRiskOrValidation: text("新风险", "new risk"),
  };
}

export function minimalBrief(): ProblemBrief {
  return {
    id: "brief-1",
    problemStatement: text("问题陈述", "Problem statement"),
    goal: text("目标", "Goal"),
    constraints: [],
    claims: [{ id: "claim-1", statement: text("论断", "Claim"), weight: "major", evidenceIds: ["e1"] }],
    successMeasures: [],
    unknowns: [],
    contradictions: [],
  };
}

export function passingValidation(): BriefValidationResult {
  return {
    passed: true,
    entailments: [{ claimId: "claim-1", entailment: "supported" }],
    missingCategories: [],
    unsupportedClaimIds: [],
    feedback: text("通过", "passed"),
  };
}

export function buildBriefSubmitted(runId: string, commandId: string, brief: ProblemBrief): RunEvent {
  return { type: "brief.submitted", runId, commandId, brief };
}

export function buildBriefValidated(
  runId: string,
  commandId: string,
  briefId: string,
  result: BriefValidationResult,
): RunEvent {
  return { type: "brief.validated", runId, commandId, briefId, result };
}

// ---------------------------------------------------------------------------
// Control fixtures (legal)
// ---------------------------------------------------------------------------

/** Control: matches `START_PROTOCOL` — `run.started` + the SCENARIO→SCENARIO anchor. */
export const legalStartBatch: RunEvent[] = [
  buildRunStarted("g1-04-control-start", "c-start"),
  buildPhaseChanged("g1-04-control-start", "c-start", "SCENARIO", "SCENARIO"),
];

/** Control: matches `ASK_PROTOCOL` — required pair + the success optional events. */
export const legalAskBatch: RunEvent[] = [
  buildQuestionAsked("g1-04-control-ask", "c-ask", "q1", "多少告警？"),
  buildCustomerReplied("g1-04-control-ask", "c-ask", "q1", text("很多", "many"), "s-owner", ["du-1"]),
  buildEvidencePatched("g1-04-control-ask", "c-ask", "p1"),
  buildQuestionAssessed("g1-04-control-ask", "c-ask", "q1"),
];

// ---------------------------------------------------------------------------
// Illegal fixtures
// ---------------------------------------------------------------------------

/**
 * Illegal: cross-phase transition.
 * The third event declares `from: "DISCOVERY"` but the folded current phase
 * (after `run.started` + the SCENARIO→SCENARIO anchor) is `SCENARIO`. The
 * SCENARIO→DISCOVERY `accept` hop was skipped, so `from` does not match the
 * folded phase. Every event is schema-valid on its own; the continuity check is
 * what G1-01 must reject.
 */
export const illegalCrossPhaseTransition: RunEvent[] = [
  buildRunStarted("g1-04-cross-phase", "c-start"),
  buildPhaseChanged("g1-04-cross-phase", "c-start", "SCENARIO", "SCENARIO"),
  buildPhaseChanged("g1-04-cross-phase", "c-hop", "DISCOVERY", "PROBLEM_FRAMING"),
];

/**
 * Illegal: wrong `from` on a `phase.changed`.
 * `from: "PITCH"` → `to: "DISCOVERY"` is not declared anywhere in
 * `PHASE_EDGES` (no edge exits PITCH toward DISCOVERY). The `from` field names
 * an origin that can never legally reach this `to`. Schema-valid, graph-illegal.
 */
export const wrongFromPhaseChanged: RunEvent[] = [
  buildPhaseChanged("g1-04-wrong-from", "c-hop", "PITCH", "DISCOVERY"),
];

/**
 * Illegal: protocol violation — MISSING required event.
 * `ASK_PROTOCOL` requires `question.asked` then `customer.replied`; this batch
 * omits `customer.replied`.
 */
export const protocolMissingRequired: RunEvent[] = [
  buildQuestionAsked("g1-04-protocol", "c-ask", "q1", "多少告警？"),
  buildEvidencePatched("g1-04-protocol", "c-ask", "p1"),
];

/**
 * Illegal: protocol violation — OUT-OF-ORDER required events.
 * `ASK_PROTOCOL` is `ordered: true` and requires `question.asked` before
 * `customer.replied`; here the reply precedes the question.
 */
export const protocolOutOfOrder: RunEvent[] = [
  buildCustomerReplied("g1-04-protocol", "c-ask", "q1", text("很多", "many"), "s-owner", []),
  buildQuestionAsked("g1-04-protocol", "c-ask", "q1", "多少告警？"),
  buildEvidencePatched("g1-04-protocol", "c-ask", "p1"),
];

/**
 * Illegal: protocol violation — EXTRA event outside the protocol.
 * `hint.granted` is neither `required` nor `optional` in `ASK_PROTOCOL`; it must
 * not appear in an `ask` batch.
 */
export const protocolExtraEvent: RunEvent[] = [
  buildQuestionAsked("g1-04-protocol", "c-ask", "q1", "多少告警？"),
  buildCustomerReplied("g1-04-protocol", "c-ask", "q1", text("很多", "many"), "s-owner", []),
  buildHintGranted("g1-04-protocol", "c-ask", "workflow"),
  buildEvidencePatched("g1-04-protocol", "c-ask", "p1"),
];

/**
 * Illegal: MIXED `runId` across one batch.
 * A single journaled batch must belong to exactly one run; here `run.started`
 * names `g1-04-mixed-a` while the anchor `phase.changed` names `g1-04-mixed-b`.
 * Schema-valid (no cross-event runId check in the schema); graph-illegal.
 */
export const mixedRunIdBatch: RunEvent[] = [
  buildRunStarted("g1-04-mixed-a", "c-start"),
  buildPhaseChanged("g1-04-mixed-b", "c-start", "SCENARIO", "SCENARIO"),
];

/**
 * Illegal: events AFTER a terminal event.
 * `run.completed` is terminal; nothing (not even its own `phase.changed`, which
 * the COMPLETE protocol authors in the same batch) may be followed by further
 * domain events. The trailing `question.asked`/`customer.replied` must be
 * rejected. (Symmetric for `run.aborted`.)
 */
export const eventsAfterTerminal: RunEvent[] = [
  buildRunStarted("g1-04-terminal", "c-start"),
  buildPhaseChanged("g1-04-terminal", "c-start", "SCENARIO", "SCENARIO"),
  buildRunCompleted("g1-04-terminal", "c-complete"),
  buildPhaseChanged("g1-04-terminal", "c-complete", "REVIEW", "COMPLETED"),
  buildQuestionAsked("g1-04-terminal", "c-after", "q-after", "补问？"),
  buildCustomerReplied("g1-04-terminal", "c-after", "q-after", text("不行", "no"), "s-owner", []),
];

/**
 * Illegal: UNKNOWN challenge response.
 * `challenge.responded` references `challengeId: "ch-not-injected"`, but no
 * `challenge.injected` with that id exists in the run. A response must answer an
 * injected challenge. Schema-valid; graph-illegal.
 */
export const unknownChallengeResponse: RunEvent[] = [
  buildChallengeResponded("g1-04-unknown-resp", "c-respond", challengeResponse("resp-1", "ch-not-injected")),
];

/**
 * Illegal: DUPLICATE challenge response.
 * The same `challengeId` is answered twice in one batch. A challenge may be
 * answered at most once. Schema-valid; graph-illegal.
 */
export const duplicateChallengeResponse: RunEvent[] = [
  buildChallengeResponded("g1-04-dup-resp", "c-respond", challengeResponse("resp-1", "ch-1")),
  buildChallengeResponded("g1-04-dup-resp", "c-respond", challengeResponse("resp-2", "ch-1")),
];

/**
 * Illegal: EMPTY challenge response.
 * `challenge.responded` whose `response` is an empty object. `ChallengeResponseSchema`
 * requires `id`, `challengeId`, `impact`, `decision`, `rationale`,
 * `newRiskOrValidation`, so `RunEventSchema` rejects this TODAY (defense in depth).
 * Cast through `unknown` because the domain schema would reject this shape — the
 * whole point of the fixture. G1-01 should reject it as an empty response too.
 */
export const emptyChallengeResponse: RunEvent[] = [
  {
    type: "challenge.responded",
    runId: "g1-04-empty-resp",
    commandId: "c-respond",
    response: {},
  } as unknown as RunEvent,
];

// ---------------------------------------------------------------------------
// Reference fixture (not illegal — recovery contract)
// ---------------------------------------------------------------------------

/**
 * Reference ONLY: a prepared-journal recovery slice.
 *
 * A journal whose model outputs are already committed as events — the customer
 * reply, the evidence-tracker assessment, and the coach's brief validation.
 * When G1-02 replays this journal it must reconstruct the aggregate from these
 * committed events WITHOUT re-invoking the customer / evidence-tracker / coach
 * models. Not asserted illegal anywhere; documented so the fail-closed replay
 * keeps this as a positive control.
 */
export const preparedJournalRecovery: RunEvent[] = [
  buildRunStarted("g1-04-journal", "c-start"),
  buildPhaseChanged("g1-04-journal", "c-start", "SCENARIO", "SCENARIO"),
  buildPhaseChanged("g1-04-journal", "c-accept", "SCENARIO", "DISCOVERY"),
  buildQuestionAsked("g1-04-journal", "c-ask", "q1", "多少告警？"),
  buildCustomerReplied("g1-04-journal", "c-ask", "q1", text("很多", "many"), "s-owner", ["du-1"]),
  buildEvidencePatched("g1-04-journal", "c-ask", "p1"),
  buildQuestionAssessed("g1-04-journal", "c-ask", "q1"),
  buildPhaseChanged("g1-04-journal", "c-frame", "DISCOVERY", "PROBLEM_FRAMING"),
  buildBriefSubmitted("g1-04-journal", "c-brief", minimalBrief()),
  buildBriefValidated("g1-04-journal", "c-brief", "brief-1", passingValidation()),
];

// ---------------------------------------------------------------------------
// Registries (for the skeleton test to iterate over)
// ---------------------------------------------------------------------------

export interface FixtureCase {
  /** Stable, human-readable fixture name. */
  name: string;
  /** Which rule the fixture violates (or "control" / "reference"). */
  rule: string;
  /** The constructed batch. */
  events: RunEvent[];
  /** Whether `RunEventSchema.parse` accepts every event TODAY (individually). */
  schemaValid: boolean;
}

export const CONTROL_FIXTURES: readonly FixtureCase[] = [
  { name: "legalStartBatch", rule: "control: matches START_PROTOCOL", events: legalStartBatch, schemaValid: true },
  { name: "legalAskBatch", rule: "control: matches ASK_PROTOCOL", events: legalAskBatch, schemaValid: true },
];

export const ILLEGAL_FIXTURES: readonly FixtureCase[] = [
  { name: "illegalCrossPhaseTransition", rule: "phase continuity: from != folded current phase", events: illegalCrossPhaseTransition, schemaValid: true },
  { name: "wrongFromPhaseChanged", rule: "no PHASE_EDGES edge from→to", events: wrongFromPhaseChanged, schemaValid: true },
  { name: "protocolMissingRequired", rule: "ASK_PROTOCOL missing required customer.replied", events: protocolMissingRequired, schemaValid: true },
  { name: "protocolOutOfOrder", rule: "ASK_PROTOCOL ordered: true violated", events: protocolOutOfOrder, schemaValid: true },
  { name: "protocolExtraEvent", rule: "hint.granted outside ASK_PROTOCOL", events: protocolExtraEvent, schemaValid: true },
  { name: "mixedRunIdBatch", rule: "events span two runIds", events: mixedRunIdBatch, schemaValid: true },
  { name: "eventsAfterTerminal", rule: "events after terminal run.completed", events: eventsAfterTerminal, schemaValid: true },
  { name: "unknownChallengeResponse", rule: "challengeId never injected", events: unknownChallengeResponse, schemaValid: true },
  { name: "duplicateChallengeResponse", rule: "challengeId answered twice", events: duplicateChallengeResponse, schemaValid: true },
  { name: "emptyChallengeResponse", rule: "empty response payload (schema-invalid by design)", events: emptyChallengeResponse, schemaValid: false },
];

export const REFERENCE_FIXTURES: readonly FixtureCase[] = [
  { name: "preparedJournalRecovery", rule: "reference: replay must not re-invoke the model", events: preparedJournalRecovery, schemaValid: true },
];
