# Remove the Codex role-runtime fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the role layer direct-only — remove the `CodexAgentRuntime` fallback and all its strict-mode machinery, failing closed with a stable `MODEL_ENDPOINT_REQUIRED` error when no model endpoint is configured.

**Architecture:** Roles keep running through the `AgentRuntime` seam, but only `DirectModelRuntime` remains. When `resolveDirectModelConfig()` returns `null`, the CLI constructs an `UnconfiguredModelRuntime` whose `invoke()` throws; read-only commands never call `invoke()` and stay usable.

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod. No new dependencies.

## Global Constraints

- Node.js ≥ 22 (`engines.node` is `>=22` in `package.json`).
- Every source import uses the `.js` extension (NodeNext ESM); every test import is extensionless.
- Error codes are stable strings surfaced via `AgentRuntimeError.code` → `errorCodeOf` → `localize`; every new code needs a `zh-CN` + `en-US` entry in `ERROR_TABLE` (`src/cli/render.ts`).
- Do NOT touch `docs/mvp-acceptance.md` (v1 freeze baseline) or the dated `docs/superpowers/{specs,plans}/2026-08-*` artifacts.
- Do NOT remove `install-skill.ts`, the Skill package, `context-firewall.ts`, or `sanitizer.ts`.
- Verify with `npm run typecheck` and `npm test` after every task; commit at the end of each task.

---

### Task 1: Add the direct-only failure path (additive)

**Files:**
- Modify: `src/agents/agent-runtime.ts` (add `MODEL_ENDPOINT_REQUIRED`)
- Create: `src/agents/unconfigured-runtime.ts`
- Create: `tests/contracts/unconfigured-runtime.test.ts`
- Modify: `src/cli/render.ts` (add localization entry)

**Interfaces:**
- Consumes: `AgentRuntime`, `AgentRuntimeError`, `AgentInvokeOptions`, `AgentInvocationResult` from `src/agents/agent-runtime.js`; `AgentRole` from `src/core/domain.js`.
- Produces: `UnconfiguredModelRuntime` (implements `AgentRuntime`) and `MODEL_ENDPOINT_REQUIRED` (stable string code), both used by Task 2.

- [ ] **Step 1: Add the `MODEL_ENDPOINT_REQUIRED` constant**

In `src/agents/agent-runtime.ts`, replace the `AgentRuntimeError` doc comment + class (lines 47–60) with:

```ts
/** A role invocation was attempted with no discoverable model endpoint. */
export const MODEL_ENDPOINT_REQUIRED = "MODEL_ENDPOINT_REQUIRED" as const;

/**
 * Stable runtime error shared by every `AgentRuntime` implementation
 * (`DirectModelRuntime`, `FixtureAgentRuntime`, `UnconfiguredModelRuntime`).
 * Carries a machine-readable `code` and never embeds payload, prompt, or
 * canary text.
 */
export class AgentRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
  }
}
```

- [ ] **Step 2: Create `src/agents/unconfigured-runtime.ts`**

```ts
import type { AgentRole } from "../core/domain.js";
import {
  AgentRuntimeError,
  MODEL_ENDPOINT_REQUIRED,
  type AgentInvocationResult,
  type AgentInvokeOptions,
  type AgentRuntime,
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
```

- [ ] **Step 3: Write the failing test** — `tests/contracts/unconfigured-runtime.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { AgentRuntimeError } from "../../src/agents/agent-runtime";
import { CustomerOutputSchema } from "../../src/agents/contracts";
import { UnconfiguredModelRuntime } from "../../src/agents/unconfigured-runtime";

describe("UnconfiguredModelRuntime", () => {
  it("fails closed with MODEL_ENDPOINT_REQUIRED on the first invoke", async () => {
    const runtime = new UnconfiguredModelRuntime();
    const error = await runtime
      .invoke(
        "customer",
        { locale: "zh-CN", question: "q", stakeholderId: "s1" },
        {
          runId: "r1",
          invocationId: "inv-1",
          freshContext: true,
          tools: "disabled",
          prompt: "ignored",
          canaries: [],
          outputSchema: CustomerOutputSchema,
          timeoutMs: 1000,
        },
      )
      .catch((e) => e);

    expect(error).toBeInstanceOf(AgentRuntimeError);
    expect(error.code).toBe("MODEL_ENDPOINT_REQUIRED");
    expect(String(error.message)).not.toContain("ignored");
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contracts/unconfigured-runtime.test.ts`
Expected: PASS (3 assertions). If `MODEL_ENDPOINT_REQUIRED` is undefined it would already fail — it is defined in Step 1.

- [ ] **Step 5: Add the localization entry**

In `src/cli/render.ts`, insert immediately BEFORE the `CODEX_STRICT_MODE_UNSAFE` entry (the object starting at line 400):

```ts
  {
    code: "MODEL_ENDPOINT_REQUIRED",
    "zh-CN": {
      message: "未配置模型端点。",
      nextActions: [
        "设置 FDE_GYM_MODEL_BASE_URL 与 FDE_GYM_MODEL（或在 ~/.codex/config.toml 中配置 model + base_url）。",
      ],
    },
    "en-US": {
      message: "No model endpoint is configured.",
      nextActions: [
        "Set FDE_GYM_MODEL_BASE_URL and FDE_GYM_MODEL (or configure model + base_url in ~/.codex/config.toml).",
      ],
    },
  },
```

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: both pass.

```bash
git add src/agents/agent-runtime.ts src/agents/unconfigured-runtime.ts tests/contracts/unconfigured-runtime.test.ts src/cli/render.ts
git commit -m "feat: add direct-only failure path (MODEL_ENDPOINT_REQUIRED)"
```

---

### Task 2: Remove the Codex role runtime, doctor, and strict-mode machinery

**Files:**
- Delete: `src/integrations/codex/codex-runtime.ts`, `src/integrations/codex/codex-process.ts`, `src/integrations/codex/strict-policy.ts`, `src/integrations/codex/capability-probe.ts`
- Delete: `tests/contracts/codex-runtime.test.ts`, `tests/contracts/codex-capability-probe.test.ts`, `tests/contracts/strict-codex-policy.test.ts`, `tests/contracts/fake-codex-runtime.mjs`, `tests/fixtures/fake-codex.mjs`
- Modify: `src/cli/main.ts`, `src/cli/commands.ts`, `src/security/sanitizer.ts`, `src/cli/render.ts`, `src/security/context-firewall.ts`, `src/agents/agent-runtime.ts`, `src/integrations/direct/direct-runtime.ts`, `src/integrations/direct/config.ts`, `tests/adversarial/leak-guard.test.ts`, `tests/e2e/codex-skill-smoke.test.ts`

**Interfaces:**
- Consumes: `UnconfiguredModelRuntime` and `MODEL_ENDPOINT_REQUIRED` (Task 1).
- Produces: a `main.ts` with no `doctor` command and a direct-only `resolveDefaultRuntime()`; a `commands.ts` with no `doctorCommand`; a `sanitizer.ts` without `AGENT_PROCESS_ERROR`.

- [ ] **Step 1: Delete the Codex role-runtime source and test files**

```bash
git rm src/integrations/codex/codex-runtime.ts \
       src/integrations/codex/codex-process.ts \
       src/integrations/codex/strict-policy.ts \
       src/integrations/codex/capability-probe.ts \
       tests/contracts/codex-runtime.test.ts \
       tests/contracts/codex-capability-probe.test.ts \
       tests/contracts/strict-codex-policy.test.ts \
       tests/contracts/fake-codex-runtime.mjs \
       tests/fixtures/fake-codex.mjs
```

- [ ] **Step 2: Rewire `src/cli/main.ts`**

Remove the `CodexAgentRuntime` import (line 7) and add the `UnconfiguredModelRuntime` import in its place, next to the `DirectModelRuntime` import:

```ts
import { DirectModelRuntime } from "../integrations/direct/direct-runtime.js";
import { resolveDirectModelConfig } from "../integrations/direct/config.js";
import { UnconfiguredModelRuntime } from "../agents/unconfigured-runtime.js";
```

Remove `"doctor",` from `COMMAND_NAMES` (line 50). Remove `doctorCommand,` from the command import list (line 16).

Delete the entire `resolveDefaultCodex()` function (lines 73–79) and replace `resolveDefaultRuntime()` (lines 81–91) with:

```ts
/**
 * Resolve the single role runtime. Roles run only through the direct
 * chat-completions runtime (the "model-as-a-function" path, ADR-0001); when no
 * model endpoint is discoverable, an `UnconfiguredModelRuntime` fails closed
 * with `MODEL_ENDPOINT_REQUIRED` on the first role invocation, so read-only
 * commands still work without an endpoint.
 */
function resolveDefaultRuntime(): AgentRuntime {
  const direct = resolveDirectModelConfig();
  if (direct) return new DirectModelRuntime(direct);
  return new UnconfiguredModelRuntime();
}
```

Remove `"codex-bin": { type: "string" },` and `"require-safe": { type: "boolean" },` from the `parseArgs` options. Delete the entire `case "doctor": { ... }` block (lines 194–201).

- [ ] **Step 3: Remove the doctor command from `src/cli/commands.ts`**

Delete the `CodexCapabilityReport` type import (line 6) and the `probeCodexCapabilities` import (lines 7–9). Delete the `DoctorData` interface (lines 176–178). Delete the `DoctorArgs` interface, `doctorCommand`, and `defaultCodexExecutable` (lines 893–913).

- [ ] **Step 4: Remove the dead `AGENT_PROCESS_ERROR` constant**

In `src/security/sanitizer.ts`, replace:

```ts
export const AGENT_SPAWN_ERROR = "AGENT_SPAWN_ERROR" as const;
export const AGENT_PROCESS_ERROR = "AGENT_PROCESS_ERROR" as const;
export const AGENT_INPUT_INVALID = "AGENT_INPUT_INVALID" as const;
```

with:

```ts
export const AGENT_SPAWN_ERROR = "AGENT_SPAWN_ERROR" as const;
export const AGENT_INPUT_INVALID = "AGENT_INPUT_INVALID" as const;
```

- [ ] **Step 5: Clean up `src/cli/render.ts` error table**

Delete the `AGENT_PROCESS_ERROR` entry (the object at lines 300–310) and the `CODEX_STRICT_MODE_UNSAFE` entry (lines 400–417). Update the `AGENT_SPAWN_ERROR` `nextActions`:

```ts
  {
    code: "AGENT_SPAWN_ERROR",
    "zh-CN": {
      message: "无法启动角色运行时。",
      nextActions: ["检查模型端点配置后重试。"],
    },
    "en-US": {
      message: "Could not start the role runtime.",
      nextActions: ["Check the model endpoint configuration and retry."],
    },
  },
```

- [ ] **Step 6: Update stale comments**

- `src/security/context-firewall.ts:191` — replace `used by \`CodexAgentRuntime\` to fail closed on` with `used by the role runtime to fail closed on`.
- `src/agents/agent-runtime.ts:34-37` — replace the interface doc sentence `Implementations are \`FixtureAgentRuntime\` (deterministic tests) and \`CodexAgentRuntime\` (real runs) in Task 6; the orchestrator depends only on this interface.` with `Implementations are \`FixtureAgentRuntime\` (deterministic tests), \`DirectModelRuntime\` (real runs), and \`UnconfiguredModelRuntime\` (fail-closed when no endpoint); the orchestrator depends only on this interface.`
- `src/integrations/direct/direct-runtime.ts:38-40` — replace the sentence `Single-shot: no repair/retry loop. The callers re-drive through the same stable error codes (\`AGENT_TIMEOUT\`, \`AGENT_OUTPUT_MALFORMED\`, …) as \`CodexAgentRuntime\`.` with `Single-shot: no repair/retry loop. The callers re-drive through the same stable error codes (\`AGENT_TIMEOUT\`, \`AGENT_OUTPUT_MALFORMED\`, …).`; and at line 110 replace `// Fail closed on the INPUT side, exactly like CodexAgentRuntime: a role must` with `// Fail closed on the INPUT side: a role must`.
- `src/integrations/direct/config.ts:12-13` — replace `Returns \`null\` when neither yields a usable endpoint — the caller then falls back to \`CodexAgentRuntime\`.` with `Returns \`null\` when neither yields a usable endpoint — the caller then fails closed with \`MODEL_ENDPOINT_REQUIRED\`.`.

- [ ] **Step 7: Trim `tests/adversarial/leak-guard.test.ts`**

Remove the `buildRoleInput`/`RunAggregate` import (line 14) and the `CodexAgentRuntime` import (line 15). Change `import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";` (line 2) to `import { mkdtempSync, rmSync, readFileSync } from "node:fs";` and delete `import { fileURLToPath } from "node:url";` (line 5). Delete the `fakeCodexRuntime` const (line 20) and the entire `describe("leak guard — CodexAgentRuntime stdout/stderr scan", () => { ... });` block (lines 185–301).

- [ ] **Step 8: Trim `tests/e2e/codex-skill-smoke.test.ts`**

Delete the `fakeCodex` const (line 32). In the `localizes failure messages` test, change `localize("AGENT_PROCESS_ERROR", ...)` (lines 205–207) to use `AGENT_SPAWN_ERROR`, and delete the `CODEX_STRICT_MODE_UNSAFE` assertion (lines 208–210). Delete the entire `it.skipIf(!hasDist)("real CLI: doctor --require-safe gates the release exit code (built binary)", ...)` block (lines 253–294).

- [ ] **Step 9: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: both pass (the two trimmed test files and all remaining suites).

```bash
git add -A
git commit -m "refactor: remove Codex role runtime and strict-mode machinery"
```

---

### Task 3: Remove doctor scripts, the release-gate step, and the capability-report doc

**Files:**
- Modify: `package.json`, `scripts/release-gate.mjs`
- Delete: `docs/codex-capability-report.md`

- [ ] **Step 1: Remove the doctor npm scripts**

In `package.json`, delete the two lines:

```json
    "doctor": "npm run build && node dist/cli/main.js doctor --json",
    "doctor:strict": "npm run build && node dist/cli/main.js doctor --json --require-safe",
```

- [ ] **Step 2: Remove the release-gate step**

In `scripts/release-gate.mjs`, delete the `{ label: "npm run doctor:strict", args: ["run", "doctor:strict"] },` entry from the `STEPS` array.

- [ ] **Step 3: Delete the capability-report doc**

```bash
git rm docs/codex-capability-report.md
```

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: both pass.

```bash
git add -A
git commit -m "chore: retire the doctor release gate"
```

---

### Task 4: Update the living docs

**Files:**
- Modify: `docs/architecture.md`, `docs/security-model.md`, `README.md`, `docs/architecture-decisions.md`, `skills/fde-gym/SKILL.md`, `skills/fde-gym/references/commands.md`, `skills/fde-gym/references/security-boundaries.md`, `tests/contracts/skill-package.test.ts`, `scripts/release-gate.mjs`

- [ ] **Step 1: `docs/architecture.md`**

Replace the two-implementation paragraph (lines 19–25) with:

```md
Each role runs through the same `AgentRuntime` interface
(`invoke(role, input, { freshContext, tools: "disabled", outputSchema })`). A
single implementation exists: `DirectModelRuntime` — one structured
chat-completions call with **no tools, no MCP, and no session**. When no model
endpoint is discoverable, the CLI resolves an `UnconfiguredModelRuntime` that
fails closed with `MODEL_ENDPOINT_REQUIRED` on the first role invocation
(read-only commands are unaffected). See `docs/architecture-decisions.md`
(ADR-0001).
```

Replace the `src/integrations/codex/codex-runtime.ts` sentence (lines 93–96) with:

```md
`src/integrations/direct/direct-runtime.ts` re-validates the role input against
`roleInputSchema(role)` before calling the model, and re-validates raw output
against the role's strict output schema after stripping prohibited keys and
scanning for canaries (see `docs/security-model.md`).
```

Delete the entire `## The dedicated strict home + per-invocation preflight (Codex fallback)` section (lines 98–118).

Replace the release-status sentence (lines 151–154) with:

```md
"**MVP v1 frozen**" means the specification and acceptance baseline are frozen,
**not** that the product is release-ready (see `docs/mvp-acceptance.md`).
```

- [ ] **Step 2: `docs/security-model.md`**

Replace the `## Canary isolation` section (lines 76–94) with:

```md
## Canary isolation

The compiler injects a deterministic, content-independent canary (SHA-256 of a
seed + role tag) into each hidden capsule. Roles run through `DirectModelRuntime`
— a single structured chat-completions call with **no tools, no MCP, and no
session** — so there is no filesystem/shell surface for a canary to leak through.
Raw model output is scanned for canaries and sanitized before it is validated
against the role's strict output schema; chain-of-thought, prompt text, and raw
output are never retained.
```

- [ ] **Step 3: `README.md`**

Replace the prerequisites bullet (lines 19–20) with:

```md
- The **`codex` CLI** — for the learner-facing Skill — on `PATH`, at
  `~/.local/bin/codex`, or via `$CODEX_BIN`.
```

Delete the entire `### Dedicated strict home (\`FDE_GYM_CODEX_HOME\`) — fallback only` section (lines 22–40).

Replace the final sentence of the `## Runtime route` paragraph (lines 55–58) with:

```md
`base_url`). When no endpoint is discoverable, role-invoking commands fail
closed with `MODEL_ENDPOINT_REQUIRED`; read-only commands (`list`, `status`,
`profile`, `replay`, `install-skill`) still work. The Codex CLI remains the
learner-facing front end (the repo-local Skill). See
`docs/architecture-decisions.md` (ADR-0001).
```

Delete the entire `## Verify the target Codex client` section (lines 72–94) and replace it with:

```md
## Verify

```bash
npm run release:gate              # npm ci → typecheck → build → test, stops on first failure
```
```

In the error table, change the `AGENT_*` row (line 177) to drop `AGENT_PROCESS_ERROR`, and replace the `CODEX_STRICT_MODE_UNSAFE` row (line 180) with:

```md
| `MODEL_ENDPOINT_REQUIRED` | no model endpoint is configured; set `FDE_GYM_MODEL_BASE_URL` + `FDE_GYM_MODEL` (or `~/.codex/config.toml`). |
```

Replace the release-status sentence (lines 115–118) with:

```md
"**MVP v1 frozen**" means the specification and acceptance baseline are frozen,
**not** that the product is release-ready (see `docs/mvp-acceptance.md`).
```

- [ ] **Step 4: `docs/architecture-decisions.md`**

Change the ADR-0001 status line to `- **Status:** Accepted`. Append ADR-0002 at the end of the file:

```md
## ADR-0002: Remove the Codex role-runtime fallback; direct-only runtime

- **Status:** Accepted
- **Date:** 2026-08-30
- **Supersedes:** ADR-0001's Codex fallback

### Context

ADR-0001 made `DirectModelRuntime` the default but kept `CodexAgentRuntime` as a
fallback for when no model endpoint was discoverable. That fallback was the last
consumer of the Codex strict-mode machinery (`codex-runtime.ts`,
`codex-process.ts`, `strict-policy.ts`, `capability-probe.ts`, the `doctor`
command, and the `FDE_GYM_CODEX_HOME` gate). It was also the source of the flaky
release gate (`doctor --require-safe` intermittently failing with
`ROLE_CANARY_LEAKED`).

### Decision

- **Remove the fallback.** Roles run only through `DirectModelRuntime`.
- **Fail closed lazily.** When no endpoint is discoverable, the CLI resolves an
  `UnconfiguredModelRuntime` whose `invoke()` throws the stable
  `MODEL_ENDPOINT_REQUIRED` error. Read-only commands (`list`, `status`,
  `profile`, `replay`, `install-skill`) never call `invoke()` and are unaffected.
- **Retire the `doctor` release gate.** `npm run release:gate` becomes
  `npm ci → typecheck → build → test`.
- **Keep the learner-facing Codex Skill** (`install-skill`), which remains the
  conversational front end.

### Consequences

- The canary-leak surface of the Codex path disappears structurally (no
  subprocess, no MCP inventory, no `--ephemeral` session to audit).
- The flaky `doctor:strict` gate is gone; the release gate is deterministic.
- `FDE_GYM_CODEX_HOME` is no longer read by the product.
```

- [ ] **Step 5: Skill references**

`skills/fde-gym/SKILL.md` — delete rule 1 (lines 34–37) and renumber the remaining five rules 1–5.

`skills/fde-gym/references/commands.md` — delete the `doctor` row (line 16).

`skills/fde-gym/references/security-boundaries.md` — delete the bullet (lines 30–31):

```md
- Run `fde-gym doctor` before the first strict run and STOP if
  `safeForStrictMode` is not `true`.
```

`tests/contracts/skill-package.test.ts` — delete the `it("instructs doctor before the first strict run and to stop when isolation is unavailable", ...)` test (lines 84–87), which asserts the now-removed doctor instruction; the Skill no longer references `doctor` or `safeForStrictMode`.

- [ ] **Step 6: `scripts/release-gate.mjs` stale comment**

Replace the file-header doc comment (lines 5–8) so it no longer claims a `doctor:strict` hard gate:

```js
/**
 * FDE Gym release gate.
 *
 * Runs the full verification chain sequentially and stops at the FIRST failure,
 * printing the exact failed command and its exit code.
 */
```

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: both pass (docs-only changes; the suite must stay green).

```bash
git add -A
git commit -m "docs: reconcile docs with the direct-only runtime"
```

---

## Final verification

```bash
npm run typecheck
npm test
npm run build
npm run release:gate     # now npm ci → typecheck → build → test (no doctor:strict)
```

Manual spot-check: with no endpoint configured, `node dist/cli/main.js list --json` exits 0 and
`node dist/cli/main.js ask --run-id r --command-id c` (no endpoint) returns
`{ ok: false, code: "MODEL_ENDPOINT_REQUIRED", ... }`.
