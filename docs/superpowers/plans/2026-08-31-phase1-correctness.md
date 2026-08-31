# Phase 1 Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the corrected determinism contract true in code — model judgments carry full provenance, the transaction no longer holds the run lock across the model call, the score separates `measured`/`proxy`/`unscorable`, and the profile fold is atomic.

**Architecture:** Four correctness items in dependency order: (1) `JudgmentEnvelope` provenance on judgment events; (2) optimistic concurrency in `executeCommandTransaction`; (3) three-state score classification; (4) a profile lock. All changes are additive and forward-compatible — no committed event is rewritten, golden replay stays byte-stable.

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-judgment-provenance-and-correctness-design.md`

## Global Constraints

- Node ≥ 22; source imports use `.js` extension; test imports are extensionless.
- Incremental and forward-compatible: no committed event is rewritten or re-folded; a pre-existing event simply lacks the new field and new code treats absence as "historical/unprovenanced," never an error.
- Golden replay byte-stability preserved: `tests/golden/manufacturing-replay.test.ts` stays green with no fixture regeneration.
- Single event log = single source of truth: no separate `judgments` store, no `judgmentId` foreign-key indirection.
- No new model I/O inside `assertCommandPhase` or the transaction commit; the model call happens exactly once per command, outside the lock.
- No new transaction adapter, feature flag, `RoleAgentFactory`, `PersistenceAdapter`, or `ProfileRepository` abstraction (that is Phase 2).
- Verify `npm run typecheck` and `npm test` after every task; commit at the end of each task.

---

### Task 1: `JudgmentProvenance` schema + `AgentInvocationResult.rawOutputDigest`

**Files:**
- Create: `src/core/judgment.ts`
- Modify: `src/agents/agent-runtime.ts:11-16` (add `rawOutputDigest`)
- Modify: `src/integrations/direct/direct-runtime.ts` (compute digest, ~199-203)
- Modify: `src/agents/fixture-runtime.ts:40` (return `rawOutputDigest`)
- Modify: `tests/e2e/cli-flow.test.ts:334` and any other `implements AgentRuntime` test double (grep) to return `rawOutputDigest`

**Interfaces:**
- Consumes: `sha256Hex`/`canonicalJson` pattern from `src/core/event-store.ts` (reuse the same helper idiom; do not import the module-private one).
- Produces: `JudgmentProvenance`, `JudgmentProvenanceSchema` (Task 2 consumes); `AgentInvocationResult.rawOutputDigest` (Task 2 consumes).

**Refinement note (visible deviation from spec):** the spec's envelope listed `value: T`. Since the envelope is *inline* on an event that already carries the judgment as its own field (`assessment` / `result` / `review`), the persisted `judgment` field is **provenance-only** — it does not duplicate `value`. The full envelope is reconstructable as `{ value: event.<payloadField>, ...event.judgment }`.

- [ ] **Step 1: Write the failing schema test**

Create `tests/unit/judgment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { JudgmentProvenanceSchema, type JudgmentProvenance } from "../../src/core/judgment";

const valid: JudgmentProvenance = {
  judgmentId: "cmd-1:coach",
  invocationId: "cmd-1:coach",
  modelId: "deepseek-v4-pro",
  promptDigest: "a".repeat(64),
  schemaVersion: 1,
  scenarioDigest: "b".repeat(64),
  rawOutputDigest: "c".repeat(64),
};

describe("JudgmentProvenance", () => {
  it("accepts a complete provenance", () => {
    expect(JudgmentProvenanceSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a truncated digest", () => {
    expect(
      JudgmentProvenanceSchema.safeParse({ ...valid, promptDigest: "short" }).success,
    ).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(
      JudgmentProvenanceSchema.safeParse({ ...valid, chainOfThought: "LEAK" }).success,
    ).toBe(false);
  });

  it("modelRevision and temperature are optional", () => {
    expect(JudgmentProvenanceSchema.safeParse(valid).success).toBe(true);
    expect(
      JudgmentProvenanceSchema.safeParse({ ...valid, modelRevision: "v2", temperature: 0.3 }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/judgment.test.ts`
Expected: FAIL — module `../../src/core/judgment` not found.

- [ ] **Step 3: Create `src/core/judgment.ts`**

```ts
import { z } from "zod";

/**
 * FDE Gym — provenance for a single model judgment.
 *
 * Attached (optionally) to judgment-bearing events so "who judged, with which
 * model and prompt, and why a score changed when the model changed" is
 * answerable from the committed event log. Provenance-only: the judgment's
 * value lives in the event's own payload field (`assessment` / `result` /
 * `review`); this envelope never duplicates it and never carries raw output —
 * only its digest.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const JudgmentProvenanceSchema = z
  .object({
    /** Deterministic id, e.g. `<commandId>:<role>` — correlates to the invocation. */
    judgmentId: z.string().min(1),
    invocationId: z.string().min(1),
    modelId: z.string().min(1).nullable(),
    modelRevision: z.string().min(1).optional(),
    /** sha256 of the rendered role prompt. */
    promptDigest: z.string().regex(SHA256_HEX),
    /** The role output schema version that validated `value`. */
    schemaVersion: z.number().int().positive(),
    /** The verified scenario-bundle digest recorded at run start. */
    scenarioDigest: z.string().regex(SHA256_HEX),
    temperature: z.number().optional(),
    /** sha256 of the pre-validation raw output (raw text never persisted). */
    rawOutputDigest: z.string().regex(SHA256_HEX),
  })
  .strict();

export type JudgmentProvenance = z.infer<typeof JudgmentProvenanceSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/judgment.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add `rawOutputDigest` to `AgentInvocationResult`**

In `src/agents/agent-runtime.ts`, change the interface:

```ts
export interface AgentInvocationResult<TOutput> {
  invocationId: string;
  output: TOutput;
  /** The configured model family identifier, or `null` when the runtime has none. */
  modelId: string | null;
  /** sha256 of the raw output BEFORE sanitization/validation. Raw text is never persisted. */
  rawOutputDigest: string;
}
```

- [ ] **Step 6: Compute it in `DirectModelRuntime`**

In `src/integrations/direct/direct-runtime.ts`, add a module helper (near `tryExtractJson`):

```ts
import { createHash } from "node:crypto";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
```

The raw string is `content` (already extracted at line 161). Compute the digest immediately after the empty-check and return it (the return is at ~199-203):

```ts
    return {
      invocationId: options.invocationId,
      output: sanitized.output,
      modelId: this.model,
      rawOutputDigest: sha256Hex(content),
    };
```

- [ ] **Step 7: Update `FixtureAgentRuntime` and test doubles**

`src/agents/fixture-runtime.ts` returns a canned result; add `rawOutputDigest` to its return object (digest the fixture's `output` via the same `sha256Hex(canonicalJson(output))` idiom, or a stable placeholder — pick the digest of the fixture output). Update every `implements AgentRuntime` test double found by:

```bash
rg -n "implements AgentRuntime" src/ tests/ --type ts
```

to also return `rawOutputDigest`.

- [ ] **Step 8: Verify + commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "feat: add JudgmentProvenance schema and rawOutputDigest to invocation result"
```

---

### Task 2: Surface invocation provenance from agent functions + attach envelope to events

**Files:**
- Modify: `src/core/domain.ts` (add optional `judgment` field to `QuestionAssessedEventSchema`, `BriefValidatedEventSchema`, `ReviewCompletedEventSchema`)
- Modify: `src/agents/evidence-tracker.ts:92-127` (surface `modelId`, `rawOutputDigest`, `promptDigest`)
- Modify: `src/agents/coach.ts:141-168` (`validateProblemBrief`) and `:184-211` (`runFinalReview`)
- Modify: `src/core/orchestrator.ts` (`prepareDiscoveryTurn` ~270, `prepareRepairPendingEvidence` ~347, `prepareFramingGate` ~453, `prepareReview` ~1089)

**Interfaces:**
- Consumes: `JudgmentProvenanceSchema`, `type JudgmentProvenance` (Task 1); `AgentInvocationResult.rawOutputDigest` (Task 1).
- Produces: a `judgment: JudgmentProvenance` field on `question.assessed`, `brief.validated`, `review.completed` events. The agent functions each expose `modelId`, `rawOutputDigest`, `promptDigest` to the orchestrator.

**Design:** the three judgment-bearing events (`question.assessed` — Evidence Tracker; `brief.validated` — Coach brief-validation; `review.completed` — Coach final-review) each gain an optional `judgment` field. The customer's `customer.replied` is prose and does **not** get an envelope. The orchestrator assembles the envelope from what the agent function surfaces plus the static bits it already holds (`scenarioDigest` from `run.started`, `schemaVersion` from the role output schema constant, `modelRevision`/`temperature` from runtime config when known).

- [ ] **Step 1: Add `judgment` to the three event schemas**

In `src/core/domain.ts`, import `JudgmentProvenanceSchema` from `./judgment.js` and add `judgment: JudgmentProvenanceSchema.optional()` to each:

`QuestionAssessedEventSchema` (~677):

```ts
export const QuestionAssessedEventSchema = z
  .object({
    type: z.literal("question.assessed"),
    ...EVENT_BASE,
    questionId: z.string().min(1),
    assessment: QuestionAssessmentSchema,
    judgment: JudgmentProvenanceSchema.optional(),
  })
  .strict();
```

`BriefValidatedEventSchema` (~728): add `judgment: JudgmentProvenanceSchema.optional(),` after `result`.

`ReviewCompletedEventSchema` (~770): add `judgment: JudgmentProvenanceSchema.optional(),` after `review`.

- [ ] **Step 2: Write a failing test for envelope attachment**

In `tests/unit/judgment.test.ts` (append), assert the three event schemas accept the `judgment` field:

```ts
import { QuestionAssessedEventSchema } from "../../src/core/domain";

it("question.assessed accepts an optional judgment envelope", () => {
  const ok = QuestionAssessedEventSchema.safeParse({
    type: "question.assessed",
    runId: "run-1",
    commandId: "cmd-1:evidence",
    seq: 1,
    logicalTime: 1,
    previousHash: "",
    hash: "d".repeat(64),
    questionId: "cmd-1",
    assessment: { atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
    judgment: valid,
  });
  expect(ok.success).toBe(true);
});
```

(Adjust `assessment` to the exact `QuestionAssessmentSchema` shape — grep it in `domain.ts`; the test must pass `RecordedEventSchema`'s envelope fields too, or parse the domain event type directly. If `QuestionAssessedEventSchema` does not include the envelope fields, drop `seq/logicalTime/previousHash/hash`.)

- [ ] **Step 3: Surface provenance in the agent functions**

`src/agents/evidence-tracker.ts` — change the return to include the provenance it already half-has (`safe.invocationId`) plus `modelId` (from `result.modelId`) and `rawOutputDigest` (from `result.rawOutputDigest`) and `promptDigest` (digest of the rendered prompt). The function already renders `renderEvidenceTrackerPrompt(input)`:

```ts
  return {
    patch: validated.patch,
    questionAssessment: validated.questionAssessment,
    invocationId: safe.invocationId,
    modelId: result.modelId,
    rawOutputDigest: result.rawOutputDigest,
    promptDigest: sha256Hex(renderEvidenceTrackerPrompt(input)),
  };
```

(Add a module-local `sha256Hex` helper, same as Task 1.)

`src/agents/coach.ts` — `validateProblemBrief` currently returns `BriefValidationResult` directly. Change it to return `{ result: BriefValidationResult; invocationId: string; modelId: string | null; rawOutputDigest: string; promptDigest: string }`, and update `prepareFramingGate` accordingly (it already destructures `coachResult`). `runFinalReview` already returns `{ review, invocationId, modelId }` — add `rawOutputDigest` and `promptDigest`.

- [ ] **Step 4: Assemble + attach the envelope in the orchestrator**

In each `prepare*` site, build the `JudgmentProvenance` and add it to the event. Representative — `prepareReview` (`orchestrator.ts:1089`):

```ts
  const reviewEvent: RunEvent = {
    type: "review.completed",
    runId,
    commandId,
    review,
    judgment: {
      judgmentId: `${commandId}:coach`,
      invocationId,
      modelId,
      promptDigest,          // surfaced by runFinalReview
      schemaVersion: FINAL_REVIEW_OUTPUT_SCHEMA_VERSION, // see coach output schema
      scenarioDigest: scenarioBundleSha256 ?? "",
      rawOutputDigest,       // surfaced by runFinalReview
    },
  };
```

Wire the equivalent at `question.assessed` (both `prepareDiscoveryTurn` and `prepareRepairPendingEvidence`) and `brief.validated` (`prepareFramingGate`), pulling `scenarioDigest` from the `run.started` event (`events.find(e => e.type === "run.started")?.scenarioBundleDigest ?? ""`).

**Threading note (do not invent a second store):** only `prepareReview` receives `events` in its input — `prepareDiscoveryTurn`, `prepareRepairPendingEvidence`, and `prepareFramingGate` do **not**. For those three, thread the digest through their input types by adding an optional `scenarioBundleDigest?: string` field (the CLI's `startCommand`/`loadRun` already holds it, or it is the `started.scenarioBundleDigest` the CLI passed to `start`). Where a legacy run genuinely lacks a digest, pass `""` (the schema's `scenarioDigest` is 64-hex, so make the field `z.string().regex(SHA256_HEX).or(z.literal(""))` or thread it as non-optional for new runs). Keep the digest provenance, never the raw bundle.

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm test   # golden replay must stay green
git add -A && git commit -m "feat: attach JudgmentProvenance to judgment-bearing events"
```

---

### Task 3: `RUN_VERSION_CONFLICT` error + `readHead`

**Files:**
- Modify: `src/core/errors.ts` (add code + class)
- Modify: `src/core/event-store.ts` (add `readHead`)

**Interfaces:**
- Consumes: the error-class pattern in `errors.ts`.
- Produces: `RUN_VERSION_CONFLICT`, `RunVersionConflictError`; `readHead(runId, options): Promise<{ seq: number; hash: string } | null>` (Task 4 consumes).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/event-store.test.ts` (or a focused `tests/unit/read-head.test.ts`):

```ts
it("readHead returns null for a run with no events and the last hash after append", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "fde-head-"));
  expect(await readHead("run-1", { baseDir })).toBeNull();
  await appendEvents("run-1", [{ type: "run.started", runId: "run-1", commandId: "start", scenarioId: "s", locale: "zh-CN" }], { baseDir });
  const head = await readHead("run-1", { baseDir });
  expect(head).not.toBeNull();
  expect(head!.seq).toBe(1);
});
```

- [ ] **Step 2: Run it to verify it fails** — `readHead` not exported.

- [ ] **Step 3: Add the error**

In `src/core/errors.ts`, add the code constant, the `FdeErrorCode` union member, and the class:

```ts
export const RUN_VERSION_CONFLICT = "RUN_VERSION_CONFLICT" as const;
// (add `| typeof RUN_VERSION_CONFLICT` to FdeErrorCode)

/** A command's prepared plan is stale: the run's event-log head moved between prepare and commit. */
export class RunVersionConflictError extends FdeError {
  readonly runId: string;
  constructor(runId: string) {
    super(RUN_VERSION_CONFLICT, `run version conflict: ${runId}`);
    this.name = "RunVersionConflictError";
    this.runId = runId;
  }
}
```

- [ ] **Step 4: Add `readHead` to `event-store.ts`**

```ts
/** The committed log head — `{ seq, hash }` of the last recorded event, or `null` for an empty/absent run. */
export async function readHead(
  runId: string,
  options: StoreOptions = {},
): Promise<{ seq: number; hash: string } | null> {
  assertSafeResourceId("run", runId);
  const baseDir = options.baseDir ?? resolveBaseDir();
  const file = eventsFile(baseDir, runId);
  if (!(await fileExists(file))) return null;
  const { events } = await readEventsAndPrefix(baseDir, runId);
  if (events.length === 0) return null;
  const last = events[events.length - 1];
  return { seq: last.seq, hash: last.hash };
}
```

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "feat: add RUN_VERSION_CONFLICT error and readHead"
```

---

### Task 4: Optimistic concurrency in `executeCommandTransaction`

**Files:**
- Modify: `src/core/command-transaction.ts:256-340`

**Interfaces:**
- Consumes: `readHead` (Task 3), `RunVersionConflictError` (Task 3), `withRunLock` (existing).
- Produces: a transaction whose `prepare()` runs outside the lock and whose commit re-checks the head.

**Semantics:** read head (short lock) → release → `prepare()` (model call, no lock) → re-acquire lock → head unchanged? write prepared journal + append + effects + committed journal : throw `RunVersionConflictError`. Never re-invoke the model.

- [ ] **Step 1: Write the failing test**

Append to the transaction test (locate via `rg -n "executeCommandTransaction" tests/` — likely `tests/contracts/orchestrator.test.ts` or a dedicated `tests/contracts/command-transaction.test.ts`; create the latter if none exists). Two cases:

```ts
it("does not re-invoke prepare when the head is unchanged", async () => {
  let calls = 0;
  const prepare = async () => { calls += 1; return { events: [], result: { ok: true } }; };
  await executeCommandTransaction({ runId: "run-1", commandId: "cmd-1", request: { type: "ask", question: "q", stakeholderId: "s" }, store: { baseDir }, prepare });
  expect(calls).toBe(1);
});

it("throws RUN_VERSION_CONFLICT (without re-running prepare) when the head moves", async () => {
  await appendEvents("run-1", [{ type: "run.started", runId: "run-1", commandId: "start", scenarioId: "s", locale: "zh-CN" }], { baseDir });
  let calls = 0;
  const prepare = async () => { calls += 1; /* simulate another writer committing here */ await appendEvents("run-1", [{ type: "phase.changed", runId: "run-1", commandId: "other", from: "SCENARIO", to: "SCENARIO" }], { baseDir }); return { events: [], result: { ok: true } }; };
  await expect(executeCommandTransaction({ runId: "run-1", commandId: "cmd-2", request: { type: "ask", question: "q", stakeholderId: "s" }, store: { baseDir }, prepare })).rejects.toMatchObject({ code: "RUN_VERSION_CONFLICT" });
  expect(calls).toBe(1);
});
```

- [ ] **Step 2: Run it to verify it fails** — current code holds the lock across prepare, so the second case does not throw and the first already passes (no head check exists).

- [ ] **Step 3: Restructure the transaction**

Replace the single `withRunLock(..., async (lock) => {...})` block in `executeCommandTransaction` with:

```ts
  const storeBase: StoreOptions = { baseDir };

  // 1. Read the committed head under a short lock, then release.
  let headBefore: { seq: number; hash: string } | null = null;
  await withRunLock(runId, storeBase, async () => {
    headBefore = await readHead(runId, storeBase);
  });

  // 2. Model call OUTSIDE the lock.
  const plan = await options.prepare();
  const events = plan.events ?? [];
  const result = plan.result;
  const effects = plan.effects ?? [];
  validatePlan(events, result, effects);

  // 3. Re-acquire the lock and commit iff the head is unchanged.
  return withRunLock(runId, storeBase, async (lock) => {
    const store: StoreOptions = { baseDir, lock };
    const existing = await readJournal(path);

    if (existing) {
      if (existing.requestHash !== requestHash) throw new CommandIdConflictError(runId, commandId);
      if (existing.status === "committed") return existing.result as T;
      await appendEvents(runId, existing.events, store);
      await applyEffects(existing.effects, baseDir, lock);
      await writeJournal(path, { ...existing, status: "committed" }, canaries);
      return existing.result as T;
    }

    const headNow = await readHead(runId, store);
    if (!sameHead(headBefore, headNow)) {
      throw new RunVersionConflictError(runId);
    }

    const prepared: PreparedCommand<JsonValue> = {
      journalVersion: JOURNAL_VERSION, runId, commandId, requestHash,
      status: "prepared", events, result, effects,
    };
    await writeJournal(path, prepared, canaries);
    await appendEvents(runId, events, store);
    await applyEffects(effects, baseDir, lock);
    await writeJournal(path, { ...prepared, status: "committed" }, canaries);
    return result as T;
  });
```

Add a module-local helper:

```ts
function sameHead(
  a: { seq: number; hash: string } | null,
  b: { seq: number; hash: string } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.seq === b.seq && a.hash === b.hash;
}
```

Preserve the existing `assertSafeResourceId` checks and `requestHash`/`path` setup at the top (unchanged).

- [ ] **Step 4: Run the focused test, then the full suite**

Run: `npx vitest run <transaction-test-file>`
Then: `npm run typecheck && npm test` — CLI e2e and golden replay must stay green (the single-process CLI never hits the conflict path).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: optimistic concurrency — model call outside the run lock"
```

---

### Task 5: Score three-states (`measured` / `proxy` / `unscorable`)

**Files:**
- Modify: `src/scoring/provenance.ts` (`StageScoreProvenance` gains `state`)
- Modify: `src/scoring/score-input.ts` (`deriveStageScores` + `buildScoreInput` compute the state)
- Modify: `src/core/domain.ts` if the state is surfaced in `ScoreBreakdown` (only if additive)

**Interfaces:**
- Consumes: `deriveStageProvenance` (existing), `fallbackStageScores` inputs (existing).
- Produces: a per-stage `state: "measured" | "proxy" | "unscorable"` derived from `source` + fallback signals; surfaced alongside the score (CLI `review` output and profile fold). Does **not** change the committed `score.computed` bytes.

**Design:** `measured` = `source === "model"`. `proxy` = `source === "deterministic-fallback"` AND a meaningful deterministic signal exists. `unscorable` = `source === "deterministic-fallback"` AND no meaningful signal (vacuous "no challenges → 100", "no proposal → 0", "no pitch ask → 0"). The vacuous cases are detected from the same fallback inputs already in `buildScoreInput`.

- [ ] **Step 1: Write the failing test**

Append to the scoring test (`rg -n "deriveStageScores|fallbackStageScores|buildScoreInput" tests/`):

```ts
it("classifies a stage with criterion scores as measured", () => {
  const { state } = classifyStage("solution", { source: "model" }, { proposalPresent: true });
  expect(state).toBe("measured");
});
it("classifies a meaningful fallback as proxy", () => {
  const { state } = classifyStage("solution", { source: "deterministic-fallback" }, { proposalPresent: true });
  expect(state).toBe("proxy");
});
it("classifies a vacuous fallback as unscorable", () => {
  const { state } = classifyStage("challenge", { source: "deterministic-fallback" }, { mandatoryChallenges: 0 });
  expect(state).toBe("unscorable");
});
```

- [ ] **Step 2: Run it to verify it fails** — `classifyStage` not defined.

- [ ] **Step 3: Implement the classification**

In `src/scoring/provenance.ts`, extend `StageScoreProvenance`:

```ts
export type StageScoreState = "measured" | "proxy" | "unscorable";

export interface StageScoreProvenance {
  source: "model" | "deterministic-fallback";
  /** Coarse classification surfaced to the learner: is this a real measurement? */
  state: StageScoreState;
  fallbackReason?: string;
}
```

In `src/scoring/score-input.ts`, add a `classifyStage` helper (exported for the test) that takes `(stage, provenance, fallbackSignals)` where `fallbackSignals` is `{ proposalPresent, mandatoryChallenges, pitchExplicitAsk, briefSupport, hasBrief }`, and wire `state` into `deriveStageScores` / `deriveStageProvenance`. Then surface the per-stage states in the CLI `review` output and in `deriveAttemptReview` (so `proxy` stages do not enter the capability total / are labeled distinctly). Keep the committed `score.computed` and its `final`/`raw` numbers unchanged.

- [ ] **Step 4: Run the focused test + full suite**

```bash
npx vitest run <scoring-test-file>
npm run typecheck && npm test   # golden replay must stay green
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: three-state score classification (measured/proxy/unscorable)"
```

---

### Task 6: Profile lock

**Files:**
- Modify: `src/storage/run-lock.ts` (generalize, or add `withProfileLock`)
- Modify: `src/storage/fs-store.ts:52-69` (`applyProfileAttemptEffect` acquires the lock)

**Interfaces:**
- Consumes: the `acquire`/`release`/`isDeadPid`/`readOwner` machinery in `run-lock.ts` (module-private — reuse by generalizing).
- Produces: `applyProfileAttemptEffect` is atomic across runs (no lost update).

**Design:** the profile fold (read → update → write) is currently lock-free. Add a profile lock keyed by a fixed learner id (`"learner"`), held at `<baseDir>/profile.lock`, reusing the same pid/stale-lock logic. The single learner per machine makes a fixed key correct.

- [ ] **Step 1: Write the failing test**

Append to a profile test (`rg -n "applyProfileAttemptEffect" tests/`):

```ts
it("serializes concurrent profile folds (no lost update)", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "fde-profile-"));
  await Promise.all(
    [1, 2, 3].map((n) =>
      applyProfileAttemptEffect(`effect-${n}`, `run-${n}`, { ...review(n) }, { baseDir }),
    ),
  );
  const profile = await loadLearnerProfile({ baseDir });
  expect(profile!.appliedEffectIds.sort()).toEqual(["effect-1", "effect-2", "effect-3"]);
});
```

(Provide a `review(n)` helper producing a valid `AttemptReview`; mirror the existing fixture in the profile test file.)

- [ ] **Step 2: Run it to verify it fails or is racy** — without a lock, the read-modify-write interleaves and one effect id is lost.

- [ ] **Step 3: Generalize the lock**

In `src/storage/run-lock.ts`, extract a `withNamedLock<T>(key: string, lockPath: string, work: () => Promise<T>)` (or add `withProfileLock`) that reuses `acquire`/`release`. Then in `src/storage/fs-store.ts`, wrap the body of `applyProfileAttemptEffect`:

```ts
  const baseDir = options.baseDir ?? resolveBaseDir();
  return withProfileLock(baseDir, async () => {
    const base = (await loadLearnerProfile(options)) ?? createEmptyProfile();
    if (base.appliedEffectIds.includes(effectId)) return base;
    const updated = updateLearnerProfile(base, review);
    const complete: LearnerProfile = {
      ...updated,
      appliedEffectIds: [...updated.appliedEffectIds, effectId],
      appliedRunIds: [...updated.appliedRunIds, runId],
    };
    await saveLearnerProfile(complete, options);
    return complete;
  });
```

`withProfileLock` holds `<baseDir>/profile.lock` (a JSON owner like the run lock, key `"learner"`).

- [ ] **Step 4: Verify + commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "feat: serialize profile fold with a profile lock"
```

---

## Execution order summary

| Task | Item | Depends on |
|---|---|---|
| 1 | `JudgmentProvenance` + `rawOutputDigest` | — |
| 2 | Attach envelope to judgment events | 1 |
| 3 | `RUN_VERSION_CONFLICT` + `readHead` | — |
| 4 | Optimistic concurrency | 3 |
| 5 | Three-state score | 1, 2 |
| 6 | Profile lock | — |

**Recommended serial order:** 1 → 2 → 3 → 4 → 5 → 6.

## Verification checklist

- [ ] `npm run release:gate` green at the end.
- [ ] Golden replay byte-stable (no fixture regeneration across all tasks).
- [ ] `appendEvents` still confined to event-store + command-transaction internals.
- [ ] No committed event rewritten; old events (no `judgment`, no `state`) still load and replay.
- [ ] The capability score no longer presents a proxy as a measured score.
