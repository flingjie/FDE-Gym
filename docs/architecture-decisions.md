# Architecture Decision Records

## ADR-0001: Extract the role runtime from Codex to a direct chat-completions runtime

- **Status:** Proposed (implementation started: `DirectModelRuntime` + contract test exist; CLI wiring pending)
- **Date:** 2026-08-29

### Context

FDE Gym runs three model roles (Customer, Evidence Tracker, Coach) by spawning a
fresh `codex exec` subprocess per invocation (`CodexAgentRuntime`), hardened
behind a strict-mode plan (`FDE_GYM_CODEX_HOME`, disabled tools, MCP preflight,
sanitized env, reasoning filter). The learner-facing front-end is already a
Codex Skill; the deterministic control plane (state machine, scoring, event
store) is pure TypeScript.

Two problems motivate this decision:

1. **The live doctor gate is flaky.** `doctor --require-safe` intermittently
   fails with `ROLE_CANARY_LEAKED` when the model leaks a role canary, blocking
   release.
2. **The role layer pays an "agent tax."** The roles need a bare
   `f(prompt, input) → schema JSON` call — no tools, no MCP, no memory — yet the
   product spends several hundred lines (`codex-process`, `strict-policy`,
   `capability-probe`, `context-firewall`, `sanitizer`) stripping the agent-ness
   back off Codex.

### Empirical findings (probe against the local proxy, 2026-08-29)

| Probe | Result |
|---|---|
| `GET /v1/models` | 200 — proxy alive |
| Auth | none required (422, not 401) — cc-switch manages the upstream token |
| `POST /v1/responses` (Codex `wire_api`) | **422 `No message in chat choice`** — the Responses→Chat translation is broken |
| `POST /v1/chat/completions` | **200, clean text** |
| `response_format: json_schema` | 502 `unavailable now` — upstream does not support strict schema |
| `response_format: json_object` | **200, clean JSON** |

The configured `wire_api = "responses"` is the broken path. The native chat wire
works, and `json_object` + client-side Zod validation (which the sanitizer
already does) is sufficient for structured output.

### Decision

- **Add `DirectModelRuntime`** (an `AgentRuntime` that `fetch`es
  `POST /chat/completions` with `response_format: json_object` and reuses the
  existing `sanitizeAgentResult` leak-guard + schema validation).
- **Keep Codex only for the learner-facing Skill** (the conversational front
  end, where an agent is the right primitive).
- **Keep the deterministic control plane, scoring, event store, firewall
  unchanged.** `AgentRuntime` is the seam, so this is an additive implementation,
  not a rewrite.
- **Move `AgentRuntimeError` into `src/agents/agent-runtime.ts`** so runtime
  implementations don't depend on the Codex module.

### Consequences

**Positive**

- **Determinism:** a single structured-output call has no tools, so the canary
  leak surface (`role-canary.txt` read via shell) disappears structurally. No
  more "disable the tools so the model can't read the answer" — the model has no
  tools at all.
- **Isolation:** no subprocess, no `--ephemeral` session persistence, no MCP
  inventory to audit, no reasoning events to filter. The `doctor` gates that
  existed to verify Codex's isolation become largely irrelevant for this layer.
- **Speed/cost:** one HTTP call vs. spawning a full agent (~11–25 s each).
- **Robustness:** a plain HTTP contract is more stable than a CLI flag surface
  that drifts across Codex versions.

**Negative / trade-offs**

- **No strict `json_schema` upstream.** Schema validation must stay client-side
  (Zod), which it already does. The model can still emit extra keys or prose; the
  sanitizer/`tryExtractJson` handles that, but it is not a hard server-side
  guarantee.
- **Auth/config.** A direct call needs the model endpoint + any token. The local
  cc-switch proxy needs none today, but a different deployment would need the
  operator to supply `baseUrl`/`model`/`apiKey`. This is the one item that
  previously required touching provider config (declined during the v1 pass).
- **Single-shot (no repair/retry loop yet).** `CodexAgentRuntime` retries once on
  malformed/leak. `DirectModelRuntime` currently does not; callers re-drive via
  the same stable error codes. Retry can be layered on later.
- **Fences/prose still possible.** `json_object` does not forbid markdown fences;
  `tryExtractJson` is the fallback, mirroring the existing behavior.

### Migration

1. (Done) `DirectModelRuntime` in `src/integrations/direct/direct-runtime.ts`.
2. (Done) Contract test in `tests/contracts/direct-runtime.test.ts`.
3. (Pending) Select the runtime at the CLI (`src/cli/main.ts:167`) via an
   env/flag — e.g. `FDE_GYM_MODEL_BASE_URL`/`FDE_GYM_MODEL` opting into the direct
   route, with `CodexAgentRuntime` as the fallback when unset.
4. (Pending) A full-flow test driving `ask`/`frame`/`review` with the fake
   chat-completions server, complementing the existing `FixtureAgentRuntime`
   journey in `tests/e2e/cli-flow.test.ts`.
