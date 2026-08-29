import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentRole } from "../../core/domain.js";
import type { AgentInvocationResult, AgentInvokeOptions, AgentRuntime } from "../../agents/agent-runtime.js";
import { roleInputSchema } from "../../security/context-firewall.js";
import {
  AGENT_INPUT_INVALID,
  AGENT_OUTPUT_MALFORMED,
  AGENT_SPAWN_ERROR,
  AGENT_TIMEOUT,
  LEAK_GUARD_TRIGGERED,
  containsCanary,
  sanitizeAgentResult,
} from "../../security/sanitizer.js";
import { runCodex } from "./codex-process.js";
import { sanitizeChildEnv } from "./capability-probe.js";

/**
 * FDE Gym — real Codex agent runtime.
 *
 * Built on the verified Task 1 spike contract (docs/codex-capability-report.md):
 * every invocation starts a fresh non-resumed session (`exec --json --ephemeral
 * --skip-git-repo-check --sandbox read-only --color never`), runs in a unique
 * role-scoped `-C` workdir with tools disabled (`--disable shell_tool
 * --disable unified_exec`), receives its prompt/input via stdin (`-`), captures
 * stdout/stderr separately, forces structured JSON output (`--output-schema`
 * + `-o`), and is killed on timeout. Raw output is revalidated against the
 * role's strict OUTPUT schema and scanned for hidden canaries.
 *
 * Repair/retry policy (at most two model invocations per `invoke`):
 *   - ONE fresh-context repair attempt after malformed structured output;
 *   - ONE fresh-context retry after a leak-guard match;
 *   - a SECOND failure returns a stable error and does NOT advance state.
 *
 * Hidden prompt text is never logged; error messages never carry payload or
 * canary text.
 */

export interface CodexAgentRuntimeConfig {
  /** Absolute path to the Codex CLI executable. */
  executable: string;
  /** Base directory for role-scoped workdirs. Default: a fresh dir under tmpdir. */
  workRoot?: string;
  /** Per-invocation timeout in ms. Default 90_000. */
  timeoutMs?: number;
  /** Optional `-m <model>` override. */
  model?: string;
  /** Delete per-invocation workdirs after each attempt. Default true. */
  cleanup?: boolean;
  /** Hidden values that must never appear in stdout/stderr or parsed output. */
  canaries?: readonly string[];
  /** Extra env keys passed through the child-env sanitizer (test control only). */
  envExtraAllow?: string[];
}

export class AgentRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
  }
}

type AttemptResult<TOutput> =
  | { outcome: "ok"; result: AgentInvocationResult<TOutput> }
  | { outcome: "malformed" }
  | { outcome: "leak" }
  | { outcome: "terminal"; error: AgentRuntimeError };

const DISABLE_TOOLS = ["--disable", "shell_tool", "--disable", "unified_exec"];

export class CodexAgentRuntime implements AgentRuntime {
  private readonly executable: string;
  private readonly workRoot: string;
  private readonly timeoutMs: number;
  private readonly model: string | undefined;
  private readonly cleanup: boolean;
  private readonly canaries: readonly string[];
  private readonly envExtraAllow: string[];

  constructor(config: CodexAgentRuntimeConfig) {
    this.executable = config.executable;
    this.workRoot = config.workRoot ?? join(tmpdir(), `fde-gym-codex-${randomUUID()}`);
    this.timeoutMs = config.timeoutMs ?? 90_000;
    this.model = config.model;
    this.cleanup = config.cleanup !== false;
    this.canaries = config.canaries ?? [];
    this.envExtraAllow = config.envExtraAllow ?? [];
    mkdirSync(this.workRoot, { recursive: true });
  }

  async invoke<TInput, TOutput>(
    role: AgentRole,
    input: TInput,
    options: AgentInvokeOptions<TOutput>,
  ): Promise<AgentInvocationResult<TOutput>> {
    // Fail closed on the INPUT side: a role must never receive an input that
    // is not one of its strict role inputs (e.g. an evaluator capsule handed to
    // the evidence tracker is rejected before any model is spawned).
    const inputCheck = roleInputSchema(role).safeParse(input);
    if (!inputCheck.success) {
      throw new AgentRuntimeError(AGENT_INPUT_INVALID, `invalid ${role} input`);
    }

    const first = await this.runOnce(role, options, false);
    if (first.outcome === "ok") return first.result;
    if (first.outcome === "terminal") throw first.error;

    const second = await this.runOnce(role, options, first.outcome === "malformed");
    if (second.outcome === "ok") return second.result;
    if (second.outcome === "terminal") throw second.error;
    if (second.outcome === "leak") {
      throw new AgentRuntimeError(
        LEAK_GUARD_TRIGGERED,
        `${role} output failed the leak guard on retry`,
      );
    }
    throw new AgentRuntimeError(
      AGENT_OUTPUT_MALFORMED,
      `${role} output remained malformed after repair`,
    );
  }

  private async runOnce<TOutput>(
    role: AgentRole,
    options: AgentInvokeOptions<TOutput>,
    repair: boolean,
  ): Promise<AttemptResult<TOutput>> {
    const workdir = join(this.workRoot, `${role}-${randomUUID()}`);
    mkdirSync(workdir, { recursive: true });
    const schemaFile = join(workdir, "schema.json");
    const outFile = join(workdir, "output.json");

    try {
      // `--output-schema` receives the complete Zod→JSON schema for the role so
      // Codex is constrained to the exact output shape, not a generic object.
      const jsonSchema = z.toJSONSchema(options.outputSchema);
      writeFileSync(schemaFile, JSON.stringify(jsonSchema), "utf8");

      const args = [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "-C",
        workdir,
        ...DISABLE_TOOLS,
        "--output-schema",
        schemaFile,
        "-o",
        outFile,
        ...(this.model ? ["-m", this.model] : []),
        "-",
      ];

      // The rendered role prompt is the prompt; a structural repair suffix is
      // added only on the second attempt.
      const prompt = repair
        ? `${options.prompt}\n\nReturn only JSON matching the supplied output schema. The previous response was invalid.`
        : options.prompt;

      const run = await runCodex(this.executable, {
        args,
        stdin: prompt,
        cwd: workdir,
        env: sanitizeChildEnv(process.env, this.envExtraAllow),
        timeoutMs: options.timeoutMs,
      });

      if (run.timedOut) {
        return {
          outcome: "terminal",
          error: new AgentRuntimeError(AGENT_TIMEOUT, `${role} invocation timed out`),
        };
      }
      if (run.spawnError) {
        return {
          outcome: "terminal",
          error: new AgentRuntimeError(AGENT_SPAWN_ERROR, `failed to spawn Codex for ${role}`),
        };
      }

      // Per-call canaries (from the role capsule) merged with any global
      // canaries the runtime was configured with.
      const canaries = [...this.canaries, ...(options.canaries ?? [])];

      // Raw leak scan across stdout + stderr. JSONL reasoning events arrive on
      // stdout, so this also catches canaries that never reach structured output.
      if (containsCanary(run.stdout, canaries) || containsCanary(run.stderr, canaries)) {
        return { outcome: "leak" };
      }

      // Structured output: the `-o` file first, the agent message as fallback.
      let rawOutput = "";
      try {
        rawOutput = readFileSync(outFile, "utf8");
      } catch {
        rawOutput = "";
      }
      if (rawOutput.trim() === "") rawOutput = run.agentMessage ?? "";

      // Scan the raw output-file text BEFORE parsing so a canary outside the
      // JSON object (e.g. trailing prose) is caught rather than dropped.
      if (containsCanary(rawOutput, canaries)) {
        return { outcome: "leak" };
      }

      let parsed: unknown = null;
      const trimmed = rawOutput.trim();
      if (trimmed !== "") {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = tryExtractJson(rawOutput);
        }
      }
      if (parsed === null) return { outcome: "malformed" };

      const sanitized = sanitizeAgentResult(
        role,
        { invocationId: options.invocationId, output: parsed },
        options.outputSchema,
        { canaries },
      );
      if (!sanitized.ok) {
        if (sanitized.failure.code === LEAK_GUARD_TRIGGERED) return { outcome: "leak" };
        return { outcome: "malformed" };
      }
      return { outcome: "ok", result: { invocationId: options.invocationId, output: sanitized.output, modelId: this.model ?? null } };
    } finally {
      if (this.cleanup) {
        try {
          rmSync(workdir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Extract a JSON object from a possibly fenced/verbose model reply. */
function tryExtractJson(raw: string): unknown {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}
