# MVP Acceptance

Recorded 2026-08-24. This documents the manual acceptance run (Task 14 Step 5)
against the automated verification suite. Hidden content (facts, canaries,
disclosure ids, raw evaluator output) is never recorded here — only test names,
public field names, and structural evidence.

## Verification suite (Step 4)

| Command | Result |
|---|---|
| `npm ci` | PASS (after `npm install` re-synced the lockfile for the `1.0.0` version bump) |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS — 32 files, **546 tests** green (540 prior + 6 new schema-version tests) |
| `npm run doctor` | **safeForStrictMode = false** (both probes, see below) |

`npm run doctor` (real Codex probe against `/Users/lingjiefan/.local/bin/codex`),
two runs measured verbatim:

```
run 1:
  localCommandExecution: true        freshContext:          true
  distinctRoleSessions:  true        structuredOutput:      false -> STRUCTURED_OUTPUT_INVALID
  toolsDisabled:         true        parentCanaryIsolated:  true
  childCanaryContained:  false -> ROLE_CANARY_LEAKED
  failures: [STRUCTURED_OUTPUT_INVALID, TIMEOUT, ROLE_CANARY_LEAKED]
  safeForStrictMode:     false

run 2:
  localCommandExecution: true        freshContext:          true
  distinctRoleSessions:  true        structuredOutput:      true
  toolsDisabled:         false -> TOOLS_NOT_DISABLED
  parentCanaryIsolated:  true        childCanaryContained:  false -> ROLE_CANARY_LEAKED
  failures: [TOOLS_NOT_DISABLED, ROLE_CANARY_LEAKED]
  safeForStrictMode:     false
```

Neither probe satisfies the completion definition's `safeForStrictMode: true`.
Both runs share `childCanaryContained=false` (`ROLE_CANARY_LEAKED`): the role
canary surfaced in child stdout/stderr, which means the `--disable shell_tool
--disable unified_exec` strict isolation is not currently taking effect on this
Codex client/proxy (the Task 1 capability report measured all-seven-true on
2026-08-23; the local proxy has been flaky this session). This is recorded
honestly, not papered over. The deterministic/structural verification
(typecheck, build, all 546 tests) is green.

## Acceptance checks (Step 5)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Only three model roles are invoked | **PASS** | `AGENT_ROLES` is fixed to `["customer","evidence_tracker","coach_evaluator"]`; `tests/contracts/agent-contracts.test.ts` |
| 2 | Each role uses a distinct fresh context | **PASS** (structural) | `CodexAgentRuntime` starts a fresh `--ephemeral` session per invocation; `tests/contracts/codex-runtime.test.ts`; real probe `freshContext=true`, `distinctRoleSessions=true` |
| 3 | The Customer never coaches or scores | **PASS** | `buildRoleInput("customer")` allowlist; `tests/contracts/context-firewall.test.ts` |
| 4 | The Tracker never sees ground truth | **PASS** | tracker input is `{ locale, turn, graph }` only; any capsule → `FIREWALL_CAPSULE_FORBIDDEN`; `tests/contracts/context-firewall.test.ts` |
| 5 | The Coach never appears as the customer | **PASS** | coach rejects the customer capsule; `tests/contracts/context-firewall.test.ts` |
| 6 | Unsupported Problem Brief claims block solution entry | **PASS** | framing gate `structure.passed && supportRatio ≥ 0.75`; `tests/e2e/problem-framing.test.ts` |
| 7 | Same seed + command sequence reproduce the event sequence | **PASS** | seeded `mulberry32` + deterministic scheduler; `tests/unit/event-scheduler.test.ts` |
| 8 | Recorded replay is byte-stable | **PASS** | `tests/golden/manufacturing-replay.test.ts` (byte-identical zh-CN + en-US snapshots) |
| 9 | Retry clears private sessions, graph, and disclosure ledger | **PASS** | `createRetry` builds a fresh aggregate; `tests/e2e/retry.test.ts` |
| 10 | No hidden prompt/capsule/canary/raw evaluator output in any channel | **PASS** (structural) / **FAIL** (live probe canary gate) | Adversarial corpus (`tests/adversarial/leak-guard.test.ts`, `prompt-injection-corpus.test.ts`, `customer-injection.test.ts`) and golden replay hidden-marker assertions pass; but the live `doctor` probe reports `childCanaryContained=false` — see verification above |

## MANUAL items (honest status)

These require a genuinely conversational Codex session that cannot be driven
non-interactively here, and are recorded as **MANUAL** (not verified by this
automated pass):

- **Fresh Codex conversation loads the repo-local Skill** (`<repo>/.codex/skills/fde-gym/`)
  — MANUAL. The Skill files install and their frontmatter/references resolve
  (`tests/contracts/skill-package.test.ts`, `tests/e2e/codex-skill-smoke.test.ts`),
  but opening a live Codex conversation and confirming it surfaces the Skill is
  a human step.
- **One zh-CN and one en-US run end-to-end through Review and Retry** — MANUAL.
  Bilingual correctness is covered by golden snapshots and the fixture-driven
  E2E suite, but a live model-backed run through the full loop (with the current
  flaky local proxy) is a human step.

## Conclusion

The deterministic and structural acceptance surface is green (546 tests pass;
checks 1–9 hold). The single open item is the **live Codex probe**: the target
client does not currently return `safeForStrictMode: true` under the flaky
local proxy, so the MVP completion definition is **not** met for the real-model
gate. All deterministic work is complete and committed-ready.
