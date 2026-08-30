# Design: Freeze Socratic hint ladders (D0) and close grant holes (D1–D2)

- **Date:** 2026-08-30
- **Status:** Accepted (D1–D2 implemented 2026-08-30)
- **Readable briefing:** [人话版](./2026-08-30-socratic-hint-ladders-briefing.md)
- **Implementation plan:** [D1/D2 plan](../plans/2026-08-30-socratic-hint-ladders.md)
- **Follows:** Hint execution-optimization analysis (static authored ladders,
  deterministic `requestHint`, production L3 drift)

## Context

Learner-facing hints are **static, bilingual, per-topic L1/L2/L3 ladders**
selected by the pure function `requestHint` in `src/simulation/hints.ts`. That
selector, the evaluator-only partition, and `hint.granted` event persistence are
the right shape for a replayable benchmark.

What is wrong is the **information contract**:

- Code comments, `docs/scenario-authoring.md`, and the selector unit fixture
  define L3 as **one actionable question, without its answer**.
- All four production scenarios ship 8× L3 texts that begin with
  「关键发现」/ `Key discovery` and state quantities that also live in
  `customer.disclosureUnits` (32/32 L3s).
- Explicit `--level 3` on a fresh topic is allowed, so a learner can buy those
  facts for a 6-point penalty without ever taking L1/L2.
- `--level` values other than `1|2|3` are coerced to auto-escalate.
- `hintCommand` folds `grantedHints` **before** `withRunLock`, then `prepare()`
  reuses that snapshot, so two writers can both grant L1.

This spec freezes the teaching contract (D0), then scopes the two
implementation slices that make it true in the control plane (D1) and in
production data (D2). Scoring double-count, Coach/state-machine dormancy, and
`status` topic listing are **out of scope**.

## Goal

Hints remain a **priced search-space compression**, not an answer sheet:

1. **D0** — one written contract for L1/L2/L3, skip-ahead, and what the compiler
   may enforce.
2. **D1** — fail closed on illegal `--level`; unique `topic`; grant computed
   from the ledger **inside** the run lock; identical `commandId` retries still
   return the first result even if the phase has moved on.
3. **D2** — rewrite all 32 production ladders to that contract; reject
   answer-shaped L3 at compile time with deterministic checks.

## Non-goals

- Do **not** generate hints at runtime (Coach `requestHint` stays unused).
- Do **not** feed hints into the evidence graph.
- Do **not** make selection depend on transcript, graph, or profile.
- Do **not** change `hintPenalty = min(12, l1 + 3×l2 + 6×l3)` or the process
  fallback (`100 − hintPenalty`) in this spec (D3).
- Do **not** delete Coach/state-machine hint remnants in this spec (D4).
- Do **not** add topic lists to `status` in this spec (D5).
- Do **not** edit `docs/mvp-acceptance.md` (v1 freeze baseline).

## D0 — frozen decisions

These are product decisions, not implementation options. Implementation must
not re-open them.

### D0.1 Ladder semantics

| Level | Allowed | Forbidden |
|---|---|---|
| **L1** | A thinking dimension or an open question with **no hidden fact** (no quantities, thresholds, dollar amounts, or unique operational counts from disclosure units). | Answers; 「关键发现」; copying disclosure-unit numbers. |
| **L2** | The **category** of missing evidence (volume, cost share, constraint class). May name *kinds* of metric. | The metric's value; the same numbers as L3 answers. |
| **L3** | **Exactly one** actionable question (or one tight compound question) that a learner could put to a stakeholder. Must be a question in both locales. | The answer; 「关键发现」 / `Key discovery`; any numeric or currency token that appears in that scenario's disclosure-unit or expected-evidence text. |

Worked rewrite (`support-automation` / `workflow`), current → target:

- **L1** now: "how many tickets a month, and how are they triaged?"
  **Target:** "Before proposing automation, how is work currently taken in and classified?"
- **L2** now: "Focus on the repeat-ticket ratio and first-response time."
  **Target:** "Look for volume, repetition, and response-time evidence — not just headcount."
- **L3** now: "Key discovery: about 180,000 tickets a month, 55% repetitive, …"
  **Target:** "What is monthly ticket volume, what share is repetitive, and what is first-response time today?"

The hidden facts stay in `disclosureUnits` (`du-001`, `du-002`). L3 points at
them; it does not state them.

### D0.2 Skip-ahead stays

Explicit `--level 2` or `--level 3` on a topic that has no grant (or only a
lower grant) **remains allowed**. After D2, L3 is a question, so skip-ahead is
paying 6 points to skip metacognitive steps — not buying the answer sheet.
Downgrade/repeat stays `HINT_NO_DOWNGRADE`. Auto mode stays strictly L1→L2→L3.

### D0.3 Hints are not evidence

Selector comments already say this. After D2 it must also be true of the YAML:
a grant must not be sufficient to fill an expected-evidence claim without a
customer answer. No schema change to put hint text on the graph.

### D0.4 Compiler enforces mechanics, authors still own pedagogy

The compiler/schema may only use **deterministic, bilingual-safe checks**
listed in D2. It will not try to judge "is this Socratic enough" with a model.

## D1 — control-plane fail-closed

### D1.1 Illegal `--level` is an error

Today (`src/cli/main.ts`): any `level` other than the strings `"1"|"2"|"3"`
becomes `undefined`, which `hintCommand` turns into auto-escalate.

Change:

- If `--level` is **absent**, auto mode (`null`) — unchanged.
- If `--level` is present and not exactly `1` / `2` / `3`, do **not** call
  `hintCommand`. Return `ok: false` with a new stable code `HINT_INVALID_LEVEL`.
- Empty string (`--level=`) is invalid.

Localization (add to `ERROR_TABLE` in `src/cli/render.ts`):

- zh-CN: message `提示级别必须是 1、2 或 3。`; nextActions `省略 --level 以自动升级，或传入 1、2 或 3。`
- en-US: message `Hint level must be 1, 2, or 3.`; nextActions `Omit --level to auto-escalate, or pass 1, 2, or 3.`

`errorCodeOf` already forwards `.code` from thrown errors; CLI can also
construct the failure envelope directly without throwing.

### D1.2 Unique `topic` at authoring time

`ScenarioAuthoringSchema` already rejects duplicate `hintLadders.id`. Add the
same superRefine for **duplicate `topic`** (first-wins `.find()` at runtime is
no longer acceptable). Error path: `evaluator.hintLadders[i].topic`.

### D1.3 Grant from the locked, current ledger

`executeCommandTransaction` already runs `prepare()` inside `withRunLock`.
The bug is the **closure**: `hintCommand` captures `loaded.aggregate.grantedHints`
from `loadRunState` *before* the lock.

Change `hintCommand` so that `prepare()`:

1. Reloads events for `runId` (same `baseDir`, under the held lock).
2. Re-folds `grantedHints`.
3. Calls `requestHint(..., freshGrantedHints)`.

Do **not** change `requestHint` itself.

### D1.4 Phase gate after journal lookup

Today the DISCOVERY / PROBLEM_FRAMING check runs **before** the transaction, so
a lost response + later retry of the same `commandId` after `frame` is
`INVALID_PHASE_COMMAND` instead of the stored result.

Change: call `executeCommandTransaction` first. Inside `prepare` (no journal
yet), reload+fold and **then** throw `InvalidPhaseCommandError` if phase is
wrong. A `committed` journal with matching hash still returns the first result
(existing transaction behavior).

### D1.5 Tests (D1)

- CLI or command-layer: `--level 4`, `--level foo`, `--level=` →
  `HINT_INVALID_LEVEL`; no `hint.granted`.
- `--level` omitted still auto-grants L1 on a fresh topic.
- Schema: two ladders with the same `topic`, different `id` → authoring parse
  fails.
- Ledger: after one L1 is committed, a `prepare` that would have seen an empty
  snapshot must grant L2 (reload-under-lock). Prefer a command-transaction test
  that issues two different `commandId`s sequentially; plus a comment that the
  reload is what closes the concurrent stale-snapshot hole.
- Idempotency: grant in DISCOVERY, advance phase with other commands, re-issue
  the **same** hint `commandId`+request → original result, not
  `INVALID_PHASE_COMMAND`.

## D2 — production ladders + compile-time leak checks

### D2.1 Rewrite all four sources

Files:

- `scenarios/source/support-automation.yaml`
- `scenarios/source/manufacturing-alert-triage.yaml`
- `scenarios/source/data-migration.yaml`
- `scenarios/source/export-freight-forwarding.yaml`

Each has 8 topics (`workflow`, `pain`, `root-cause`, `business-impact`,
`constraints`, `success-measures`, `trust`, `failure-modes`). Rewrite **all
three levels** per topic using D0.1, not only L3. Keep `id` / `topic` stable so
existing tests that key on topic names stay valid.

After YAML edits, recompile bundles (`compiler` / existing scenario build
path) so `scenarios/compiled/**` matches. Do not hand-edit compiled JSON.

### D2.2 Deterministic discipline checks

Add a pure helper (new small module next to schema/compiler, e.g.
`src/scenarios/hint-discipline.ts`) called from the authoring `superRefine`
(so both `compile` and any parse of `ScenarioAuthoring` fail the same way).

For each ladder, for each locale `zh-CN` and `en-US`:

1. **Answer banner:** L3 must not match `关键发现` or `Key discovery`
   (case-insensitive).
2. **Question shape:** L3 must contain `?` or `？`.
3. **Hidden numeric tokens:** From all `customer.disclosureUnits[].text` and
   `evaluator.expectedEvidence[].text` (both locales), extract numeric tokens:
   integers (including single digits such as `4` in `4 hours`), groups with
   thousands separators (`3,400`, `180,000`), decimals (`2.1`), and the numeric
   core of currency (`$320` → `320`). Normalize by stripping commas. Match a
   hint only as a **whole token** (not `3` inside `3400`). If L1, L2, or L3
   contains any token that appears in that hidden corpus, reject. Path:
   `evaluator.hintLadders[i].hints.<level>`.
4. **Duplicate topic:** as D1.2 (can live in the same superRefine).

Do **not** fuzzy-match whole sentences. Do **not** scan `public.*` into the
hidden corpus (public constraints may legally repeat numbers the learner is
allowed to see).

Authoring example in `docs/scenario-authoring.md` already uses a placeholder
L3 question — replace the placeholder with a real question that passes (3), and
state the three checks above next to the existing L1/L2/L3 bullets.

### D2.3 Tests (D2)

- Fixture ladder with 「关键发现」 L3 → schema/compiler failure.
- Fixture L3 without `?`/`？` → failure.
- Fixture L3 containing `180000` / `180,000` while a disclosure unit contains
  `180,000` → failure.
- The four production sources, once rewritten, parse and compile.
- Keep `tests/unit/hints.test.ts` selector contracts (auto, skip, exhaustion).
- Extend golden/E2E only if a frozen L1 string is asserted; do not add a
  "replay must not contain L3" test that never requests L3 — if touching
  `tests/e2e/all-scenarios.test.ts`, request L3 and assert the granted text is
  a question and does not contain a sampled hidden number from that scenario.

## Follow-on (not this spec)

- **D3** — decide whether process fallback should include `hintPenalty` (today
  ~1.1×). Revisit only after D2 (information quantity changes the meaning of
  the tariff).
- **D4** — quarantine or delete unused Coach `requestHint` and state-machine
  `hintPlaceholder`.
- **D5** — `status` lists topics and max granted level (not hint body). Align
  `HINT_UNKNOWN_TOPIC` nextActions that already mention `status`.

## ADR (land with D0 docs in implementation)

Add **ADR-0003** to `docs/architecture-decisions.md` when implementing:

- **Decision:** Production hint ladders obey Socratic L1/L2/L3; L3 is a
  question without the disclosure-unit answer. Selection stays the deterministic
  `requestHint` function. Skip-ahead remains a learner-facing capability.
- **Consequences:** Compiler rejects answer banners and hidden numeric tokens in
  hint text. Runtime generation of hints is not a supported path.

## Implementation order

1. D1 tests → D1 code (no YAML yet; production compile still passes).
2. D2 helper + failing fixtures → helper green.
3. Rewrite 32 ladders until production compile is green.
4. ADR-0003 + `docs/scenario-authoring.md` bullets.

D1 is shippable alone (behavior fix without teaching-content change). D2 is
the measurement fix and should follow immediately so skip-ahead is not still
an answer purchase.
