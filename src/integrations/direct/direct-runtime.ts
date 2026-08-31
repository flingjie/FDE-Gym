import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentRole } from "../../core/domain.js";
import {
  AgentRuntimeError,
  type AgentInvocationResult,
  type AgentInvokeOptions,
  type AgentRuntime,
} from "../../agents/agent-runtime.js";
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

/**
 * FDE Gym — direct chat-completions role runtime.
 *
 * An `AgentRuntime` that talks straight to an OpenAI-compatible
 * `POST /chat/completions` endpoint instead of spawning the Codex CLI. It is
 * the "model-as-a-function" shape the three roles actually need: a single
 * structured-output call, no tools, no MCP, no memory, no subprocess. The
 * deterministic control plane and the learner-facing Codex Skill are unchanged;
 * only the role layer moves off `codex exec`.
 *
 * Empirical basis (probed against the local proxy on 2026-08-29):
 *   - `POST /v1/responses` (Codex's `wire_api`) returns 422 "No message in chat
 *     choice" — the proxy's Responses→Chat translation is broken.
 *   - `POST /v1/chat/completions` returns 200 and clean text.
 *   - `response_format: json_schema` is unavailable upstream (502); the loose
 *     `response_format: json_object` works, so schema validation stays here in
 *     `sanitizeAgentResult` (which is exactly what it already does).
 *
 * Single-shot: no repair/retry loop. The callers re-drive through the same
 * stable error codes (`AGENT_TIMEOUT`, `AGENT_OUTPUT_MALFORMED`, …).
 */

export interface DirectModelRuntimeConfig {
  /** Base URL of the OpenAI-compatible endpoint, e.g. `http://127.0.0.1:15721/v1`. */
  baseUrl: string;
  /** Model identifier, e.g. `deepseek-v4-pro`. */
  model: string;
  /** Per-invocation timeout in ms. Default 90_000. */
  timeoutMs?: number;
  /** Optional bearer token; most local proxies (cc-switch) need none. */
  apiKey?: string;
  /** Hidden values that must never appear in model output. */
  canaries?: readonly string[];
}

/** Extract the assistant text from a chat-completions payload. Handles both the
 * streaming shape (`choices[0].delta.content`) and the standard shape
 * (`choices[0].message.content`) since the proxy returns `delta` regardless. */
function extractContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown>;
  for (const key of ["delta", "message"]) {
    const holder = first[key];
    if (typeof holder === "object" && holder !== null) {
      const content = (holder as Record<string, unknown>).content;
      if (typeof content === "string") return content;
    }
  }
  return null;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
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

export class DirectModelRuntime implements AgentRuntime {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly canaries: readonly string[];

  constructor(config: DirectModelRuntimeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 90_000;
    this.apiKey = config.apiKey;
    this.canaries = config.canaries ?? [];
  }

  async invoke<TInput, TOutput>(
    role: AgentRole,
    input: TInput,
    options: AgentInvokeOptions<TOutput>,
  ): Promise<AgentInvocationResult<TOutput>> {
    // Fail closed on the INPUT side: a role must
    // never receive an input outside its strict role schema.
    const inputCheck = roleInputSchema(role).safeParse(input);
    if (!inputCheck.success) {
      throw new AgentRuntimeError(AGENT_INPUT_INVALID, `invalid ${role} input`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // `json_object` only guarantees valid JSON, not the exact shape. The Codex
    // path enforces the shape with `--output-schema`; the direct path has no
    // such flag, so it must hand the model the schema in a system message.
    const jsonSchema = z.toJSONSchema(options.outputSchema);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "Respond with a single JSON object that matches this JSON Schema (no prose, no markdown fences):\n" +
                JSON.stringify(jsonSchema),
            },
            { role: "user", content: options.prompt },
          ],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new AgentRuntimeError(AGENT_TIMEOUT, `${role} invocation timed out`);
      }
      throw new AgentRuntimeError(AGENT_SPAWN_ERROR, `failed to reach the model for ${role}`);
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw new AgentRuntimeError(AGENT_SPAWN_ERROR, `model endpoint returned ${response.status}`);
    }

    const body: unknown = await response.json().catch(() => null);
    const content = extractContent(body);
    if (content === null || content.trim() === "") {
      throw new AgentRuntimeError(AGENT_OUTPUT_MALFORMED, `${role} produced no output`);
    }

    // Per-call canaries merged with any global canaries the runtime was given.
    const canaries = [...this.canaries, ...(options.canaries ?? [])];

    // Raw leak scan BEFORE parsing so a canary outside the JSON object (e.g.
    // trailing prose) is caught rather than silently dropped by JSON.parse.
    if (containsCanary(content, canaries)) {
      throw new AgentRuntimeError(LEAK_GUARD_TRIGGERED, `${role} output failed the leak guard`);
    }

    let parsed: unknown = null;
    const trimmed = content.trim();
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = tryExtractJson(content);
    }
    if (parsed === null) {
      throw new AgentRuntimeError(AGENT_OUTPUT_MALFORMED, `${role} output was malformed`);
    }

    const sanitized = sanitizeAgentResult(
      role,
      { invocationId: options.invocationId, output: parsed },
      options.outputSchema,
      { canaries },
    );
    if (!sanitized.ok) {
      if (sanitized.failure.code === LEAK_GUARD_TRIGGERED) {
        throw new AgentRuntimeError(LEAK_GUARD_TRIGGERED, sanitized.failure.message);
      }
      throw new AgentRuntimeError(AGENT_OUTPUT_MALFORMED, sanitized.failure.message);
    }

    return {
      invocationId: options.invocationId,
      output: sanitized.output,
      modelId: this.model,
      rawOutputDigest: sha256Hex(content),
    };
  }
}
