import { ZodError } from "zod";
import type { z } from "zod";

import type {
  AgentRole,
  BriefValidationResult,
  ChallengeResponse,
  ClaimEntailment,
  EvidenceGraph,
  EvidenceGraphPatch,
  PitchArtifact,
  ProblemBrief,
  ProblemBriefClaim,
  SolutionProposal,
} from "../core/domain.js";
import {
  ChallengeResponseSchema,
  PitchArtifactSchema,
  ProblemBriefSchema,
  SolutionProposalSchema,
} from "../core/domain.js";
import { EvidenceGraphError, applyEvidencePatch } from "../evidence/graph.js";
import {
  SUPPORT_RATIO_THRESHOLD,
  calculateSupportRatio,
  validateBriefStructure,
} from "../evidence/brief-validator.js";
import { sanitizeAgentResult, type RawAgentResult } from "../security/sanitizer.js";
import {
  allChallengesAnswered as challengesAllAnswered,
  type InjectedChallengeCollection,
} from "./challenge-state.js";
import { CLARIFICATION_BUDGET_EXCEEDED, FRAME_BLOCKED } from "../core/errors.js";
export { CLARIFICATION_BUDGET_EXCEEDED, FRAME_BLOCKED } from "../core/errors.js";
import type { GuardId } from "./action-types.js";

/**
 * FDE Gym — guard registry (Phase 2, G2-02).
 *
 * A guard is a PURE, deterministic predicate over an input value: no model call,
 * no wall-clock, no `Math.random`, no I/O. Every guard returns a
 * `GuardResult` — a stable machine-readable code plus minimal learner-safe
 * evidence (ids/codes only, never hidden evidence text). A guard NEVER throws;
 * any thrown error from a wrapped module is converted to `{ ok: false, code }`.
 *
 * Each guard is exposed two ways:
 *   - a named, precisely-typed function (e.g. `noPendingEvidence(...)`) for
 *     callers that already hold the typed value;
 *   - a registry entry (`GUARD_REGISTRY[guardId]`) callable with a single
 *     `unknown` input, which validates/casts the input and delegates to the
 *     named function.
 *
 * The registry's per-guard input contracts are documented alongside
 * `GUARD_REGISTRY` below.
 */

// ---------------------------------------------------------------------------
// Result + registry types
// ---------------------------------------------------------------------------

/** A stable, machine-readable guard outcome. `evidence` is ids/codes only. */
export type GuardResult =
  | { ok: true }
  | { ok: false; code: string; evidence?: unknown };

/**
 * The uniform registry callable. Guards have heterogeneous inputs (some take an
 * aggregate slice, some an artifact, some a response); each registry entry is a
 * `(input: unknown) => GuardResult` that casts its own input and calls its named
 * guard. The named functions below keep the precise per-guard types.
 */
export type Guard = (input: unknown) => GuardResult;

// ---------------------------------------------------------------------------
// Stable codes
// ---------------------------------------------------------------------------

/** Registry input did not match the guard's documented input contract. */
export const GUARD_INPUT_INVALID = "GUARD_INPUT_INVALID" as const;

/**
 * `FRAME_BLOCKED` / `CLARIFICATION_BUDGET_EXCEEDED` are shared with the
 * orchestrator via `errors.ts` (a leaf module with no graph imports), so the
 * registry and the orchestrator use one definition. `DEFAULT_CLARIFICATION_BUDGET`
 * is a config default owned here (consumed by the `discovery.clarify` node).
 */
export const DEFAULT_CLARIFICATION_BUDGET = 3;

/** Fallback when `applyEvidencePatch` throws something other than `EvidenceGraphError`. */
export const EVIDENCE_PATCH_INVALID = "EVIDENCE_PATCH_INVALID" as const;
export const BRIEF_STRUCTURE_INVALID = "BRIEF_STRUCTURE_INVALID" as const;
export const BRIEF_SUPPORT_INSUFFICIENT = "BRIEF_SUPPORT_INSUFFICIENT" as const;
export const PROPOSAL_STRUCTURE_INVALID = "PROPOSAL_STRUCTURE_INVALID" as const;
export const CHALLENGE_RESPONSE_INVALID = "CHALLENGE_RESPONSE_INVALID" as const;
export const CHALLENGES_UNANSWERED = "CHALLENGES_UNANSWERED" as const;
export const PITCH_STRUCTURE_INVALID = "PITCH_STRUCTURE_INVALID" as const;
/** Fallback when `sanitizeAgentResult` itself throws (it normally returns a typed failure). */
export const JUDGMENT_INVALID = "JUDGMENT_INVALID" as const;

/** The guard ids, in one place, so the registry keys cannot drift. */
export const GUARD_IDS = {
  NO_PENDING_EVIDENCE: "no-pending-evidence",
  EVIDENCE_PATCH_VALID: "evidence-patch-valid",
  BRIEF_STRUCTURE_VALID: "brief-structure-valid",
  BRIEF_SUPPORT_SUFFICIENT: "brief-support-sufficient",
  CLARIFICATION_BUDGET_AVAILABLE: "clarification-budget-available",
  PROPOSAL_STRUCTURE_VALID: "proposal-structure-valid",
  CHALLENGE_RESPONSE_VALID: "challenge-response-valid",
  ALL_CHALLENGES_ANSWERED: "all-challenges-answered",
  PITCH_STRUCTURE_VALID: "pitch-structure-valid",
  JUDGMENT_VALID: "judgment-valid",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function invalidInput(): GuardResult {
  return { ok: false, code: GUARD_INPUT_INVALID };
}

/**
 * Reduce a Zod validation error to learner-safe evidence: issue codes (stable
 * machine strings) and issue paths (schema field names/indices). Zod issue
 * `message`s may echo input values, so they are deliberately NOT included.
 */
function zodEvidence(error: ZodError): { codes: string[]; paths: string[][] } {
  const codes = [...new Set(error.issues.map((issue) => issue.code))];
  const paths = error.issues.map((issue) => issue.path.map(String));
  return { codes, paths };
}

/** The learner-visible pending-evidence marker shape (mirrors the aggregate). */
export interface PendingEvidenceMarker {
  turnId: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Named guards
// ---------------------------------------------------------------------------

/**
 * `no-pending-evidence`: the run has no pending evidence, so `frame` may
 * proceed. Mirrors the orchestrator's `assertFrameAllowed` (rejects with
 * `FRAME_BLOCKED` when `pendingEvidence !== null`).
 */
export function noPendingEvidence(pendingEvidence: PendingEvidenceMarker | null): GuardResult {
  if (pendingEvidence === null) return { ok: true };
  return { ok: false, code: FRAME_BLOCKED, evidence: { turnId: pendingEvidence.turnId } };
}

/**
 * `evidence-patch-valid`: the patch is structurally valid — `applyEvidencePatch`
 * does not throw. Rejects with the thrown `EvidenceGraphError`'s stable `code`
 * (and the patch id); any other throw reduces to `EVIDENCE_PATCH_INVALID`.
 */
export function evidencePatchValid(graph: EvidenceGraph, patch: EvidenceGraphPatch): GuardResult {
  try {
    applyEvidencePatch(graph, patch);
    return { ok: true };
  } catch (error) {
    if (error instanceof EvidenceGraphError) {
      return { ok: false, code: error.code, evidence: { patchId: error.patchId } };
    }
    return { ok: false, code: EVIDENCE_PATCH_INVALID };
  }
}

/**
 * `brief-structure-valid`: the brief is schema-valid (defense-in-depth) and
 * passes `validateBriefStructure`. A failed structure reports the missing
 * category keys and unsupported claim ids (ids/codes only).
 */
export function briefStructureValid(brief: ProblemBrief, graph: EvidenceGraph): GuardResult {
  try {
    ProblemBriefSchema.parse(brief);
  } catch (error) {
    if (error instanceof ZodError) {
      return { ok: false, code: BRIEF_STRUCTURE_INVALID, evidence: zodEvidence(error) };
    }
    return { ok: false, code: BRIEF_STRUCTURE_INVALID };
  }

  let structure: BriefValidationResult;
  try {
    structure = validateBriefStructure(brief, graph);
  } catch {
    return { ok: false, code: BRIEF_STRUCTURE_INVALID };
  }

  if (!structure.passed) {
    return {
      ok: false,
      code: BRIEF_STRUCTURE_INVALID,
      evidence: {
        missingCategories: structure.missingCategories,
        unsupportedClaimIds: structure.unsupportedClaimIds,
      },
    };
  }
  return { ok: true };
}

/**
 * `brief-support-sufficient`: the weighted support ratio is at least
 * `SUPPORT_RATIO_THRESHOLD` (0.75). Reports the computed ratio + threshold.
 */
export function briefSupportSufficient(
  claims: readonly ProblemBriefClaim[],
  entailments: readonly ClaimEntailment[],
): GuardResult {
  const supportRatio = calculateSupportRatio(claims, entailments);
  if (supportRatio >= SUPPORT_RATIO_THRESHOLD) return { ok: true };
  return {
    ok: false,
    code: BRIEF_SUPPORT_INSUFFICIENT,
    evidence: { supportRatio, threshold: SUPPORT_RATIO_THRESHOLD },
  };
}

/**
 * `clarification-budget-available`: the clarification budget is not exhausted
 * (`used < limit`). Mirrors the orchestrator's `prepareClarification` gate.
 */
export function clarificationBudgetAvailable(
  clarificationBudgetUsed: number,
  clarificationBudgetLimit: number = DEFAULT_CLARIFICATION_BUDGET,
): GuardResult {
  if (clarificationBudgetUsed < clarificationBudgetLimit) return { ok: true };
  return {
    ok: false,
    code: CLARIFICATION_BUDGET_EXCEEDED,
    evidence: { clarificationBudgetUsed, clarificationBudgetLimit },
  };
}

/** `proposal-structure-valid`: the proposal satisfies `SolutionProposalSchema`. */
export function proposalStructureValid(proposal: SolutionProposal): GuardResult {
  try {
    SolutionProposalSchema.parse(proposal);
    return { ok: true };
  } catch (error) {
    if (error instanceof ZodError) {
      return { ok: false, code: PROPOSAL_STRUCTURE_INVALID, evidence: zodEvidence(error) };
    }
    return { ok: false, code: PROPOSAL_STRUCTURE_INVALID };
  }
}

/** `challenge-response-valid`: the response satisfies `ChallengeResponseSchema`. */
export function challengeResponseValid(response: ChallengeResponse): GuardResult {
  try {
    ChallengeResponseSchema.parse(response);
    return { ok: true };
  } catch (error) {
    if (error instanceof ZodError) {
      return { ok: false, code: CHALLENGE_RESPONSE_INVALID, evidence: zodEvidence(error) };
    }
    return { ok: false, code: CHALLENGE_RESPONSE_INVALID };
  }
}

/**
 * `all-challenges-answered`: every injected challenge is answered. Vacuously
 * true on an empty set (the empty case advances via an explicit edge elsewhere).
 * Reports the pending challenge ids on failure.
 */
export function allChallengesAnsweredGuard(challenges: InjectedChallengeCollection): GuardResult {
  if (challengesAllAnswered(challenges)) return { ok: true };
  const pendingChallengeIds = challenges
    .filter((entry) => entry.status === "pending")
    .map((entry) => entry.id);
  return { ok: false, code: CHALLENGES_UNANSWERED, evidence: { pendingChallengeIds } };
}

/** `pitch-structure-valid`: the pitch satisfies `PitchArtifactSchema`. */
export function pitchStructureValid(pitch: PitchArtifact): GuardResult {
  try {
    PitchArtifactSchema.parse(pitch);
    return { ok: true };
  } catch (error) {
    if (error instanceof ZodError) {
      return { ok: false, code: PITCH_STRUCTURE_INVALID, evidence: zodEvidence(error) };
    }
    return { ok: false, code: PITCH_STRUCTURE_INVALID };
  }
}

/**
 * `judgment-valid`: a role's raw output is sanitized AND schema-valid. Wraps
 * `sanitizeAgentResult`, forwarding its stable failure code (`LEAK_GUARD_TRIGGERED`
 * / `AGENT_OUTPUT_INVALID`) and the prohibited-key paths (paths only, no values).
 */
export function judgmentValid(
  role: AgentRole,
  result: RawAgentResult,
  outputSchema: z.ZodType,
  canaries?: readonly string[],
): GuardResult {
  try {
    const safe = sanitizeAgentResult(role, result, outputSchema, { canaries });
    if (safe.ok) return { ok: true };
    return {
      ok: false,
      code: safe.failure.code,
      evidence: { prohibitedPaths: safe.failure.prohibitedPaths },
    };
  } catch {
    return { ok: false, code: JUDGMENT_INVALID };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const VALID_AGENT_ROLES: readonly string[] = ["customer", "evidence_tracker", "coach_evaluator"];

const guardNoPendingEvidence: Guard = (input: unknown): GuardResult => {
  if (input === null) return noPendingEvidence(null);
  if (isRecord(input) && typeof input.turnId === "string" && typeof input.code === "string") {
    return noPendingEvidence({ turnId: input.turnId, code: input.code });
  }
  return invalidInput();
};

const guardEvidencePatchValid: Guard = (input: unknown): GuardResult => {
  if (!isRecord(input)) return invalidInput();
  const { graph, patch } = input;
  if (!isRecord(graph) || !isRecord(patch)) return invalidInput();
  return evidencePatchValid(graph as EvidenceGraph, patch as EvidenceGraphPatch);
};

const guardBriefStructureValid: Guard = (input: unknown): GuardResult => {
  if (!isRecord(input)) return invalidInput();
  const { brief, graph } = input;
  if (!isRecord(brief) || !isRecord(graph)) return invalidInput();
  return briefStructureValid(brief as ProblemBrief, graph as EvidenceGraph);
};

const guardBriefSupportSufficient: Guard = (input: unknown): GuardResult => {
  if (!isRecord(input)) return invalidInput();
  const { claims, entailments } = input;
  if (!Array.isArray(claims) || !Array.isArray(entailments)) return invalidInput();
  return briefSupportSufficient(
    claims as readonly ProblemBriefClaim[],
    entailments as readonly ClaimEntailment[],
  );
};

const guardClarificationBudgetAvailable: Guard = (input: unknown): GuardResult => {
  if (!isRecord(input)) return invalidInput();
  const used = input.clarificationBudgetUsed;
  const limit = input.clarificationBudgetLimit;
  if (typeof used !== "number" || !Number.isInteger(used) || used < 0) return invalidInput();
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
    return invalidInput();
  }
  return clarificationBudgetAvailable(used, limit ?? DEFAULT_CLARIFICATION_BUDGET);
};

const guardProposalStructureValid: Guard = (input: unknown): GuardResult => {
  if (!isRecord(input)) return invalidInput();
  const { proposal } = input;
  if (!isRecord(proposal)) return invalidInput();
  return proposalStructureValid(proposal as SolutionProposal);
};

const guardChallengeResponseValid: Guard = (input: unknown): GuardResult => {
  if (!isRecord(input)) return invalidInput();
  const { response } = input;
  if (!isRecord(response)) return invalidInput();
  return challengeResponseValid(response as ChallengeResponse);
};

const guardAllChallengesAnswered: Guard = (input: unknown): GuardResult => {
  if (!isRecord(input)) return invalidInput();
  const { challenges } = input;
  if (!Array.isArray(challenges)) return invalidInput();
  return allChallengesAnsweredGuard(challenges as InjectedChallengeCollection);
};

const guardPitchStructureValid: Guard = (input: unknown): GuardResult => {
  if (!isRecord(input)) return invalidInput();
  const { pitch } = input;
  if (!isRecord(pitch)) return invalidInput();
  return pitchStructureValid(pitch as PitchArtifact);
};

const guardJudgmentValid: Guard = (input: unknown): GuardResult => {
  if (!isRecord(input)) return invalidInput();
  const { role, result, outputSchema, canaries } = input;
  if (typeof role !== "string" || !VALID_AGENT_ROLES.includes(role)) return invalidInput();
  if (!isRecord(result) || typeof result.invocationId !== "string" || !("output" in result)) {
    return invalidInput();
  }
  if (
    typeof outputSchema !== "object" ||
    outputSchema === null ||
    typeof (outputSchema as { safeParse?: unknown }).safeParse !== "function"
  ) {
    return invalidInput();
  }
  if (canaries !== undefined && !isStringArray(canaries)) return invalidInput();
  return judgmentValid(
    role as AgentRole,
    { invocationId: result.invocationId, output: result.output },
    outputSchema as z.ZodType,
    canaries as readonly string[] | undefined,
  );
};

/**
 * The guard registry: guard id → `(input: unknown) => GuardResult`.
 *
 * Per-guard registry input contracts (each entry validates/casts `unknown`):
 *   - "no-pending-evidence"            → `{ turnId: string; code: string } | null`
 *   - "evidence-patch-valid"           → `{ graph: EvidenceGraph; patch: EvidenceGraphPatch }`
 *   - "brief-structure-valid"          → `{ brief: ProblemBrief; graph: EvidenceGraph }`
 *   - "brief-support-sufficient"       → `{ claims: ProblemBriefClaim[]; entailments: ClaimEntailment[] }`
 *   - "clarification-budget-available" → `{ clarificationBudgetUsed: number; clarificationBudgetLimit?: number }`
 *   - "proposal-structure-valid"       → `{ proposal: SolutionProposal }`
 *   - "challenge-response-valid"       → `{ response: ChallengeResponse }`
 *   - "all-challenges-answered"        → `{ challenges: InjectedChallengeCollection }`
 *   - "pitch-structure-valid"          → `{ pitch: PitchArtifact }`
 *   - "judgment-valid"                 → `{ role: AgentRole; result: RawAgentResult; outputSchema: z.ZodType; canaries?: readonly string[] }`
 */
export const GUARD_REGISTRY: Readonly<Record<GuardId, Guard>> = {
  [GUARD_IDS.NO_PENDING_EVIDENCE]: guardNoPendingEvidence,
  [GUARD_IDS.EVIDENCE_PATCH_VALID]: guardEvidencePatchValid,
  [GUARD_IDS.BRIEF_STRUCTURE_VALID]: guardBriefStructureValid,
  [GUARD_IDS.BRIEF_SUPPORT_SUFFICIENT]: guardBriefSupportSufficient,
  [GUARD_IDS.CLARIFICATION_BUDGET_AVAILABLE]: guardClarificationBudgetAvailable,
  [GUARD_IDS.PROPOSAL_STRUCTURE_VALID]: guardProposalStructureValid,
  [GUARD_IDS.CHALLENGE_RESPONSE_VALID]: guardChallengeResponseValid,
  [GUARD_IDS.ALL_CHALLENGES_ANSWERED]: guardAllChallengesAnswered,
  [GUARD_IDS.PITCH_STRUCTURE_VALID]: guardPitchStructureValid,
  [GUARD_IDS.JUDGMENT_VALID]: guardJudgmentValid,
};
