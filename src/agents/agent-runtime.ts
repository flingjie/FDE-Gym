import type { z } from "zod";
import type { AgentRole } from "../core/domain.js";

/**
 * The result of one agent invocation. Kept intentionally lean: the validated
 * `output`, its `invocationId`, and the configured model family identifier
 * (`modelId`, when the runtime knows it) — safe invocation metadata only. No
 * chain-of-thought, no raw prompt, no transcript — those never leave the role
 * boundary.
 */
export interface AgentInvocationResult<TOutput> {
  invocationId: string;
  output: TOutput;
  /** The configured model family identifier, or `null` when the runtime has none. */
  modelId: string | null;
}

/**
 * Per-invocation options for an agent runtime. `prompt` is the rendered role
 * prompt (never logged), and `canaries` are hidden values that must never
 * appear in any child surface (stdout, stderr, reasoning, output file).
 */
export interface AgentInvokeOptions<TOutput> {
  runId: string;
  invocationId: string;
  freshContext: true;
  tools: "disabled";
  prompt: string;
  canaries: readonly string[];
  outputSchema: z.ZodType<TOutput>;
  timeoutMs: number;
}

/**
 * Stable contract for the three logical model roles. Implementations are
 * `FixtureAgentRuntime` (deterministic tests) and `CodexAgentRuntime` (real
 * runs) in Task 6; the orchestrator depends only on this interface.
 */
export interface AgentRuntime {
  invoke<TInput, TOutput>(
    role: AgentRole,
    input: TInput,
    options: AgentInvokeOptions<TOutput>,
  ): Promise<AgentInvocationResult<TOutput>>;
}
