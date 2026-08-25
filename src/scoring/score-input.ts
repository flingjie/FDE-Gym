import type { CriterionScores, QuestionAssessment, RunEvent } from "../core/domain.js";
import type { RunAggregate } from "../security/context-firewall.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
} from "../scenarios/schema.js";
import { calculateSupportRatio } from "../evidence/brief-validator.js";
import type { AttemptReview, CompetencyScores } from "../profile/learner-profile.js";
import type { ScoreBreakdown } from "../core/domain.js";
import { computeStageScore, type RubricStageId } from "./rubric.js";
import {
  buildScoreProvenance,
  deriveStageProvenance,
  type ScoreProvenance,
  type StageScoreProvenance,
} from "./provenance.js";
import type {
  HintCounts,
  QuestionScoreInput,
  ScoreInput,
  StageScores,
} from "./formulas.js";

/**
 * FDE Gym — deterministic derivation of the scoring inputs and score provenance.
 *
 * `calculateScore` needs two inputs the product derives from the committed event
 * stream plus model outputs:
 *   - Per-question FORM metrics (atomicity/neutrality/relevance/redundancy) come
 *     from the Evidence Tracker's persisted `question.assessed` event;
 *   - The five stage scores come from the Coach's persisted per-criterion
 *     `criterionScores` (weighted by `computeStageScore` against the fixed
 *     capability rubric).
 *
 * Both have a DOCUMENTED deterministic fallback, used ONLY when the model
 * judgment is explicitly missing: a legacy run that predates the persisted
 * assessment/criterion scores, or a stage whose `criterionScores` map is absent
 * or empty. The fallback is deterministic (no randomness, no wall-clock, no
 * model call) so the replay and the score remain byte-stable. Each stage's
 * model-vs-fallback choice is recorded in the returned `ScoreProvenance`.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp100(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** The last `brief.validated` result (the one pairing with the submitted brief). */
function findLastBriefValidation(events: readonly RunEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "brief.validated") return event.result;
  }
  return null;
}

/** Distinct challenge ids the run injected (from `challenge.injected` events). */
function injectedChallengeIds(events: readonly RunEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type === "challenge.injected") seen.add(event.challengeId);
  }
  return [...seen];
}

/**
 * DETERMINISTIC FALLBACK (Task 13 item): stage scores derived from available
 * public signals. There is no per-criterion Coach score yet.
 *
 *   - framing   = `briefSupport × 100` (the weighted support ratio is the
 *                 strongest framing signal available).
 *   - solution  = 100 when a structurally-valid proposal exists, else 0.
 *   - challenge = 100 × answered/mandatory (100 when there were no challenges).
 *   - pitch     = 100 when the pitch carries an explicit ask, else 0.
 *   - process   = 100 − hintPenalty (hint reliance degrades process discipline).
 */
export function fallbackStageScores(input: {
  briefSupport: number;
  proposalPresent: boolean;
  mandatoryChallenges: number;
  answeredChallenges: number;
  pitchExplicitAsk: boolean;
  hintPenalty: number;
}): StageScores {
  return {
    framing: clamp100(input.briefSupport * 100),
    solution: input.proposalPresent ? 100 : 0,
    challenge:
      input.mandatoryChallenges === 0
        ? 100
        : clamp100((input.answeredChallenges / input.mandatoryChallenges) * 100),
    pitch: input.pitchExplicitAsk ? 100 : 0,
    process: clamp100(100 - input.hintPenalty),
  };
}

/**
 * Derive the five stage scores plus each stage's provenance. When the Coach's
 * final review carries per-criterion scores, weight them with `computeStageScore`
 * against the fixed capability rubric; otherwise fall back to `fallbackStageScores`.
 * A stage is derived from criterion scores only when at least one is present — a
 * missing stage falls back rather than collapsing to 0. The per-stage
 * model-vs-fallback choice is recorded for `ScoreProvenance`.
 */
function deriveStageScores(
  criterionScores: CriterionScores | undefined,
  fallback: StageScores,
): { stageScores: StageScores; stageProvenance: Record<RubricStageId, StageScoreProvenance> } {
  const stageProvenance = deriveStageProvenance(criterionScores);
  const stageScore = (stage: RubricStageId): number => {
    if (stageProvenance[stage].source === "model") {
      return computeStageScore(stage, criterionScores![stage]!);
    }
    return fallback[stage];
  };
  return {
    stageScores: {
      framing: stageScore("framing"),
      solution: stageScore("solution"),
      challenge: stageScore("challenge"),
      pitch: stageScore("pitch"),
      process: stageScore("process"),
    },
    stageProvenance,
  };
}

/**
 * Build per-question score inputs. `newlyRevealedWeight` always comes from the
 * disclosure ledger (question-driven only). The FORM metrics
 * (atomicity/neutrality/relevance/redundancy) come from the persisted Evidence
 * Tracker assessment (`question.assessed`), keyed by the turn's questionId.
 *
 * For runs predating `question.assessed` (or a turn whose assessment is
 * missing), the deterministic revelation heuristic is the fallback: a question
 * that revealed new evidence scores as a clean, relevant, non-redundant
 * question, and one that revealed nothing scores as redundant.
 */
function buildQuestionScores(
  events: readonly RunEvent[],
  customerCapsule: CustomerCapsule,
  evaluatorCapsule: EvaluatorCapsule,
): QuestionScoreInput[] {
  const duToEvidence = new Map(
    customerCapsule.disclosureUnits.map((unit) => [unit.id, unit.evidenceId] as const),
  );
  const evidenceWeight = new Map(
    evaluatorCapsule.expectedEvidence.map((evidence) => [evidence.id, evidence.weight] as const),
  );

  // Persisted assessments, keyed by questionId.
  const assessments = new Map<string, QuestionAssessment>();
  for (const event of events) {
    if (event.type === "question.assessed") assessments.set(event.questionId, event.assessment);
  }

  const revealed = new Set<string>();
  const out: QuestionScoreInput[] = [];

  let pending = false;
  let currentQuestionId: string | null = null;
  for (const event of events) {
    if (event.type === "question.asked") {
      pending = true;
      currentQuestionId = event.questionId;
    } else if (event.type === "customer.replied" && pending) {
      pending = false;
      let newlyRevealedWeight = 0;
      for (const duId of event.disclosedDisclosureUnitIds) {
        const evidenceId = duToEvidence.get(duId);
        if (evidenceId === undefined || revealed.has(evidenceId)) continue;
        revealed.add(evidenceId);
        newlyRevealedWeight += evidenceWeight.get(evidenceId) ?? 0;
      }
      const hasNew = newlyRevealedWeight > 0;
      const assessment = currentQuestionId === null ? undefined : assessments.get(currentQuestionId);
      out.push({
        newlyRevealedWeight,
        atomicity: assessment?.atomicity ?? 1,
        neutrality: assessment?.neutrality ?? 1,
        relevance: assessment?.relevance ?? (hasNew ? 1 : 0),
        redundancy: assessment?.redundancy ?? (hasNew ? 0 : 1),
      });
      currentQuestionId = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildScoreInput
// ---------------------------------------------------------------------------

export interface BuildScoreInputOptions {
  events: readonly RunEvent[];
  aggregate: RunAggregate;
  customerCapsule: CustomerCapsule;
  evaluatorCapsule: EvaluatorCapsule;
  publicScenario: PublicScenario;
  /** The Coach's per-criterion scores from final-review (optional). */
  criterionScores?: CriterionScores;
  /** The Coach final-review invocation id (provenance metadata). */
  evaluatorInvocationId?: string | null;
  /** The configured model family identifier (provenance metadata). */
  modelId?: string | null;
  /** The verified scenario-bundle digest recorded at run start (provenance metadata). */
  scenarioBundleSha256?: string | null;
}

export interface BuildScoreInputResult {
  input: ScoreInput;
  provenance: ScoreProvenance;
}

/** Assemble the full `ScoreInput` for `calculateScore` plus its provenance. */
export function buildScoreInput(options: BuildScoreInputOptions): BuildScoreInputResult {
  const { events, aggregate, customerCapsule, evaluatorCapsule, publicScenario } = options;

  // --- coverage: revealed expected-evidence weight / total weight -------------
  const totalExpectedWeight = evaluatorCapsule.expectedEvidence.reduce(
    (sum, evidence) => sum + evidence.weight,
    0,
  );
  const disclosed = new Set(aggregate.disclosedDisclosureUnitIds);
  const revealedEvidenceIds = new Set(
    customerCapsule.disclosureUnits
      .filter((unit) => disclosed.has(unit.id))
      .map((unit) => unit.evidenceId),
  );
  const revealedWeight = evaluatorCapsule.expectedEvidence
    .filter((evidence) => revealedEvidenceIds.has(evidence.id))
    .reduce((sum, evidence) => sum + evidence.weight, 0);
  const coverage = totalExpectedWeight > 0 ? revealedWeight / totalExpectedWeight : 0;

  // --- per-question inputs -----------------------------------------------------
  const questions = buildQuestionScores(events, customerCapsule, evaluatorCapsule);

  // --- stakeholder coverage (percentage) ---------------------------------------
  const stakeholders = customerCapsule.stakeholders;
  const askedStakeholders = new Set(aggregate.transcript.map((turn) => turn.stakeholderId));
  const stakeholderCoverage =
    stakeholders.length > 0
      ? clamp100((100 * askedStakeholders.size) / stakeholders.length)
      : 0;

  // --- contradiction handling (percentage) -------------------------------------
  const contradictionNodes = aggregate.graph.nodes.filter((node) => node.kind === "contradiction");
  const briefContradictionEvidence = new Set(
    (aggregate.brief?.contradictions ?? []).flatMap((entry) => entry.evidenceIds),
  );
  const handledContradictions = contradictionNodes.filter((node) =>
    briefContradictionEvidence.has(node.id),
  ).length;
  const contradictionHandling =
    contradictionNodes.length > 0
      ? clamp100((100 * handledContradictions) / contradictionNodes.length)
      : 100;

  // --- hint counts -------------------------------------------------------------
  const hintCounts: HintCounts = { l1: 0, l2: 0, l3: 0 };
  for (const entry of aggregate.grantedHints) {
    if (entry.level === 1) hintCounts.l1 += 1;
    else if (entry.level === 2) hintCounts.l2 += 1;
    else if (entry.level === 3) hintCounts.l3 += 1;
  }
  const hintPenalty = Math.min(12, hintCounts.l1 + 3 * hintCounts.l2 + 6 * hintCounts.l3);

  // --- brief support + unsupported critical claims -----------------------------
  const validation = findLastBriefValidation(events);
  const brief = aggregate.brief;
  const briefSupport = brief
    ? calculateSupportRatio(brief.claims, validation?.entailments ?? [])
    : 0;
  const unsupportedIds = new Set(validation?.unsupportedClaimIds ?? []);
  const criticalUnsupported = (brief?.claims ?? []).filter(
    (claim) => claim.weight === "critical" && unsupportedIds.has(claim.id),
  ).length;

  // --- unacknowledged critical contradictions (deterministic approximation) ----
  const unacknowledgedCriticalContradictions = evaluatorCapsule.criticalContradictions.filter(
    (cc) => !cc.expectedEvidenceIds.every((id) => revealedEvidenceIds.has(id)),
  ).length;

  // --- pitch + leak guard -------------------------------------------------------
  const pitchExplicitAsk = aggregate.pitch !== null && aggregate.pitch.ask["zh-CN"].trim().length > 0;

  // --- stage scores (per-criterion Coach scores with deterministic fallback) ----
  const mandatory = injectedChallengeIds(events);
  const answered = new Set(aggregate.challengeResponses.map((response) => response.challengeId));
  const fallback = fallbackStageScores({
    briefSupport,
    proposalPresent: aggregate.proposal !== null,
    mandatoryChallenges: mandatory.length,
    answeredChallenges: [...answered].filter((id) => mandatory.includes(id)).length,
    pitchExplicitAsk,
    hintPenalty,
  });
  const { stageScores, stageProvenance } = deriveStageScores(options.criterionScores, fallback);

  const input: ScoreInput = {
    coverage: clamp01(coverage),
    totalExpectedWeight: Math.max(0, totalExpectedWeight),
    questionBudget: publicScenario.questionBudget,
    questions,
    stakeholderCoverage,
    contradictionHandling,
    stageScores,
    hintCounts,
    criticalUnsupported,
    unacknowledgedCriticalContradictions,
    briefSupport: clamp01(briefSupport),
    pitchExplicitAsk,
    leakGuardViolation: false,
  };

  const provenance = buildScoreProvenance({
    stageProvenance,
    evaluatorInvocationId: options.evaluatorInvocationId ?? null,
    modelId: options.modelId ?? null,
    scenarioBundleSha256: options.scenarioBundleSha256 ?? null,
  });

  return { input, provenance };
}

// ---------------------------------------------------------------------------
// Attempt review (profile inputs)
// ---------------------------------------------------------------------------

/** Map the six capability scores to the six learner-profile competencies. */
function mapCompetencies(score: ScoreBreakdown): CompetencyScores {
  return {
    discovery: score.discovery,
    problemFraming: score.framing,
    evidenceReasoning: score.process,
    solutionDesign: score.solution,
    adaptability: score.challenge,
    pitching: score.pitch,
  };
}

/**
 * Derive the `AttemptReview` profile inputs from the computed score. The six
 * competencies map 1:1 onto the stage/discovery scores; `evidenceReasoning`
 * uses `process` (evidence hygiene). The score's `comparabilityKey` is carried
 * through so the profile never blends EMA across incompatible scoring identity.
 * Deterministic.
 */
export function deriveAttemptReview(
  scoreInput: ScoreInput,
  score: ScoreBreakdown,
  events: readonly RunEvent[],
  aggregate: RunAggregate,
  comparabilityKey: string,
): Omit<AttemptReview, "retryFocuses"> {
  const questionCount = score.questions.length;
  const repeated = score.questions.filter((question) => question.gq === 0).length;
  const validation = findLastBriefValidation(events);
  const totalClaims = aggregate.brief?.claims.length ?? 0;

  return {
    competencies: mapCompetencies(score),
    hintReliance: clamp100((score.hintPenalty / 12) * 100),
    repeatedQuestionRate: questionCount > 0 ? repeated / questionCount : 0,
    unsupportedClaimRate:
      totalClaims > 0 ? (validation?.unsupportedClaimIds.length ?? 0) / totalClaims : 0,
    contradictionHandling: scoreInput.contradictionHandling,
    comparabilityKey,
  };
}
