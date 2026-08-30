# Codex Strict-Mode Security Design

> OBSOLETE — superseded by ADR-0002

**Date:** 2026-08-29  
**Status:** Approved for implementation planning  
**Scope:** FDEGym's production `CodexAgentRuntime` and live capability probe

## Problem

FDEGym declares `AgentInvokeOptions.tools: "disabled"`, but the current implementation disables only Codex's `shell_tool` and `unified_exec` features. A local Codex Desktop installation can expose `node_repl` through MCP, allowing arbitrary Node.js execution and filesystem reads despite those feature flags.

The current uncommitted point fix adds:

```text
-c mcp_servers.node_repl.enabled=false
```

to both the production runtime and capability probe. Root-cause investigation showed that this is not a sound strict-mode boundary:

1. With an empty `CODEX_HOME`, Codex 0.149.0 exits with `invalid transport in mcp_servers.node_repl` because the override creates an incomplete server entry.
2. It disables only one known server name; any filesystem, browser, or custom MCP server under another name remains available.
3. The policy is duplicated between the runtime and probe and can drift.
4. `--ignore-user-config` removes all user MCP configuration, but it also removes the current custom model-provider configuration. In the current environment, a normal configured invocation completes while an `--ignore-user-config` invocation does not complete within 45 seconds.
5. Probe gates infer safety from the absence of canaries even when the relevant invocation failed or timed out.
6. The probe can reuse stale structured output and races by mutating the process-wide parent-canary environment variable.
7. The runtime treats a nonzero Codex exit as malformed model output and ignores its configured timeout ceiling.

## Security Decision

FDEGym strict mode uses a **dedicated, user-managed Codex home** supplied through the required environment variable:

```text
FDE_GYM_CODEX_HOME=/absolute/path/to/fdegym-codex-home
```

The strict home contains only the provider/authentication configuration required to invoke Codex. FDEGym does not copy credentials, migrate provider configuration, print tokens, or mutate the user's normal Codex home.

The strict home must have no enabled MCP servers. FDEGym checks this immediately before each production role invocation and during `doctor`. Missing home configuration, an unreadable home, an MCP inventory failure, or any enabled MCP server fails closed before a model process starts.

This design deliberately does not use `--ignore-user-config`: the strict home is itself the isolated configuration boundary, preserving custom providers while separating them from daily-use MCP, plugin, and project configuration.

## Architecture

### Shared strict policy

Add a focused module:

```text
src/integrations/codex/strict-policy.ts
```

It owns the single strict-mode contract used by both runtime and probe:

- Resolve and validate `FDE_GYM_CODEX_HOME`.
- Build the shared fixed Codex execution arguments.
- Build the child environment with `CODEX_HOME` explicitly set to the strict home.
- Inspect `codex mcp list --json` under the same executable and environment.
- Reject unsafe or indeterminate MCP state.

The module must stay small and explicit. It must not introduce a registry, factory, feature flag, or user-supplied arbitrary Codex argument list.

### Shared fixed execution policy

Every role/probe model invocation uses:

- `exec --json`
- `--ephemeral`
- `--skip-git-repo-check`
- `--sandbox read-only`
- `--color never`
- `--ignore-rules`
- `--disable shell_tool`
- `--disable unified_exec`
- a unique role-scoped `-C` work directory
- stdin prompt input

The unsafe `mcp_servers.node_repl.enabled=false` override is removed. MCP isolation is enforced by validating the complete effective inventory in the dedicated strict home, not by guessing server names.

### Production preflight

Before each `CodexAgentRuntime.invoke` starts a role model process:

1. Resolve and validate the strict home.
2. Run `codex mcp list --json` with `CODEX_HOME` set to that home.
3. Require the inventory command to spawn, finish before timeout, exit zero, and return a valid array.
4. Treat any server whose `enabled` field is not exactly `false` as enabled.
5. Reject the invocation with `CODEX_STRICT_MODE_UNSAFE` if the inventory is enabled or indeterminate.

The preflight is intentionally per invocation rather than a cached constructor check. A strict-home configuration change is detected by the next role call.

### Capability probe

`doctor` uses the same strict-home resolver, child environment, execution arguments, and MCP inventory check. The probe preserves its existing public boolean matrix; new unsafe conditions appear as stable failure codes and force `safeForStrictMode=false` without adding hidden configuration values to the report.

## Runtime Failure Semantics

Runtime processing order:

```text
strict-home resolution
→ MCP inventory preflight
→ role-input validation
→ Codex spawn
→ process-result classification
→ raw canary scan
→ structured-output parsing
→ sanitizer and strict schema validation
```

Stable behavior:

- Unsafe/missing strict home or unsafe MCP inventory: `CODEX_STRICT_MODE_UNSAFE`, no role model spawn.
- Spawn failure: `AGENT_SPAWN_ERROR`, terminal, no retry.
- Timeout: `AGENT_TIMEOUT`, terminal, no retry.
- Nonzero exit: new `AGENT_PROCESS_ERROR`, terminal, no malformed-output repair.
- Exit zero with malformed/invalid structured output: one fresh repair attempt.
- Canary match: one fresh retry; a second match returns `LEAK_GUARD_TRIGGERED`.

`CodexAgentRuntimeConfig.timeoutMs` is a hard runtime ceiling. The effective process timeout is:

```ts
Math.min(runtimeTimeoutMs, invocationTimeoutMs)
```

A caller may request a shorter timeout but cannot exceed the configured runtime limit.

Error messages and reports must never include stderr, model output, config contents, provider values, or canaries.

## Probe Fail-Closed Semantics

A probe invocation is successful only when:

```text
!spawnError && !timedOut && exitCode === 0
```

Each gate requires both a successful invocation and the expected safe observation:

- Local command: version invocation succeeds and emits a semantic version.
- Distinct sessions: all three model calls succeed, all produce thread IDs, and the IDs are distinct.
- Fresh context: successful role calls produce thread IDs and no new persisted session files.
- Parent isolation: the environment-reveal invocation succeeds and does not reveal the parent canary.
- Child containment: every role-canary-bearing invocation succeeds and does not reveal the role canary.
- Structured output: the invocation succeeds and this invocation's output parses against the schema.
- Tool isolation: the invocation succeeds and does not reveal the scenario canary.
- MCP isolation: inventory succeeds and contains no enabled server.

`safeForStrictMode` requires every gate, no timeout, and no recorded failure.

### Stale output prevention

Before the structured-output probe starts, it removes any existing output file. A failed invocation can therefore never validate bytes from an earlier probe that reused the same `workRoot` with cleanup disabled.

### Concurrent probe safety

The probe no longer writes `process.env.FDE_PARENT_CANARY`. It builds a local source snapshot instead:

```ts
const probeSourceEnv = {
  ...process.env,
  FDE_PARENT_CANARY: parentCanary,
};
```

`sanitizeChildEnv` receives that snapshot. Concurrent probes cannot overwrite, delete, or restore each other's process-wide state.

## Test Design

Implementation follows test-driven development.

### Strict-policy contracts

Add tests for:

- Missing `FDE_GYM_CODEX_HOME`.
- Non-absolute, missing, and unreadable strict-home paths.
- Shared runtime/probe argument identity.
- Required `--ignore-rules`, sandbox, ephemeral, and disabled shell/unified features.
- Absence of the `node_repl.enabled=false` point override.
- MCP inventory acceptance when empty or all entries are explicitly disabled.
- MCP inventory rejection for any enabled entry.
- MCP inventory rejection for invalid JSON, nonzero exit, spawn failure, or timeout.

### Runtime regressions

Extend the fake Codex runtime to verify:

- Enabled MCP blocks the role model and leaves model invocation count at zero.
- A clean strict home with no `node_repl` starts successfully.
- Child arguments and `CODEX_HOME` come from the shared policy.
- Nonzero role exit returns `AGENT_PROCESS_ERROR` with one attempt.
- A 300 ms runtime timeout caps a 10 s invocation request.
- Existing malformed-output repair and canary retry behavior remains unchanged.

### Probe regressions

Extend the probe fake to target individual calls:

- Only the environment-reveal call times out or exits nonzero: parent isolation and the overall gate fail.
- Only the tool-isolation call fails: `toolsDisabled=false` and the overall gate fails.
- A valid stale output file plus a failed structured invocation cannot pass.
- Two probes run concurrently without mutating `process.env.FDE_PARENT_CANARY`.
- Enabled MCP stops strict certification and emits only a stable failure code.

### Full verification

Run:

```text
npm run typecheck
npm run build
npm test
```

Then run the live diagnostic and release gate separately with an explicitly configured strict home:

```text
FDE_GYM_CODEX_HOME=/absolute/strict/home fde-gym doctor
FDE_GYM_CODEX_HOME=/absolute/strict/home fde-gym doctor --require-safe
```

A live doctor failure remains a release failure, even when all fake contract tests pass.

## Documentation Changes

Update:

- `README.md`: strict-home prerequisite, setup contract, and release-gate invocation.
- `docs/architecture.md`: dedicated configuration boundary and per-invocation MCP preflight.
- `docs/security-model.md`: what the strict home does and does not guarantee.
- `docs/codex-capability-report.md`: new fail-closed conditions and failure codes.
- CLI error localization/documentation for `AGENT_PROCESS_ERROR` and strict-home failures.

## Out of Scope

This change does not:

- Auto-copy provider configuration, authentication files, or bearer tokens.
- Modify the user's normal `CODEX_HOME`.
- Add a container or OS-level sandbox.
- Change scenario compilation, role schemas, scoring, replay, retry, or learner profiles.
- Introduce a generic provider abstraction.
- Preserve the old strict path behind a feature flag.

## Acceptance Criteria

1. No strict invocation names or overrides a specific MCP server.
2. Runtime and doctor use one shared strict policy.
3. Missing or unsafe strict-home state prevents the role model from spawning.
4. Every probe gate requires successful execution; silence caused by failure is never interpreted as safety.
5. Nonzero role exits are terminal process failures, not malformed model output.
6. Runtime timeout configuration is enforced as a hard ceiling.
7. Concurrent probes do not mutate process-wide canary state.
8. Reused work roots cannot validate stale structured output.
9. Targeted contracts, typecheck, build, and the complete test suite pass.
10. Live strict doctor status is reported independently and remains release-blocking.
