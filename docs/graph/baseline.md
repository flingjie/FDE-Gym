# Agent Graph — CI Baseline (G0-01)

Date recorded: 2026-09-01

## Code baseline hashes

| Label | Hash |
|---|---|
| Current HEAD (working tree at time of capture) | `d7b84b78340800194c26c83e4ec860715d703074` (`d7b84b7`) |
| Plan-referenced baseline | `1410441c8121b32d91d5a8585d9eb634ab35fda3` |

The plan references `1410441c8121b32d91d5a8585d9eb634ab35fda3`, but the current
HEAD is `d7b84b7` — the tree has moved ahead (recent commits: calibration/drift
measurement script, difficulty + drift statistics, phase-3d plan/spec docs). This
document captures the **current** working tree. The working tree is clean at
capture time (`git status --short` is empty).

## Toolchain actually used

| Tool | Version |
|---|---|
| Node | `v24.14.0` |
| npm | `11.9.0` |
| TypeScript | `^5.9.3` (declared; per `package.json`) |
| Vitest | `^4.1.11` (declared; runner reports `v4.1.11`) |

`package.json` `engines` is `node >=22`; Node 24.14.0 satisfies it.

## Command results

All four commands were run on the existing `node_modules` (dependencies were
already installed, so no standalone `npm ci` was needed up front; the
`release:gate` script independently re-runs `npm ci` and it succeeded with no
lockfile drift).

### 1. `npm run typecheck` — PASS

```
> tsc -p tsconfig.json --noEmit
```
Exit 0, no diagnostics. Wall time ~1.1s.

### 2. `npm run build` — PASS

```
> tsc -p tsconfig.json
```
Exit 0, no diagnostics. Wall time ~1.2s. Emits to `dist/` (per `tsconfig.json`).

### 3. `npm test` — PASS (753 passed, 1 skipped)

```
 RUN  v4.1.11 /Users/lingjiefan/underway/FDEGym
 Test Files  51 passed | 1 skipped (52)
      Tests  753 passed | 1 skipped (754)
   Start at  10:23:51
   Duration  23.43s (transform 3.21s, setup 0ms, import 6.58s, tests 84.31s, environment 3ms)
```

Non-blocking noise: Node emits `ExperimentalWarning: SQLite is an experimental
feature` several times during the run (from a worker/`node:sqlite` import). This
is a warning, not a failure, and does not affect the pass/fail outcome.

The 1 skipped test file / test is a pre-existing skip in the suite, not a
regression.

### 4. `npm run release:gate` — PASS

Runs `node scripts/release-gate.mjs`, which executes sequentially and stops at
the first failure:

```
=== release gate: npm ci ===
added 50 packages, and audited 51 packages in 3s
found 0 vulnerabilities

=== release gate: npm run typecheck ===   (exit 0)
=== release gate: npm run build ===        (exit 0)
=== release gate: npm test ===             (51 passed | 1 skipped; 753 passed | 1 skipped)

release gate: all steps passed.
```

Exit code 0. `npm ci` cleanly installed 50 packages from the lockfile
(`package-lock.json`), confirming no lockfile drift.

## Golden replay summary

Test: `tests/golden/manufacturing-replay.test.ts` (Task 11). It contains two
suites.

### Suite 1 — `golden replay: customer-support-agent`

- Loads `tests/golden/fixtures/customer-support-events.jsonl` (a fixed public
  `RunEvent[]` stream, **no event-store envelope** — domain payloads only) via a
  local `loadGoldenEvents()` helper.
- Projects with `projectReplay(events, locale)` for `zh-CN` and `en-US` and
  asserts **byte-identity** of `canonical()` against the per-locale snapshot
  files:
  - `tests/golden/fixtures/customer-support-replay.zh-CN.json`
  - `tests/golden/fixtures/customer-support-replay.en-US.json`
- Asserts repeated runs produce identical bytes (`canonical(b) === canonical(a)`).
- Asserts locale resolution (same turn resolves to the zh-CN vs en-US prose).
- Asserts the full 18-field public `LearnerReplay` set is present, `mode ===
  "recorded"`, and concrete lengths (2 transcript turns, 2 graph diffs, 2
  question metrics, 1 hint, 1 event injection, 1 strength/weakness/
  missed-opportunity/decision-divergence-point, 2 next-focus, `score` non-null).
- Asserts structural exclusion of hidden markers: `du-001`, `du-003`,
  `disclosedDisclosureUnitIds`, the canary sentinel `CUSTOMER_CANARY_7f3a9c1e2b4d`,
  `chainOfThought`, `reasoning`, `systemPrompt`, `rawCustomerOutput`, and the
  string `"commandId"`.

### Suite 2 — `golden replay: frozen v1 manufacturing run`

- Copies the frozen v1 fixture
  `tests/fixtures/runs/v1/manufacturing/{events.jsonl,manifest.json}` into a
  temp base dir, runs the **current reader** (`loadEvents`, i.e. the real
  `event-store.ts` path), strips the hash-chain envelope, and asserts the stream
  has 24 recorded events.
- Byte-compares `projectReplay` output (after envelope stripping) against the v1
  snapshots:
  - `tests/fixtures/runs/v1/manufacturing/replay.zh-CN.json`
  - `tests/fixtures/runs/v1/manufacturing/replay.en-US.json`

This second suite proves the current reader upcasts a frozen v1 run and still
reproduces the historical learner-replay bytes.

### How the golden replay is keyed/versioned

- **Byte-stability is asserted over** `canonical(replay) = JSON.stringify(replay,
  null, 2) + "\n"` — 2-space pretty-printed JSON plus a trailing newline. This is
  NOT the event-store's hashing canonical JSON (`src/storage/event-chain.ts`
  `canonicalJson`); it is a test-local pretty-print.
- **Locale-keyed**: two snapshot files per fixture set (`*.zh-CN.json`,
  `*.en-US.json`).
- **Versioned via the run manifest**, not a hard-coded replay version:
  - Current runs write `{ "runFormatVersion": 2 }` (see
    `src/core/event-store.ts`, which serializes `RUN_FORMAT_VERSION`).
  - The frozen v1 fixture's `manifest.json` is exactly `{"schemaVersion":1}`,
    which `resolveRunFormatVersion()` maps to run format 1 and upcasts through
    `upcastRecordedEvent()`.
  - `LearnerReplay.mode` is the label `"recorded"`; `"re-simulation"` is reserved
    but not implemented (`src/replay/projector.ts`).

## Event / schema version

The single frozen content version is split into independent versions:

| Constant | Value | Location |
|---|---|---|
| `FDE_SCHEMA_VERSION` | `1` | `src/core/domain.ts:25` |
| `RUN_FORMAT_VERSION` | `2` | `src/core/versioning.ts:39` |
| `EVENT_ENVELOPE_VERSION` | `1` | `src/core/versioning.ts:41` |
| `SCENARIO_SCHEMA_VERSION` | `= FDE_SCHEMA_VERSION` (1) | `src/scenarios/schema.ts:22` |
| `SCENARIO_MANIFEST_VERSION` | `2` | `src/scenarios/schema.ts:29` |
| `JOURNAL_VERSION` | `1` | `src/core/command-transaction.ts:86` |
| `SCORE_SCHEMA_VERSION` / `FORMULA_VERSION` / `OUTPUT_SCHEMA_VERSION` | `1` each | `src/scoring/versions.ts` |
| `CAPABILITY_RUBRIC_VERSION` | `1` | `src/scoring/rubric.ts:25` |
| `RUNTIME_POLICY_VERSION` | `1` | `src/scoring/identity.ts:11` |
| Agent output schema versions (evidence tracker / brief validation / final review) | `1` each | `src/agents/contracts.ts` |

Where the replay/event version is pinned:

- **`src/core/domain.ts:25`** — `FDE_SCHEMA_VERSION = 1` is the frozen content
  version carried by scenario packs, run manifests (v1), and learner profiles.
- **`src/core/versioning.ts`** — the explicit format-version layer:
  `RUN_FORMAT_VERSION = 2` (run manifest + recorded-event shape; v1 upcasts) and
  `EVENT_ENVELOPE_VERSION = 1` (hash-chain envelope).
- **`src/core/event-store.ts`** — writes `{ runFormatVersion: RUN_FORMAT_VERSION }`
  to the immutable run manifest; selects the event upcaster by the on-disk
  manifest version before validating the current `RecordedEventSchema`.
- **`src/replay/projector.ts`** — pins no numeric version of its own; it emits
  `mode: "recorded"` and depends on the run-format reader for the input stream.
  Its byte-stable output is guarded by the golden snapshot tests rather than a
  version constant.

## Reproducibility verdict

**CLEAN and re-runnable.** All four commands pass on the current HEAD
(`d7b84b7`):

- `typecheck` — pass, no diagnostics.
- `build` — pass, no diagnostics.
- `test` — 753 passed, 1 skipped (754), 0 failures, ~23.4s.
- `release:gate` — pass (runs `npm ci` + typecheck + build + test), exit 0.

`npm ci` succeeds with no lockfile drift (`package-lock.json` in sync). There are
no failures to fix before the graph-engineering work can proceed. The only
observed non-blocking noise is Node's `ExperimentalWarning: SQLite` emitted
during vitest runs; it does not affect outcomes.
