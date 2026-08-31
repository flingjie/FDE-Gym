# Phase 2c — Runtime Capabilities Protocol

**Date:** 2026-08-31
**Status:** Approved for implementation planning
**Scope:** FDEGym Phase 2 "降耦合" — runtime capabilities protocol (minimal)

## Context

`src/agents/agent-runtime.ts` defines the `AgentRuntime` interface, but the product has a
single real implementation (`DirectModelRuntime`, chat-completions style) plus two test/fail
runtimes, so the abstraction reads as "an interface for testing" rather than a stable runtime
boundary. Different providers diverge on structured-output support, seed semantics,
cancellation, token limits, and identity — the interface does not currently surface any of
that.

This sub-project makes the runtime advertise a small, stable capability surface the control
plane can read. It is **capabilities only** — no per-role model configuration (deferred).

## Goal

- `AgentRuntime` gains `readonly capabilities: RuntimeCapabilities`; every implementation
  reports its capabilities honestly.
- The CLI logs the runtime's capabilities at startup, so the surface is consumed, not merely
  declared.

## Non-negotiable constraints

- **Behavior-preserving.** 708 tests green; golden replay byte-stable; no event/score change.
  The capabilities field is read-only metadata; `invoke` behavior is untouched.
- Source imports `.js`; test imports extensionless; no new deps.
- No per-role model config, no feature flag, no capability-based dispatch in this sub-project.

## The type (`src/agents/agent-runtime.ts`)

```ts
export interface RuntimeCapabilities {
  /** How structured output is enforced: native (schema-validated by the endpoint
   *  or the runtime itself) vs prompted (a JSON schema handed to the model in the
   *  prompt/system message). */
  structuredOutput: "native" | "prompted";
  /** Whether the runtime honors a seed for reproducibility. */
  supportsSeed: boolean;
  /** Whether in-flight calls can be cancelled (e.g. AbortController timeout). */
  supportsCancellation: boolean;
  /** Maximum input tokens, or `null` when unknown/unbounded by the runtime. */
  maxInputTokens: number | null;
  /** Stable provider/transport identifier (e.g. "openai-compatible", "fixture", "unconfigured"). */
  provider: string;
}

export interface AgentRuntime {
  readonly capabilities: RuntimeCapabilities;
  invoke<TInput, TOutput>(...): Promise<AgentInvocationResult<TOutput>>;
}
```

## Implementation reporting

| Runtime | structuredOutput | supportsSeed | supportsCancellation | maxInputTokens | provider |
|---|---|---|---|---|---|
| `DirectModelRuntime` | `"prompted"` | `false` | `true` | `null` | `"openai-compatible"` |
| `FixtureAgentRuntime` | `"native"` | `true` | `false` | `null` | `"fixture"` |
| `UnconfiguredModelRuntime` | `"native"` | `false` | `false` | `null` | `"unconfigured"` |

(`DirectModelRuntime` uses `response_format: json_object` + a system-message schema, not
native `json_schema` — hence `"prompted"`. `FixtureAgentRuntime` parses its fixture directly
against the role schema — `"native"` — and is deterministic — `supportsSeed: true`.)

## Consumer (`src/cli/main.ts`)

In `resolveDefaultRuntime()` (or immediately after it in the run loop), read
`runtime.capabilities` and emit a startup log line (the existing logger) summarizing
`provider`, `structuredOutput`, `supportsSeed`, `supportsCancellation`, `maxInputTokens`.
Read-only; no behavior change.

## Out of scope

- Per-role model configuration and a capability-driven dispatch.
- SQLite event store (separate sub-project).
- Any change to `invoke` semantics, timeout, or seed handling.

## Testing

- The 708-test suite passes unchanged.
- Add a unit test asserting each runtime's `capabilities` matches the table above (e.g.
  `DirectModelRuntime` reports `structuredOutput: "prompted"`, `supportsCancellation: true`).
- `npm run typecheck` green (the new field is required, so all three implementations must
  define it — a missing implementation fails typecheck).

## Success criteria

- `npm run release:gate` green; golden replay byte-stable.
- `runtime.capabilities` is a required, stable field on the interface; all three
  implementations report it; `main.ts` logs it at startup.
