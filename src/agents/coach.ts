import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRuntime } from "./agent-runtime.js";
import {
  BriefValidationOutputSchema,
  FinalReviewOutputSchema,
} from "./contracts.js";
import type {
  BriefValidationInput,
  FinalReviewInput,
} from "./contracts.js";
import type { BriefValidationResult, FinalReviewResult, LocalizedText, ProblemBrief } from "../core/domain.js";
import { buildRoleInput } from "../security/context-firewall.js";
import type { RunAggregate } from "../core/aggregate.js";
import { sanitizeAgentResult } from "../security/sanitizer.js";
import type { EvaluatorCapsule } from "../scenarios/schema.js";
import { wrapUntrustedLearnerInput } from "./customer.js";
import {
  validateBriefValidationOutput,
  validateFinalReviewOutput,
} from "./output-validation.js";

/**
 * FDE Gym — Coach/Evaluator wrapper.
 *
 * Two entry points, both built EXCLUSIVELY through the context firewall and
 * sanitized against the evaluator canary before returning a schema-validated
 * result:
 *
 *   - `validateProblemBrief(context)` -> `BriefValidationResult`
 *     (the semantic entailment classification; `entailments` +
 *     `missingCategories` + `unsupportedClaimIds` + `feedback`)
 *   - `runFinalReview(context)`        -> `FinalReviewInvocation`
 *     (`review` + safe invocation metadata)
 *
 * Hints are NOT a model path: they flow only through the deterministic authored
 * ladder in `src/simulation/hints.ts` (ADR-0003). The Coach NEVER receives the
 * customer capsule — `buildRoleInput("coach_evaluator", …)` rejects a customer
 * capsule (`FIREWALL_CAPSULE_FORBIDDEN`) and builds only from the evaluator
 * capsule plus the public aggregate. For brief validation the coach sees ONLY
 * `{ locale, brief, graph, transcript }`; for final review it additionally sees
 * the public proposal, pitch, challenge responses, and the hint ledger.
 */

const PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
  "prompts",
  "coach-evaluator.md",
);

let cachedPrompt: string | null = null;

function loadPromptTemplate(): string {
  if (cachedPrompt === null) cachedPrompt = readFileSync(PROMPT_PATH, "utf8");
  return cachedPrompt;
}

/** The two coach input shapes the prompt template must render. */
export type CoachPromptInput = BriefValidationInput | FinalReviewInput;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function wrapLocalized(text: LocalizedText): LocalizedText {
  return {
    "zh-CN": wrapUntrustedLearnerInput(text["zh-CN"]),
    "en-US": wrapUntrustedLearnerInput(text["en-US"]),
  };
}

/**
 * Wrap every learner-authored prose field of a Problem Brief in the
 * UNTRUSTED_LEARNER_INPUT boundary. Structural references (`id`, `weight`,
 * `evidenceIds`, `disposition`) are left untouched.
 */
function wrapBriefProse(brief: ProblemBrief): ProblemBrief {
  return {
    ...brief,
    problemStatement: wrapLocalized(brief.problemStatement),
    goal: wrapLocalized(brief.goal),
    constraints: brief.constraints.map(wrapLocalized),
    claims: brief.claims.map((claim) => ({ ...claim, statement: wrapLocalized(claim.statement) })),
    successMeasures: brief.successMeasures.map(wrapLocalized),
    unknowns: brief.unknowns.map(wrapLocalized),
    contradictions: brief.contradictions.map((contradiction) => ({
      ...contradiction,
      statement: wrapLocalized(contradiction.statement),
    })),
  };
}

/** Wrap the learner-authored prose in a coach input (brief + transcript questions). */
function wrapLearnerProse(input: CoachPromptInput): unknown {
  if (!("brief" in input)) return input;
  const result: Record<string, unknown> = { ...input };
  result.brief = wrapBriefProse(input.brief);
  if ("transcript" in input) {
    result.transcript = input.transcript.map((turn) => ({
      ...turn,
      question: wrapUntrustedLearnerInput(turn.question),
    }));
  }
  return result;
}

/** Render the coach prompt: `{{LOCALE}}` parameterized, learner text wrapped. */
export function renderCoachPrompt(input: CoachPromptInput): string {
  const template = loadPromptTemplate();
  const renderSafe = wrapLearnerProse(input);
  return template
    .replaceAll("{{LOCALE}}", input.locale)
    .replace("{{INPUT}}", JSON.stringify(renderSafe, null, 2));
}

export interface CoachContext {
  runtime: AgentRuntime;
  /** Must carry `coachTask` (+ `brief`) for the chosen task. */
  state: RunAggregate;
  capsule: EvaluatorCapsule;
  invocationId: string;
  timeoutMs: number;
  /** Hidden values to scan the output for; defaults to the capsule canary. */
  canaries?: readonly string[];
}

/** Stable code for a coach output rejected by the sanitizer. */
export const COACH_OUTPUT_REJECTED = "COACH_OUTPUT_REJECTED" as const;

export class CoachError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CoachError";
    this.code = code;
  }
}

/** The sanitized brief-validation result plus safe invocation metadata. */
export interface BriefValidationInvocation {
  result: BriefValidationResult;
  invocationId: string;
  modelId: string | null;
  rawOutputDigest: string;
  promptDigest: string;
}

/** Build `BriefValidationInput` via the firewall (`coachTask="brief-validation"`) and invoke the Coach. */
export async function validateProblemBrief(
  context: CoachContext,
): Promise<BriefValidationInvocation> {
  const built = buildRoleInput("coach_evaluator", context.state, context.capsule);
  if (built.kind !== "brief-validation") {
    throw new CoachError(COACH_OUTPUT_REJECTED, "coach firewall built the wrong role");
  }
  const input = built.input;

  const canaries = context.canaries ?? [context.capsule.canary];

  const result = await context.runtime.invoke("coach_evaluator", input, {
    runId: context.state.runId,
    invocationId: context.invocationId,
    freshContext: true,
    tools: "disabled",
    prompt: renderCoachPrompt(input),
    canaries,
    outputSchema: BriefValidationOutputSchema,
    timeoutMs: context.timeoutMs,
  });

  const safe = sanitizeAgentResult("coach_evaluator", result, BriefValidationOutputSchema, {
    canaries,
  });
  if (!safe.ok) {
    throw new CoachError(safe.failure.code, safe.failure.message);
  }
  return {
    result: validateBriefValidationOutput(input, safe.output),
    invocationId: safe.invocationId,
    modelId: result.modelId,
    rawOutputDigest: result.rawOutputDigest,
    promptDigest: sha256Hex(renderCoachPrompt(input)),
  };
}

/** The sanitized final review plus safe invocation metadata. */
export interface FinalReviewInvocation {
  review: FinalReviewResult;
  invocationId: string;
  modelId: string | null;
  rawOutputDigest: string;
  promptDigest: string;
}

/**
 * Build `FinalReviewInput` via the firewall (`coachTask="final-review"`) and
 * invoke the Coach. Returns the sanitized, schema-validated `FinalReviewResult`
 * together with the safe invocation metadata (`invocationId`, configured model
 * family). The Coach sees ONLY the public brief + proposal + pitch + challenge
 * responses + graph + transcript + hint ledger (never the capsule's ground truth).
 */
export async function runFinalReview(context: CoachContext): Promise<FinalReviewInvocation> {
  const built = buildRoleInput("coach_evaluator", context.state, context.capsule);
  if (built.kind !== "final-review") {
    throw new CoachError(COACH_OUTPUT_REJECTED, "coach firewall built the wrong role");
  }
  const input = built.input;

  const canaries = context.canaries ?? [context.capsule.canary];

  const result = await context.runtime.invoke("coach_evaluator", input, {
    runId: context.state.runId,
    invocationId: context.invocationId,
    freshContext: true,
    tools: "disabled",
    prompt: renderCoachPrompt(input),
    canaries,
    outputSchema: FinalReviewOutputSchema,
    timeoutMs: context.timeoutMs,
  });

  const safe = sanitizeAgentResult("coach_evaluator", result, FinalReviewOutputSchema, {
    canaries,
  });
  if (!safe.ok) {
    throw new CoachError(safe.failure.code, safe.failure.message);
  }
  const review = validateFinalReviewOutput(input, safe.output);
  return {
    review,
    invocationId: result.invocationId,
    modelId: result.modelId,
    rawOutputDigest: result.rawOutputDigest,
    promptDigest: sha256Hex(renderCoachPrompt(input)),
  };
}

export interface SampleFinalReviewOptions {
  samples: number;
  commandId: string;
  timeoutMs: number;
  canaries: readonly string[];
}

/**
 * Run the Coach final review `samples` times, each with a distinct invocation id
 * `${commandId}:coach:${i}`, and return the N `FinalReviewInvocation`s. The
 * caller aggregates the samples (see `aggregateReviews`); this loop only samples.
 */
export async function sampleFinalReview(
  runtime: AgentRuntime,
  state: RunAggregate,
  capsule: EvaluatorCapsule,
  options: SampleFinalReviewOptions,
): Promise<FinalReviewInvocation[]> {
  if (!Number.isInteger(options.samples) || options.samples < 1) {
    throw new CoachError(COACH_OUTPUT_REJECTED, "samples must be a positive integer");
  }
  const out: FinalReviewInvocation[] = [];
  for (let i = 1; i <= options.samples; i++) {
    out.push(await runFinalReview({
      runtime,
      state,
      capsule,
      invocationId: `${options.commandId}:coach:${i}`,
      timeoutMs: options.timeoutMs,
      canaries: options.canaries,
    }));
  }
  return out;
}
