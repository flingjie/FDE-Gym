# Runtime Capabilities Protocol (Phase 2c) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `AgentRuntime` a stable capability surface — `RuntimeCapabilities` with `structuredOutput`/`supportsSeed`/`supportsCancellation`/`maxInputTokens`/`provider` — reported by every implementation and read by the CLI at startup.

**Architecture:** A read-only `capabilities` field on the interface, a constant object on each implementation, a startup stderr log in `main.ts`, and a unit test pinning the reported values.

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-runtime-capabilities-design.md`

## Global Constraints

- **Behavior-preserving.** 708 tests green; golden replay byte-stable; no event/score change. `invoke` behavior untouched.
- Source imports `.js`; test imports extensionless; no new deps.
- No per-role model config, no feature flag, no capability-driven dispatch.

---

### Task 1: `RuntimeCapabilities` + `capabilities` field + three implementations + test

**Files:**
- Modify: `src/agents/agent-runtime.ts` (add the type + field)
- Modify: `src/integrations/direct/direct-runtime.ts`
- Modify: `src/agents/fixture-runtime.ts`
- Modify: `src/agents/unconfigured-runtime.ts`
- Create: `tests/unit/runtime-capabilities.test.ts`

**Interfaces:**
- Produces: `RuntimeCapabilities`; `AgentRuntime.capabilities` (required, read-only); each impl's concrete `capabilities` object.

- [ ] **Step 1: Add the type + field.** In `src/agents/agent-runtime.ts`, add above the `AgentRuntime` interface:

```ts
export interface RuntimeCapabilities {
  /** Native = schema enforced by the endpoint/runtime itself; prompted = a JSON
   *  schema handed to the model in the prompt/system message. */
  structuredOutput: "native" | "prompted";
  /** Whether the runtime honors a seed for reproducibility. */
  supportsSeed: boolean;
  /** Whether in-flight calls can be cancelled (e.g. AbortController timeout). */
  supportsCancellation: boolean;
  /** Maximum input tokens, or `null` when unknown/unbounded by the runtime. */
  maxInputTokens: number | null;
  /** Stable provider/transport identifier. */
  provider: string;
}
```

And add the field to `AgentRuntime`:

```ts
export interface AgentRuntime {
  readonly capabilities: RuntimeCapabilities;
  invoke<TInput, TOutput>(
    role: AgentRole,
    input: TInput,
    options: AgentInvokeOptions<TOutput>,
  ): Promise<AgentInvocationResult<TOutput>>;
}
```

- [ ] **Step 2: Report in `DirectModelRuntime`.** In `src/integrations/direct/direct-runtime.ts`, add a public field (it uses `response_format: json_object` + a system-message schema, an `AbortController` timeout, and no seed):

```ts
readonly capabilities: RuntimeCapabilities = {
  structuredOutput: "prompted",
  supportsSeed: false,
  supportsCancellation: true,
  maxInputTokens: null,
  provider: "openai-compatible",
};
```

(Import `RuntimeCapabilities` from `../../agents/agent-runtime.js`.)

- [ ] **Step 3: Report in `FixtureAgentRuntime`.** In `src/agents/fixture-runtime.ts` (it parses its fixture directly against the role schema, and is deterministic):

```ts
readonly capabilities: RuntimeCapabilities = {
  structuredOutput: "native",
  supportsSeed: true,
  supportsCancellation: false,
  maxInputTokens: null,
  provider: "fixture",
};
```

- [ ] **Step 4: Report in `UnconfiguredModelRuntime`.** In `src/agents/unconfigured-runtime.ts`:

```ts
readonly capabilities: RuntimeCapabilities = {
  structuredOutput: "native",
  supportsSeed: false,
  supportsCancellation: false,
  maxInputTokens: null,
  provider: "unconfigured",
};
```

- [ ] **Step 5: Add the unit test** `tests/unit/runtime-capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DirectModelRuntime } from "../../src/integrations/direct/direct-runtime";
import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import { UnconfiguredModelRuntime } from "../../src/agents/unconfigured-runtime";

describe("RuntimeCapabilities", () => {
  it("DirectModelRuntime reports prompted structured output + cancellation", () => {
    const c = new DirectModelRuntime({ baseUrl: "http://x/v1", model: "m" }).capabilities;
    expect(c).toMatchObject({ structuredOutput: "prompted", supportsSeed: false, supportsCancellation: true, maxInputTokens: null, provider: "openai-compatible" });
  });
  it("FixtureAgentRuntime reports native + seed", () => {
    const c = new FixtureAgentRuntime().capabilities;
    expect(c).toMatchObject({ structuredOutput: "native", supportsSeed: true, supportsCancellation: false, provider: "fixture" });
  });
  it("UnconfiguredModelRuntime reports unconfigured", () => {
    const c = new UnconfiguredModelRuntime().capabilities;
    expect(c.provider).toBe("unconfigured");
  });
});
```

- [ ] **Step 6: Verify + commit.** `npm run typecheck && npm test` — 711 green (708 + 3). The required field forces all three impls (and any test-double implementing `AgentRuntime`) to define it — typecheck catches any miss.

```bash
git add -A && git commit -m "feat: add RuntimeCapabilities to the AgentRuntime interface"
```

---

### Task 2: Read capabilities at startup

**Files:**
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Log capabilities after the runtime is resolved.** In `main.ts`, where `const runtime = resolveDefaultRuntime();` is called, add a single stderr line (stdout stays clean for JSON):

```ts
const runtime = resolveDefaultRuntime();
process.stderr.write(
  `[fde-gym] runtime: provider=${runtime.capabilities.provider} ` +
  `structuredOutput=${runtime.capabilities.structuredOutput} ` +
  `seed=${runtime.capabilities.supportsSeed} cancel=${runtime.capabilities.supportsCancellation} ` +
  `maxInputTokens=${runtime.capabilities.maxInputTokens ?? "unknown"}\n`,
);
```

- [ ] **Step 2: Verify + full gate + commit.**

```bash
npm run typecheck && npm test
npm run release:gate   # golden replay byte-stable
git add -A && git commit -m "feat: log runtime capabilities at startup"
```

---

## Execution order

1 → 2 (serial; Task 2 consumes Task 1's field).

## Verification checklist

- [ ] `npm run release:gate` green; golden replay byte-stable.
- [ ] `runtime.capabilities` is required on `AgentRuntime`; all three impls + any test double define it.
- [ ] `main.ts` logs the capabilities to stderr at startup (stdout untouched).
