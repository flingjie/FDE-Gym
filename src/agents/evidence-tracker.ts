import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRuntime } from "./agent-runtime.js";
import {
  EvidenceTrackerOutputSchema,
  type EvidenceTrackerInput,
  type QuestionAssessment,
} from "./contracts.js";
import type { EvidenceGraphPatch } from "../core/domain.js";
import { buildRoleInput, type RunAggregate } from "../security/context-firewall.js";
import { sanitizeAgentResult } from "../security/sanitizer.js";
import { validateEvidenceTrackerOutput } from "./output-validation.js";

/**
 * FDE Gym — Evidence Tracker wrapper.
 *
 * `extractEvidence` builds the strict tracker INPUT through the context
 * firewall (`transcript` + `graph` ONLY — the firewall structurally rejects any
 * capsule), invokes the `AgentRuntime` under the `evidence_tracker` role with
 * `EvidenceTrackerOutputSchema`, and sanitizes the result. The tracker is
 * therefore incapable of seeing expected evidence, ground truth, or a rubric:
 * its input schema declares no such fields, and this wrapper never constructs
 * the input by hand.
 */

const PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
  "prompts",
  "evidence-tracker.md",
);

let cachedPrompt: string | null = null;

function loadPromptTemplate(): string {
  if (cachedPrompt === null) cachedPrompt = readFileSync(PROMPT_PATH, "utf8");
  return cachedPrompt;
}

function wrapUntrustedLearnerInput(text: string): string {
  return `<UNTRUSTED_LEARNER_INPUT>\n${text}\n</UNTRUSTED_LEARNER_INPUT>`;
}

/**
 * Render the evidence-tracker prompt for a given input. The learner question
 * (inside the public turn) is wrapped in the UNTRUSTED_LEARNER_INPUT boundary.
 */
export function renderEvidenceTrackerPrompt(input: EvidenceTrackerInput): string {
  const template = loadPromptTemplate();
  const renderSafe = {
    ...input,
    turn: { ...input.turn, question: wrapUntrustedLearnerInput(input.turn.question) },
  };
  return template
    .replaceAll("{{LOCALE}}", input.locale)
    .replace("{{INPUT}}", JSON.stringify(renderSafe, null, 2));
}

export interface EvidenceTurnResult {
  patch: EvidenceGraphPatch;
  questionAssessment: QuestionAssessment;
  invocationId: string;
}

export interface ExtractEvidenceContext {
  runtime: AgentRuntime;
  /** The last transcript turn is the extraction target (firewall reads it). */
  state: RunAggregate;
  invocationId: string;
  timeoutMs: number;
  /** Hidden values to scan the output for; the tracker never receives a capsule. */
  canaries?: readonly string[];
}

/** Stable code for a tracker output rejected by the sanitizer. */
export const EVIDENCE_OUTPUT_REJECTED = "EVIDENCE_OUTPUT_REJECTED" as const;

export class EvidenceTrackerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EvidenceTrackerError";
    this.code = code;
  }
}

export async function extractEvidence(
  context: ExtractEvidenceContext,
): Promise<EvidenceTurnResult> {
  // The evidence tracker takes NO capsule; buildRoleInput rejects one outright.
  const built = buildRoleInput("evidence_tracker", context.state);
  if (built.kind !== "evidence_tracker") {
    throw new EvidenceTrackerError(EVIDENCE_OUTPUT_REJECTED, "evidence tracker firewall built the wrong role");
  }
  const input = built.input;

  const canaries = context.canaries ?? [];

  const result = await context.runtime.invoke("evidence_tracker", input, {
    runId: context.state.runId,
    invocationId: context.invocationId,
    freshContext: true,
    tools: "disabled",
    prompt: renderEvidenceTrackerPrompt(input),
    canaries,
    outputSchema: EvidenceTrackerOutputSchema,
    timeoutMs: context.timeoutMs,
  });

  const safe = sanitizeAgentResult("evidence_tracker", result, EvidenceTrackerOutputSchema, {
    canaries,
  });
  if (!safe.ok) {
    throw new EvidenceTrackerError(safe.failure.code, safe.failure.message);
  }
  const validated = validateEvidenceTrackerOutput(input, safe.output);
  return {
    patch: validated.patch,
    questionAssessment: validated.questionAssessment,
    invocationId: safe.invocationId,
  };
}
