import type { z } from "zod";
import type { AgentRole } from "../core/domain.js";

/**
 * The result of one agent invocation. Kept intentionally lean: the validated
 * `output` and its `invocationId` only. No chain-of-thought, no raw prompt, no
 * transcript — those never leave the role boundary.
 */
export interface AgentInvocationResult<TOutput> {
  invocationId: string;
  output: TOutput;
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
    options: {
      runId: string;
      invocationId: string;
      freshContext: true;
      tools: "disabled";
      outputSchema: z.ZodType<TOutput>;
      timeoutMs: number;
    },
  ): Promise<AgentInvocationResult<TOutput>>;
}
