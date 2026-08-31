import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole } from "../core/domain.js";
import { canonicalJson } from "../core/event-store.js";
import type { AgentInvocationResult, AgentInvokeOptions, AgentRuntime, RuntimeCapabilities } from "./agent-runtime.js";

/**
 * FDE Gym — deterministic fixture runtime.
 *
 * Maps `(role, invocationId)` to a fixture JSON object (in-memory map and/or
 * files under `<fixtureDir>/<role>/<invocationId>.json`). No network, no model
 * nondeterminism — every CI test runs through this. The fixture's output is
 * validated against the role's strict OUTPUT schema so a bad fixture fails
 * loudly rather than injecting malformed data into the product.
 */

export interface FixtureAgentRuntimeOptions {
  /** Root directory containing `<role>/<invocationId>.json` fixture files. */
  fixtureDir?: string;
  /** In-memory map keyed by `${role}:${invocationId}` → raw output value. */
  fixtures?: Record<string, unknown>;
  /** Optional model family identifier reported on every result (provenance metadata). */
  modelId?: string | null;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export class FixtureAgentRuntime implements AgentRuntime {
  readonly capabilities: RuntimeCapabilities = {
    structuredOutput: "native",
    supportsSeed: true,
    supportsCancellation: false,
    maxInputTokens: null,
    provider: "fixture",
  };

  private readonly fixtureDir: string | undefined;
  private readonly fixtures: Record<string, unknown>;
  private readonly modelId: string | null;

  constructor(options: FixtureAgentRuntimeOptions = {}) {
    this.fixtureDir = options.fixtureDir;
    this.fixtures = options.fixtures ?? {};
    this.modelId = options.modelId ?? null;
  }

  async invoke<TInput, TOutput>(
    role: AgentRole,
    _input: TInput,
    options: AgentInvokeOptions<TOutput>,
  ): Promise<AgentInvocationResult<TOutput>> {
    // The fixture runtime is deterministic: it ignores `prompt` and `canaries`
    // but must still accept them so the three-role contract stays uniform.
    const raw = this.resolve(role, options.invocationId);
    const output = options.outputSchema.parse(raw);
    return {
      invocationId: options.invocationId,
      output,
      modelId: this.modelId,
      rawOutputDigest: sha256Hex(canonicalJson(raw)),
    };
  }

  private resolve(role: AgentRole, invocationId: string): unknown {
    const key = `${role}:${invocationId}`;
    if (Object.prototype.hasOwnProperty.call(this.fixtures, key)) {
      return this.fixtures[key];
    }
    if (this.fixtureDir) {
      const file = join(this.fixtureDir, role, `${invocationId}.json`);
      if (existsSync(file)) {
        return JSON.parse(readFileSync(file, "utf8")) as unknown;
      }
    }
    throw new Error(`no fixture for ${key}`);
  }
}
