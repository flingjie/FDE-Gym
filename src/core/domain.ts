import { z } from "zod";

import { ScoreProvenanceSchema } from "../scoring/provenance.js";

/**
 * FDE Gym — core domain types and strict schemas.
 *
 * These names are the stable contracts consumed by every later task. Renaming
 * any of them cascades through the orchestrator, state machine, evidence graph,
 * role runtimes, and CLI. The string-literal unions below are derived from
 * `as const` arrays so the TypeScript type and the Zod enum can never drift.
 */

// ---------------------------------------------------------------------------
// Bilingual text
// ---------------------------------------------------------------------------

/**
 * Frozen MVP schema version (finalized in Task 14). Every load-time-gated
 * resource — scenario packs (`SCENARIO_SCHEMA_VERSION`), run manifests, and
 * learner profiles — carries this exact literal value. Loaders reject any other
 * value with `UNSUPPORTED_SCHEMA_VERSION` (see `core/errors.ts`).
 */
export const FDE_SCHEMA_VERSION = 1 as const;

/**
 * Safe filesystem resource-id shape. Every id that becomes a filename component
 * (run ids today; scenario ids and command-journal ids in later tasks) must
 * match this before any path join: a leading alphanumeric, then up to 127 of
 * `[A-Za-z0-9._-]`. It preserves full UUIDs and hyphenated scenario ids while
 * excluding path separators, traversal, and empty strings.
 */
export const SAFE_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Zod form of `SAFE_RESOURCE_ID` for schema-level validation of filename-bound ids. */
export const SafeResourceIdSchema = z.string().regex(SAFE_RESOURCE_ID);

export const LOCALES = ["zh-CN", "en-US"] as const;
export type Locale = (typeof LOCALES)[number];
export const LocaleSchema = z.enum(LOCALES);

/** Exactly two locale keys; both required and non-empty. */
export type LocalizedText = {
  "zh-CN": string;
  "en-US": string;
};

export const LocalizedTextSchema = z
  .object({
    "zh-CN": z.string().min(1),
    "en-US": z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phases, roles, evidence vocabulary
// ---------------------------------------------------------------------------

export const RUN_PHASES = [
  "SCENARIO",
  "DISCOVERY",
  "PROBLEM_FRAMING",
  "SOLUTION_DESIGN",
  "CHALLENGE",
  "PITCH",
  "REVIEW",
  "RETRY_READY",
  "COMPLETED",
  "ABORTED",
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export const RunPhaseSchema = z.enum(RUN_PHASES);

export const AGENT_ROLES = ["customer", "evidence_tracker", "coach_evaluator"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const AgentRoleSchema = z.enum(AGENT_ROLES);

export const EVIDENCE_KINDS = ["fact", "assumption", "unknown", "contradiction"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

export const EVIDENCE_STATUSES = ["active", "resolved", "invalidated"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];
export const EvidenceStatusSchema = z.enum(EVIDENCE_STATUSES);

export const EVIDENCE_RELATIONS = [
  "supports",
  "contradicts",
  "derived_from",
  "resolves",
  "depends_on",
] as const;
export type EvidenceRelation = (typeof EVIDENCE_RELATIONS)[number];
export const EvidenceRelationSchema = z.enum(EVIDENCE_RELATIONS);

// ---------------------------------------------------------------------------
// Evidence graph
// ---------------------------------------------------------------------------

export const EvidenceNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: EvidenceKindSchema,
    claim: LocalizedTextSchema,
    status: EvidenceStatusSchema,
    /** Public transcript source ids. A `fact` requires at least one (enforced by Task 5). */
    sourceTranscriptIds: z.array(z.string().min(1)),
    /** Information-gain weight; must be strictly positive. */
    weight: z.number().positive(),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type EvidenceNode = z.infer<typeof EvidenceNodeSchema>;

export const EvidenceEdgeSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    relation: EvidenceRelationSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();
export type EvidenceEdge = z.infer<typeof EvidenceEdgeSchema>;

export const EvidenceGraphSchema = z
  .object({
    version: z.number().int().nonnegative(),
    nodes: z.array(EvidenceNodeSchema),
    edges: z.array(EvidenceEdgeSchema),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const nodeIds = new Set<string>();
    graph.nodes.forEach((node, i) => {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate evidence node id: ${node.id}`,
          path: ["nodes", i, "id"],
        });
      }
      nodeIds.add(node.id);
    });

    const edgeIds = new Set<string>();
    graph.edges.forEach((edge, i) => {
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate evidence edge id: ${edge.id}`,
          path: ["edges", i, "id"],
        });
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({
          code: "custom",
          message: `edge references missing node: ${edge.from}`,
          path: ["edges", i, "from"],
        });
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({
          code: "custom",
          message: `edge references missing node: ${edge.to}`,
          path: ["edges", i, "to"],
        });
      }
    });
  });
export type EvidenceGraph = z.infer<typeof EvidenceGraphSchema>;

/** A patch applied by the Evidence Tracker. Nodes are never deleted; they become `invalidated`. */
export const EvidenceGraphPatchSchema = z
  .object({
    patchId: z.string().min(1),
    /** Must equal the graph version the patch was computed against. */
    expectedVersion: z.number().int().nonnegative(),
    addNodes: z.array(EvidenceNodeSchema),
    addEdges: z.array(EvidenceEdgeSchema),
    invalidateNodeIds: z.array(z.string().min(1)),
  })
  .strict();
export type EvidenceGraphPatch = z.infer<typeof EvidenceGraphPatchSchema>;

// ---------------------------------------------------------------------------
// Problem brief
// ---------------------------------------------------------------------------

export const CLAIM_WEIGHTS = ["critical", "major", "minor"] as const;
export type ClaimWeight = (typeof CLAIM_WEIGHTS)[number];
export const ClaimWeightSchema = z.enum(CLAIM_WEIGHTS);

/** Every claim must carry `evidenceIds` referencing existing evidence nodes. */
export const ProblemBriefClaimSchema = z
  .object({
    id: z.string().min(1),
    statement: LocalizedTextSchema,
    weight: ClaimWeightSchema,
    evidenceIds: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type ProblemBriefClaim = z.infer<typeof ProblemBriefClaimSchema>;

export const CONTRADICTION_DISPOSITIONS = [
  "resolved",
  "accepted_risk",
  "needs_follow_up",
] as const;
export type ContradictionDisposition = (typeof CONTRADICTION_DISPOSITIONS)[number];

export const ProblemBriefContradictionSchema = z
  .object({
    id: z.string().min(1),
    statement: LocalizedTextSchema,
    evidenceIds: z.array(z.string().min(1)).min(1),
    disposition: z.enum(CONTRADICTION_DISPOSITIONS),
  })
  .strict();
export type ProblemBriefContradiction = z.infer<typeof ProblemBriefContradictionSchema>;

export const ProblemBriefSchema = z
  .object({
    id: z.string().min(1),
    problemStatement: LocalizedTextSchema,
    goal: LocalizedTextSchema,
    constraints: z.array(LocalizedTextSchema),
    claims: z.array(ProblemBriefClaimSchema),
    successMeasures: z.array(LocalizedTextSchema),
    unknowns: z.array(LocalizedTextSchema),
    contradictions: z.array(ProblemBriefContradictionSchema),
  })
  .strict()
  .superRefine((brief, ctx) => {
    const claimIds = new Set<string>();
    brief.claims.forEach((claim, i) => {
      if (claimIds.has(claim.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate claim id: ${claim.id}`,
          path: ["claims", i, "id"],
        });
      }
      claimIds.add(claim.id);
    });

    const contradictionIds = new Set<string>();
    brief.contradictions.forEach((contradiction, i) => {
      if (contradictionIds.has(contradiction.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate contradiction id: ${contradiction.id}`,
          path: ["contradictions", i, "id"],
        });
      }
      contradictionIds.add(contradiction.id);
    });
  });
export type ProblemBrief = z.infer<typeof ProblemBriefSchema>;

// ---------------------------------------------------------------------------
// Solution proposal
// ---------------------------------------------------------------------------

/** Every core decision must carry `evidenceIds`. */
export const SolutionDecisionSchema = z
  .object({
    id: z.string().min(1),
    decision: LocalizedTextSchema,
    rationale: LocalizedTextSchema,
    evidenceIds: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type SolutionDecision = z.infer<typeof SolutionDecisionSchema>;

export const SolutionAlternativeSchema = z
  .object({
    id: z.string().min(1),
    description: LocalizedTextSchema,
    tradeoff: LocalizedTextSchema,
  })
  .strict();
export type SolutionAlternative = z.infer<typeof SolutionAlternativeSchema>;

export const SolutionRiskSchema = z
  .object({
    id: z.string().min(1),
    description: LocalizedTextSchema,
    mitigation: LocalizedTextSchema,
  })
  .strict();
export type SolutionRisk = z.infer<typeof SolutionRiskSchema>;

export const SolutionProposalSchema = z
  .object({
    id: z.string().min(1),
    objective: LocalizedTextSchema,
    approach: LocalizedTextSchema,
    approachEvidenceIds: z.array(z.string().min(1)).min(1),
    assumptions: z.array(LocalizedTextSchema),
    alternatives: z.array(SolutionAlternativeSchema).min(1),
    tradeoffs: z.array(LocalizedTextSchema),
    risks: z.array(SolutionRiskSchema),
    validationPlan: z.array(LocalizedTextSchema),
    rolloutPlan: z.array(LocalizedTextSchema),
    decisions: z.array(SolutionDecisionSchema),
  })
  .strict();
export type SolutionProposal = z.infer<typeof SolutionProposalSchema>;

// ---------------------------------------------------------------------------
// Pitch artifact
// ---------------------------------------------------------------------------

export const PitchArtifactSchema = z
  .object({
    id: z.string().min(1),
    audience: LocalizedTextSchema,
    problem: LocalizedTextSchema,
    recommendation: LocalizedTextSchema,
    expectedValue: LocalizedTextSchema,
    evidenceIds: z.array(z.string().min(1)).min(1),
    risks: z.array(LocalizedTextSchema),
    ask: LocalizedTextSchema,
    nextSteps: z.array(LocalizedTextSchema),
  })
  .strict();
export type PitchArtifact = z.infer<typeof PitchArtifactSchema>;

// ---------------------------------------------------------------------------
// Challenge response
// ---------------------------------------------------------------------------

export const CHALLENGE_DECISIONS = ["keep", "change"] as const;
export type ChallengeDecision = (typeof CHALLENGE_DECISIONS)[number];

export const ChallengeResponseSchema = z
  .object({
    id: z.string().min(1),
    challengeId: z.string().min(1),
    impact: LocalizedTextSchema,
    decision: z.enum(CHALLENGE_DECISIONS),
    rationale: LocalizedTextSchema,
    newRiskOrValidation: LocalizedTextSchema,
  })
  .strict();
export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;

// ---------------------------------------------------------------------------
// Public transcript
// ---------------------------------------------------------------------------

export const TranscriptTurnSchema = z
  .object({
    turnId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    question: z.string().min(1),
    customerReply: LocalizedTextSchema,
    stakeholderId: z.string().min(1),
  })
  .strict();
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

// ---------------------------------------------------------------------------
// Hint levels
// ---------------------------------------------------------------------------

export const HINT_LEVELS = [1, 2, 3] as const;
export type HintLevel = (typeof HINT_LEVELS)[number];
export const HintLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

// ---------------------------------------------------------------------------
// Per-question assessment (Evidence Tracker output)
//
// The tracker produces this for each discovery turn; the orchestrator persists
// it as a `question.assessed` event so scoring can consume the real FORM
// metrics instead of the deterministic revelation heuristic.
// ---------------------------------------------------------------------------

export const QuestionAssessmentSchema = z
  .object({
    intentCount: z.number().int().positive(),
    atomicity: z.number().min(0).max(1),
    neutrality: z.number().min(0).max(1),
    relevance: z.number().min(0).max(1),
    redundancy: z.number().min(0).max(1),
  })
  .strict();
export type QuestionAssessment = z.infer<typeof QuestionAssessmentSchema>;

// ---------------------------------------------------------------------------
// Brief validation result (shared by Coach output and the `brief.validated` event)
// ---------------------------------------------------------------------------

export const ENTAILMENTS = ["supported", "partial", "unsupported"] as const;
export type Entailment = (typeof ENTAILMENTS)[number];
export const EntailmentSchema = z.enum(ENTAILMENTS);

export const ClaimEntailmentSchema = z
  .object({
    claimId: z.string().min(1),
    entailment: EntailmentSchema,
  })
  .strict();
export type ClaimEntailment = z.infer<typeof ClaimEntailmentSchema>;

export const BriefValidationResultSchema = z
  .object({
    passed: z.boolean(),
    entailments: z.array(ClaimEntailmentSchema),
    missingCategories: z.array(z.string().min(1)),
    unsupportedClaimIds: z.array(z.string().min(1)),
    feedback: LocalizedTextSchema,
  })
  .strict();
export type BriefValidationResult = z.infer<typeof BriefValidationResultSchema>;

// ---------------------------------------------------------------------------
// Final review result (shared by Coach output and the `review.completed` event)
// ---------------------------------------------------------------------------

export const DecisionDivergencePointSchema = z
  .object({
    id: z.string().min(1),
    description: LocalizedTextSchema,
  })
  .strict();
export type DecisionDivergencePoint = z.infer<typeof DecisionDivergencePointSchema>;

/**
 * Per-stage, per-criterion numeric scores (0..100) assigned by the Coach in
 * `final-review`. Keys are the fixed capability-rubric criterion ids
 * (`src/scoring/rubric.ts`); unknown ids are ignored by `computeStageScore`.
 * OPTIONAL: absent from pre-criterion-score runs (and older committed events),
 * in which case scoring falls back to the deterministic stage-score heuristics
 * (`fallbackStageScores`). Numeric and learner-safe — no hidden content.
 */
export const CriterionScoresSchema = z
  .object({
    framing: z.record(z.string(), z.number().min(0).max(100)).optional(),
    solution: z.record(z.string(), z.number().min(0).max(100)).optional(),
    challenge: z.record(z.string(), z.number().min(0).max(100)).optional(),
    pitch: z.record(z.string(), z.number().min(0).max(100)).optional(),
    process: z.record(z.string(), z.number().min(0).max(100)).optional(),
  })
  .strict();
export type CriterionScores = z.infer<typeof CriterionScoresSchema>;

export const FinalReviewResultSchema = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    strengths: z.array(LocalizedTextSchema),
    weaknesses: z.array(LocalizedTextSchema),
    missedOpportunities: z.array(LocalizedTextSchema),
    decisionDivergencePoints: z.array(DecisionDivergencePointSchema),
    nextFocus: z.array(LocalizedTextSchema),
    criterionScores: CriterionScoresSchema.optional(),
  })
  .strict();
export type FinalReviewResult = z.infer<typeof FinalReviewResultSchema>;

// ---------------------------------------------------------------------------
// Run commands (discriminated union)
//
// Every command carries a `commandId` for idempotency (Task 4). Covers the
// full phase-transition + learner-action surface. Task 4/11 may ADD variants;
// they must not rename these.
// ---------------------------------------------------------------------------

export const StartCommandSchema = z
  .object({
    type: z.literal("start"),
    commandId: z.string().min(1),
    scenarioId: z.string().min(1),
    locale: LocaleSchema,
    parentRunId: z.string().min(1).optional(),
    /** Verified scenario-bundle digest recorded at run start (Task 7 provenance). */
    scenarioBundleDigest: z.string().length(64).optional(),
  })
  .strict();

export const AcceptCommandSchema = z
  .object({
    type: z.literal("accept"),
    commandId: z.string().min(1),
  })
  .strict();

export const AskCommandSchema = z
  .object({
    type: z.literal("ask"),
    commandId: z.string().min(1),
    question: z.string().min(1),
  })
  .strict();

export const FrameCommandSchema = z
  .object({
    type: z.literal("frame"),
    commandId: z.string().min(1),
  })
  .strict();

export const HintCommandSchema = z
  .object({
    type: z.literal("hint"),
    commandId: z.string().min(1),
    topic: z.string().min(1),
    level: HintLevelSchema,
  })
  .strict();

export const SubmitBriefCommandSchema = z
  .object({
    type: z.literal("submit-brief"),
    commandId: z.string().min(1),
    brief: ProblemBriefSchema,
  })
  .strict();

export const ClarifyCommandSchema = z
  .object({
    type: z.literal("clarify"),
    commandId: z.string().min(1),
  })
  .strict();

export const SubmitDesignCommandSchema = z
  .object({
    type: z.literal("submit-design"),
    commandId: z.string().min(1),
    proposal: SolutionProposalSchema,
  })
  .strict();

export const RespondChallengeCommandSchema = z
  .object({
    type: z.literal("respond-challenge"),
    commandId: z.string().min(1),
    response: ChallengeResponseSchema,
  })
  .strict();

export const SubmitPitchCommandSchema = z
  .object({
    type: z.literal("submit-pitch"),
    commandId: z.string().min(1),
    pitch: PitchArtifactSchema,
  })
  .strict();

export const ReviewCommandSchema = z
  .object({
    type: z.literal("review"),
    commandId: z.string().min(1),
  })
  .strict();

export const RetryCommandSchema = z
  .object({
    type: z.literal("retry"),
    commandId: z.string().min(1),
  })
  .strict();

export const StartRetryCommandSchema = z
  .object({
    type: z.literal("start-retry"),
    commandId: z.string().min(1),
  })
  .strict();

export const CompleteCommandSchema = z
  .object({
    type: z.literal("complete"),
    commandId: z.string().min(1),
  })
  .strict();

export const AbortCommandSchema = z
  .object({
    type: z.literal("abort"),
    commandId: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const RunCommandSchema = z.discriminatedUnion("type", [
  StartCommandSchema,
  AcceptCommandSchema,
  AskCommandSchema,
  FrameCommandSchema,
  HintCommandSchema,
  SubmitBriefCommandSchema,
  ClarifyCommandSchema,
  SubmitDesignCommandSchema,
  RespondChallengeCommandSchema,
  SubmitPitchCommandSchema,
  ReviewCommandSchema,
  RetryCommandSchema,
  StartRetryCommandSchema,
  CompleteCommandSchema,
  AbortCommandSchema,
]);
export type RunCommand = z.infer<typeof RunCommandSchema>;

// ---------------------------------------------------------------------------
// Run events (discriminated union)
//
// Domain events emitted by `decide()` in Task 4. They carry `runId` and the
// `commandId` that produced them. The event-store envelope (`seq`,
// `logicalTime`, `previousHash`, `hash`) is layered on top by Task 4 as
// `RecordedEvent` — kept out of the domain payload so wall-clock and hashing
// stay outside the pure reducer.
// ---------------------------------------------------------------------------

const EVENT_BASE = {
  runId: z.string().min(1),
  commandId: z.string().min(1),
} as const;

export const RunStartedEventSchema = z
  .object({
    type: z.literal("run.started"),
    ...EVENT_BASE,
    scenarioId: z.string().min(1),
    locale: LocaleSchema,
    /** Verified scenario-bundle digest at run start; absent on provenance-legacy (pre-Task 7) runs. */
    scenarioBundleDigest: z.string().length(64).optional(),
  })
  .strict();

export const PhaseChangedEventSchema = z
  .object({
    type: z.literal("phase.changed"),
    ...EVENT_BASE,
    from: RunPhaseSchema,
    to: RunPhaseSchema,
  })
  .strict();

export const QuestionAskedEventSchema = z
  .object({
    type: z.literal("question.asked"),
    ...EVENT_BASE,
    questionId: z.string().min(1),
    question: z.string().min(1),
  })
  .strict();

export const CustomerRepliedEventSchema = z
  .object({
    type: z.literal("customer.replied"),
    ...EVENT_BASE,
    questionId: z.string().min(1),
    reply: LocalizedTextSchema,
    stakeholderId: z.string().min(1),
    /**
     * Disclosure unit ids newly revealed by this reply. Internal to the event
     * store: `projectPublic` never projects these (disclosure ids are hidden).
     * Needed so `foldRunAggregate` can rebuild the disclosure ledger on resume.
     */
    disclosedDisclosureUnitIds: z.array(z.string().min(1)),
  })
  .strict();

export const EvidencePatchedEventSchema = z
  .object({
    type: z.literal("evidence.patched"),
    ...EVENT_BASE,
    patch: EvidenceGraphPatchSchema,
  })
  .strict();

export const QuestionAssessedEventSchema = z
  .object({
    type: z.literal("question.assessed"),
    ...EVENT_BASE,
    questionId: z.string().min(1),
    assessment: QuestionAssessmentSchema,
  })
  .strict();

/**
 * Durable pending-evidence marker emitted when the Evidence Tracker fails.
 * Carries ONLY the pending turn id + a stable failure code — never the thrown
 * error message, reasoning, or any canary/payload text (learner-visible
 * durability contract).
 */
export const EvidencePendingEventSchema = z
  .object({
    type: z.literal("evidence.pending"),
    ...EVENT_BASE,
    turnId: z.string().min(1),
    failureCode: z.string().min(1),
  })
  .strict();

/** Durable resolution marker; clears the pending marker only for its own turn. */
export const EvidenceResolvedEventSchema = z
  .object({
    type: z.literal("evidence.resolved"),
    ...EVENT_BASE,
    turnId: z.string().min(1),
  })
  .strict();

export const HintGrantedEventSchema = z
  .object({
    type: z.literal("hint.granted"),
    ...EVENT_BASE,
    topic: z.string().min(1),
    level: HintLevelSchema,
    hint: LocalizedTextSchema,
  })
  .strict();

export const BriefSubmittedEventSchema = z
  .object({
    type: z.literal("brief.submitted"),
    ...EVENT_BASE,
    brief: ProblemBriefSchema,
  })
  .strict();

export const BriefValidatedEventSchema = z
  .object({
    type: z.literal("brief.validated"),
    ...EVENT_BASE,
    briefId: z.string().min(1),
    result: BriefValidationResultSchema,
  })
  .strict();

export const DesignSubmittedEventSchema = z
  .object({
    type: z.literal("design.submitted"),
    ...EVENT_BASE,
    proposal: SolutionProposalSchema,
  })
  .strict();

export const ChallengeInjectedEventSchema = z
  .object({
    type: z.literal("challenge.injected"),
    ...EVENT_BASE,
    challengeId: z.string().min(1),
    prompt: LocalizedTextSchema,
  })
  .strict();

export const ChallengeRespondedEventSchema = z
  .object({
    type: z.literal("challenge.responded"),
    ...EVENT_BASE,
    response: ChallengeResponseSchema,
  })
  .strict();

export const PitchSubmittedEventSchema = z
  .object({
    type: z.literal("pitch.submitted"),
    ...EVENT_BASE,
    pitch: PitchArtifactSchema,
  })
  .strict();

export const ReviewCompletedEventSchema = z
  .object({
    type: z.literal("review.completed"),
    ...EVENT_BASE,
    review: FinalReviewResultSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Score breakdown (Task 11): the deterministic numeric score persisted by the
// `review` command and reconstructed by the replay. Mirrors `calculateScore`'s
// output (`src/scoring/formulas.ts`) so the replay can surface it without a
// model call. All fields are learner-safe numbers/booleans — no hidden content.
// ---------------------------------------------------------------------------

export const QuestionEfficiencyBreakdownSchema = z
  .object({
    /** `gq` — newly revealed weight / total weight (question-driven only). */
    gq: z.number(),
    /** `IGq` — 100 × min(1, questionBudget × gq). */
    informationGain: z.number(),
    /** `Formq` — atomicity × neutrality × relevance × (1 - redundancy). */
    form: z.number(),
    /** `QuestionEfficiencyq` — IGq × Formq. */
    efficiency: z.number(),
  })
  .strict();
export type QuestionEfficiencyBreakdown = z.infer<typeof QuestionEfficiencyBreakdownSchema>;

export const PassGateResultsSchema = z
  .object({
    finalScore: z.boolean(),
    briefSupport: z.boolean(),
    noUnacknowledgedCriticalContradiction: z.boolean(),
    pitchExplicitAsk: z.boolean(),
    noLeakGuardViolation: z.boolean(),
  })
  .strict();
export type PassGateResults = z.infer<typeof PassGateResultsSchema>;

export const ScoreBreakdownSchema = z
  .object({
    coverage: z.number(),
    coveragePercent: z.number(),
    averageForm: z.number(),
    budgetFactor: z.number(),
    questionEfficiency: z.number(),
    discovery: z.number(),
    framing: z.number(),
    solution: z.number(),
    challenge: z.number(),
    pitch: z.number(),
    process: z.number(),
    raw: z.number(),
    hintPenalty: z.number(),
    integrity: z.number(),
    final: z.number(),
    questions: z.array(QuestionEfficiencyBreakdownSchema),
    passes: PassGateResultsSchema,
  })
  .strict();
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const ScoreComputedEventSchema = z
  .object({
    type: z.literal("score.computed"),
    ...EVENT_BASE,
    score: ScoreBreakdownSchema,
    /** Task 8 provenance: the scoring-function identity + per-stage source. */
    provenance: ScoreProvenanceSchema,
  })
  .strict();

export const RetryStartedEventSchema = z
  .object({
    type: z.literal("retry.started"),
    ...EVENT_BASE,
    newRunId: z.string().min(1),
  })
  .strict();

/**
 * The retry focus summaries carried into a child run. Committed to the CHILD's
 * event log so `foldRunAggregate` can reconstruct `previousAttemptReview` after
 * a process restart without re-invoking the parent's review model.
 */
export const RetryFocusEventSchema = z
  .object({
    type: z.literal("retry.focus"),
    ...EVENT_BASE,
    focusSummaries: z.array(LocalizedTextSchema),
  })
  .strict();

export const RunCompletedEventSchema = z
  .object({
    type: z.literal("run.completed"),
    ...EVENT_BASE,
  })
  .strict();

export const RunAbortedEventSchema = z
  .object({
    type: z.literal("run.aborted"),
    ...EVENT_BASE,
    reason: z.string().min(1).optional(),
  })
  .strict();

export const RunEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  PhaseChangedEventSchema,
  QuestionAskedEventSchema,
  CustomerRepliedEventSchema,
  EvidencePatchedEventSchema,
  QuestionAssessedEventSchema,
  EvidencePendingEventSchema,
  EvidenceResolvedEventSchema,
  HintGrantedEventSchema,
  BriefSubmittedEventSchema,
  BriefValidatedEventSchema,
  DesignSubmittedEventSchema,
  ChallengeInjectedEventSchema,
  ChallengeRespondedEventSchema,
  PitchSubmittedEventSchema,
  ReviewCompletedEventSchema,
  ScoreComputedEventSchema,
  RetryStartedEventSchema,
  RetryFocusEventSchema,
  RunCompletedEventSchema,
  RunAbortedEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

/**
 * Event-store envelope layered on top of a domain event by Task 4. The domain
 * event itself never carries hashing metadata; `decide()` and `reduce()` stay
 * pure.
 */
export interface EventEnvelope {
  seq: number;
  logicalTime: number;
  previousHash: string;
  hash: string;
}

export type RecordedEvent = RunEvent & EventEnvelope;
