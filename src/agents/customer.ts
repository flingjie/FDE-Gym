import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRuntime } from "./agent-runtime.js";
import {
  CustomerOutputSchema,
  type CustomerInput,
  type CustomerOutput,
} from "./contracts.js";
import { buildRoleInput, type RunAggregate } from "../security/context-firewall.js";
import { sanitizeAgentResult } from "../security/sanitizer.js";
import type { CustomerCapsule } from "../scenarios/schema.js";

/**
 * FDE Gym — Customer Simulator wrapper.
 *
 * `answerDiscoveryQuestion` is the ONLY entry point: it builds the strict
 * customer INPUT through the context firewall (never by hand), invokes the
 * `AgentRuntime` under the `customer` role with `CustomerOutputSchema`, and
 * sanitizes the result against the capsule canary before returning a typed
 * `CustomerTurn`. The Customer can therefore never see the evaluator capsule,
 * score, hints, or learner profile — the firewall guarantees it, and this
 * wrapper refuses to construct the input any other way.
 */

const PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
  "prompts",
  "customer.md",
);

let cachedPrompt: string | null = null;

/** Load the role prompt template once (deterministic file content). */
function loadPromptTemplate(): string {
  if (cachedPrompt === null) cachedPrompt = readFileSync(PROMPT_PATH, "utf8");
  return cachedPrompt;
}

/** Wrap learner prose in the untrusted-input boundary the prompt contract requires. */
export function wrapUntrustedLearnerInput(text: string): string {
  return `<UNTRUSTED_LEARNER_INPUT>\n${text}\n</UNTRUSTED_LEARNER_INPUT>`;
}

/**
 * Render the customer role prompt for a given input. The learner question is
 * wrapped in the UNTRUSTED_LEARNER_INPUT boundary exactly once; the raw
 * question is never emitted outside it. Parameterized on `locale`.
 */
export function renderCustomerPrompt(input: CustomerInput): string {
  const template = loadPromptTemplate();
  const renderSafe = { ...input, question: wrapUntrustedLearnerInput(input.question) };
  return template
    .replaceAll("{{LOCALE}}", input.locale)
    .replace("{{INPUT}}", JSON.stringify(renderSafe, null, 2));
}

/**
 * The learner-safe turn the Customer produced. Reused directly from
 * `CustomerOutput` — the wrapper adds no fields, so the type is exactly the
 * sanitized, schema-validated contract (reply + stakeholderId +
 * disclosedDisclosureUnitIds).
 */
export type CustomerTurn = CustomerOutput;

export interface AnswerDiscoveryQuestionContext {
  runtime: AgentRuntime;
  /** Must carry `pendingQuestion` (the firewall requires it). */
  state: RunAggregate;
  capsule: CustomerCapsule;
  invocationId: string;
  timeoutMs: number;
  /** Hidden values to scan the output for; defaults to the capsule canary. */
  canaries?: readonly string[];
}

/** Stable code for a customer output rejected by the sanitizer. */
export const CUSTOMER_OUTPUT_REJECTED = "CUSTOMER_OUTPUT_REJECTED" as const;

export class CustomerAgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CustomerAgentError";
    this.code = code;
  }
}

export async function answerDiscoveryQuestion(
  context: AnswerDiscoveryQuestionContext,
): Promise<CustomerTurn> {
  const built = buildRoleInput("customer", context.state, context.capsule);
  if (built.kind !== "customer") {
    // Unreachable: the firewall always returns the customer shape for this role.
    throw new CustomerAgentError(CUSTOMER_OUTPUT_REJECTED, "customer firewall built the wrong role");
  }
  const input = built.input;

  const canaries = context.canaries ?? [context.capsule.canary];

  const result = await context.runtime.invoke("customer", input, {
    runId: context.state.runId,
    invocationId: context.invocationId,
    freshContext: true,
    tools: "disabled",
    prompt: renderCustomerPrompt(input),
    canaries,
    outputSchema: CustomerOutputSchema,
    timeoutMs: context.timeoutMs,
  });

  // Defense-in-depth sanitize: strip prohibited keys, leak-guard scan, strict
  // schema validation. Required even when the runtime already sanitized.
  const safe = sanitizeAgentResult("customer", result, CustomerOutputSchema, {
    canaries,
  });
  if (!safe.ok) {
    throw new CustomerAgentError(safe.failure.code, safe.failure.message);
  }
  return safe.output;
}
