import { z } from "zod";
import {
  ChallengeResponseSchema,
  EvidenceGraphSchema,
  LocaleSchema,
  PitchArtifactSchema,
  ProblemBriefSchema,
  RunPhaseSchema,
  SolutionProposalSchema,
  TranscriptTurnSchema,
  type ChallengeResponse,
  type EvidenceGraph,
  type Locale,
  type PitchArtifact,
  type ProblemBrief,
  type RunPhase,
  type SolutionProposal,
  type TranscriptTurn,
} from "./domain.js";
import { HintLedgerEntrySchema, type HintLedgerEntry } from "../agents/contracts.js";
import {
  InjectedChallengeStateSchema,
  type InjectedChallengeCollection,
} from "../graph/challenge-state.js";

/**
 * FDE Gym — the internal run aggregate.
 *
 * The domain's single source of truth for a run's in-flight state. It is
 * consumed by the security firewall (`buildRoleInput`) and rebuilt on resume by
 * `foldRunAggregate`. The trailing SENSITIVE fields (`score`, `learnerProfile`,
 * `previousAttemptReview`, `rubric`) are RECOGNIZED by `RunAggregateSchema` (so
 * they never trip the firewall's unrecognized-field guard) but are NEVER copied
 * into any role input — the firewall builds each role input field-by-field from
 * an explicit per-role allowlist.
 */

/** The coach's concrete task, which selects which coach INPUT schema to build. */
export const COACH_TASKS = ["brief-validation", "final-review"] as const;
export type CoachTask = (typeof COACH_TASKS)[number];
export const CoachTaskSchema = z.enum(COACH_TASKS);

/** The learner-safe public view of a run — every field a role input may be built from. */
export interface PublicRunView {
  runId: string;
  scenarioId: string;
  locale: Locale;
  phase: RunPhase | null;
  /** Public dialogue (question + public reply per turn). */
  transcript: TranscriptTurn[];
  /** Public evidence graph state. */
  graph: EvidenceGraph;
  disclosedDisclosureUnitIds: string[];
  grantedHints: HintLedgerEntry[];
  /** The learner's current question (targets a specific stakeholder). */
  pendingQuestion: { question: string; stakeholderId: string } | null;
  coachTask: CoachTask;
  brief: ProblemBrief | null;
  proposal: SolutionProposal | null;
  pitch: PitchArtifact | null;
  challengeResponses: ChallengeResponse[];
  /**
   * The injected-challenge lifecycle (which challenges were injected and which
   * are answered), folded from `challenge.injected`/`challenge.responded`. The
   * single source of truth for `all-answered` (G1-03). Optional for leniency on
   * hand-built/legacy aggregates; `foldRunAggregate` always populates it.
   */
  injectedChallenges?: InjectedChallengeCollection;
  /** Durable pending-evidence marker: the turn's id + a stable failure code (never a message). */
  pendingEvidence: { turnId: string; code: string } | null;
  /** Clarifications consumed this framing attempt, folded from committed phase changes. */
  clarificationBudgetUsed: number;
}

/** Fields that must NEVER reach a role input. Recognized by the schema (so they
 *  never trip fail-closed) but excluded from the public view's type. */
export interface SensitiveRunState {
  score?: unknown;
  learnerProfile?: unknown;
  previousAttemptReview?: unknown;
  rubric?: unknown;
}

export type RunAggregate = PublicRunView & SensitiveRunState;

export const RunAggregateSchema = z
  .object({
    runId: z.string().min(1),
    scenarioId: z.string().min(1),
    locale: LocaleSchema,
    phase: RunPhaseSchema.nullable(),
    transcript: z.array(TranscriptTurnSchema),
    graph: EvidenceGraphSchema,
    disclosedDisclosureUnitIds: z.array(z.string().min(1)),
    grantedHints: z.array(HintLedgerEntrySchema),
    pendingQuestion: z
      .object({ question: z.string().min(1), stakeholderId: z.string().min(1) })
      .strict()
      .nullable(),
    coachTask: CoachTaskSchema,
    brief: ProblemBriefSchema.nullable(),
    proposal: SolutionProposalSchema.nullable(),
    pitch: PitchArtifactSchema.nullable(),
    challengeResponses: z.array(ChallengeResponseSchema),
    injectedChallenges: z.array(InjectedChallengeStateSchema).optional(),
    pendingEvidence: z
      .object({ turnId: z.string().min(1), code: z.string().min(1) })
      .strict()
      .nullable()
      .optional(),
    clarificationBudgetUsed: z.number().int().nonnegative().optional(),
    score: z.unknown().optional(),
    learnerProfile: z.unknown().optional(),
    previousAttemptReview: z.unknown().optional(),
    rubric: z.unknown().optional(),
  })
  .strict();
