import type { AgentRole } from "../core/domain.js";
import {
  AgentRuntimeError,
  MODEL_ENDPOINT_REQUIRED,
  type AgentInvocationResult,
  type AgentInvokeOptions,
  type AgentRuntime,
  type RuntimeCapabilities,
} from "./agent-runtime.js";

/**
 * FDE Gym — unconfigured role runtime.
 *
 * The direct-only runtime seam resolves to this when no model endpoint is
 * discoverable (`FDE_GYM_MODEL_BASE_URL` + `FDE_GYM_MODEL`, or
 * `~/.codex/config.toml`). Read-only commands never call `invoke()`, so they
 * keep working; the first `invoke()` on a role fails closed with the stable
 * `MODEL_ENDPOINT_REQUIRED` error instead of running without a model.
 */
export class UnconfiguredModelRuntime implements AgentRuntime {
  readonly capabilities: RuntimeCapabilities = {
    structuredOutput: "native",
    supportsSeed: false,
    supportsCancellation: false,
    maxInputTokens: null,
    provider: "unconfigured",
  };

  async invoke<TInput, TOutput>(
    role: AgentRole,
    _input: TInput,
    _options: AgentInvokeOptions<TOutput>,
  ): Promise<AgentInvocationResult<TOutput>> {
    throw new AgentRuntimeError(
      MODEL_ENDPOINT_REQUIRED,
      `no model endpoint configured (${role})`,
    );
  }
}
