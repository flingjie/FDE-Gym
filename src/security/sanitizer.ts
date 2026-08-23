import type { z } from "zod";
import type { AgentRole } from "../core/domain.js";
import {
  collectProhibitedKeyPaths,
  stripProhibitedKeys,
} from "../agents/contracts.js";

/**
 * FDE Gym — output sanitizer + leak guard.
 *
 * `sanitizeAgentResult` is the last line of defense between raw model output
 * and the learner-visible product: it strips prohibited keys (chain-of-thought,
 * raw prompts, analysis), collects where they were found, refuses any output
 * that still contains a hidden canary value, and validates the remainder
 * against the role's strict OUTPUT schema. Raw model output, CoT, and prompt
 * text are never retained — only the validated `output` and its `invocationId`.
 */

export const LEAK_GUARD_TRIGGERED = "LEAK_GUARD_TRIGGERED" as const;
export const AGENT_OUTPUT_INVALID = "AGENT_OUTPUT_INVALID" as const;
export const AGENT_OUTPUT_MALFORMED = "AGENT_OUTPUT_MALFORMED" as const;
export const AGENT_TIMEOUT = "AGENT_TIMEOUT" as const;
export const AGENT_SPAWN_ERROR = "AGENT_SPAWN_ERROR" as const;
export const AGENT_INPUT_INVALID = "AGENT_INPUT_INVALID" as const;

/** The raw, unvalidated payload produced by one agent invocation. */
export interface RawAgentResult {
  invocationId: string;
  output: unknown;
}

export interface SanitizeFailure {
  /** Stable machine-readable code. Never contains payload/canary text. */
  code: string;
  /** Human-readable message. Never contains payload/canary text. */
  message: string;
  /** JSON paths at which prohibited keys were found (paths only, no values). */
  prohibitedPaths: string[];
}

export type SafeRoleResult<TOutput> =
  | { ok: true; invocationId: string; output: TOutput }
  | { ok: false; invocationId: string; failure: SanitizeFailure };

export interface SanitizeOptions {
  /** Hidden values that must never appear anywhere in the output. */
  canaries?: readonly string[];
}

/** True if `text` contains any non-empty canary value. */
export function containsCanary(text: string, canaries: readonly string[]): boolean {
  for (const canary of canaries) {
    if (canary.length > 0 && text.includes(canary)) return true;
  }
  return false;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Sanitize and validate a raw agent payload against the role's output schema.
 *
 * Order: strip prohibited keys → leak-guard scan on values → strict schema
 * validation. The leak guard runs on VALUES (not just keys) so a canary planted
 * inside a required field is still caught and reported as `LEAK_GUARD_TRIGGERED`
 * without echoing the matched text.
 */
export function sanitizeAgentResult<TOutput>(
  role: AgentRole,
  result: RawAgentResult,
  outputSchema: z.ZodType<TOutput>,
  options: SanitizeOptions = {},
): SafeRoleResult<TOutput> {
  const prohibitedPaths = collectProhibitedKeyPaths(result.output);
  const stripped = stripProhibitedKeys(result.output);

  const canaries = options.canaries ?? [];
  if (canaries.length > 0 && containsCanary(safeStringify(stripped), canaries)) {
    return {
      ok: false,
      invocationId: result.invocationId,
      failure: {
        code: LEAK_GUARD_TRIGGERED,
        message: `${role} output failed the leak guard`,
        prohibitedPaths,
      },
    };
  }

  const validation = outputSchema.safeParse(stripped);
  if (!validation.success) {
    return {
      ok: false,
      invocationId: result.invocationId,
      failure: {
        code: AGENT_OUTPUT_INVALID,
        message: `${role} output failed schema validation`,
        prohibitedPaths,
      },
    };
  }

  return { ok: true, invocationId: result.invocationId, output: validation.data };
}
