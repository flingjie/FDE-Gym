# MVP Acceptance

Recorded 2026-08-24. This documents the manual acceptance run (Task 14 Step 5)
against the automated verification suite. Hidden content (facts, canaries,
disclosure ids, raw evaluator output) is never recorded here — only test names,
public field names, and structural evidence.

> **Runtime reconciliation (2026-08-30, ADR-0002).** The runtime rows below are
> updated to the direct-only runtime: `npm run doctor` and `CodexAgentRuntime`
> were removed, and the release gate is now deterministic
> (`npm run release:gate` = `npm ci` → typecheck → build → test). The
> security/determinism acceptance claims are unchanged.

## Verification suite (Step 4)

| Command | Result |
|---|---|
| `npm ci` | PASS (after `npm install` re-synced the lockfile for the `1.0.0` version bump) |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS — 32 files, **546 tests** green (540 prior + 6 new schema-version tests) |
| `npm run release:gate` | **PASS** (deterministic — `npm ci` → typecheck → build → test; the pre-ADR-0002 `doctor` probe is retired) |

The `npm run doctor` live Codex probe recorded on 2026-08-24 (which reported
`safeForStrictMode: false`, with both runs sharing `childCanaryContained=false`
→ `ROLE_CANARY_LEAKED` under the then-flaky local proxy) is retired by ADR-0002.
The Codex role runtime and its strict-mode machinery were removed, so there is
no Codex subprocess, MCP inventory, or canary-bearing child process left to
probe — that canary-leak surface is gone structurally, not papered over. The
release gate is now deterministic (`npm run release:gate`), and the
deterministic/structural verification (typecheck, build, all 546 tests) is
green.

## Acceptance checks (Step 5)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Only three model roles are invoked | **PASS** | `AGENT_ROLES` is fixed to `["customer","evidence_tracker","coach_evaluator"]`; `tests/contracts/agent-contracts.test.ts` |
| 2 | Each role uses a distinct fresh context | **PASS** (structural) | `DirectModelRuntime` makes one stateless, tool-free chat-completions call per invocation (no session); `tests/contracts/direct-runtime.test.ts` |
| 3 | The Customer never coaches or scores | **PASS** | `buildRoleInput("customer")` allowlist; `tests/contracts/context-firewall.test.ts` |
| 4 | The Tracker never sees ground truth | **PASS** | tracker input is `{ locale, turn, graph }` only; any capsule → `FIREWALL_CAPSULE_FORBIDDEN`; `tests/contracts/context-firewall.test.ts` |
| 5 | The Coach never appears as the customer | **PASS** | coach rejects the customer capsule; `tests/contracts/context-firewall.test.ts` |
| 6 | Unsupported Problem Brief claims block solution entry | **PASS** | framing gate `structure.passed && supportRatio ≥ 0.75`; `tests/e2e/problem-framing.test.ts` |
| 7 | Same seed + command sequence reproduce the event sequence | **PASS** | seeded `mulberry32` + deterministic scheduler; `tests/unit/event-scheduler.test.ts` |
| 8 | Recorded replay is byte-stable | **PASS** | `tests/golden/manufacturing-replay.test.ts` (byte-identical zh-CN + en-US snapshots) |
| 9 | Retry clears private sessions, graph, and disclosure ledger | **PASS** | `createRetry` builds a fresh aggregate; `tests/e2e/retry.test.ts` |
| 10 | No hidden prompt/capsule/canary/raw evaluator output in any channel | **PASS** (structural) | Adversarial corpus (`tests/adversarial/leak-guard.test.ts`, `prompt-injection-corpus.test.ts`, `customer-injection.test.ts`) and golden replay hidden-marker assertions pass; the pre-ADR-0002 Codex canary-leak surface (subprocess + MCP) is retired with the Codex role runtime |

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
  E2E suite, but a live model-backed run through the full loop is a human step.

## Conclusion

The deterministic and structural acceptance surface is green (546 tests pass;
checks 1–10 hold structurally). The pre-ADR-0002 live Codex probe is retired
with the Codex role runtime (ADR-0002), so there is no `safeForStrictMode` gate
left to fail; the release gate is deterministic (`npm run release:gate`). The
remaining live-model items (a fresh Codex conversation loading the repo-local
Skill; one zh-CN and one en-US run end-to-end) are recorded above as MANUAL
human steps. All deterministic work is complete and committed-ready.
