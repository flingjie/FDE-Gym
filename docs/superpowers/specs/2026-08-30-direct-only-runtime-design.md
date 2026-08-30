# Design: Remove the Codex role-runtime fallback (direct-only runtime)

- **Date:** 2026-08-30
- **Status:** Proposed (awaiting implementation)
- **Follows:** ADR-0001 (extract the role runtime to a direct chat-completions runtime)

## Context

FDE Gym runs three model roles (Customer, Evidence Tracker, Coach) through an
`AgentRuntime` seam. After ADR-0001, `resolveDefaultRuntime()` prefers
`DirectModelRuntime` (a single `POST /chat/completions` call) and **falls back to
`CodexAgentRuntime`** — the Codex CLI subprocess path — only when no model
endpoint is discoverable. That fallback is the last remaining reason for the
entire Codex strict-mode apparatus to exist: `codex-runtime.ts`, `codex-process.ts`,
`strict-policy.ts`, `capability-probe.ts`, the `doctor` command, the
`FDE_GYM_CODEX_HOME` gate, and the `doctor:strict` release-gate step.

The fallback is also the source of the flaky release gate: `doctor --require-safe`
intermittently fails with `ROLE_CANARY_LEAKED` when a role leaks a canary,
blocking release for a path the product no longer wants to run.

## Goal

Roles run **only** via `DirectModelRuntime`. Remove the `CodexAgentRuntime`
fallback and all of its strict-mode machinery and tests. Keep the learner-facing
Codex Skill (`install-skill`) unchanged — the learner front end is still a Codex
Skill (ADR-0001).

## Non-goals

- Do **not** remove the learner-facing Skill (`install-skill.ts`, the Skill
  package, `skill-package.test.ts`).
- Do **not** remove the shared runtime-independent security layers
  (`context-firewall.ts`, `sanitizer.ts`).
- Do **not** touch `docs/mvp-acceptance.md` — it is the v1 freeze baseline.
- Do **not** remove the historical dated spec/plan artifacts under
  `docs/superpowers/{specs,plans}/2026-08-*` — they are records of past work.

## Design

### Runtime resolution (lazy fail-closed)

`src/cli/main.ts`:

```ts
function resolveDefaultRuntime(): AgentRuntime {
  const direct = resolveDirectModelConfig();
  if (direct) return new DirectModelRuntime(direct);
  return new UnconfiguredModelRuntime();
}
```

- New file `src/agents/unconfigured-runtime.ts`: `UnconfiguredModelRuntime
  implements AgentRuntime`, whose `invoke()` throws
  `new AgentRuntimeError(MODEL_ENDPOINT_REQUIRED, "no model endpoint configured")`.
- `main.ts` still resolves the runtime once at startup and passes it in
  `CommandContext.runtime`. Construction is cheap and never touches the network;
  the only "failure" is `resolveDirectModelConfig()` returning `null`.
- Because read-only / deterministic commands (`list`, `status`, `profile`,
  `replay`, `install-skill`, `start`, `hint`, `clarify`) never call
  `runtime.invoke()`, they continue to work on a machine with no model endpoint.
  Only commands that actually invoke a role (`ask`, `repair-evidence`, `frame`,
  `submit-brief`, `submit-design`, `respond-challenge`, `submit-pitch`, `review`,
  `retry`) fail — and only at the moment of the first `invoke()`, surfaced
  through the existing `guard()` → `errorCodeOf` → `toFailure` plumbing.

### New stable error code

- `MODEL_ENDPOINT_REQUIRED`, defined in `src/agents/agent-runtime.ts` next to
  `AgentRuntimeError` (it is a runtime-contract code, not a sanitizer code).
- Localization entry added to `ERROR_TABLE` in `src/cli/render.ts`:

  - zh-CN: message `未配置模型端点。`; nextActions
    `设置 FDE_GYM_MODEL_BASE_URL 与 FDE_GYM_MODEL（或在 ~/.codex/config.toml 中配置 model + base_url）。`
  - en-US: message `No model endpoint is configured.`; nextActions
    `Set FDE_GYM_MODEL_BASE_URL and FDE_GYM_MODEL (or configure model + base_url in ~/.codex/config.toml).`

## Deletions

### Source

- `src/integrations/codex/codex-runtime.ts`
- `src/integrations/codex/codex-process.ts`
- `src/integrations/codex/strict-policy.ts`
- `src/integrations/codex/capability-probe.ts`

### CLI wiring

- `src/cli/commands.ts`: remove `doctorCommand`, `DoctorData`, `DoctorArgs`,
  `defaultCodexExecutable`, and the `capability-probe` / `CodexCapabilityReport`
  imports.
- `src/cli/main.ts`: remove the `doctor` command name, the `--codex-bin` and
  `--require-safe` flags, `resolveDefaultCodex()`, and the fallback line
  `return new CodexAgentRuntime(...)`.

### Scripts / gates

- `package.json`: remove `doctor` and `doctor:strict` scripts.
- `scripts/release-gate.mjs`: remove the `npm run doctor:strict` step (keep
  `npm ci`, `typecheck`, `build`, `test`).

### Docs

- `docs/codex-capability-report.md` (describes the now-removed doctor report).

### Tests

- `tests/contracts/codex-runtime.test.ts`
- `tests/contracts/codex-capability-probe.test.ts`
- `tests/contracts/strict-codex-policy.test.ts`
- `tests/contracts/fake-codex-runtime.mjs`
- `tests/fixtures/fake-codex.mjs`

## Edits

- `src/security/context-firewall.ts:191` — comment only: drop the
  `CodexAgentRuntime` mention.
- `src/agents/agent-runtime.ts:36,49` — comment: implementation list becomes
  `FixtureAgentRuntime` + `DirectModelRuntime` (+ `UnconfiguredModelRuntime`).
- `src/integrations/direct/direct-runtime.ts:40,110` — comments: drop
  `CodexAgentRuntime` mention.
- `src/integrations/direct/config.ts:13` — comment: replace "then falls back to
  `CodexAgentRuntime`" with "the caller reports `MODEL_ENDPOINT_REQUIRED`".
- `src/cli/render.ts` — remove the `CODEX_STRICT_MODE_UNSAFE` entry; remove the
  now-dead `AGENT_PROCESS_ERROR` entry (only the Codex subprocess path produced
  it); replace the `fde-gym doctor` reference in `AGENT_SPAWN_ERROR` nextActions
  with a generic "check the model endpoint configuration" action.
- `tests/adversarial/leak-guard.test.ts` — trim any codex-runtime-specific cases
  that relied on the removed fake; keep the shared-sanitizer leak-guard coverage.
- `tests/e2e/codex-skill-smoke.test.ts` — drop the `fake-codex.mjs` / built-binary
  doctor portion; keep the Skill install + `FixtureAgentRuntime` envelope smoke.

## New tests

- `tests/contracts/unconfigured-runtime.test.ts` — assert
  `UnconfiguredModelRuntime.invoke()` throws `AgentRuntimeError` with code
  `MODEL_ENDPOINT_REQUIRED`.

## Docs to update

- `docs/architecture-decisions.md` — mark ADR-0001 `Accepted`; add a short
  ADR-0002 "Remove the Codex role-runtime fallback; direct-only runtime"
  recording the removal, the lazy `MODEL_ENDPOINT_REQUIRED` behavior, and the
  retirement of the `doctor` release gate.
- `docs/architecture.md` — remove strict-mode/doctor/`FDE_GYM_CODEX_HOME`
  references; describe the runtime layer as direct-only.
- `docs/security-model.md` — rewrite the "Canary isolation" section to describe
  the direct-only path (no subprocess, no MCP, no session) and drop the Codex
  fallback / doctor description.
- `README.md` — remove the doctor command from the command list and any
  strict-mode setup references.
- `skills/fde-gym/SKILL.md` and `skills/fde-gym/references/*` — remove any
  `doctor` / strict-mode references that the learner-facing Skill may surface.

## Verification

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run release:gate` (now `npm ci` → typecheck → build → test)
5. Manual: with no endpoint configured, `fde-gym list` succeeds and
   `fde-gym ask ...` returns `MODEL_ENDPOINT_REQUIRED`; with a configured
   endpoint, a full role flow still works.
