# Codex Strict-Mode Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FDEGym's Codex role runtime fail closed around a dedicated `FDE_GYM_CODEX_HOME`, reject every enabled MCP server, and ensure the live doctor never interprets a failed probe as evidence of safety.

**Architecture:** Extract the generic Codex child-process runner from the capability probe, then add one focused `strict-policy.ts` module consumed by both the runtime and doctor. The policy resolves the dedicated strict home, supplies the fixed execution arguments and sanitized environment, and inspects the complete effective MCP inventory before model execution. Runtime and probe retain their own responsibilities while sharing the security policy.

**Tech Stack:** Node.js 22+, TypeScript 5.9, Vitest 4, Zod 4, Codex CLI 0.149-compatible command surface.

## Global Constraints

- `FDE_GYM_CODEX_HOME` is required for strict role execution and must be an absolute, existing, readable directory.
- FDEGym must not copy, print, migrate, or mutate provider credentials or the user's normal `CODEX_HOME`.
- The strict home may contain provider/auth configuration but must contain no enabled MCP server.
- Runtime and doctor must consume the same strict execution arguments and child-environment builder.
- Do not use `--ignore-user-config`; it removes the custom provider required by the current environment.
- Do not name, create, or override a specific MCP server such as `node_repl`.
- Do not add a registry, factory, feature flag, arbitrary extra-argument surface, TOML parser, or new runtime dependency.
- Raw stderr, model output, provider configuration, MCP configuration values, and canaries must never enter learner-visible errors or capability-report failures.
- `CodexAgentRuntimeConfig.timeoutMs` is a hard ceiling; the effective timeout is `Math.min(runtimeTimeoutMs, invocationTimeoutMs)`.
- The existing capability-report boolean shape remains unchanged.
- A failed live `doctor --require-safe` remains release-blocking even when all fake tests pass.

## File Structure

### Create

- `src/integrations/codex/codex-process.ts` — generic child-process execution and JSONL event extraction, moved out of the probe.
- `src/integrations/codex/strict-policy.ts` — strict-home validation, environment/argument construction, and MCP inventory inspection.
- `tests/contracts/strict-codex-policy.test.ts` — direct policy contracts.

### Modify

- `src/integrations/codex/capability-probe.ts` — consume shared process/policy modules and make every gate require successful execution.
- `src/integrations/codex/codex-runtime.ts` — perform per-invocation strict preflight, enforce timeout ceiling, classify nonzero exits.
- `src/security/sanitizer.ts` — export `AGENT_PROCESS_ERROR`.
- `tests/fixtures/fake-codex.mjs` — model probe and MCP inventory controls targeted by invocation kind.
- `tests/contracts/fake-codex-runtime.mjs` — runtime MCP preflight, argv/home capture, and nonzero-exit controls.
- `tests/contracts/codex-capability-probe.test.ts` — targeted fail-closed, stale-output, MCP, and concurrency regressions.
- `tests/contracts/codex-runtime.test.ts` — runtime preflight, process exit, shared args/home, and timeout regressions.
- `src/cli/render.ts` — learner-safe localization for `AGENT_PROCESS_ERROR` and stricter strict-mode guidance.
- `tests/e2e/codex-skill-smoke.test.ts` — localization assertions.
- `README.md` — strict-home prerequisite and command examples.
- `docs/architecture.md` — dedicated configuration boundary and per-invocation preflight.
- `docs/security-model.md` — strict-home guarantee and local-machine limitations.
- `docs/codex-capability-report.md` — new probe failure semantics/codes.

---

### Task 1: Extract the Generic Codex Process Runner

**Files:**
- Create: `src/integrations/codex/codex-process.ts`
- Modify: `src/integrations/codex/capability-probe.ts:1-272`
- Modify: `src/integrations/codex/codex-runtime.ts:18`
- Modify: `tests/contracts/codex-capability-probe.test.ts:7-15`

**Interfaces:**
- Produces:
  - `CodexEvent`
  - `CodexInvocationResult`
  - `CodexRunOptions`
  - `parseJsonlEvents(stdout: string): CodexEvent[]`
  - `extractThreadId(events: CodexEvent[]): string | null`
  - `extractAgentMessage(events: CodexEvent[]): string | null`
  - `codexInvocationCompleted(result: CodexInvocationResult): boolean`
  - `runCodex(executable: string, options: CodexRunOptions): Promise<CodexInvocationResult>`
- Consumed by: `capability-probe.ts`, `codex-runtime.ts`, and Task 2's strict policy.

- [ ] **Step 1: Point parsing tests at the new module before it exists**

Change the import in `tests/contracts/codex-capability-probe.test.ts` so parser/process helpers come from the focused module while `sanitizeChildEnv` and `probeCodexCapabilities` temporarily remain imported from the probe:

```ts
import {
  parseJsonlEvents,
  extractThreadId,
  extractAgentMessage,
} from "../../src/integrations/codex/codex-process";
import {
  sanitizeChildEnv,
  probeCodexCapabilities,
} from "../../src/integrations/codex/capability-probe";
```

- [ ] **Step 2: Run the parsing contract and verify RED**

Run:

```bash
npx vitest run tests/contracts/codex-capability-probe.test.ts
```

Expected: FAIL because `src/integrations/codex/codex-process.ts` does not exist.

- [ ] **Step 3: Create `codex-process.ts` by moving the existing process contract without changing behavior**

Move the existing process types, retained-event allowlist, JSONL parsers, and `runCodex` implementation from `capability-probe.ts`. Add the one pure completion predicate used by later tasks:

```ts
import { spawn } from "node:child_process";

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexInvocationResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
  events: CodexEvent[];
  threadId: string | null;
  agentMessage: string | null;
}

export interface CodexRunOptions {
  args: string[];
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const KEPT_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "item.started",
  "item.completed",
  "item.updated",
]);

export function codexInvocationCompleted(result: CodexInvocationResult): boolean {
  return result.spawnError === null && !result.timedOut && result.exitCode === 0;
}
```

Copy the complete existing implementations of `parseJsonlEvents`, `extractThreadId`, `extractAgentMessage`, and `runCodex` into this file. Preserve the rule that reasoning events, including nested `item.type === "reasoning"`, are never retained.

In `runCodex`, make timer cleanup safe for every spawn path:

```ts
let timer: ReturnType<typeof setTimeout> | undefined;
const finish = () => {
  if (settled) return;
  settled = true;
  if (timer !== undefined) clearTimeout(timer);
  result.events = parseJsonlEvents(result.stdout);
  result.threadId = extractThreadId(result.events);
  result.agentMessage = extractAgentMessage(result.events);
  resolve(result);
};
```

Assign `timer = setTimeout(...)` only after `spawn` returns.

- [ ] **Step 4: Update production imports and remove moved definitions from the probe**

In `capability-probe.ts`, import the moved helpers:

```ts
import {
  codexInvocationCompleted,
  extractAgentMessage,
  extractThreadId,
  parseJsonlEvents,
  runCodex,
  type CodexEvent,
  type CodexInvocationResult,
  type CodexRunOptions,
} from "./codex-process.js";
```

Re-export the legacy probe-level names so existing callers are not broken:

```ts
export {
  extractAgentMessage,
  extractThreadId,
  parseJsonlEvents,
  runCodex,
};
export type {
  CodexEvent,
  CodexInvocationResult,
  CodexRunOptions,
};
```

In `codex-runtime.ts`, replace the probe import with:

```ts
import { runCodex } from "./codex-process.js";
import { sanitizeChildEnv } from "./capability-probe.js";
```

Do not alter strict arguments yet; Task 2 owns that change.

- [ ] **Step 5: Run targeted contracts and typecheck**

Run:

```bash
npx vitest run tests/contracts/codex-capability-probe.test.ts tests/contracts/codex-runtime.test.ts
npm run typecheck
```

Expected: all targeted tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the process-boundary refactor**

```bash
git add src/integrations/codex/codex-process.ts src/integrations/codex/capability-probe.ts src/integrations/codex/codex-runtime.ts tests/contracts/codex-capability-probe.test.ts
git commit -m "refactor: isolate Codex process runner"
```

---

### Task 2: Add the Shared Strict Policy

**Files:**
- Create: `src/integrations/codex/strict-policy.ts`
- Create: `tests/contracts/strict-codex-policy.test.ts`
- Modify: `tests/fixtures/fake-codex.mjs`
- Modify: `tests/contracts/fake-codex-runtime.mjs`

**Interfaces:**
- Consumes: `runCodex` and `codexInvocationCompleted` from Task 1.
- Produces:
  - `STRICT_HOME_ENV`
  - `StrictPolicyFailure`
  - `StrictCodexPolicyError`
  - `resolveStrictCodexHome(env?: NodeJS.ProcessEnv): string`
  - `sanitizeChildEnv(source: NodeJS.ProcessEnv, extraAllow?: string[]): NodeJS.ProcessEnv`
  - `buildStrictChildEnv(source: NodeJS.ProcessEnv, strictHome: string, extraAllow?: string[]): NodeJS.ProcessEnv`
  - `buildStrictExecArgs(workdir: string, options?: StrictExecOptions): string[]`
  - `inspectStrictMcpInventory(options: StrictMcpInspectionOptions): Promise<StrictMcpInspection>`

- [ ] **Step 1: Add RED tests for home validation, fixed args, child env, and MCP inventory**

Create `tests/contracts/strict-codex-policy.test.ts` with temporary-directory cleanup and these contracts:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStrictChildEnv,
  buildStrictExecArgs,
  inspectStrictMcpInventory,
  resolveStrictCodexHome,
  StrictCodexPolicyError,
} from "../../src/integrations/codex/strict-policy";

const fakeCodex = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const roots: string[] = [];

function makeTemp(): string {
  const path = mkdtempSync(join(tmpdir(), "fde-strict-policy-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  delete process.env.FAKE_MCP_MODE;
  for (const path of roots) {
    chmodSync(path, 0o700);
    rmSync(path, { recursive: true, force: true });
  }
  roots.length = 0;
});

describe("strict Codex policy", () => {
  it("requires an explicit absolute readable strict home", () => {
    expect(() => resolveStrictCodexHome({})).toThrow(StrictCodexPolicyError);
    expect(() => resolveStrictCodexHome({ FDE_GYM_CODEX_HOME: "relative/home" })).toThrow(
      StrictCodexPolicyError,
    );
    const file = join(makeTemp(), "not-a-directory");
    writeFileSync(file, "x", "utf8");
    expect(() => resolveStrictCodexHome({ FDE_GYM_CODEX_HOME: file })).toThrow(
      StrictCodexPolicyError,
    );
    const unreadable = makeTemp();
    chmodSync(unreadable, 0o000);
    expect(() => resolveStrictCodexHome({ FDE_GYM_CODEX_HOME: unreadable })).toThrow(
      StrictCodexPolicyError,
    );
  });

  it("uses the dedicated home and drops unrelated parent secrets", () => {
    const home = makeTemp();
    const env = buildStrictChildEnv(
      { PATH: "/usr/bin", HOME: "/home/user", CODEX_HOME: "/normal", SECRET: "no" },
      home,
    );
    expect(env.CODEX_HOME).toBe(home);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SECRET).toBeUndefined();
  });

  it("builds one server-name-agnostic strict exec policy", () => {
    const args = buildStrictExecArgs("/tmp/role", { model: "model-x" });
    expect(args).toContain("--ignore-rules");
    expect(args).toEqual(expect.arrayContaining(["--disable", "shell_tool"]));
    expect(args).toEqual(expect.arrayContaining(["--disable", "unified_exec"]));
    expect(args).not.toContain("mcp_servers.node_repl.enabled=false");
    expect(args.at(-1)).toBe("-");
  });

  it("accepts an empty MCP inventory", async () => {
    const home = makeTemp();
    process.env.FAKE_MCP_MODE = "empty";
    const result = await inspectStrictMcpInventory({
      executable: fakeCodex,
      env: buildStrictChildEnv(process.env, home, ["FAKE_MCP_MODE"]),
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ safe: true });
  });

  it("rejects an enabled MCP without retaining its name", async () => {
    const home = makeTemp();
    process.env.FAKE_MCP_MODE = "enabled";
    const result = await inspectStrictMcpInventory({
      executable: fakeCodex,
      env: buildStrictChildEnv(process.env, home, ["FAKE_MCP_MODE"]),
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ safe: false, failure: "MCP_SERVERS_ENABLED" });
    expect(JSON.stringify(result)).not.toContain("fake-filesystem");
  });

  it.each(["invalid", "exit", "timeout"])("rejects an indeterminate MCP inventory: %s", async (mode) => {
    const home = makeTemp();
    process.env.FAKE_MCP_MODE = mode;
    const result = await inspectStrictMcpInventory({
      executable: fakeCodex,
      env: buildStrictChildEnv(process.env, home, ["FAKE_MCP_MODE"]),
      timeoutMs: mode === "timeout" ? 100 : 10_000,
    });
    expect(result).toEqual({ safe: false, failure: "MCP_INVENTORY_FAILED" });
  });
});
```

- [ ] **Step 2: Run policy tests and verify RED**

Run:

```bash
npx vitest run tests/contracts/strict-codex-policy.test.ts
```

Expected: FAIL because `strict-policy.ts` does not exist and the fake does not support MCP inventory modes.

- [ ] **Step 3: Teach both fake executables to answer `codex mcp list --json`**

At the beginning of each fake's execution path, detect the inventory command before incrementing model-attempt counters:

```js
function isMcpList() {
  return argv[0] === "mcp" && argv[1] === "list" && argv.includes("--json");
}

function respondMcpList() {
  const mode = process.env.FAKE_MCP_MODE ?? "empty";
  if (mode === "timeout") {
    setTimeout(() => {
      process.stdout.write("[]\n");
      process.exit(0);
    }, 60_000);
    return;
  }
  if (mode === "exit") {
    process.stderr.write("fake-codex: MCP inventory failed\n");
    process.exit(7);
  }
  if (mode === "invalid") {
    process.stdout.write("not-json\n");
    process.exit(0);
  }
  const inventory =
    mode === "enabled"
      ? [{ name: "fake-filesystem", enabled: true }]
      : mode === "disabled"
        ? [{ name: "fake-disabled", enabled: false }]
        : [];
  process.stdout.write(JSON.stringify(inventory) + "\n");
  process.exit(0);
}
```

Call `respondMcpList()` immediately when `isMcpList()` is true. Add `FAKE_MCP_MODE` to each test file's explicit child-environment allowlist where needed.

- [ ] **Step 4: Implement the strict policy**

Create the module with these exact public types:

```ts
import { accessSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { constants } from "node:fs";

import {
  codexInvocationCompleted,
  runCodex,
} from "./codex-process.js";

export const STRICT_HOME_ENV = "FDE_GYM_CODEX_HOME" as const;

export type StrictPolicyFailure =
  | "STRICT_HOME_REQUIRED"
  | "STRICT_HOME_INVALID"
  | "MCP_INVENTORY_FAILED"
  | "MCP_SERVERS_ENABLED";

export class StrictCodexPolicyError extends Error {
  readonly code = "CODEX_STRICT_MODE_UNSAFE" as const;
  readonly failure: StrictPolicyFailure;

  constructor(failure: StrictPolicyFailure) {
    super("Codex strict-mode policy is unsafe");
    this.name = "StrictCodexPolicyError";
    this.failure = failure;
  }
}

export interface StrictExecOptions {
  model?: string;
  extra?: readonly string[];
  disableTools?: boolean;
}

export type StrictMcpInspection =
  | { safe: true }
  | { safe: false; failure: "MCP_INVENTORY_FAILED" | "MCP_SERVERS_ENABLED" };

export interface StrictMcpInspectionOptions {
  executable: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
```

Implement `resolveStrictCodexHome` with `isAbsolute`, `statSync(path).isDirectory()`, and `accessSync(path, constants.R_OK)`. Convert every filesystem exception to `StrictCodexPolicyError("STRICT_HOME_INVALID")` without embedding the path.

Move `BASE_ENV_KEYS` and `sanitizeChildEnv` from `capability-probe.ts` into this module, preserving its allowlist behavior. Add:

```ts
export function buildStrictChildEnv(
  source: NodeJS.ProcessEnv,
  strictHome: string,
  extraAllow: string[] = [],
): NodeJS.ProcessEnv {
  const env = sanitizeChildEnv(source, extraAllow);
  env.CODEX_HOME = strictHome;
  return env;
}
```

Build model arguments from a single function:

```ts
export function buildStrictExecArgs(
  workdir: string,
  options: StrictExecOptions = {},
): string[] {
  const disableTools = options.disableTools !== false
    ? ["--disable", "shell_tool", "--disable", "unified_exec"]
    : [];
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--ignore-rules",
    "-C",
    workdir,
    ...disableTools,
    ...(options.extra ?? []),
    ...(options.model ? ["-m", options.model] : []),
    "-",
  ];
}
```

Implement inventory inspection. Parse only the top-level array and each entry's `enabled` boolean; do not retain names or config values:

```ts
export async function inspectStrictMcpInventory(
  options: StrictMcpInspectionOptions,
): Promise<StrictMcpInspection> {
  const run = await runCodex(options.executable, {
    args: ["mcp", "list", "--json"],
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (!codexInvocationCompleted(run)) {
    return { safe: false, failure: "MCP_INVENTORY_FAILED" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { safe: false, failure: "MCP_INVENTORY_FAILED" };
  }
  if (!Array.isArray(parsed)) {
    return { safe: false, failure: "MCP_INVENTORY_FAILED" };
  }
  const anyEnabled = parsed.some(
    (entry) =>
      entry === null ||
      typeof entry !== "object" ||
      (entry as { enabled?: unknown }).enabled !== false,
  );
  return anyEnabled
    ? { safe: false, failure: "MCP_SERVERS_ENABLED" }
    : { safe: true };
}
```

- [ ] **Step 5: Run policy contracts and typecheck**

Run:

```bash
npx vitest run tests/contracts/strict-codex-policy.test.ts
npm run typecheck
```

Expected: all policy tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit the shared policy**

```bash
git add src/integrations/codex/strict-policy.ts tests/contracts/strict-codex-policy.test.ts tests/fixtures/fake-codex.mjs tests/contracts/fake-codex-runtime.mjs
git commit -m "feat: add shared Codex strict policy"
```

---

### Task 3: Enforce Strict Policy and Process Errors in the Runtime

**Files:**
- Modify: `src/integrations/codex/codex-runtime.ts:1-272`
- Modify: `src/security/sanitizer.ts:19-24`
- Modify: `tests/contracts/codex-runtime.test.ts:105-274`
- Modify: `tests/contracts/fake-codex-runtime.mjs`

**Interfaces:**
- Consumes: every Task 2 policy function.
- Produces: terminal `AGENT_PROCESS_ERROR` and runtime enforcement of `CODEX_STRICT_MODE_UNSAFE`.

- [ ] **Step 1: Extend the runtime fake's observation and failure controls**

Add these environment keys to the fake and test allowlist:

```ts
const FAKE_KEYS = [
  "FAKE_RUNTIME_MODE",
  "FAKE_RUNTIME_CANARY",
  "FAKE_RUNTIME_COUNT_FILE",
  "FAKE_RUNTIME_SLEEP_MS",
  "FAKE_RUNTIME_PROMPT_FILE",
  "FAKE_RUNTIME_SCHEMA_FILE",
  "FAKE_RUNTIME_ARGS_FILE",
  "FAKE_RUNTIME_HOME_FILE",
  "FAKE_RUNTIME_EXIT_CODE",
  "FAKE_MCP_MODE",
];
```

In the fake, capture model argv and `CODEX_HOME` after the MCP-list early return:

```js
capture("FAKE_RUNTIME_ARGS_FILE", JSON.stringify(argv));
capture("FAKE_RUNTIME_HOME_FILE", process.env.CODEX_HOME ?? "");
```

Add a terminal process mode before writing output:

```js
if (mode === "exit") {
  process.stderr.write("fake-codex: role process failed\n");
  process.exit(Number(process.env.FAKE_RUNTIME_EXIT_CODE ?? 7));
}
```

- [ ] **Step 2: Add RED runtime contracts**

Update `makeRuntime` to create a dedicated strict home and set `process.env.FDE_GYM_CODEX_HOME` to it. Default `FAKE_MCP_MODE` to `empty` and allow it through the child environment.

Add these tests:

```ts
it("rejects an enabled MCP before spawning the role model", async () => {
  const { rt, countFile } = makeRuntime("valid");
  process.env.FAKE_MCP_MODE = "enabled";
  await expect(rt.invoke("customer", customerInput(), invokeOptions())).rejects.toMatchObject({
    code: "CODEX_STRICT_MODE_UNSAFE",
  });
  expect(readCount(countFile)).toBe(0);
});

it("uses the shared strict args and dedicated CODEX_HOME", async () => {
  const { rt, argsFile, homeFile, strictHome } = makeRuntime("valid");
  await rt.invoke("customer", customerInput(), invokeOptions());
  const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
  expect(args).toContain("--ignore-rules");
  expect(args).not.toContain("mcp_servers.node_repl.enabled=false");
  expect(readFileSync(homeFile, "utf8")).toBe(strictHome);
});

it("treats a nonzero Codex exit as a terminal process error", async () => {
  const { rt, countFile } = makeRuntime("exit");
  await expect(rt.invoke("customer", customerInput(), invokeOptions())).rejects.toMatchObject({
    code: "AGENT_PROCESS_ERROR",
  });
  expect(readCount(countFile)).toBe(1);
});

it("enforces the runtime timeout as a hard ceiling", async () => {
  const { rt } = makeRuntime("valid", { sleepMs: 60_000, timeoutMs: 300 });
  const started = Date.now();
  await expect(rt.invoke("customer", customerInput(), invokeOptions())).rejects.toMatchObject({
    code: AGENT_TIMEOUT,
  });
  expect(Date.now() - started).toBeLessThan(2_000);
}, 10_000);
```

Expand `makeRuntime`'s return type with `argsFile`, `homeFile`, and `strictHome` paths.

- [ ] **Step 3: Run runtime contracts and verify RED**

Run:

```bash
npx vitest run tests/contracts/codex-runtime.test.ts
```

Expected failures: no MCP preflight, missing shared args/home capture assertions, nonzero exit reported as malformed, and timeout exceeding the runtime ceiling.

- [ ] **Step 4: Integrate the strict policy before the first model attempt**

Replace the local `DISABLE_TOOLS` array and probe imports with:

```ts
import { runCodex } from "./codex-process.js";
import {
  buildStrictChildEnv,
  buildStrictExecArgs,
  inspectStrictMcpInventory,
  resolveStrictCodexHome,
} from "./strict-policy.js";
```

At the beginning of `invoke`, compute the strict execution context and preflight it:

```ts
const effectiveTimeoutMs = Math.min(this.timeoutMs, options.timeoutMs);
const strictHome = resolveStrictCodexHome(process.env);
const childEnv = buildStrictChildEnv(process.env, strictHome, this.envExtraAllow);
const inventory = await inspectStrictMcpInventory({
  executable: this.executable,
  env: childEnv,
  timeoutMs: effectiveTimeoutMs,
});
if (!inventory.safe) {
  throw new AgentRuntimeError(
    "CODEX_STRICT_MODE_UNSAFE",
    "Codex strict-mode policy is unsafe",
  );
}
```

Pass `childEnv` and `effectiveTimeoutMs` into both `runOnce` attempts. Build args with:

```ts
const args = buildStrictExecArgs(workdir, {
  model: this.model,
  extra: ["--output-schema", schemaFile, "-o", outFile],
});
```

Pass `env: childEnv` and `timeoutMs: effectiveTimeoutMs` to `runCodex`.

- [ ] **Step 5: Add terminal nonzero-exit classification**

Export the new code from `sanitizer.ts`:

```ts
export const AGENT_PROCESS_ERROR = "AGENT_PROCESS_ERROR" as const;
```

Import it in the runtime. Immediately after timeout/spawn checks, before output parsing, add:

```ts
if (run.exitCode !== 0) {
  return {
    outcome: "terminal",
    error: new AgentRuntimeError(
      AGENT_PROCESS_ERROR,
      `${role} invocation failed`,
    ),
  };
}
```

Do not include the numeric exit code or stderr in the error.

- [ ] **Step 6: Run runtime and policy contracts**

Run:

```bash
npx vitest run tests/contracts/strict-codex-policy.test.ts tests/contracts/codex-runtime.test.ts
npm run typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 7: Commit runtime enforcement**

```bash
git add src/integrations/codex/codex-runtime.ts src/security/sanitizer.ts tests/contracts/codex-runtime.test.ts tests/contracts/fake-codex-runtime.mjs
git commit -m "fix: enforce Codex strict runtime policy"
```

---

### Task 4: Make the Capability Probe Fail Closed

**Files:**
- Modify: `src/integrations/codex/capability-probe.ts:1-614`
- Modify: `tests/contracts/codex-capability-probe.test.ts:22-331`
- Modify: `tests/fixtures/fake-codex.mjs`

**Interfaces:**
- Consumes: `codexInvocationCompleted`, `buildStrictChildEnv`, `buildStrictExecArgs`, `inspectStrictMcpInventory`, `resolveStrictCodexHome`, and `sanitizeChildEnv`.
- Preserves: existing `CodexCapabilityReport` fields exactly.
- Adds stable report failure codes: `STRICT_HOME_REQUIRED`, `STRICT_HOME_INVALID`, `MCP_INVENTORY_FAILED`, `MCP_SERVERS_ENABLED`, `ROLE_INVOCATION_FAILED`, `ENVIRONMENT_PROBE_FAILED`, `STRUCTURED_OUTPUT_INVOCATION_FAILED`, `TOOL_ISOLATION_PROBE_FAILED`.

- [ ] **Step 1: Add targeted failure controls to the probe fake**

Identify the invocation kind without retaining prompt content:

```js
function invocationKind() {
  const prompt = stdin.toLowerCase();
  if (argv.includes("--output-schema")) return "structured";
  if (prompt.includes("environment variable")) return "environment";
  if (prompt.includes("scenario file")) return "tools";
  return "role";
}
```

Before normal response, apply targeted controls:

```js
const kind = invocationKind();
if (process.env.FAKE_FAIL_ON === kind) {
  const mode = process.env.FAKE_FAIL_MODE ?? "exit";
  if (mode === "timeout") {
    setTimeout(respond, 60_000);
    return;
  }
  process.stderr.write("fake-codex: targeted probe failure\n");
  process.exit(7);
}
```

Add `FAKE_FAIL_ON`, `FAKE_FAIL_MODE`, and `FAKE_MCP_MODE` to the probe test's allowed/cleaned environment keys.

- [ ] **Step 2: Add RED probe regressions**

In `beforeEach`, create an explicit temporary strict home and assign `process.env.FDE_GYM_CODEX_HOME`. Preserve any original `FDE_PARENT_CANARY` value within each concurrency test rather than globally deleting an unrelated user value.

Add:

```ts
it("fails parent isolation when only the environment probe exits nonzero", async () => {
  process.env.FAKE_FAIL_ON = "environment";
  process.env.FAKE_FAIL_MODE = "exit";
  const report = await probeCodexCapabilities({
    executable: fakeCodex,
    workRoot: makeTemp(),
    sessionsDir: join(makeTemp(), "sessions"),
    timeoutMs: 10_000,
    envExtraAllow: ["FAKE_FAIL_ON", "FAKE_FAIL_MODE", "FAKE_MCP_MODE"],
  });
  expect(report.parentCanaryIsolated).toBe(false);
  expect(report.failures).toContain("ENVIRONMENT_PROBE_FAILED");
  expect(report.safeForStrictMode).toBe(false);
});

it("fails tool isolation when only the tool probe exits nonzero", async () => {
  process.env.FAKE_FAIL_ON = "tools";
  process.env.FAKE_FAIL_MODE = "exit";
  const report = await probeCodexCapabilities({
    executable: fakeCodex,
    workRoot: makeTemp(),
    sessionsDir: join(makeTemp(), "sessions"),
    timeoutMs: 10_000,
    envExtraAllow: ["FAKE_FAIL_ON", "FAKE_FAIL_MODE", "FAKE_MCP_MODE"],
  });
  expect(report.toolsDisabled).toBe(false);
  expect(report.failures).toContain("TOOL_ISOLATION_PROBE_FAILED");
  expect(report.safeForStrictMode).toBe(false);
});

it("does not validate stale structured output after this invocation fails", async () => {
  const workRoot = makeTemp();
  writeFileSync(join(workRoot, "structured-out.txt"), JSON.stringify({ result: "stale" }), "utf8");
  process.env.FAKE_FAIL_ON = "structured";
  process.env.FAKE_FAIL_MODE = "exit";
  const report = await probeCodexCapabilities({
    executable: fakeCodex,
    workRoot,
    sessionsDir: join(makeTemp(), "sessions"),
    timeoutMs: 10_000,
    cleanup: false,
    envExtraAllow: ["FAKE_FAIL_ON", "FAKE_FAIL_MODE", "FAKE_MCP_MODE"],
  });
  expect(report.structuredOutput).toBe(false);
  expect(report.failures).toContain("STRUCTURED_OUTPUT_INVOCATION_FAILED");
  expect(report.safeForStrictMode).toBe(false);
});

it("does not mutate the process-wide parent canary across concurrent probes", async () => {
  process.env.FDE_PARENT_CANARY = "ORIGINAL_PARENT_VALUE";
  await Promise.all([
    probeCodexCapabilities({ executable: fakeCodex, workRoot: makeTemp(), sessionsDir: join(makeTemp(), "a"), timeoutMs: 10_000 }),
    probeCodexCapabilities({ executable: fakeCodex, workRoot: makeTemp(), sessionsDir: join(makeTemp(), "b"), timeoutMs: 10_000 }),
  ]);
  expect(process.env.FDE_PARENT_CANARY).toBe("ORIGINAL_PARENT_VALUE");
});

it("rejects an enabled MCP before model capability probes", async () => {
  process.env.FAKE_MCP_MODE = "enabled";
  const report = await probeCodexCapabilities({
    executable: fakeCodex,
    workRoot: makeTemp(),
    sessionsDir: join(makeTemp(), "sessions"),
    timeoutMs: 10_000,
    envExtraAllow: ["FAKE_MCP_MODE"],
  });
  expect(report.failures).toContain("MCP_SERVERS_ENABLED");
  expect(report.safeForStrictMode).toBe(false);
});
```

- [ ] **Step 3: Run probe contracts and verify RED**

Run:

```bash
npx vitest run tests/contracts/codex-capability-probe.test.ts
```

Expected: targeted invocation failures still leave unsafe booleans true, stale output passes, concurrency mutates the global canary, and MCP inventory is not checked.

- [ ] **Step 4: Replace duplicated probe policy with shared policy**

Import:

```ts
import {
  buildStrictChildEnv,
  buildStrictExecArgs,
  inspectStrictMcpInventory,
  resolveStrictCodexHome,
  sanitizeChildEnv,
  StrictCodexPolicyError,
} from "./strict-policy.js";
import {
  codexInvocationCompleted,
  runCodex,
  type CodexInvocationResult,
} from "./codex-process.js";
```

Re-export `sanitizeChildEnv` from the probe for compatibility. Remove `BASE_ENV_KEYS`, the local sanitizer implementation, and the duplicated `DISABLE_TOOLS`/`baseArgs` construction.

Resolve the strict home inside the probe. If resolution throws `StrictCodexPolicyError`, push its `failure` code and return a report whose safety gates are false and `safeForStrictMode` is false. Never include the path in failures.

Build the local canary source without touching `process.env`:

```ts
const probeSourceEnv: NodeJS.ProcessEnv = {
  ...process.env,
  FDE_PARENT_CANARY: parentCanary,
};
const buildEnv = () => buildStrictChildEnv(probeSourceEnv, strictHome, envExtraAllow);
```

After the version check, call `inspectStrictMcpInventory`. If unsafe, push its stable failure and skip model probes.

Build model arguments exclusively through:

```ts
buildStrictExecArgs(roleDir, {
  model: config.model,
  disableTools: opts.tools !== false,
  extra: opts.extra,
});
```

- [ ] **Step 5: Require successful execution for every probe gate**

Track completion explicitly:

```ts
let roleInvocationsCompleted = true;
let environmentProbeCompleted = false;
let structuredProbeCompleted = false;
let toolProbeCompleted = false;
```

For each of the three role calls:

```ts
const completed = codexInvocationCompleted(run);
roleInvocationsCompleted &&= completed;
if (!completed) pushFailure("ROLE_INVOCATION_FAILED");
if (completed && run.threadId) threadIds.push(run.threadId);
else if (completed) pushFailure("NO_THREAD_ID");
```

Set:

```ts
distinctRoleSessions =
  roleInvocationsCompleted &&
  threadIds.length === 3 &&
  new Set(threadIds).size === 3;
freshContext = roleInvocationsCompleted && threadIds.length === 3 && !sessionPersisted;
```

For the environment invocation, set `environmentProbeCompleted = codexInvocationCompleted(run)` and push `ENVIRONMENT_PROBE_FAILED` when false.

Before the structured invocation:

```ts
rmSync(outFile, { force: true });
```

Only call `isValidSchemaOutput` when `structuredProbeCompleted` is true. Push `STRUCTURED_OUTPUT_INVOCATION_FAILED` on process failure and `STRUCTURED_OUTPUT_INVALID` only for a completed but invalid response.

For tool isolation:

```ts
toolProbeCompleted = codexInvocationCompleted(run);
toolsDisabled = toolProbeCompleted && !(run.stdout + run.stderr).includes(scenarioCanary);
```

Compute report fields and final safety as:

```ts
const parentCanaryIsolated = environmentProbeCompleted && !parentLeaked;
const childCanaryContained = roleInvocationsCompleted && !roleLeaked;
const safeForStrictMode =
  mcpInventory.safe &&
  localCommandExecution &&
  freshContext &&
  distinctRoleSessions &&
  structuredOutput &&
  toolsDisabled &&
  parentCanaryIsolated &&
  childCanaryContained &&
  !anyTimedOut &&
  failures.length === 0;
```

Return those derived booleans rather than `!parentLeaked`/`!roleLeaked` alone.

- [ ] **Step 6: Run all Codex contract tests and typecheck**

Run:

```bash
npx vitest run tests/contracts/strict-codex-policy.test.ts tests/contracts/codex-capability-probe.test.ts tests/contracts/codex-runtime.test.ts
npm run typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 7: Commit probe hardening**

```bash
git add src/integrations/codex/capability-probe.ts tests/contracts/codex-capability-probe.test.ts tests/fixtures/fake-codex.mjs
git commit -m "fix: make Codex capability probe fail closed"
```

---

### Task 5: Update Learner-Safe Errors and Security Documentation

**Files:**
- Modify: `src/cli/render.ts:278-399`
- Modify: `tests/e2e/codex-skill-smoke.test.ts:190-210`
- Modify: `README.md:14-55,122-152`
- Modify: `docs/architecture.md:19-23,76-94,126-129`
- Modify: `docs/security-model.md`
- Modify: `docs/codex-capability-report.md`

**Interfaces:**
- Consumes: `AGENT_PROCESS_ERROR`, `CODEX_STRICT_MODE_UNSAFE`, and the stable doctor failure codes from Tasks 3–4.
- Produces: bilingual recovery guidance and the operator setup contract.

- [ ] **Step 1: Add RED localization assertions**

In `tests/e2e/codex-skill-smoke.test.ts`, add:

```ts
expect(localize("AGENT_PROCESS_ERROR", "zh-CN").message).not.toBe(
  localize("AGENT_PROCESS_ERROR", "en-US").message,
);
expect(localize("CODEX_STRICT_MODE_UNSAFE", "en-US").nextActions.join(" ")).toContain(
  "FDE_GYM_CODEX_HOME",
);
```

- [ ] **Step 2: Run the focused e2e test and verify RED**

Run:

```bash
npx vitest run tests/e2e/codex-skill-smoke.test.ts
```

Expected: `AGENT_PROCESS_ERROR` falls back to the generic message and strict-mode guidance does not mention the required home.

- [ ] **Step 3: Add bilingual learner-safe errors**

Insert this row after `AGENT_SPAWN_ERROR`:

```ts
{
  code: "AGENT_PROCESS_ERROR",
  "zh-CN": {
    message: "角色运行进程失败。",
    nextActions: ["运行 `fde-gym doctor` 检查 Codex 严格模式配置。"],
  },
  "en-US": {
    message: "The role runtime process failed.",
    nextActions: ["Run `fde-gym doctor` to check the Codex strict-mode configuration."],
  },
},
```

Change `CODEX_STRICT_MODE_UNSAFE` next actions to mention setting an absolute `FDE_GYM_CODEX_HOME`, running diagnostic doctor, and removing all enabled MCP servers from that dedicated home. Do not mention a discovered server name.

- [ ] **Step 4: Document strict-home setup and operational semantics**

Update `README.md` with a prerequisite block containing exact commands:

```bash
export FDE_GYM_CODEX_HOME="$HOME/.codex-fde-gym"
mkdir -p "$FDE_GYM_CODEX_HOME"
CODEX_HOME="$FDE_GYM_CODEX_HOME" codex login
CODEX_HOME="$FDE_GYM_CODEX_HOME" codex mcp list --json
fde-gym doctor --require-safe
```

State that custom-provider users must place only the minimum provider/auth configuration in this home themselves; FDEGym never copies credentials. State that every enabled MCP entry makes strict mode unsafe.

Update architecture/security docs to describe:

- normal Codex home versus dedicated strict home;
- per-invocation MCP inventory preflight;
- shared runtime/probe execution arguments;
- `--ignore-rules` and disabled shell/unified features;
- the remaining local-machine limitation: a learner can still read local files outside the model role boundary.

Update `docs/codex-capability-report.md` with stable failures and the rule that a gate invocation must complete successfully before an absence of canary data is meaningful.

- [ ] **Step 5: Run focused tests and documentation searches**

Run:

```bash
npx vitest run tests/e2e/codex-skill-smoke.test.ts
rg -n "FDE_GYM_CODEX_HOME|AGENT_PROCESS_ERROR|MCP_SERVERS_ENABLED|MCP_INVENTORY_FAILED" README.md docs src/cli/render.ts
```

Expected: test PASS; every new contract appears in the intended docs/error table.

- [ ] **Step 6: Commit errors and documentation**

```bash
git add src/cli/render.ts tests/e2e/codex-skill-smoke.test.ts README.md docs/architecture.md docs/security-model.md docs/codex-capability-report.md
git commit -m "docs: define Codex strict-home contract"
```

---

### Task 6: Full Regression and Live Strict-Mode Verification

**Files:**
- Verify only; modify production files only if a failing test identifies a defect within this plan's scope.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence that fake contracts, TypeScript build, full suite, and live doctor behavior match the design.

- [ ] **Step 1: Verify no server-name point override remains**

Run:

```bash
rg -n "mcp_servers\.node_repl|const DISABLE_TOOLS" src tests README.md docs
```

Expected: no production strict-policy hit for `mcp_servers.node_repl`; no duplicated `DISABLE_TOOLS` array. Historical explanation in the approved design spec is allowed.

- [ ] **Step 2: Run the complete static and automated verification chain**

Run:

```bash
npm run typecheck
npm run build
npm test
```

Expected: each command exits 0; Vitest reports zero failed tests.

- [ ] **Step 3: Verify unsafe live configuration fails closed without exposing MCP names**

Point the strict variable at the current normal Codex home, which presently contains an enabled MCP, and run the diagnostic only:

```bash
FDE_GYM_CODEX_HOME="$HOME/.codex" node dist/cli/main.js doctor --json
```

Expected: command exits 0 because diagnostic doctor remains inspectable; report has `safeForStrictMode:false`, includes `MCP_SERVERS_ENABLED`, and contains no configured MCP server name or provider value.

Then run:

```bash
FDE_GYM_CODEX_HOME="$HOME/.codex" node dist/cli/main.js doctor --json --require-safe
```

Expected: exits nonzero with learner-safe code `CODEX_STRICT_MODE_UNSAFE` and no report payload.

- [ ] **Step 4: Run live strict doctor against the user-provisioned dedicated home when available**

Run:

```bash
test -n "${FDE_GYM_CODEX_HOME:-}" && node dist/cli/main.js doctor --json --require-safe
```

Expected when the home is correctly provisioned and the external Codex/provider is healthy: exit 0 with `safeForStrictMode:true`.

If no dedicated home has been provisioned, do not substitute the normal home and do not claim release readiness. Record this exact limitation in the completion report:

```text
Live safe-path doctor not run: no user-provisioned FDE_GYM_CODEX_HOME was available.
```

If the live provider times out or fails, report the exact stable failure codes but never raw output or credentials; release remains blocked.

- [ ] **Step 5: Inspect the final diff for accidental credential or config retention**

Run:

```bash
git diff main...HEAD -- src tests README.md docs
rg -n "experimental_bearer_token|base_url|FAKE_CANARY|PARENT_SECRET|ROLE_SECRET|SCENARIO_SECRET" src README.md docs
```

Expected: no real provider/token value; only explicit test fixtures use fake canary literals; production errors contain no payload.

- [ ] **Step 6: Commit any verification-only corrections, otherwise leave the branch unchanged**

If verification required an in-scope correction, stage only those corrected files and commit:

```bash
git add src tests README.md docs
git commit -m "fix: complete Codex strict-mode verification"
```

If no correction was needed, do not create an empty commit.
