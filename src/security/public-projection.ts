import type {
  ChallengeResponse,
  DecisionDivergencePoint,
  EvidenceGraphPatch,
  HintLevel,
  Locale,
  LocalizedText,
  PitchArtifact,
  ProblemBrief,
  RunEvent,
  RunPhase,
  ScoreBreakdown,
  SolutionProposal,
} from "../core/domain.js";

/**
 * FDE Gym — public projection.
 *
 * `projectPublic(event)` maps an internal `RunEvent` to a learner-safe public
 * event (or `null` for internal-only / unrecognized events). It constructs each
 * public event field-by-field and never spreads the source event, so hidden
 * content (system prompts, hidden capsules, disclosure unit ids, canaries,
 * chain-of-thought, raw evaluator output) is structurally incapable of
 * surfacing here. Any event type not explicitly mapped returns `null` — the
 * fail-safe default for future internal events.
 *
 * Task 6 maps the Task 4 `RunEvent` union; later tasks extend the mapping for
 * score breakdown (Task 10) and strengths/weaknesses/focus (Tasks 9/10).
 */

export type PublicEvent =
  | { type: "run.started"; runId: string; scenarioId: string; locale: Locale }
  | { type: "phase.changed"; runId: string; from: RunPhase; to: RunPhase }
  | { type: "question.asked"; runId: string; questionId: string; question: string }
  | { type: "customer.replied"; runId: string; questionId: string; reply: LocalizedText; stakeholderId: string }
  | { type: "evidence.patched"; runId: string; patch: EvidenceGraphPatch }
  | { type: "hint.granted"; runId: string; topic: string; level: HintLevel; hint: LocalizedText }
  | { type: "brief.submitted"; runId: string; brief: ProblemBrief }
  | { type: "brief.validated"; runId: string; passed: boolean; feedback: LocalizedText }
  | { type: "design.submitted"; runId: string; proposal: SolutionProposal }
  | { type: "challenge.injected"; runId: string; challengeId: string; prompt: LocalizedText }
  | { type: "challenge.responded"; runId: string; response: ChallengeResponse }
  | { type: "pitch.submitted"; runId: string; pitch: PitchArtifact }
  | {
      type: "review.completed";
      runId: string;
      verdict: "pass" | "fail";
      strengths: LocalizedText[];
      weaknesses: LocalizedText[];
      missedOpportunities: LocalizedText[];
      decisionDivergencePoints: DecisionDivergencePoint[];
      nextFocus: LocalizedText[];
    }
  | { type: "score.computed"; runId: string; score: ScoreBreakdown }
  | { type: "retry.started"; runId: string; newRunId: string }
  | { type: "run.completed"; runId: string }
  | { type: "run.aborted"; runId: string; reason?: string };

export function projectPublic(event: RunEvent): PublicEvent | null {
  switch (event.type) {
    case "run.started":
      return {
        type: "run.started",
        runId: event.runId,
        scenarioId: event.scenarioId,
        locale: event.locale,
      };
    case "phase.changed":
      return { type: "phase.changed", runId: event.runId, from: event.from, to: event.to };
    case "question.asked":
      return {
        type: "question.asked",
        runId: event.runId,
        questionId: event.questionId,
        question: event.question,
      };
    case "customer.replied":
      return {
        type: "customer.replied",
        runId: event.runId,
        questionId: event.questionId,
        reply: event.reply,
        stakeholderId: event.stakeholderId,
      };
    case "evidence.patched":
      // The patch carries only public graph ids (evidence node/edge ids and
      // public transcript source ids) — never hidden disclosure/evidence ids.
      return { type: "evidence.patched", runId: event.runId, patch: event.patch };
    case "question.assessed":
      // Internal-only: per-question form metrics are consumed by scoring and are
      // never surfaced as a public event (the learner sees only aggregate
      // numbers via the score breakdown).
      return null;
    case "evidence.pending":
      // Internal durability marker (turnId + stable code only); never projected.
      return null;
    case "evidence.resolved":
      // Internal durability marker; never projected.
      return null;
    case "hint.granted":
      return {
        type: "hint.granted",
        runId: event.runId,
        topic: event.topic,
        level: event.level,
        hint: event.hint,
      };
    case "brief.submitted":
      return { type: "brief.submitted", runId: event.runId, brief: event.brief };
    case "brief.validated":
      // Learner-safe subset: verdict + feedback only. Per-claim entailments,
      // missing categories, and unsupported-claim ids are evaluator internals.
      return {
        type: "brief.validated",
        runId: event.runId,
        passed: event.result.passed,
        feedback: event.result.feedback,
      };
    case "design.submitted":
      return { type: "design.submitted", runId: event.runId, proposal: event.proposal };
    case "challenge.injected":
      return {
        type: "challenge.injected",
        runId: event.runId,
        challengeId: event.challengeId,
        prompt: event.prompt,
      };
    case "challenge.responded":
      return { type: "challenge.responded", runId: event.runId, response: event.response };
    case "pitch.submitted":
      return { type: "pitch.submitted", runId: event.runId, pitch: event.pitch };
    case "review.completed":
      // Learner-safe subset: verdict + strengths + weaknesses + focus. Missed
      // opportunities and decision-divergence points are sanitized Coach
      // feedback over PUBLIC input only (the Coach never sees ground truth) and
      // are therefore learner-safe — Task 11 exposes them so the replay can
      // show the full review. The optional per-criterion `criterionScores` are
      // NOT projected here (they are numeric but surface only as the aggregate
      // stage scores in `score.computed`).
      return {
        type: "review.completed",
        runId: event.runId,
        verdict: event.review.verdict,
        strengths: event.review.strengths,
        weaknesses: event.review.weaknesses,
        missedOpportunities: event.review.missedOpportunities,
        decisionDivergencePoints: event.review.decisionDivergencePoints,
        nextFocus: event.review.nextFocus,
      };
    case "score.computed":
      // The score breakdown is numeric + boolean only — no hidden content.
      return { type: "score.computed", runId: event.runId, score: event.score };
    case "retry.started":
      return { type: "retry.started", runId: event.runId, newRunId: event.newRunId };
    case "retry.focus":
      // Internal reconstruction marker (previous attempt focus for a resumed
      // child run). The focus summaries are already learner-visible through the
      // parent's `review.completed`; this event is never projected.
      return null;
    case "run.completed":
      return { type: "run.completed", runId: event.runId };
    case "run.aborted":
      return event.reason !== undefined
        ? { type: "run.aborted", runId: event.runId, reason: event.reason }
        : { type: "run.aborted", runId: event.runId };
    default: {
      // Fail-safe: an unrecognized (internal/future) event is never projected.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}
