# FDE Gym

A bilingual (**zh-CN default**, **en-US** selectable) Forward-Deployed Engineering
(FDE) capability-training product driven through the ChatGPT **Codex CLI**.

FDE Gym runs three isolated model roles — a **Customer**, an **Evidence
Tracker**, and a **Coach/Evaluator** — behind a strict context firewall, and
walks a learner through a gated Scenario → Discovery → Problem Framing →
Solution → Challenge → Pitch → Review → Retry loop. The learner interacts only
through a small, safe CLI and a thin Codex Skill; hidden scenario content
(customer facts, evaluator ground truth, canaries) never crosses the role or
learner boundaries.

## Prerequisites

- **Node.js ≥ 22** (`engines.node` is `>=22`).
- The **`codex` CLI** on `PATH`, at `~/.local/bin/codex`, or via `$CODEX_BIN`.
  Verify with `fde-gym doctor` (below).

## Install

```bash
npm ci          # or `npm install` to (re)build the lockfile
npm run build
```

## Install the Codex Skill (repo-local)

```bash
fde-gym install-skill            # copies skills/fde-gym/ + dist/ into .codex/skills/fde-gym/
fde-gym install-skill --dry-run  # list the exact files without writing
```

The Skill installs **repo-locally** to `<repo>/.codex/skills/fde-gym/` (derived
from the package root — never `~/.codex`). `.codex/` is git-ignored (generated,
not source). The Skill is a thin adapter: it turns learner intent into exactly
one safe CLI command and renders only the returned learner-safe envelope.

## Verify the target Codex client

```bash
fde-gym doctor                    # diagnostic: print the full capability report
fde-gym doctor --require-safe     # release gate: exit non-zero unless safeForStrictMode === true
npm run release:gate              # npm ci → typecheck → build → test → doctor:strict, stops on first failure
```

`doctor` probes the real Codex CLI and reports a `safeForStrictMode` boolean
plus seven gate booleans (`localCommandExecution`, `freshContext`,
`distinctRoleSessions`, `structuredOutput`, `toolsDisabled`,
`parentCanaryIsolated`, `childCanaryContained`). A strict run must only start
when `safeForStrictMode` is `true`; `doctor --require-safe` (and the
`doctor:strict` npm script) turns that requirement into an executable gate that
exits non-zero with the stable code `CODEX_STRICT_MODE_UNSAFE` when the probe
does not pass. `npm run release:gate` runs the full chain and stops at the
first failure — a failing live doctor is a failed release, never a warning.

## Determinism and release status

Four claims are precise and are what the verification suite asserts:

1. **Same committed events → same state.** `decide()`/`reduce()` are pure folds
   over the event log — no wall-clock, no `Math.random` (see
   `docs/architecture.md`).
2. **Same scenario bundle digest + seed + trigger context → same scheduled
   event order.** The only randomness is a seeded PRNG consumed solely to order
   the scenario-event wave.
3. **Same event log → byte-stable recorded replay (per locale).** `replay`
   projects the committed events; identical committed events yield identical
   bytes within a given locale, not across locales (zh-CN ≠ en-US bytes)
   (see `docs/replay.md`).
4. **A fresh model invocation does NOT guarantee identical prose or judgment.**
   Only the control-plane state and ordering are deterministic; role prose is
   confined behind schema-validated boundaries and never drives the control
   plane.

"**MVP v1 frozen**" means the specification and acceptance baseline are frozen,
**not** that the product is release-ready. Release stays blocked until a live
`doctor --require-safe` probe returns `safeForStrictMode: true` (see
`docs/mvp-acceptance.md`).

## Learner flow

| Command | Purpose |
|---|---|
| `start` | start a run (`--run-id --scenario --command-id [--locale]`) |
| `status` | show a run's phase summary (`--run-id`) |
| `list` | list runs |
| `ask` | ask the customer a question (JSON on stdin) |
| `hint` | request a laddered hint (`--topic [--level 1..3]`) |
| `frame` | DISCOVERY → PROBLEM_FRAMING |
| `clarify` | PROBLEM_FRAMING → DISCOVERY |
| `submit-brief` | submit a problem brief (JSON on stdin) |
| `submit-design` | submit a solution design + inject challenges (`[--seed n]`) |
| `respond-challenge` | answer a challenge (JSON on stdin) |
| `submit-pitch` | submit the pitch (JSON on stdin) |
| `review` | final review + score breakdown |
| `replay` | project the learner-safe replay (`[--locale]`) |
| `retry` | start a clean retry (`--new-run-id`; focus summaries on stdin) |
| `profile` | show the learner profile |

Resume a run with any of its commands (`status`, `ask`, …) using the same
`--run-id`; the event store is append-only and idempotent per `commandId`.
`replay` renders the recorded, byte-stable replay; `retry` starts a clean child
run that clears sessions, the evidence graph, and the disclosure ledger.

## Locale

`zh-CN` is the default. Pass `--locale en-US` (or start with `--locale en-US`)
to switch every learner-safe message to English.

## Storage

State lives under `$FDE_GYM_HOME` when set, otherwise the project-local
`.fde-gym/` directory (git-ignored):

- `runs/<run-id>/manifest.json` — `{ "schemaVersion": 1 }`.
- `runs/<run-id>/events.jsonl` — the append-only, SHA-256 hash-chained event log.
- `profile.json` — the learner profile (six-competency EMA).

Override with `FDE_GYM_HOME` or `--base-dir <dir>` for testing/scripts.

## Troubleshooting (error codes)

Failures return `{ ok: false, code, message, nextActions }`. Common codes:

| Code | Meaning |
|---|---|
| `INVALID_PHASE_COMMAND` | command issued in the wrong phase — check `status`. |
| `INVALID_ARTIFACT` | a submitted brief/design/response/pitch failed structural validation. |
| `RUN_NOT_FOUND` / `RUN_ALREADY_EXISTS` | unknown run id / run already started. |
| `EVENT_CHAIN_INVALID` | the event log failed hash-chain verification (tampered/corrupted). |
| `UNSUPPORTED_SCHEMA_VERSION` | a resource is not schema v1 — recompile/recreate it. |
| `FRAME_BLOCKED` / `EVIDENCE_EXTRACTION_FAILED` | evidence extraction is pending. |
| `CLARIFICATION_BUDGET_EXCEEDED` | clarification budget exhausted. |
| `INVALID_RETRY_FOCUS` | retry needs 2–3 focus summaries. |
| `HINT_UNKNOWN_TOPIC` / `HINT_NO_DOWNGRADE` / `HINT_EXHAUSTED` | hint-ladder misuse. |
| `LEAK_GUARD_TRIGGERED` | a role output failed the leak guard. |
| `AGENT_TIMEOUT` / `AGENT_SPAWN_ERROR` / `AGENT_OUTPUT_*` / `AGENT_INPUT_INVALID` | role-runtime failures. |
| `SCENARIO_NOT_FOUND` | unknown scenario id. |
| `SKILL_SOURCE_MISSING` / `SKILL_EXISTS_UNRELATED` | Skill install problems. |
| `CODEX_STRICT_MODE_UNSAFE` | `doctor --require-safe`: the live Codex probe did not return `safeForStrictMode: true`. |

## Security boundary (read this)

Local hidden files are **NOT** certification-grade anti-cheating. FDE Gym's
isolation (role allowlists, context firewall, output sanitizer, canary leak
guard, read-only sandbox) makes it structurally hard for hidden content to leak
across role/learner boundaries — but it runs on the learner's own machine, with
plain filesystem access to the scenario/run files. A motivated learner who can
read their own disk (or attach a debugger) can see anything on it. This is a
**local training product**, not a remote proctored exam; see
`docs/security-model.md` for the exact boundary and what it does and does not
guarantee.

## Docs

- `docs/architecture.md` — roles, partitions, phases, firewall, event store.
- `docs/scenario-authoring.md` — authoring schema, lint rules, worked example.
- `docs/security-model.md` — threat model and the local-MVP boundary.
- `docs/scoring.md` — exact formulas and pass gates.
- `docs/replay.md` — recorded vs re-simulation replay.
- `docs/mvp-acceptance.md` — the manual acceptance run.
