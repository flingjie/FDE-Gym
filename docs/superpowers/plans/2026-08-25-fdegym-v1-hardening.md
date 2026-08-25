# FDEGym V1 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the frozen FDEGym MVP v1 specification baseline into a release-candidate implementation whose real Codex role boundary, run persistence, scenario integrity, scoring provenance, and release gates are explicit and recoverable.

**Architecture:** Keep the current TypeScript/Node local-file architecture, three fixed model roles, event-sourced run state, and learner-safe replay. Add a run-scoped single-writer boundary plus a write-ahead command transaction journal; make model calls consume rendered role prompts, complete JSON schemas, and per-invocation canaries; make compiled scenario bundles the only runtime source; separate format versions and persist scoring provenance. Existing v1 run logs remain readable by the new reader, while old binaries are not promised to read new-format logs.

**Tech Stack:** TypeScript 5.9 ESM, Node.js >=22, Zod 4.4.3, Vitest 4.1, YAML 2.9, Node built-ins only for persistence and locking.

## Global Constraints

- “MVP v1 frozen” means specification and acceptance-baseline freeze; it does **not** mean release-ready.
- Release remains blocked while a live Codex probe returns `safeForStrictMode !== true`.
- Determinism means committed events → state/replay and fixed score inputs → score; repeated model generation is not deterministic.
- Preserve the three-role topology: `customer`, `evidence_tracker`, `coach_evaluator`.
- Preserve fresh, ephemeral, read-only, tools-disabled Codex sessions; never use session resume.
- Never persist raw model output, reasoning, system prompts, canary values, or hidden capsule objects in learner-visible projections.
- Preserve current v1 run readability and recorded-replay byte stability for committed v1 fixtures.
- Runtime scenarios come only from a verified compiled bundle; source YAML is build-time input only.
- Do not add a database or third-party locking package; use Node.js built-ins.
- Every behavioral change is test-first and ends at an independently reviewable commit gate.
- Implementation begins in an isolated worktree created through `superpowers:using-git-worktrees`.

---

## Phase 0: Documentation Discovery and Allowed APIs

### Sources consulted

- Runtime contract and Codex execution:
  - `src/agents/agent-runtime.ts:4-32`
  - `src/integrations/codex/codex-runtime.ts:41-284`
  - `src/integrations/codex/capability-probe.ts:84-604`
- Existing role prompt renderers and schemas:
  - `src/agents/customer.ts:27-120`
  - `src/agents/evidence-tracker.ts:27-120`
  - `src/agents/coach.ts:42-216`
  - `src/agents/contracts.ts:39-205`
  - `resources/prompts/customer.md:1-19`
  - `resources/prompts/evidence-tracker.md:1-18`
  - `resources/prompts/coach-evaluator.md:1-20`
- Context and output safety:
  - `src/security/context-firewall.ts:79-357`
  - `src/security/sanitizer.ts:19-110`
- Run/event persistence:
  - `src/core/event-store.ts:1-272`
  - `src/core/errors.ts:1-86`
  - `src/core/domain.ts:452-855`
- Discovery pending behavior:
  - `src/core/orchestrator.ts:78-343`
  - `src/cli/commands.ts:222-347`
  - `src/replay/projector.ts:152-260`
- Profile and multi-resource writes:
  - `src/storage/fs-store.ts:1-77`
  - `src/profile/learner-profile.ts:53-177`
  - `src/core/orchestrator.ts:880-1080`
- Scenario source and compiler:
  - `src/scenarios/compiler.ts:43-151`
  - `src/scenarios/loader.ts:1-163`
  - `src/scenarios/schema.ts:21-387`
- Scoring and replay:
  - `src/scoring/rubric.ts:2-132`
  - `src/scoring/formulas.ts:43-224`
  - `src/scoring/score-input.ts:79-344`
  - `src/replay/projector.ts:42-431`
- Existing test patterns:
  - `tests/contracts/codex-runtime.test.ts:100-253`
  - `tests/contracts/orchestrator.test.ts:150-235`
  - `tests/unit/event-store.test.ts:1-152`
  - `tests/e2e/cli-flow.test.ts:292-358`
- Product contracts:
  - `docs/architecture.md:3-120`
  - `docs/scoring.md:3-151`
  - `docs/replay.md:3-65`
  - `docs/mvp-acceptance.md:8-85`

### Allowed existing APIs

```ts
AgentRuntime.invoke<TInput, TOutput>(role, input, options)
renderCustomerPrompt(input)
renderEvidenceTrackerPrompt(input)
renderCoachPrompt(input)
buildRoleInput(role, state, capsule)
roleInputSchema(role)
sanitizeAgentResult(role, result, outputSchema, options)
z.toJSONSchema(schema)
runCodex(executable, options)
probeCodexCapabilities(config)
canonicalJson(value)
appendEvents(runId, events, options)
loadEvents(runId, options)
loadRun(runId, options)
foldRunAggregate(events, scenarioId, locale)
projectReplay(events, locale)
computeStageScore(stage, criterionScores)
buildScoreInput(options)
calculateScore(input)
```

### Node.js built-ins allowed behind storage modules

```ts
open(path, "wx")
FileHandle.writeFile(data)
FileHandle.sync()
FileHandle.close()
rename(from, to)
truncate(path, length)
unlink(path)
mkdir(path, { recursive: true })
stat(path)
createHash("sha256")
randomUUID()
hostname()
```

### Anti-pattern guards established by discovery

- Do not keep the generic `buildPrompt(input, repair)` as the production role prompt.
- Do not pass `{ "type": "object" }` as the Codex output schema.
- Do not rely on wrapper-only canary scanning; raw stdout/stderr needs per-call canaries.
- Do not treat `appendEvents()` as concurrency-safe or end-to-end idempotent.
- Do not use check-then-append to prevent duplicate `start`.
- Do not leave a malformed trailing JSONL fragment in place before the next write.
- Do not use an in-process mutex as the cross-process writer boundary.
- Do not load `scenarios/source/*.yaml` at runtime.
- Do not treat current scenario `manifest.json` as an integrity proof.
- Do not describe model-derived judgments as deterministic.
- Do not mix `EvaluatorCapsule.rubric` with the fixed capability `RUBRIC`.
- Do not run recorded replay by invoking a model.

---

## File and Responsibility Map

### New files

- `src/storage/atomic-file.ts` — atomic same-filesystem file replacement and directory sync.
- `src/storage/run-lock.ts` — cross-process run lock with owner token and dead-owner recovery.
- `src/core/command-transaction.ts` — write-ahead command journal, request fingerprinting, event/effect recovery, and result replay.
- `src/agents/output-validation.ts` — input-dependent Customer, Tracker, brief-review, and criterion membership checks.
- `src/scenarios/bundle.ts` — manifest schemas, bundle digest verification, and role-safe runtime bundle API.
- `src/core/versioning.ts` — separate run/event/scenario/score/rubric versions and pure event upcasters.
- `src/scoring/provenance.ts` — scoring-source and comparability metadata.
- `scripts/release-gate.mjs` — structural suite plus live doctor release gate.
- `tests/fixtures/runs/v1/manufacturing/events.jsonl` — frozen previous-reader compatibility fixture.
- `tests/fixtures/runs/v1/manufacturing/manifest.json` — its v1 run manifest.

### Existing files with changed responsibilities

- `src/agents/agent-runtime.ts` — invocation contract includes rendered prompt and per-call canaries.
- `src/integrations/codex/codex-runtime.ts` — executes supplied prompt and complete JSON schema only.
- `src/agents/{customer,evidence-tracker,coach}.ts` — render prompt, pass canaries, validate domain membership.
- `src/core/domain.ts` — pending/resolved events, event revision, score provenance, stable error/event schemas.
- `src/core/event-store.ts` — logical append under run lock using atomic replacement and v1/v2 reader.
- `src/core/orchestrator.ts` — prepares complete command batches/effects; no partial multi-write sequences.
- `src/cli/commands.ts` — every mutating command goes through command transactions.
- `src/replay/projector.ts` — reconstructs pending state and reads upcast events/provenance.
- `src/profile/learner-profile.ts` — records applied effect IDs/run IDs for exactly-once projection.
- `src/storage/fs-store.ts` — atomic profile writes and idempotent profile effect application.
- `src/scenarios/compiler.ts` — emits `events.json`, hashes artifacts, stages and atomically publishes bundles.
- `src/scenarios/loader.ts` — delegates to one manifest-root `loadScenarioBundle` API.
- `docs/{architecture,security-model,scenario-authoring,scoring,replay,mvp-acceptance}.md` — corrected determinism, version, safety, and release semantics.

---

## Phase 1: Wire the Real Codex Role Contract

### Task 1: Rendered prompts, complete JSON schemas, and per-call canaries

**Files:**
- Modify: `src/agents/agent-runtime.ts:9-32`
- Modify: `src/agents/fixture-runtime.ts:33-47`
- Modify: `src/agents/customer.ts:70-120`
- Modify: `src/agents/evidence-tracker.ts:62-120`
- Modify: `src/agents/coach.ts:112-216`
- Modify: `src/integrations/codex/codex-runtime.ts:82-284`
- Modify: `tests/contracts/fake-codex-runtime.mjs:1-113`
- Modify: `tests/contracts/codex-runtime.test.ts:100-253`
- Test: `tests/contracts/customer-agent.test.ts`
- Test: `tests/contracts/evidence-tracker-agent.test.ts`
- Test: `tests/contracts/coach-agent.test.ts`

**Interfaces:**
- Consumes: the existing three prompt renderers and strict Zod output schemas.
- Produces:

```ts
export interface AgentInvokeOptions<TOutput> {
  runId: string;
  invocationId: string;
  freshContext: true;
  tools: "disabled";
  prompt: string;
  canaries: readonly string[];
  outputSchema: z.ZodType<TOutput>;
  timeoutMs: number;
}
```

- [ ] **Step 1: Write failing runtime tests for prompt, schema, and per-call raw leak**

Add capture paths to the fake runtime and extend `invokeOptions`:

```ts
const invokeOptions = (invocationId = "inv-1") => ({
  runId: "r1",
  invocationId,
  freshContext: true as const,
  tools: "disabled" as const,
  prompt: "CUSTOMER ROLE\n<UNTRUSTED_LEARNER_INPUT>question</UNTRUSTED_LEARNER_INPUT>",
  canaries: ["PER_CALL_CANARY"],
  outputSchema: CustomerOutputSchema,
  timeoutMs: 10_000,
});
```

Add assertions that the fake child received the supplied prompt and a schema containing `properties.reply`, `required`, and `additionalProperties: false`. Add a raw-stdout mode that emits `PER_CALL_CANARY` while the runtime config has no global canaries; expect `LEAK_GUARD_TRIGGERED`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
npm test -- tests/contracts/codex-runtime.test.ts
```

Expected: failures because `prompt` and per-call `canaries` are not accepted and the schema file is still `{ "type": "object" }`.

- [ ] **Step 3: Extend the runtime interface and fixture runtime**

Use the exact interface above in `agent-runtime.ts`. Keep fixture validation authoritative:

```ts
const output = options.outputSchema.parse(raw);
return { invocationId: options.invocationId, output };
```

The fixture runtime may ignore `prompt` and `canaries`, but its method signature must accept them.

- [ ] **Step 4: Pass rendered prompts and capsule canaries from wrappers**

Customer invocation:

```ts
prompt: renderCustomerPrompt(input),
canaries,
```

Tracker invocation:

```ts
prompt: renderEvidenceTrackerPrompt(input),
canaries,
```

Coach invocation:

```ts
prompt: renderCoachPrompt(input),
canaries,
```

Do not place canary values inside the rendered prompt or role input.

- [ ] **Step 5: Replace the weak schema and generic prompt in Codex runtime**

Write the schema with the installed Zod 4 API:

```ts
const jsonSchema = z.toJSONSchema(options.outputSchema);
await writeFile(schemaPath, JSON.stringify(jsonSchema), "utf8");
```

Use the supplied prompt, with a structural repair suffix only on attempt two:

```ts
const prompt = repair
  ? `${options.prompt}\n\nReturn only JSON matching the supplied output schema. The previous response was invalid.`
  : options.prompt;
```

Scan `stdout`, `stderr`, JSONL reasoning events, and output-file text against `options.canaries` before parsing.

- [ ] **Step 6: Run runtime and role contract tests**

Run:

```bash
npm test -- tests/contracts/codex-runtime.test.ts tests/contracts/customer-agent.test.ts tests/contracts/evidence-tracker-agent.test.ts tests/contracts/coach-agent.test.ts
```

Expected: all selected tests pass; captured prompt contains the role-specific marker; captured schema is not a one-property generic object.

- [ ] **Step 7: Anti-pattern grep**

Run:

```bash
rg 'JSON\.stringify\(\{ type: "object" \}\)|buildPrompt\(input' src/integrations/codex src/agents
```

Expected: no matches in production runtime code.

- [ ] **Step 8: Commit**

```bash
git add src/agents src/integrations/codex tests/contracts

git commit -m "fix: enforce real Codex role contracts"
```

---

## Phase 2: Validate Model Outputs Against Domain Membership

### Task 2: Reject fabricated stakeholders, disclosures, transcript sources, claims, and rubric keys

**Files:**
- Create: `src/agents/output-validation.ts`
- Modify: `src/agents/customer.ts`
- Modify: `src/agents/evidence-tracker.ts`
- Modify: `src/agents/coach.ts`
- Modify: `src/core/errors.ts`
- Test: `tests/contracts/customer-agent.test.ts`
- Test: `tests/contracts/evidence-tracker-agent.test.ts`
- Test: `tests/contracts/coach-agent.test.ts`
- Test: `tests/unit/score-input.test.ts`

**Documentation references:**
- Copy the set-membership and `ctx.addIssue` approach from `src/scenarios/schema.ts:273-385`.
- Copy the graph invariant error style from `src/evidence/graph.ts:205-320`.
- Use the fixed rubric IDs from `src/scoring/rubric.ts:35-76`.

**Interfaces:**

```ts
export const AGENT_OUTPUT_DOMAIN_INVALID = "AGENT_OUTPUT_DOMAIN_INVALID" as const;

export function validateCustomerOutput(
  input: CustomerInput,
  output: CustomerOutput,
): CustomerOutput;

export function validateEvidenceTrackerOutput(
  input: EvidenceTrackerInput,
  output: EvidenceTrackerOutput,
): EvidenceTrackerOutput;

export function validateBriefValidationOutput(
  input: BriefValidationInput,
  output: BriefValidationOutput,
): BriefValidationOutput;

export function validateFinalReviewOutput(
  input: FinalReviewInput,
  output: FinalReviewOutput,
): FinalReviewOutput;
```

- [ ] **Step 1: Write negative membership tests**

Cover these concrete cases:

```ts
expect(() => validateCustomerOutput(input, {
  reply: text,
  stakeholderId: "unknown-stakeholder",
  disclosedDisclosureUnitIds: [],
})).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
```

Also reject:

- disclosure IDs absent from `input.disclosureUnits`;
- a newly disclosed unit whose prerequisites are not in `input.disclosedDisclosureUnitIds` or the same output batch;
- Tracker fact nodes whose `sourceTranscriptIds` do not equal the current public turn ID;
- brief entailment/unsupported claim IDs absent from `input.brief.claims`;
- final-review criterion maps with unknown, missing, or duplicate fixed rubric criterion IDs.

- [ ] **Step 2: Run tests and confirm failure**

```bash
npm test -- tests/contracts/customer-agent.test.ts tests/contracts/evidence-tracker-agent.test.ts tests/contracts/coach-agent.test.ts tests/unit/score-input.test.ts
```

Expected: compile or assertion failures because validators do not exist.

- [ ] **Step 3: Implement validators as pure functions**

Use stable, payload-free errors:

```ts
function domainError(detail: string): never {
  throw new OrchestratorError(AGENT_OUTPUT_DOMAIN_INVALID, detail);
}
```

Error messages may name contract fields such as `stakeholderId`; they must not include model text, canary values, capsule prose, or raw IDs supplied only by the model.

For final review, construct the exact criterion set from `input.rubric[stage]` and require equality with `Object.keys(output.criterionScores[stage])` whenever model criterion scores are present.

- [ ] **Step 4: Call validators immediately after Zod/sanitizer success**

The order must be:

```text
raw canary scan → JSON parse → prohibited-key strip → Zod output parse → input-dependent membership validation → domain event construction
```

- [ ] **Step 5: Run focused and adversarial tests**

```bash
npm test -- tests/contracts/customer-agent.test.ts tests/contracts/evidence-tracker-agent.test.ts tests/contracts/coach-agent.test.ts tests/unit/score-input.test.ts tests/adversarial/leak-guard.test.ts
```

Expected: all selected tests pass, and unknown criterion keys can no longer force a zero-scored non-fallback stage.

- [ ] **Step 6: Commit**

```bash
git add src/agents src/core/errors.ts tests/contracts tests/unit/score-input.test.ts

git commit -m "fix: validate model output domain references"
```

---

## Phase 3: Make Evidence Pending and Clarification Budgets Durable

### Task 3: Persist pending/resolved evidence state and expose repair through CLI

**Files:**
- Modify: `src/core/domain.ts:627-840`
- Modify: `src/security/context-firewall.ts:86-151`
- Modify: `src/core/orchestrator.ts:78-343`
- Modify: `src/replay/projector.ts:152-260`
- Modify: `src/cli/commands.ts:85-347`
- Modify: `src/cli/main.ts:46-64`
- Modify: `src/cli/render.ts`
- Test: `tests/contracts/orchestrator.test.ts:172-235`
- Test: `tests/e2e/cli-flow.test.ts`
- Test: `tests/unit/event-store.test.ts`

**Interfaces:**

```ts
export const EvidencePendingEventSchema = RunEventBaseSchema.extend({
  type: z.literal("evidence.pending"),
  turnId: z.string().min(1),
  failureCode: z.string().min(1),
}).strict();

export const EvidenceResolvedEventSchema = RunEventBaseSchema.extend({
  type: z.literal("evidence.resolved"),
  turnId: z.string().min(1),
}).strict();
```

Add to `RunAggregate`:

```ts
pendingEvidence: { turnId: string; code: string } | null;
clarificationBudgetUsed: number;
```

Add CLI surface:

```ts
export interface RepairEvidenceArgs {
  runId: string;
  commandId: string;
}

export async function repairEvidenceCommand(
  ctx: CommandContext,
  args: RepairEvidenceArgs,
): Promise<CliResult<AskData>>;
```

- [ ] **Step 1: Write a reload-level failing test**

Test sequence:

```text
runDiscoveryTurn with missing Tracker fixture
→ loadEvents
→ foldRunAggregate
→ frameCommand returns FRAME_BLOCKED
→ add Tracker fixture
→ repairEvidenceCommand
→ reload
→ pendingEvidence is null
→ frameCommand succeeds
```

Assert the persisted failure event contains only `turnId` and the stable code `EVIDENCE_EXTRACTION_FAILED`, not the thrown message.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
npm test -- tests/contracts/orchestrator.test.ts tests/e2e/cli-flow.test.ts
```

Expected: failure because pending state disappears after reload and no repair CLI command exists.

- [ ] **Step 3: Add pending/resolved event schemas and aggregate folding**

Reducer behavior:

```ts
case "evidence.pending":
  return { ...aggregate, pendingEvidence: { turnId: event.turnId, code: event.failureCode } };
case "evidence.resolved":
  return aggregate.pendingEvidence?.turnId === event.turnId
    ? { ...aggregate, pendingEvidence: null }
    : aggregate;
```

Register both event types in `RunEventSchema` and initialize `pendingEvidence: null` in every aggregate constructor.

- [ ] **Step 4: Persist the pending event in the same accepted batch**

Tracker failure batch:

```ts
const pendingEvent: RunEvent = {
  type: "evidence.pending",
  runId,
  commandId: `${commandId}:evidence-pending`,
  turnId: `${commandId}:turn`,
  failureCode: failure.code,
};
await appendEvents(runId, [questionEvent, replyEvent, pendingEvent], store);
```

Repair success appends `evidence.patched`, `question.assessed`, and `evidence.resolved` as one batch.

- [ ] **Step 5: Enforce the frame gate and add repair command**

At the start of `frameCommand`:

```ts
assertFrameAllowed(loaded.aggregate.pendingEvidence);
```

`repairEvidenceCommand` must use the original ask command ID derived from the pending turn (`turnId` without `:turn`) and call `repairPendingEvidence` with the reconstructed aggregate.

- [ ] **Step 6: Persist clarification count rather than passing zero**

Increment `clarificationBudgetUsed` from committed phase-change/clarification events. Replace:

```ts
clarificationBudgetUsed: 0
```

with:

```ts
clarificationBudgetUsed: loaded.aggregate.clarificationBudgetUsed
```

Add a fourth clarification test expecting `CLARIFICATION_BUDGET_EXCEEDED` after reload.

- [ ] **Step 7: Run focused tests**

```bash
npm test -- tests/contracts/orchestrator.test.ts tests/e2e/cli-flow.test.ts tests/unit/event-store.test.ts
```

Expected: pending survives reload; repair clears it; frame blocks before repair; clarification budget survives separate CLI calls.

- [ ] **Step 8: Commit**

```bash
git add src/core src/security/context-firewall.ts src/replay src/cli tests/contracts tests/e2e tests/unit/event-store.test.ts

git commit -m "fix: persist discovery recovery gates"
```

---

## Phase 4: Establish Crash-Safe Single-Writer Storage

### Task 4: Safe IDs, run locks, atomic writes, and trailing-tail repair

**Files:**
- Create: `src/storage/atomic-file.ts`
- Create: `src/storage/run-lock.ts`
- Modify: `src/core/event-store.ts:1-272`
- Modify: `src/core/errors.ts:9-86`
- Modify: `src/core/domain.ts` ID schemas
- Modify: `src/storage/fs-store.ts:1-77`
- Test: `tests/unit/event-store.test.ts`
- Test: `tests/unit/fs-store.test.ts`
- Create: `tests/unit/run-lock.test.ts`

**Interfaces:**

```ts
export function assertSafeResourceId(kind: "run" | "scenario" | "command", id: string): void;

export async function atomicWriteFile(path: string, contents: string): Promise<void>;

export interface RunLock {
  runId: string;
  token: string;
  lockPath: string;
}

export async function withRunLock<T>(
  runId: string,
  options: StoreOptions,
  work: (lock: RunLock) => Promise<T>,
): Promise<T>;
```

Extend store options without exposing filesystem primitives above storage:

```ts
export interface StoreOptions {
  baseDir?: string;
  lock?: RunLock;
}
```

- [ ] **Step 1: Write failing ID, concurrency, crash-tail, and atomic-profile tests**

Required cases:

- `../outside`, `/absolute`, empty IDs, and path separators return stable `INVALID_RESOURCE_ID`.
- Two concurrent append attempts to the same run cannot both compute from the same head.
- A dead-owner lock is recoverable; a live-owner lock returns `RUN_LOCKED` without deleting the owner’s lock.
- An incomplete trailing line is physically removed before a later append.
- A failure before atomic rename leaves the previous profile valid.

- [ ] **Step 2: Run tests and confirm failure**

```bash
npm test -- tests/unit/event-store.test.ts tests/unit/fs-store.test.ts tests/unit/run-lock.test.ts
```

Expected: failures because IDs are unvalidated, no cross-process lock exists, tail repair is read-only, and profile writes replace the destination directly.

- [ ] **Step 3: Implement safe ID validation**

Use one exact contract:

```ts
const SAFE_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
```

Reject before every path join for runId, scenarioId, and commandId-derived filenames. Preserve full UUIDs and current hyphenated scenario IDs.

- [ ] **Step 4: Implement atomic file replacement**

Algorithm:

```text
create sibling temporary file with open("wx")
→ write complete contents
→ FileHandle.sync()
→ close
→ rename temporary file over destination
→ open parent directory and sync it
→ remove temporary file in finally when rename did not complete
```

Use this helper for `profile.json`, run manifests, command journals, and later scenario bundle publication metadata.

- [ ] **Step 5: Implement run lock ownership**

Lock file lives under:

```text
<baseDir>/runs/.locks/<runId>.lock
```

Owner JSON contains `pid`, `hostname`, and `token`. Acquire with `open(path, "wx")`; release only when the on-disk token equals the holder token. If an existing owner is on the same host and `process.kill(pid, 0)` reports `ESRCH`, remove and retry once. Do not time-expire a live PID.

- [ ] **Step 6: Replace append-in-place with logical append plus atomic replacement**

Inside `withRunLock`:

```text
read bytes
→ validate committed prefix and record last-good byte offset
→ reject middle corruption
→ discard only an incomplete trailing fragment
→ compute the new hash-chained batch
→ write valid existing lines + new lines to a sibling temp file
→ fsync + atomic rename
```

Do not change `canonicalJson`, sequence numbers, logical time, or the event hash algorithm.

- [ ] **Step 7: Make run manifest immutable after creation**

Create it with exclusive semantics for a new run. Existing appends validate it but do not rewrite it. A different command attempting another `run.started` for the same run returns `RUN_ALREADY_EXISTS`.

- [ ] **Step 8: Run storage tests twice**

```bash
npm test -- tests/unit/event-store.test.ts tests/unit/fs-store.test.ts tests/unit/run-lock.test.ts
npm test -- tests/unit/event-store.test.ts tests/unit/fs-store.test.ts tests/unit/run-lock.test.ts
```

Expected: both runs pass; no lock or temp files remain in test directories.

- [ ] **Step 9: Commit**

```bash
git add src/storage src/core/event-store.ts src/core/errors.ts src/core/domain.ts tests/unit

git commit -m "fix: make local persistence crash safe"
```

---

## Phase 5: Add End-to-End Command Transactions

### Task 5: Write-ahead command journal and deterministic result replay

**Files:**
- Create: `src/core/command-transaction.ts`
- Modify: `src/core/event-store.ts`
- Modify: `src/cli/commands.ts`
- Modify: `src/core/orchestrator.ts`
- Modify: `src/core/errors.ts`
- Test: `tests/contracts/command-transaction.test.ts`
- Test: `tests/e2e/cli-flow.test.ts`
- Test: `tests/unit/event-store.test.ts`

**Architecture decision:** Use a per-command write-ahead journal, not a response-only sidecar. The prepared journal is atomic and contains the canonical request hash, complete event batch, learner-safe result snapshot, and idempotent effects. Recovery can finish a prepared command without re-invoking a model.

**Interfaces:**

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CommandEffect =
  | { type: "profile.apply-attempt"; effectId: string; runId: string; review: AttemptReview }
  | { type: "retry.ensure-child"; effectId: string; parentRunId: string; childRunId: string; events: RunEvent[] };

export interface PreparedCommand<T extends JsonValue> {
  journalVersion: 1;
  runId: string;
  commandId: string;
  requestHash: string;
  status: "prepared" | "committed";
  events: RunEvent[];
  result: T;
  effects: CommandEffect[];
}

export interface CommandPlan<T extends JsonValue> {
  events: RunEvent[];
  result: T;
  effects?: CommandEffect[];
}

export async function executeCommandTransaction<T extends JsonValue>(options: {
  runId: string;
  commandId: string;
  request: JsonValue;
  store?: StoreOptions;
  prepare: () => Promise<CommandPlan<T>>;
}): Promise<T>;
```

- [ ] **Step 1: Write failing transaction tests**

Cover:

1. same command ID + same request returns the first stored result and calls `prepare` once;
2. same command ID + different request throws `COMMAND_ID_CONFLICT`;
3. crash after journal prepare but before event commit recovers events/result without calling `prepare` again;
4. crash after event commit but before effect/commit marker replays effects exactly once;
5. concurrent identical commands produce one journal and one event batch.

Use `canonicalJson(request)` and SHA-256 for the request hash.

- [ ] **Step 2: Run the transaction test and confirm failure**

```bash
npm test -- tests/contracts/command-transaction.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement journal state transitions**

Journal path:

```text
<baseDir>/runs/<runId>/commands/<commandId>.json
```

State machine:

```text
absent → prepare callback → atomic write prepared
prepared → append missing event batch → apply missing effects
all durable → atomic write committed
committed + matching hash → return stored result
any state + different hash → COMMAND_ID_CONFLICT
```

The journal may store domain events and the already learner-safe CLI data object; it must reject values outside `JsonValue` and must pass canary/prohibited-key checks before write.

- [ ] **Step 4: Refactor mutating orchestrator functions into preparation plus transaction commit**

Each mutating command preparation returns all events before persistence. For design submission, combine `design.submitted`, phase change, challenge injections, and interruptions in one `CommandPlan`. For review, include review/score events plus a `profile.apply-attempt` effect. Read-only `status`, `list`, `profile`, and `replay` remain outside command transactions.

- [ ] **Step 5: Wrap every mutating CLI command**

Pattern:

```ts
return executeCommandTransaction({
  runId: args.runId,
  commandId: args.commandId,
  request: { type: "ask", question: args.question, stakeholderId: args.stakeholderId },
  store: { baseDir: ctx.baseDir },
  prepare: async () => {
    const result = await prepareDiscoveryTurn(input);
    return { events: result.acceptedEvents, result: result.cliData };
  },
});
```

The actual `CliResult` envelope is reconstructed around the stored data with the persisted locale/phase; do not store raw model results.

- [ ] **Step 6: Make duplicate start semantics explicit**

Under the transaction lock:

- same `runId`, same `commandId`, same request → return first start result;
- same `runId`, same `commandId`, different scenario/locale → `COMMAND_ID_CONFLICT`;
- existing `run.started` with another command ID → `RUN_ALREADY_EXISTS`;
- no second `run.started` can be appended.

Add a regression test asserting the first and last scenario IDs can never diverge.

- [ ] **Step 7: Run CLI and persistence tests**

```bash
npm test -- tests/contracts/command-transaction.test.ts tests/e2e/cli-flow.test.ts tests/unit/event-store.test.ts
```

Expected: repeated model-backed commands do not call the fixture runtime twice and return byte-equal learner-safe data.

- [ ] **Step 8: Commit**

```bash
git add src/core src/cli src/storage tests/contracts tests/e2e tests/unit/event-store.test.ts

git commit -m "feat: add recoverable command transactions"
```

---

## Phase 6: Reconcile Cross-Resource Effects

### Task 6: Exactly-once profile projection and recoverable retry child creation

**Files:**
- Modify: `src/profile/learner-profile.ts:72-177`
- Modify: `src/storage/fs-store.ts:20-77`
- Modify: `src/core/command-transaction.ts`
- Modify: `src/core/orchestrator.ts:880-1080`
- Modify: `src/cli/commands.ts:521-597`
- Test: `tests/unit/learner-profile.test.ts`
- Test: `tests/unit/fs-store.test.ts`
- Test: `tests/e2e/retry.test.ts`
- Test: `tests/e2e/cli-flow.test.ts`

**Interfaces:**

Add to profile:

```ts
appliedEffectIds: string[];
appliedRunIds: string[];
```

```ts
export async function applyProfileAttemptEffect(
  effectId: string,
  runId: string,
  review: AttemptReview,
  options: ProfileStoreOptions = {},
): Promise<LearnerProfile>;
```

- [ ] **Step 1: Write failure-injection tests**

Required scenarios:

- score events committed, profile effect interrupted, retry applies profile once;
- duplicate review command does not increment `attempts` twice;
- parent `retry.started` committed, child creation interrupted, retry recovery creates the same child;
- same parent command with a different `newRunId` returns `COMMAND_ID_CONFLICT`;
- two child locks are acquired in lexicographic runId order to prevent deadlock.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
npm test -- tests/unit/learner-profile.test.ts tests/unit/fs-store.test.ts tests/e2e/retry.test.ts
```

Expected: duplicate attempt increments and partial retry states are observable.

- [ ] **Step 3: Implement profile effect idempotency**

Before updating EMA:

```ts
if (profile.appliedEffectIds.includes(effectId)) return profile;
```

After update, append effect/run IDs and atomically write the complete profile. Preserve the existing EMA formula exactly.

For loading old v1 profiles, upcast missing arrays to empty arrays in the versioning layer rather than weakening `LearnerProfileSchema`.

- [ ] **Step 4: Encode review profile updates as transaction effects**

`submitReview` preparation produces review/score events and:

```ts
{
  type: "profile.apply-attempt",
  effectId: `${runId}:${commandId}:profile`,
  runId,
  review: attemptReview,
}
```

The command transaction applies this after run events and before marking committed; recovery repeats it safely.

- [ ] **Step 5: Encode retry child creation as a recoverable effect**

Parent command transaction commits `retry.started` and stores a `retry.ensure-child` effect containing the exact child start/accept batch. Recovery acquires parent and child locks in sorted order, then ensures the child event log contains that exact batch.

The retry focus must be represented in child committed events so `foldRunAggregate` reconstructs `previousAttemptReview` after process restart.

- [ ] **Step 6: Run focused and full CLI journey tests**

```bash
npm test -- tests/unit/learner-profile.test.ts tests/unit/fs-store.test.ts tests/e2e/retry.test.ts tests/e2e/cli-flow.test.ts
```

Expected: exact-once profile attempts, recoverable child creation, and unchanged clean-retry isolation.

- [ ] **Step 7: Commit**

```bash
git add src/profile src/storage src/core src/cli tests/unit tests/e2e

git commit -m "fix: reconcile profile and retry effects"
```

---

## Phase 7: Make the Compiled Scenario Bundle the Runtime Source

### Task 7: Integrity manifest, compiled events, explicit roots, and atomic bundle publication

**Files:**
- Create: `src/scenarios/bundle.ts`
- Modify: `src/scenarios/compiler.ts:43-151`
- Modify: `src/scenarios/loader.ts:1-163`
- Modify: `src/scenarios/schema.ts`
- Modify: `src/cli/commands.ts:72-247`
- Modify: `scenarios/compiled/*/manifest.json`
- Create: `scenarios/compiled/*/events.json`
- Test: `tests/contracts/scenario-compiler.test.ts`
- Test: `tests/contracts/scenario-calibration.test.ts`
- Test: `tests/e2e/all-scenarios.test.ts`

**Interfaces:**

```ts
export const SCENARIO_MANIFEST_VERSION = 2 as const;

export interface ScenarioArtifactDescriptor {
  path: string;
  sha256: string;
  bytes: number;
  schemaVersion: number;
}

export interface ScenarioBundle {
  manifest: VerifiedScenarioManifest;
  publicScenario: PublicScenario;
  customerCapsule: CustomerCapsule;
  evaluatorCapsule: EvaluatorCapsule;
  eventCandidates: readonly ScenarioEventCandidate[];
  bundleDigest: string;
}

export interface ScenarioLoadOptions {
  compiledRoot: string;
}

export function loadScenarioBundle(id: string, options: ScenarioLoadOptions): ScenarioBundle;
```

- [ ] **Step 1: Write failing bundle integrity tests**

Assert:

- compiling the same source and seed twice yields byte-identical artifacts and digests;
- one-byte tampering in any partition or `events.json` fails before returning a role view;
- mixed IDs or schema versions fail;
- missing/stale artifacts fail;
- manifest contains no canary or canary seed;
- runtime loading does not open `scenarios/source/*.yaml`;
- explicit `compiledRoot` works when `process.cwd()` is outside the repository.

- [ ] **Step 2: Run scenario tests and confirm failure**

```bash
npm test -- tests/contracts/scenario-compiler.test.ts tests/contracts/scenario-calibration.test.ts tests/e2e/all-scenarios.test.ts
```

Expected: failure because the current manifest has no hashes/events descriptor and loader uses ambient cwd plus source YAML.

- [ ] **Step 3: Implement canonical bundle generation**

Keep current public/customer/evaluator allowlists. Add `events.json` from `validated.events`. Serialize each artifact once, compute SHA-256 and byte length, then compute a root digest from canonical manifest descriptors.

Manifest must not contain canary values or `canarySeed`.

- [ ] **Step 4: Publish bundles atomically**

Build in a sibling staging directory, reread and verify all descriptors, write manifest last, sync, then atomically rename the staging directory into place. Preserve the previous bundle when validation fails.

- [ ] **Step 5: Implement one manifest-root loader**

`loadScenarioBundle` performs:

```text
safe scenario ID validation
→ manifest parse/version check
→ descriptor path containment check
→ read all four artifacts
→ hash/byte verification
→ id/schema cross-check
→ strict Zod parse
→ return one immutable bundle
```

`resolveScenario` loads one bundle and never calls `loadScenarioEventCandidates` against YAML.

- [ ] **Step 6: Persist bundle digest at run start**

Add `scenarioBundleDigest` to new run metadata/events and validate the current bundle against it on resume. Existing v1 runs without a digest remain readable but are marked provenance-legacy.

- [ ] **Step 7: Recompile all production scenarios and run tests**

```bash
npm run build
npm test -- tests/contracts/scenario-compiler.test.ts tests/contracts/scenario-calibration.test.ts tests/e2e/all-scenarios.test.ts
```

Expected: all three production scenarios load only through verified bundles.

- [ ] **Step 8: Anti-pattern grep**

```bash
rg 'scenarios", "source"|ScenarioAuthoringSchema\.parse' src/cli src/core src/scenarios/loader.ts
```

Expected: no runtime YAML reads; authoring schema parse remains only in build-time compiler code.

- [ ] **Step 9: Commit**

```bash
git add src/scenarios src/cli/commands.ts scenarios/compiled tests/contracts tests/e2e

git commit -m "feat: verify compiled scenario bundles"
```

---

## Phase 8: Separate Versions and Persist Scoring Provenance

### Task 8: V1 upcasting, explicit format versions, score sources, and comparability keys

**Files:**
- Create: `src/core/versioning.ts`
- Create: `src/scoring/provenance.ts`
- Modify: `src/core/domain.ts`
- Modify: `src/core/event-store.ts`
- Modify: `src/scoring/rubric.ts`
- Modify: `src/scoring/score-input.ts`
- Modify: `src/scoring/formulas.ts`
- Modify: `src/replay/projector.ts`
- Modify: `src/profile/learner-profile.ts`
- Create: `tests/fixtures/runs/v1/manufacturing/events.jsonl`
- Create: `tests/fixtures/runs/v1/manufacturing/manifest.json`
- Create: `tests/contracts/version-compatibility.test.ts`
- Modify: `tests/unit/score-input.test.ts`
- Modify: `tests/golden/manufacturing-replay.test.ts`

**Compatibility decision:** New readers support frozen v1 fixtures through pure upcasting. Unknown future format/event revisions fail closed. Old binaries are not guaranteed to read new run/event formats.

**Interfaces:**

```ts
export const RUN_FORMAT_VERSION = 2 as const;
export const EVENT_ENVELOPE_VERSION = 1 as const;
export const SCORE_SCHEMA_VERSION = 1 as const;
export const CAPABILITY_RUBRIC_ID = "fde-capability" as const;
export const CAPABILITY_RUBRIC_VERSION = 1 as const;

export interface StageScoreProvenance {
  source: "model" | "deterministic-fallback";
  fallbackReason?: string;
}

export interface ScoreProvenance {
  scoreSchemaVersion: typeof SCORE_SCHEMA_VERSION;
  formulaVersion: 1;
  capabilityRubricId: typeof CAPABILITY_RUBRIC_ID;
  capabilityRubricVersion: typeof CAPABILITY_RUBRIC_VERSION;
  capabilityRubricSha256: string;
  scenarioBundleSha256: string | null;
  outputSchemaVersion: 1;
  evaluatorInvocationId: string | null;
  modelId: string | null;
  stages: Record<RubricStageId, StageScoreProvenance>;
  comparabilityKey: string;
}

export function upcastRunManifest(raw: unknown): CurrentRunManifest;
export function upcastRecordedEvent(raw: unknown, runFormatVersion: number): RecordedEvent;
```

- [ ] **Step 1: Freeze current v1 fixtures before changing schemas**

Copy an existing committed manufacturing run fixture and its current manifest into `tests/fixtures/runs/v1/manufacturing/`. Add a test asserting the current reader reproduces the existing learner replay bytes.

- [ ] **Step 2: Write failing compatibility and provenance tests**

Cover:

- v1 run/profile missing new fields upcasts and replays;
- unknown run format/event revision fails with `UNSUPPORTED_SCHEMA_VERSION`;
- hash verification occurs before upcasting and original files remain unchanged;
- every new `score.computed` has provenance;
- mixed model/fallback stages report separate sources;
- comparability keys differ when rubric, model family, output schema, formula, or calibration version differs;
- legacy score is marked non-comparable by default.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
npm test -- tests/contracts/version-compatibility.test.ts tests/unit/score-input.test.ts tests/golden/manufacturing-replay.test.ts
```

Expected: failures because all resources share `FDE_SCHEMA_VERSION` and score provenance does not exist.

- [ ] **Step 4: Split version constants without weakening validation**

Keep scenario authoring schema v1 where its shape is unchanged. Introduce independent run format, event envelope, scenario manifest, score, formula, and rubric versions. Readers accept only explicitly listed versions; no range comparison such as `version <= current`.

Processing order:

```text
read raw record
→ validate original envelope/hash
→ select explicit upcaster by run format and event type/revision
→ validate current RunEventSchema
→ fold/project
```

- [ ] **Step 5: Persist score provenance**

The model runtime result must expose safe invocation metadata (`invocationId`, configured model identifier when available) separately from content. Build per-stage provenance in `buildScoreInput`; persist it with `score.computed`; replay projects only learner-safe provenance fields needed to explain comparability and fallback use.

Do not persist prompts, canaries, raw model payload, or hidden scenario rubric contents.

- [ ] **Step 6: Make profile comparison explicit**

Store the latest `comparabilityKey` with each applied attempt summary. Do not blend EMA across incompatible keys silently; start a new cohort or mark the profile trend discontinuity.

- [ ] **Step 7: Correct stale score comments**

Replace statements in `src/scoring/score-input.ts:18-32` and `src/core/orchestrator.ts:1022-1025` that claim assessments/criterion scores are unavailable. State that fallback is only for legacy or explicitly missing model judgment.

- [ ] **Step 8: Run compatibility, scoring, replay, and profile tests**

```bash
npm test -- tests/contracts/version-compatibility.test.ts tests/unit/score-input.test.ts tests/unit/scoring.test.ts tests/unit/learner-profile.test.ts tests/golden/manufacturing-replay.test.ts
```

Expected: v1 fixture bytes remain stable; new scores carry provenance; incompatible attempts are not silently blended.

- [ ] **Step 9: Commit**

```bash
git add src/core src/scoring src/replay src/profile tests/contracts tests/unit tests/golden tests/fixtures/runs

git commit -m "feat: version runs and score provenance"
```

---

## Phase 9: Turn Doctor and Documentation into Release Gates

### Task 9: Unsafe doctor exit, release script, and corrected product contracts

**Files:**
- Modify: `src/cli/commands.ts:670-680`
- Modify: `src/cli/main.ts:173-180,363-376`
- Modify: `tests/contracts/codex-capability-probe.test.ts`
- Modify: `tests/e2e/codex-skill-smoke.test.ts`
- Create: `scripts/release-gate.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/security-model.md`
- Modify: `docs/scenario-authoring.md`
- Modify: `docs/scoring.md`
- Modify: `docs/replay.md`
- Replace: `docs/mvp-acceptance.md` with a newly measured record only after live verification

**Interfaces:**

Add a release-oriented doctor mode:

```ts
export interface DoctorArgs {
  locale: Locale;
  executable?: string;
  requireSafe?: boolean;
}
```

Package scripts:

```json
{
  "doctor": "npm run build && node dist/cli/main.js doctor --json",
  "doctor:strict": "npm run build && node dist/cli/main.js doctor --json --require-safe",
  "release:gate": "node scripts/release-gate.mjs"
}
```

- [ ] **Step 1: Write failing unsafe-exit tests**

Use the fake Codex executable to return a report with `safeForStrictMode: false`. Assert normal `doctor --json` remains diagnostic, while `doctor --json --require-safe` exits non-zero with a stable learner-safe code such as `CODEX_STRICT_MODE_UNSAFE`.

- [ ] **Step 2: Run focused test and confirm failure**

```bash
npm test -- tests/contracts/codex-capability-probe.test.ts tests/e2e/codex-skill-smoke.test.ts
```

Expected: failure because current `doctorCommand` always returns `ok`.

- [ ] **Step 3: Implement strict doctor behavior**

When `requireSafe` is true and the report is unsafe, return a `CliFailure`; do not include canary values, raw stdout/stderr, prompt text, or model output. Preserve the full safe boolean matrix in the diagnostic report.

- [ ] **Step 4: Implement release gate script**

Run sequentially and stop on first failure:

```text
npm ci
npm run typecheck
npm run build
npm test
npm run doctor:strict
```

The script must print the exact failed command and exit code. It must not reinterpret a failing live doctor as a warning.

- [ ] **Step 5: Rewrite determinism and freeze wording**

Document four separate claims:

1. same committed events → same state;
2. same scenario bundle digest + seed + trigger context → same scheduled event order;
3. same event log → byte-stable recorded replay;
4. a fresh model invocation does not guarantee identical prose or judgment.

State explicitly that frozen v1 is a specification/acceptance baseline, not release readiness.

- [ ] **Step 6: Document executable versus guidance-only gates**

Name the fixed capability rubric as `capabilityScoringRubric`. Name scenario authoring rubric as `scenarioDeliverableRubric`. Mark scenario-authored `passGates[]` as guidance-only until each has an executable predicate mapping.

- [ ] **Step 7: Run structural release checks**

```bash
npm run typecheck
npm run build
npm test
```

Expected: all pass.

- [ ] **Step 8: Run live doctor and record the real result**

```bash
npm run doctor:strict
```

Expected for release eligibility: exit 0, `safeForStrictMode: true`, every required boolean true, and empty failures. If it fails, preserve the failure and keep release status blocked; do not edit acceptance text to claim success.

- [ ] **Step 9: Commit**

```bash
git add src/cli tests scripts package.json README.md docs

git commit -m "docs: enforce FDEGym release gates"
```

---

## Phase 10: Final Verification

### Task 10: Verify all contracts, compatibility, safety, and repository cleanliness

**Files:**
- Verify only; modify a file only when a failed check identifies a defect covered by Tasks 1–9.

- [ ] **Step 1: Install from the lockfile**

```bash
npm ci
```

Expected: exit 0 with no lockfile changes.

- [ ] **Step 2: Typecheck and build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 3: Run the complete test suite**

```bash
npm test
```

Expected: all tests pass, including concurrency, recovery, v1 compatibility, bundle integrity, score provenance, and adversarial leak checks.

- [ ] **Step 4: Run anti-pattern scans**

```bash
rg 'JSON\.stringify\(\{ type: "object" \}\)|buildPrompt\(input|scenarios", "source"|clarificationBudgetUsed: 0' src
rg 'appendFile\(' src/core/event-store.ts src/storage
rg 'Date\.now\(|Math\.random\(' src/core src/scoring src/replay src/simulation
```

Expected:

- first command: no matches;
- second command: no event-log append-in-place path;
- third command: no control-plane nondeterminism; lock/temp-file diagnostics may use `randomUUID()` only inside storage modules.

- [ ] **Step 5: Verify frozen v1 compatibility**

```bash
npm test -- tests/contracts/version-compatibility.test.ts tests/golden/manufacturing-replay.test.ts
```

Expected: v1 run fixture loads and produces the frozen replay bytes without modifying fixture files.

- [ ] **Step 6: Verify scenario bundle integrity**

```bash
npm test -- tests/contracts/scenario-compiler.test.ts tests/contracts/scenario-calibration.test.ts tests/e2e/all-scenarios.test.ts
```

Expected: deterministic compilation, tamper rejection, explicit-root loading, and all production scenarios pass.

- [ ] **Step 7: Verify real Codex safety**

```bash
npm run doctor:strict
```

Expected for release: exit 0 and `safeForStrictMode=true`. If the external client/proxy remains unsafe, stop release work and retain the failed acceptance record.

- [ ] **Step 8: Verify generated output and git state**

```bash
git status --short
git diff --check
```

Expected: only intended source, test, generated scenario, and documentation changes; no temporary locks, journals, staging directories, profile files, or test run directories.

- [ ] **Step 9: Request code review**

Invoke `superpowers:requesting-code-review` and review these dimensions separately:

1. role isolation and leak prevention;
2. write-ahead recovery and lock correctness;
3. event/replay backward compatibility;
4. scenario manifest integrity;
5. score provenance and comparability;
6. release-gate truthfulness.

---

## Self-Review

### Spec coverage

- Real Codex role prompt/output schema/canary wiring: Task 1.
- Domain membership validation: Task 2.
- Persistent evidence pending and clarification budget: Task 3.
- Duplicate start, concurrency, path containment, crash safety: Task 4.
- End-to-end command idempotency: Task 5.
- Profile/retry/design multi-write consistency: Tasks 5–6.
- Runtime scenario single source and manifest integrity: Task 7.
- Event/schema compatibility and model-score provenance: Task 8.
- Determinism wording, frozen-baseline meaning, live acceptance: Task 9.
- Whole-repository verification: Task 10.

### Type consistency

- `RunLock` is produced by `withRunLock` and carried through `StoreOptions.lock`.
- `executeCommandTransaction` consumes `CommandPlan<T extends JsonValue>` and stores `PreparedCommand<T>`.
- `CommandEffect` IDs are persisted in `LearnerProfile.appliedEffectIds`.
- `ScenarioBundle.bundleDigest` feeds `ScoreProvenance.scenarioBundleSha256`.
- `ScoreProvenance.comparabilityKey` feeds learner-profile cohort handling.

### Scope boundaries

- No database migration.
- No new agent role.
- No re-simulation implementation.
- No certification-grade anti-cheating claim.
- No promise that old binaries read new run formats.
- No automatic waiver for a failing live Codex gate.
