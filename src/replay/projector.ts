import type {
  DecisionDivergencePoint,
  EvidenceNode,
  HintLevel,
  Locale,
  LocalizedText,
  RunEvent,
  RunPhase,
  ScoreBreakdown,
} from "../core/domain.js";
import type { HintLedgerEntry } from "../agents/contracts.js";
import type { RunAggregate } from "../core/aggregate.js";
import type { ScoreProvenance } from "../scoring/provenance.js";
import { applyEvidencePatch, createEmptyEvidenceGraph } from "../evidence/graph.js";
import { reduceInjectedChallenges } from "../graph/challenge-state.js";

/**
 * FDE Gym — learner-safe replay projector (Task 11).
 *
 * Two deterministic consumers of the committed event stream:
 *
 *   - `foldRunAggregate(events, scenarioId, locale)` rebuilds the FULL internal
 *     `RunAggregate` so the orchestrator/firewall can RESUME a persisted run.
 *     It reconstructs phase, transcript, evidence graph, the disclosure ledger,
 *     granted hints, brief, proposal, pitch, and challenge responses from the
 *     domain events; everything else (score, profile, CoT, …) starts empty.
 *
 *   - `projectReplay(events, locale)` renders the learner-safe `LearnerReplay`.
 *     It is BYTE-STABLE from the public event stream (deterministic: no model,
 *     no wall-clock) and is locale-parameterized — every `LocalizedText` is
 *     resolved to the requested locale. It reuses the same field-by-field
 *     discipline as `projectPublic` (never spreads an event) so hidden content
 *     (system prompts, hidden capsules, disclosure unit ids, canaries,
 *     chain-of-thought, raw evaluator output) is structurally incapable of
 *     surfacing.
 *
 * Replay modes (labelled on the output via `mode`):
 *   - `"recorded"`      — byte-stable projection of the committed events.
 *   - `"re-simulation"` — a separate mode promising only deterministic
 *     event/state ORDER, never identical model prose. Not implemented in
 *     Task 11; the label exists so a future command cannot conflate the two.
 */

export type ReplayMode = "recorded" | "re-simulation";

// ---------------------------------------------------------------------------
// LearnerReplay shape (locale-resolved, learner-safe)
// ---------------------------------------------------------------------------

export interface ReplayStageChange {
  from: RunPhase;
  to: RunPhase;
}

export interface ReplayTurn {
  turnId: string;
  seq: number;
  question: string;
  customerReply: string;
  stakeholderId: string;
}

export interface ReplayGraphDiff {
  patchId: string;
  expectedVersion: number;
  addNodes: Array<{
    id: string;
    kind: EvidenceNode["kind"];
    claim: string;
    status: EvidenceNode["status"];
    sourceTranscriptIds: string[];
    weight: number;
  }>;
  addEdges: Array<{
    id: string;
    from: string;
    to: string;
    relation: string;
  }>;
  invalidateNodeIds: string[];
}

export interface ReplayQuestionMetric {
  turnId: string;
  /** Deterministic information gain: sum of weights of nodes added by this question's patch. */
  informationGain: number;
  /** Number of evidence nodes added by this question's patch. */
  nodeCount: number;
}

export interface ReplayHint {
  topic: string;
  level: HintLevel;
  hint: string;
}

export interface ReplayEventInjection {
  challengeId: string;
  prompt: string;
}

export interface ReplayArtifacts {
  briefId: string | null;
  proposalId: string | null;
  pitchId: string | null;
  briefSubmissions: number;
  proposalSubmissions: number;
  pitchSubmissions: number;
}

export interface ReplayDecisionDivergencePoint {
  id: string;
  description: string;
}

export interface LearnerReplay {
  mode: ReplayMode;
  runId: string;
  scenarioId: string;
  locale: Locale;
  phase: RunPhase | null;
  stages: ReplayStageChange[];
  transcript: ReplayTurn[];
  graphDiffs: ReplayGraphDiff[];
  questionMetrics: ReplayQuestionMetric[];
  hints: ReplayHint[];
  eventInjections: ReplayEventInjection[];
  artifacts: ReplayArtifacts;
  /** The persisted `score.computed` breakdown, or `null` before review. */
  score: ScoreBreakdown | null;
  strengths: string[];
  weaknesses: string[];
  missedOpportunities: string[];
  decisionDivergencePoints: ReplayDecisionDivergencePoint[];
  nextFocus: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolve(text: LocalizedText, locale: Locale): string {
  return text[locale];
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// foldRunAggregate
// ---------------------------------------------------------------------------

/** The pristine aggregate a fold starts from. */
function emptyAggregate(scenarioId: string, locale: Locale): RunAggregate {
  return {
    runId: "",
    scenarioId,
    locale,
    phase: null,
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
  };
}

/**
 * Deterministic fold of the committed event stream into the full `RunAggregate`.
 * `scenarioId`/`locale` are anchors (overridden by `run.started` when present).
 * `pendingQuestion` is transient working state and is never resurrected across
 * a resume (a persisted run never has a half-asked question in flight).
 */
export function foldRunAggregate(
  events: readonly RunEvent[],
  scenarioId: string,
  locale: Locale,
): RunAggregate {
  const agg = emptyAggregate(scenarioId, locale);

  for (const event of events) {
    switch (event.type) {
      case "run.started": {
        agg.runId = event.runId;
        agg.scenarioId = event.scenarioId;
        agg.locale = event.locale;
        break;
      }
      case "phase.changed": {
        agg.phase = event.to;
        // A `clarify` round-trip (PROBLEM_FRAMING -> DISCOVERY) consumes one unit
        // of the clarification budget; no other command produces this transition.
        if (event.from === "PROBLEM_FRAMING" && event.to === "DISCOVERY") {
          agg.clarificationBudgetUsed += 1;
        }
        break;
      }
      case "question.asked": {
        agg.pendingQuestion = { question: event.question, stakeholderId: "" };
        break;
      }
      case "customer.replied": {
        if (agg.pendingQuestion !== null) {
          const turnId = `${event.commandId}:turn`;
          agg.transcript = [
            ...agg.transcript,
            {
              turnId,
              seq: agg.transcript.length,
              question: agg.pendingQuestion.question,
              customerReply: event.reply,
              stakeholderId: event.stakeholderId,
            },
          ];
          agg.disclosedDisclosureUnitIds = dedupe([
            ...agg.disclosedDisclosureUnitIds,
            ...event.disclosedDisclosureUnitIds,
          ]);
          agg.pendingQuestion = null;
        }
        // Challenge-interruption `customer.replied` events carry no pending
        // question and are therefore not transcript turns.
        break;
      }
      case "evidence.patched": {
        agg.graph = applyEvidencePatch(agg.graph, event.patch);
        break;
      }
      case "evidence.pending": {
        agg.pendingEvidence = { turnId: event.turnId, code: event.failureCode };
        break;
      }
      case "evidence.resolved": {
        if (agg.pendingEvidence?.turnId === event.turnId) {
          agg.pendingEvidence = null;
        }
        break;
      }
      case "hint.granted": {
        agg.grantedHints = [...agg.grantedHints, { topic: event.topic, level: event.level }];
        break;
      }
      case "brief.submitted": {
        agg.brief = event.brief;
        break;
      }
      case "design.submitted": {
        agg.proposal = event.proposal;
        break;
      }
      case "challenge.injected": {
        agg.injectedChallenges = reduceInjectedChallenges(agg.injectedChallenges ?? [], event);
        break;
      }
      case "challenge.responded": {
        agg.challengeResponses = [...agg.challengeResponses, event.response];
        agg.injectedChallenges = reduceInjectedChallenges(agg.injectedChallenges ?? [], event);
        break;
      }
      case "pitch.submitted": {
        agg.pitch = event.pitch;
        break;
      }
      case "retry.focus": {
        agg.previousAttemptReview = { focusSummaries: event.focusSummaries };
        break;
      }
      // Not part of the aggregate: brief.validated, challenge.injected,
      // review.completed, score.computed, retry.started, run.completed,
      // run.aborted.
      default:
        break;
    }
  }

  // Never resurrect transient working state across a resume.
  agg.pendingQuestion = null;
  return agg;
}

// ---------------------------------------------------------------------------
// projectReplay
// ---------------------------------------------------------------------------

/** Resolve the persisted score breakdown verbatim (byte-stable from the event). */
function lastScore(events: readonly RunEvent[]): ScoreBreakdown | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "score.computed") return event.score;
  }
  return null;
}

/**
 * Project the learner-safe, byte-stable replay. Deterministic and locale
 * resolved; excludes every hidden/internal field by construction.
 */
export function projectReplay(events: readonly RunEvent[], locale: Locale): LearnerReplay {
  const agg = foldRunAggregate(events, "", locale);

  const stages: ReplayStageChange[] = [];
  const transcript: ReplayTurn[] = [];
  const graphDiffs: ReplayGraphDiff[] = [];
  const hints: ReplayHint[] = [];
  const eventInjections: ReplayEventInjection[] = [];
  const artifacts: ReplayArtifacts = {
    briefId: null,
    proposalId: null,
    pitchId: null,
    briefSubmissions: 0,
    proposalSubmissions: 0,
    pitchSubmissions: 0,
  };
  let strengths: string[] = [];
  let weaknesses: string[] = [];
  let missedOpportunities: string[] = [];
  let decisionDivergencePoints: ReplayDecisionDivergencePoint[] = [];
  let nextFocus: string[] = [];

  const metricByTurn = new Map<string, { informationGain: number; nodeCount: number }>();
  let pendingQuestion: string | null = null;
  let currentTurnId: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case "phase.changed": {
        stages.push({ from: event.from, to: event.to });
        break;
      }
      case "question.asked": {
        pendingQuestion = event.question;
        currentTurnId = null;
        break;
      }
      case "customer.replied": {
        if (pendingQuestion !== null) {
          const turnId = `${event.commandId}:turn`;
          transcript.push({
            turnId,
            seq: transcript.length,
            question: pendingQuestion,
            customerReply: resolve(event.reply, locale),
            stakeholderId: event.stakeholderId,
          });
          currentTurnId = turnId;
          pendingQuestion = null;
        }
        break;
      }
      case "evidence.patched": {
        graphDiffs.push({
          patchId: event.patch.patchId,
          expectedVersion: event.patch.expectedVersion,
          addNodes: event.patch.addNodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            claim: resolve(node.claim, locale),
            status: node.status,
            sourceTranscriptIds: node.sourceTranscriptIds,
            weight: node.weight,
          })),
          addEdges: event.patch.addEdges.map((edge) => ({
            id: edge.id,
            from: edge.from,
            to: edge.to,
            relation: edge.relation,
          })),
          invalidateNodeIds: event.patch.invalidateNodeIds,
        });
        if (currentTurnId !== null) {
          const gain = event.patch.addNodes.reduce((sum, node) => sum + node.weight, 0);
          const prior = metricByTurn.get(currentTurnId) ?? { informationGain: 0, nodeCount: 0 };
          metricByTurn.set(currentTurnId, {
            informationGain: prior.informationGain + gain,
            nodeCount: prior.nodeCount + event.patch.addNodes.length,
          });
        }
        break;
      }
      case "hint.granted": {
        hints.push({ topic: event.topic, level: event.level, hint: resolve(event.hint, locale) });
        break;
      }
      case "brief.submitted": {
        artifacts.briefId = event.brief.id;
        artifacts.briefSubmissions += 1;
        break;
      }
      case "design.submitted": {
        artifacts.proposalId = event.proposal.id;
        artifacts.proposalSubmissions += 1;
        break;
      }
      case "challenge.injected": {
        eventInjections.push({ challengeId: event.challengeId, prompt: resolve(event.prompt, locale) });
        break;
      }
      case "pitch.submitted": {
        artifacts.pitchId = event.pitch.id;
        artifacts.pitchSubmissions += 1;
        break;
      }
      case "review.completed": {
        strengths = event.review.strengths.map((text) => resolve(text, locale));
        weaknesses = event.review.weaknesses.map((text) => resolve(text, locale));
        missedOpportunities = event.review.missedOpportunities.map((text) => resolve(text, locale));
        decisionDivergencePoints = event.review.decisionDivergencePoints.map((point) => ({
          id: point.id,
          description: resolve(point.description, locale),
        }));
        nextFocus = event.review.nextFocus.map((text) => resolve(text, locale));
        break;
      }
      default:
        break;
    }
  }

  const questionMetrics: ReplayQuestionMetric[] = transcript.map((turn) => {
    const metric = metricByTurn.get(turn.turnId);
    return {
      turnId: turn.turnId,
      informationGain: metric?.informationGain ?? 0,
      nodeCount: metric?.nodeCount ?? 0,
    };
  });

  return {
    mode: "recorded",
    runId: agg.runId,
    scenarioId: agg.scenarioId,
    locale,
    phase: agg.phase,
    stages,
    transcript,
    graphDiffs,
    questionMetrics,
    hints,
    eventInjections,
    artifacts,
    score: lastScore(events),
    strengths,
    weaknesses,
    missedOpportunities,
    decisionDivergencePoints,
    nextFocus,
  };
}

/** Re-exported for callers that need the raw ledger type (typing convenience). */
export type { HintLedgerEntry, DecisionDivergencePoint };

// ---------------------------------------------------------------------------
// Score provenance projection (Task 8)
// ---------------------------------------------------------------------------

/**
 * The learner-safe subset of a score's provenance: everything needed to explain
 * comparability (score/formula/rubric/model identity + comparability key) and
 * fallback use (per-stage source), minus the internal `evaluatorInvocationId`
 * and `scenarioBundleSha256` the learner does not need. `promptSetDigest` and
 * `runtimePolicyVersion` are OPTIONAL here because legacy (upcast) provenance
 * leaves them absent (they are schema-optional).
 */
export type LearnerSafeScoreProvenance = Omit<
  ScoreProvenance,
  "scenarioBundleSha256" | "evaluatorInvocationId" | "promptSetDigest" | "runtimePolicyVersion"
> & {
  promptSetDigest?: string;
  runtimePolicyVersion?: number;
};

/**
 * Project the persisted `score.computed` provenance into its learner-safe
 * subset, or `null` when the run has no score yet. Kept SEPARATE from
 * `LearnerReplay` so the recorded-replay bytes stay frozen; a legacy (upcast)
 * score returns its non-comparable provenance verbatim.
 */
export function projectScoreProvenance(events: readonly RunEvent[]): LearnerSafeScoreProvenance | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "score.computed") {
      const { scenarioBundleSha256: _scenario, evaluatorInvocationId: _invocation, ...safe } =
        event.provenance;
      return safe;
    }
  }
  return null;
}
