import { z } from "zod";
import {
  BriefValidationResultSchema,
  ChallengeResponseSchema,
  EvidenceGraphPatchSchema,
  EvidenceGraphSchema,
  FinalReviewResultSchema,
  HintLevelSchema,
  LocalizedTextSchema,
  LocaleSchema,
  PitchArtifactSchema,
  ProblemBriefSchema,
  QuestionAssessmentSchema,
  SolutionProposalSchema,
  TranscriptTurnSchema,
  type BriefValidationResult,
  type FinalReviewResult,
} from "../core/domain.js";
import {
  DisclosureUnitSchema,
  ResponsePolicySchema,
  StakeholderSchema,
} from "../scenarios/schema.js";

/**
 * FDE Gym — role-scoped input/output contracts.
 *
 * Each role receives a strict INPUT and returns a strict, schema-validated
 * OUTPUT through the `AgentRuntime`. Output schemas are `.strict()` and never
 * declare prohibited field names; the recursive sanitizer below is the
 * defense-in-depth guard applied to raw agent payloads before validation.
 */

// ---------------------------------------------------------------------------
// Customer Simulator
// ---------------------------------------------------------------------------

export const CustomerInputSchema = z
  .object({
    locale: LocaleSchema,
    /** Learner prose, wrapped in an UNTRUSTED_LEARNER_INPUT boundary by Task 7. */
    question: z.string().min(1),
    stakeholderId: z.string().min(1),
    stakeholders: z.array(StakeholderSchema).min(1),
    disclosureUnits: z.array(DisclosureUnitSchema),
    /** Disclosure ledger: unit ids already revealed to the learner. */
    disclosedDisclosureUnitIds: z.array(z.string().min(1)),
    responsePolicies: z.array(ResponsePolicySchema),
  })
  .strict();
export type CustomerInput = z.infer<typeof CustomerInputSchema>;

export const CustomerOutputSchema = z
  .object({
    reply: LocalizedTextSchema,
    stakeholderId: z.string().min(1),
    /** Unit ids newly disclosed by this reply. */
    disclosedDisclosureUnitIds: z.array(z.string().min(1)),
  })
  .strict();
export type CustomerOutput = z.infer<typeof CustomerOutputSchema>;

// ---------------------------------------------------------------------------
// Evidence Tracker
// ---------------------------------------------------------------------------

export const EvidenceTrackerInputSchema = z
  .object({
    locale: LocaleSchema,
    turn: TranscriptTurnSchema,
    /** Public graph state only — no ground truth, no evaluator capsule. */
    graph: EvidenceGraphSchema,
  })
  .strict();
export type EvidenceTrackerInput = z.infer<typeof EvidenceTrackerInputSchema>;

// Moved to core/domain.ts — persisted as the `question.assessed` event payload.
export { QuestionAssessmentSchema } from "../core/domain.js";
export type { QuestionAssessment } from "../core/domain.js";

export const EvidenceTrackerOutputSchema = z
  .object({
    patch: EvidenceGraphPatchSchema,
    questionAssessment: QuestionAssessmentSchema,
  })
  .strict();
export type EvidenceTrackerOutput = z.infer<typeof EvidenceTrackerOutputSchema>;

// ---------------------------------------------------------------------------
// Coach — hint ledger
// ---------------------------------------------------------------------------

export const HintLedgerEntrySchema = z
  .object({
    topic: z.string().min(1),
    level: HintLevelSchema,
  })
  .strict();
export type HintLedgerEntry = z.infer<typeof HintLedgerEntrySchema>;

// ---------------------------------------------------------------------------
// Coach — problem brief validation
// ---------------------------------------------------------------------------

export const BriefValidationInputSchema = z
  .object({
    locale: LocaleSchema,
    brief: ProblemBriefSchema,
    graph: EvidenceGraphSchema,
    transcript: z.array(TranscriptTurnSchema),
  })
  .strict()
  .superRefine((input, ctx) => {
    const nodeIds = new Set<string>(input.graph.nodes.map((node) => node.id));
    const collect = (evidenceIds: string[], path: (string | number)[]) => {
      evidenceIds.forEach((evidenceId, j) => {
        if (!nodeIds.has(evidenceId)) {
          ctx.addIssue({
            code: "custom",
            message: `brief references missing evidence node: ${evidenceId}`,
            path: [...path, j],
          });
        }
      });
    };
    input.brief.claims.forEach((claim, i) => {
      collect(claim.evidenceIds, ["brief", "claims", i, "evidenceIds"]);
    });
    input.brief.contradictions.forEach((contradiction, i) => {
      collect(contradiction.evidenceIds, ["brief", "contradictions", i, "evidenceIds"]);
    });
  });
export type BriefValidationInput = z.infer<typeof BriefValidationInputSchema>;

export type BriefValidationOutput = BriefValidationResult;
export const BriefValidationOutputSchema = BriefValidationResultSchema;

// ---------------------------------------------------------------------------
// Coach — final review
// ---------------------------------------------------------------------------

/**
 * One criterion of the FIXED capability rubric (`src/scoring/rubric.ts`), fed to
 * the Coach in `final-review` so it can assign per-criterion 0–100 scores. This
 * is the public, learner-safe capability rubric — NOT the scenario's hidden
 * `evaluator.rubric` (ground truth), which is never passed to any role.
 */
export const RubricCriterionInputSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    weight: z.number().int().min(0).max(100),
  })
  .strict();
export type RubricCriterionInput = z.infer<typeof RubricCriterionInputSchema>;

export const RubricInputSchema = z
  .object({
    framing: z.array(RubricCriterionInputSchema),
    solution: z.array(RubricCriterionInputSchema),
    challenge: z.array(RubricCriterionInputSchema),
    pitch: z.array(RubricCriterionInputSchema),
    process: z.array(RubricCriterionInputSchema),
  })
  .strict();
export type RubricInput = z.infer<typeof RubricInputSchema>;

export const FinalReviewInputSchema = z
  .object({
    locale: LocaleSchema,
    brief: ProblemBriefSchema,
    proposal: SolutionProposalSchema,
    pitch: PitchArtifactSchema,
    challengeResponses: z.array(ChallengeResponseSchema),
    graph: EvidenceGraphSchema,
    transcript: z.array(TranscriptTurnSchema),
    hintLedger: z.array(HintLedgerEntrySchema),
    rubric: RubricInputSchema,
  })
  .strict();
export type FinalReviewInput = z.infer<typeof FinalReviewInputSchema>;

export type FinalReviewOutput = FinalReviewResult;
export const FinalReviewOutputSchema = FinalReviewResultSchema;

// ---------------------------------------------------------------------------
// Prohibited-output sanitizer
// ---------------------------------------------------------------------------

/**
 * Field names that must never appear in a role output (or any nested object
 * within one). Chain-of-thought, raw prompts, and hidden analysis are not
 * stored or projected anywhere in the product.
 */
export const PROHIBITED_OUTPUT_KEYS = [
  "analysis",
  "reasoning",
  "chainOfThought",
  "systemPrompt",
  "rawPrompt",
] as const;

const PROHIBITED_OUTPUT_KEY_SET: ReadonlySet<string> = new Set(PROHIBITED_OUTPUT_KEYS);

/**
 * Recursively strip prohibited keys from any depth of a value. Arrays and
 * nested objects are traversed; primitives and null pass through untouched.
 * Used as defense-in-depth before strict schema validation rejects extras.
 */
export function stripProhibitedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripProhibitedKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (PROHIBITED_OUTPUT_KEY_SET.has(key)) continue;
      out[key] = stripProhibitedKeys(entry);
    }
    return out;
  }
  return value;
}

/**
 * Return every JSON path at which a prohibited key occurs, so callers can
 * choose to ERROR (fail closed) rather than silently strip.
 */
export function collectProhibitedKeyPaths(value: unknown, prefix = "$"): string[] {
  const paths: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, i) => paths.push(...collectProhibitedKeyPaths(entry, `${prefix}[${i}]`)));
    return paths;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const path = `${prefix}.${key}`;
      if (PROHIBITED_OUTPUT_KEY_SET.has(key)) paths.push(path);
      paths.push(...collectProhibitedKeyPaths(entry, path));
    }
  }
  return paths;
}
