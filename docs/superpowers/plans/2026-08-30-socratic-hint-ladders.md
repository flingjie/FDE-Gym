# Socratic hint ladders (D1–D2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail-close illegal hint levels and stale-ledger grants (D1), then make all 32 production ladders Socratic and reject answer-shaped L3 at compile time (D2).

**Architecture:** Keep `requestHint` as the pure selector. D1 fixes CLI parsing and makes `hintCommand.prepare()` reload `grantedHints` under the existing run lock. D2 adds `collectHintDisciplineIssues` and calls it from `ScenarioAuthoringSchema.superRefine`, then rewrites YAML so production sources pass.

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-socratic-hint-ladders-design.md`  
**Briefing:** `docs/superpowers/specs/2026-08-30-socratic-hint-ladders-briefing.md`

## Global Constraints

- Node.js ≥ 22 (`engines.node` is `>=22` in `package.json`).
- Source imports use the `.js` extension (NodeNext ESM); test imports are extensionless.
- Every new error code needs `zh-CN` + `en-US` in `ERROR_TABLE` (`src/cli/render.ts`).
- Do **not** change `requestHint` escalation rules (auto L1→L2→L3; explicit skip-ahead allowed; no downgrade).
- Do **not** generate hints at runtime; do **not** write hints into the evidence graph.
- Do **not** change `hintPenalty` / process fallback (D3).
- Do **not** delete Coach `requestHint` or state-machine `hintPlaceholder` (D4).
- Do **not** add topic lists to `status` (D5).
- Do **not** edit `docs/mvp-acceptance.md`.
- Verify with `npx vitest run <files>` after each task; `npm run typecheck` before each commit.

---

### Task 1: Reject illegal `--level` at the CLI

**Files:**
- Create: `src/cli/hint-level.ts`
- Create: `tests/contracts/hint-level.test.ts`
- Modify: `src/cli/main.ts` (hint case around the `level` parse)
- Modify: `src/cli/render.ts` (insert `HINT_INVALID_LEVEL` before `HINT_UNKNOWN_TOPIC`)
- Modify: `tests/e2e/codex-skill-smoke.test.ts` (assert zh-CN ≠ en-US for the new code)

**Interfaces:**
- Consumes: `localize` from `src/cli/render.ts`.
- Produces: `parseHintLevel(raw: string | boolean | undefined): { ok: true; level: 1 | 2 | 3 | undefined } | { ok: false }` used by `main.ts`. `undefined` level means auto-escalate (same as today’s omitted `--level`).

- [ ] **Step 1: Write the failing test** — `tests/contracts/hint-level.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { parseHintLevel } from "../../src/cli/hint-level";
import { localize } from "../../src/cli/render";

describe("parseHintLevel", () => {
  it("treats a missing flag as auto-escalate", () => {
    expect(parseHintLevel(undefined)).toEqual({ ok: true, level: undefined });
  });

  it("accepts 1, 2, and 3", () => {
    expect(parseHintLevel("1")).toEqual({ ok: true, level: 1 });
    expect(parseHintLevel("2")).toEqual({ ok: true, level: 2 });
    expect(parseHintLevel("3")).toEqual({ ok: true, level: 3 });
  });

  it("rejects 4, foo, empty string, and non-strings", () => {
    expect(parseHintLevel("4")).toEqual({ ok: false });
    expect(parseHintLevel("foo")).toEqual({ ok: false });
    expect(parseHintLevel("")).toEqual({ ok: false });
    expect(parseHintLevel(true)).toEqual({ ok: false });
  });
});

describe("HINT_INVALID_LEVEL copy", () => {
  it("localizes differently in zh-CN and en-US", () => {
    expect(localize("HINT_INVALID_LEVEL", "zh-CN").message).toBe("提示级别必须是 1、2 或 3。");
    expect(localize("HINT_INVALID_LEVEL", "en-US").message).toBe("Hint level must be 1, 2, or 3.");
    expect(localize("HINT_INVALID_LEVEL", "zh-CN").message).not.toBe(
      localize("HINT_INVALID_LEVEL", "en-US").message,
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/contracts/hint-level.test.ts`

Expected: FAIL (module `src/cli/hint-level` not found, and `HINT_INVALID_LEVEL` falls through to the generic fallback message).

- [ ] **Step 3: Implement `src/cli/hint-level.ts`**

```ts
export type ParsedHintLevel =
  | { ok: true; level: 1 | 2 | 3 | undefined }
  | { ok: false };

/** Parse `--level`. Absent → auto; only the strings "1"|"2"|"3" are explicit. */
export function parseHintLevel(raw: string | boolean | undefined): ParsedHintLevel {
  if (raw === undefined) return { ok: true, level: undefined };
  if (raw === "1" || raw === "2" || raw === "3") {
    return { ok: true, level: Number(raw) as 1 | 2 | 3 };
  }
  return { ok: false };
}
```

- [ ] **Step 4: Add localization** in `src/cli/render.ts` `ERROR_TABLE`, immediately **before** the `HINT_UNKNOWN_TOPIC` entry:

```ts
  {
    code: "HINT_INVALID_LEVEL",
    "zh-CN": {
      message: "提示级别必须是 1、2 或 3。",
      nextActions: ["省略 --level 以自动升级，或传入 1、2 或 3。"],
    },
    "en-US": {
      message: "Hint level must be 1, 2, or 3.",
      nextActions: ["Omit --level to auto-escalate, or pass 1, 2, or 3."],
    },
  },
```

- [ ] **Step 5: Wire `src/cli/main.ts`**

Add `import { parseHintLevel } from "./hint-level.js";`

Replace the hint `case` body so illegal levels never call `hintCommand`:

```ts
    case "hint": {
      const topic = flags.topic;
      if (!runId || !commandId || typeof topic !== "string") {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      const parsedLevel = parseHintLevel(flags.level);
      if (!parsedLevel.ok) {
        result = { ok: false, code: "HINT_INVALID_LEVEL", ...localize("HINT_INVALID_LEVEL", locale) };
        break;
      }
      result = await hintCommand(ctx, { runId, topic, level: parsedLevel.level, commandId });
      break;
    }
```

- [ ] **Step 6: Extend `tests/e2e/codex-skill-smoke.test.ts` localization test** with:

```ts
    expect(localize("HINT_INVALID_LEVEL", "zh-CN").message).not.toBe(
      localize("HINT_INVALID_LEVEL", "en-US").message,
    );
```

- [ ] **Step 7: Re-run tests**

Run: `npx vitest run tests/contracts/hint-level.test.ts tests/e2e/codex-skill-smoke.test.ts`

Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/cli/hint-level.ts src/cli/main.ts src/cli/render.ts tests/contracts/hint-level.test.ts tests/e2e/codex-skill-smoke.test.ts
git commit -m "$(cat <<'EOF'
fix: reject illegal hint --level instead of auto-escalating

EOF
)"
```

---

### Task 2: Reject duplicate hint `topic` at authoring time

**Files:**
- Modify: `src/scenarios/schema.ts` (the `hintLadders` uniqueness loop ~387–397)
- Modify: `tests/contracts/domain-schema.test.ts`

**Interfaces:**
- Consumes: existing `ScenarioAuthoringSchema` superRefine.
- Produces: authoring parse fails when two ladders share `topic` (same pattern as duplicate `id`).

- [ ] **Step 1: Write the failing test** in `tests/contracts/domain-schema.test.ts` inside `describe("scenario authoring cross-references and hint completeness")`:

```ts
  it("rejects duplicate hint ladder topics", () => {
    const authoring = validAuthoring();
    authoring.evaluator.hintLadders.push({
      id: "h2",
      topic: "workflow",
      hints: { "1": text, "2": text, "3": text },
    });
    const parsed = ScenarioAuthoringSchema.safeParse(authoring);
    expect(parsed.success).toBe(false);
  });
```

Keep the existing unique-id ladders valid; this test adds a second ladder with a **new id** and the **same topic**.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/contracts/domain-schema.test.ts`

Expected: FAIL (`rejects duplicate hint ladder topics` — parse still succeeds).

- [ ] **Step 3: Extend the hint-ladder uniqueness loop** in `src/scenarios/schema.ts`

Replace the loop that only tracks `hintLadderIds` with:

```ts
    const hintLadderIds = new Set<string>();
    const hintLadderTopics = new Set<string>();
    doc.evaluator.hintLadders.forEach((ladder, i) => {
      if (hintLadderIds.has(ladder.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate hint ladder id: ${ladder.id}`,
          path: ["evaluator", "hintLadders", i, "id"],
        });
      }
      hintLadderIds.add(ladder.id);
      if (hintLadderTopics.has(ladder.topic)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate hint ladder topic: ${ladder.topic}`,
          path: ["evaluator", "hintLadders", i, "topic"],
        });
      }
      hintLadderTopics.add(ladder.topic);
    });
```

- [ ] **Step 4: Re-run**

Run: `npx vitest run tests/contracts/domain-schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/scenarios/schema.ts tests/contracts/domain-schema.test.ts
git commit -m "$(cat <<'EOF'
fix: reject duplicate hint ladder topics at authoring time

EOF
)"
```

---

### Task 3: Grant from the locked current ledger; journal before phase gate

**Files:**
- Modify: `src/cli/commands.ts` (`hintCommand` only)
- Create: `tests/contracts/hint-command.test.ts`

**Interfaces:**
- Consumes: `loadEvents`, `stripEnvelope`, `foldRunAggregate`, `requestHint`, `executeCommandTransaction`, `InvalidPhaseCommandError`.
- Produces: `hintCommand` whose `prepare()` reloads events (so `grantedHints` is current) and checks phase **inside** `prepare`, so a committed journal is returned even after the phase moved.

- [ ] **Step 1: Write `tests/contracts/hint-command.test.ts`**

Use the same `scenario()` / `FixtureAgentRuntime` / temp `baseDir` pattern as `tests/e2e/cli-flow.test.ts` (copy `text`, a minimal `scenario()` with one `workflow` ladder, `startCommand`, `hintCommand`). Do **not** import from `cli-flow.test.ts`.

Required cases:

1. Auto twice with different `commandId`s → levels 1 then 2 (fresh ledger inside prepare).
2. Same `commandId` + same request after a `phase.changed` to `SOLUTION_DESIGN` (append via `appendEvents` with a **new** commandId) → still `ok: true` with the original grant.
3. A **new** `commandId` after that phase change → `ok: false`, `code: "INVALID_PHASE_COMMAND"`.

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import { hintCommand, startCommand, type CommandContext } from "../../src/cli/commands";
import { appendEvents } from "../../src/core/event-store";
import type { EvaluatorCapsule, PublicScenario, CustomerCapsule } from "../../src/scenarios/schema";
import type { ScenarioEventCandidate } from "../../src/scenarios/schema";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

function scenario(): NonNullable<CommandContext["scenario"]> {
  const publicScenario: PublicScenario = {
    id: "scn-hint",
    schemaVersion: 1,
    locale: "zh-CN",
    openingRequest: text("开场", "Opening"),
    visibleContext: text("背景", "Context"),
    visibleConstraints: [text("约束", "Constraint")],
    deliverables: [text("交付", "Deliverable")],
    learnerRules: [text("规则", "Rule")],
    questionBudget: 12,
  };
  const customer: CustomerCapsule = {
    id: "scn-hint",
    schemaVersion: 1,
    stakeholders: [
      {
        id: "s1",
        role: text("角色", "Role"),
        persona: text("画像", "Persona"),
        concerns: [],
        blindSpots: [],
      },
    ],
    disclosureUnits: [],
    responsePolicies: [],
    privateConflicts: [],
    canary: "customer-canary",
  };
  const evaluator: EvaluatorCapsule = {
    id: "scn-hint",
    schemaVersion: 1,
    expectedEvidence: [],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [
      {
        id: "hl-workflow",
        topic: "workflow",
        hints: {
          "1": text("L1 角度", "L1 dimension"),
          "2": text("L2 类别", "L2 category"),
          "3": text("L3 该问什么？", "L3 what to ask?"),
        },
      },
    ],
    passGates: [],
    canary: "evaluator-canary",
  };
  const events: ScenarioEventCandidate[] = [];
  return { public: publicScenario, customer, evaluator, events };
}

describe("hintCommand ledger and journal", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function ctx(): { ctx: CommandContext; runId: string; baseDir: string } {
    const baseDir = mkdtempSync(join(tmpdir(), "fde-hint-cmd-"));
    dirs.push(baseDir);
    return {
      baseDir,
      runId: "run-hint-1",
      ctx: { runtime: new FixtureAgentRuntime({ fixtures: {} }), baseDir, scenario: scenario() },
    };
  }

  it("auto-escalates using the committed ledger", async () => {
    const { ctx: commandCtx, runId } = ctx();
    const started = await startCommand(commandCtx, {
      runId,
      scenarioId: "scn-hint",
      locale: "zh-CN",
      commandId: "cmd-start",
    });
    expect(started.ok).toBe(true);
    const first = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      commandId: "cmd-h1",
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.level).toBe(1);
    const second = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      commandId: "cmd-h2",
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.level).toBe(2);
  });

  it("replays a committed hint after the phase has moved on", async () => {
    const { ctx: commandCtx, runId, baseDir } = ctx();
    expect(
      (await startCommand(commandCtx, {
        runId,
        scenarioId: "scn-hint",
        locale: "zh-CN",
        commandId: "cmd-start",
      })).ok,
    ).toBe(true);
    const granted = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      level: 1,
      commandId: "cmd-h1",
    });
    expect(granted.ok).toBe(true);
    await appendEvents(
      runId,
      [
        {
          type: "phase.changed",
          runId,
          commandId: "cmd-force-phase",
          from: "DISCOVERY",
          to: "SOLUTION_DESIGN",
        },
      ],
      { baseDir },
    );
    const replayed = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      level: 1,
      commandId: "cmd-h1",
    });
    expect(replayed.ok).toBe(true);
    if (replayed.ok && granted.ok) {
      expect(replayed.data.level).toBe(granted.data.level);
      expect(replayed.data.hint).toEqual(granted.data.hint);
    }
    const fresh = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      commandId: "cmd-h-new",
    });
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.code).toBe("INVALID_PHASE_COMMAND");
  });
});
```

If `FixtureAgentRuntime` requires a non-empty `fixtures` map, match `cli-flow.test.ts` (`new FixtureAgentRuntime({ fixtures: fixtures() })`). `start` / `hint` must not invoke a role; an empty map is fine if the constructor allows it — if the constructor throws, pass `{ fixtures: {} }` as in other tests or copy the `cli-flow` fixtures object.

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run tests/contracts/hint-command.test.ts`

Expected: FAIL on the phase-moved replay (`INVALID_PHASE_COMMAND` instead of the stored grant), because phase is still checked before the transaction.

- [ ] **Step 3: Replace `hintCommand` in `src/cli/commands.ts`**

```ts
export async function hintCommand(ctx: CommandContext, args: HintArgs): Promise<CliResult<HintData>> {
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    const scenario = resolveScenario(ctx, loaded.scenarioId, loaded.scenarioBundleDigest);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "hint", topic: args.topic, level: args.level ?? null },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const recorded = await loadEvents(args.runId, { baseDir: ctx.baseDir });
        const events = recorded.map(stripEnvelope);
        const aggregate = foldRunAggregate(events, loaded.scenarioId, loaded.locale);
        if (aggregate.phase !== "DISCOVERY" && aggregate.phase !== "PROBLEM_FRAMING") {
          throw new InvalidPhaseCommandError("hint", aggregate.phase);
        }
        const grant = requestHint(
          args.topic,
          args.level ?? null,
          scenario.evaluator.hintLadders,
          aggregate.grantedHints,
        );
        const event: RunEvent = {
          type: "hint.granted",
          runId: args.runId,
          commandId: args.commandId,
          topic: args.topic,
          level: grant.level,
          hint: grant.hint,
        };
        return {
          events: [event],
          result: { topic: args.topic, level: grant.level, hint: grant.hint },
        };
      },
    });
    const recordedAfter = await loadEvents(args.runId, { baseDir: ctx.baseDir });
    const phase = foldRunAggregate(
      recordedAfter.map(stripEnvelope),
      loaded.scenarioId,
      loaded.locale,
    ).phase;
    return ok(args.runId, phase, loaded.locale, data);
  });
}
```

The extra fold after the transaction is so a successful **new** grant still reports the current phase. A journal replay never runs `prepare`; `ok(...)` should use the phase from the **reloaded** aggregate (which may already be `SOLUTION_DESIGN`). Using `loaded.phase` from before the lock would lie on replay. The snippet above reloads after commit/replay so the envelope phase matches the log.

If `ok(args.runId, loaded.phase, ...)` is kept instead, the replay test may still pass on `data` while `phase` is stale — **prefer the reload** so the envelope is honest.

- [ ] **Step 4: Re-run**

Run: `npx vitest run tests/contracts/hint-command.test.ts tests/e2e/cli-flow.test.ts tests/contracts/command-transaction.test.ts`

Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/cli/commands.ts tests/contracts/hint-command.test.ts
git commit -m "$(cat <<'EOF'
fix: compute hint grants from the locked ledger and honor journal replay

EOF
)"
```

---

### Task 4: Hint discipline helper (not wired to authoring yet)

**Files:**
- Create: `src/scenarios/hint-discipline.ts`
- Create: `tests/contracts/hint-discipline.test.ts`

**Interfaces:**
- Consumes: `ScenarioAuthoring` type from `src/scenarios/schema.ts` (import type only; do not call `ScenarioAuthoringSchema.parse` from the helper).
- Produces: `collectHintDisciplineIssues(doc: ScenarioAuthoring): HintDisciplineIssue[]` used by Task 6.

- [ ] **Step 1: Write `tests/contracts/hint-discipline.test.ts`**

Build a minimal `ScenarioAuthoring`-shaped object (same fields as `validAuthoring()` in `domain-schema.test.ts`) with:

- one disclosure unit whose zh-CN text contains `180,000` / `18万` style numbers as in production (`每月约18万张工单，55%重复`);
- one expected-evidence description **without** those numbers;
- one ladder.

Cases:

1. L3 `关键发现：每月约18万张` / `Key discovery: 180,000 tickets` → issues include banner **and** numeric tokens.
2. L3 `现在每月工单量是多少？` / `What is monthly ticket volume?` and L1/L2 with no hidden numbers → **no** issues.
3. L3 without `?` or `？` → issue on that locale.
4. Two ladders, same `topic`, different `id` → duplicate-topic issue.
5. L1 containing `18` while the disclosure unit contains `18万` → L1 numeric issue (`18` is a whole token in both after stripping non-digits from `18万`? **Implement token extraction so `18万` yields `18`**, and `180,000` yields `180000`. Match hint tokens the same way. Do not treat `3` as a match inside `3400`.)

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run tests/contracts/hint-discipline.test.ts`

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/scenarios/hint-discipline.ts`**

```ts
import type { LocalizedText } from "../core/domain.js";
import type { ScenarioAuthoring } from "./schema.js";

export interface HintDisciplineIssue {
  path: Array<string | number>;
  message: string;
}

const ANSWER_BANNER = /关键发现|key discovery/i;

/** Maximal digit runs, commas stripped (`180,000` → `180000`, `18万` → `18`). */
export function numericTokens(text: string): string[] {
  const tokens = new Set<string>();
  const stripped = text.replace(/,/g, "");
  for (const match of stripped.matchAll(/\d+(?:\.\d+)?/g)) {
    tokens.add(match[0]);
  }
  return [...tokens];
}

function localizedValues(text: LocalizedText): string[] {
  return [text["zh-CN"], text["en-US"]];
}

export function hiddenNumericTokenSet(doc: ScenarioAuthoring): Set<string> {
  const tokens = new Set<string>();
  for (const unit of doc.customer.disclosureUnits) {
    for (const value of localizedValues(unit.text)) {
      for (const token of numericTokens(value)) tokens.add(token);
    }
  }
  for (const evidence of doc.evaluator.expectedEvidence) {
    for (const value of localizedValues(evidence.description)) {
      for (const token of numericTokens(value)) tokens.add(token);
    }
  }
  return tokens;
}

export function collectHintDisciplineIssues(doc: ScenarioAuthoring): HintDisciplineIssue[] {
  const issues: HintDisciplineIssue[] = [];
  const hidden = hiddenNumericTokenSet(doc);
  const seenTopics = new Set<string>();

  doc.evaluator.hintLadders.forEach((ladder, i) => {
    if (seenTopics.has(ladder.topic)) {
      issues.push({
        path: ["evaluator", "hintLadders", i, "topic"],
        message: `duplicate hint ladder topic: ${ladder.topic}`,
      });
    }
    seenTopics.add(ladder.topic);

    for (const level of ["1", "2", "3"] as const) {
      const text = ladder.hints[level];
      for (const locale of ["zh-CN", "en-US"] as const) {
        const value = text[locale];
        const path = ["evaluator", "hintLadders", i, "hints", level, locale];
        if (level === "3") {
          if (ANSWER_BANNER.test(value)) {
            issues.push({ path, message: "L3 must not contain an answer banner (关键发现 / Key discovery)" });
          }
          if (!value.includes("?") && !value.includes("？")) {
            issues.push({ path, message: "L3 must be a question (contain ? or ？)" });
          }
        }
        for (const token of numericTokens(value)) {
          if (hidden.has(token)) {
            issues.push({
              path,
              message: `hint level ${level} repeats hidden numeric token: ${token}`,
            });
          }
        }
      }
    }
  });

  return issues;
}
```

Tune `numericTokens` / tests until case 5 is true: disclosure `18万` and hint `18` collide on `18`; disclosure `3,400` and hint `3` do **not** collide.

- [ ] **Step 4: Re-run**

Run: `npx vitest run tests/contracts/hint-discipline.test.ts`

Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/scenarios/hint-discipline.ts tests/contracts/hint-discipline.test.ts
git commit -m "$(cat <<'EOF'
feat: add deterministic hint-ladder discipline checks

EOF
)"
```

---

### Task 5: Rewrite production YAML; prove discipline on sources

**Files:**
- Modify: `scenarios/source/support-automation.yaml` (`hintLadders` only)
- Modify: `scenarios/source/manufacturing-alert-triage.yaml` (`hintLadders` only)
- Modify: `scenarios/source/data-migration.yaml` (`hintLadders` only)
- Modify: `scenarios/source/export-freight-forwarding.yaml` (`hintLadders` only)
- Modify: `tests/contracts/hint-discipline.test.ts` (load each source YAML and expect `collectHintDisciplineIssues` empty)

**Interfaces:**
- Consumes: `collectHintDisciplineIssues` from Task 4; D0.1 semantics from the spec.
- Produces: four source files whose ladders pass the helper **before** Task 6 wires Zod.

Keep every `id` / `topic` unchanged (`hl-workflow` / `workflow`, etc.).

**Rewrite rule (apply to every topic):**

1. Open `customer.disclosureUnits` with that `topic` — those sentences are the **answers**.
2. L1: one dimension question, no quantities from those units.
3. L2: which *kind* of evidence is missing (volume, cost share, constraint class), no values.
4. L3: one stakeholder-askable question (must include `？` or `?` in **both** locales), no answer banner, no numeric tokens that appear in those units or in `expectedEvidence[].description`.

**Worked replacement for `support-automation.yaml` — replace the entire `hintLadders:` list with:**

```yaml
  hintLadders:
    - id: hl-workflow
      topic: workflow
      hints:
        "1":
          "zh-CN": "在谈自动化之前，工作现在是怎么进到支持中心、又是怎么被分类的？"
          "en-US": "Before proposing automation, how does work currently enter the support center and get classified?"
        "2":
          "zh-CN": "去找体量、重复程度、响应速度这类证据，不要只看编制人数。"
          "en-US": "Look for volume, repetition, and response-speed evidence — not just headcount."
        "3":
          "zh-CN": "现在每月大概处理多少工单？其中重复性工单占比多少？平均首响和高峰首响分别是多久？"
          "en-US": "What is monthly ticket volume, what share is repetitive, and what are average and peak first-response times?"
    - id: hl-pain
      topic: pain
      hints:
        "1":
          "zh-CN": "支持中心现在最疼的是人、钱，还是复杂单处理？"
          "en-US": "Is the support center hurting most on people, cost, or complex-ticket handling?"
        "2":
          "zh-CN": "去找人工成本结构、人员稳定性和复杂单一次解决情况。"
          "en-US": "Look for labor-cost structure, workforce stability, and first-contact resolution on complex tickets."
        "3":
          "zh-CN": "人工成本占总支持预算的多少？一线流失有多严重？复杂工单一次解决得怎么样？"
          "en-US": "What share of the support budget is labor, how severe is frontline attrition, and how well are complex tickets resolved at first contact?"
    - id: hl-root-cause
      topic: root-cause
      hints:
        "1":
          "zh-CN": "现有自动化到底卡在规则、理解还是维护？"
          "en-US": "Is current automation stuck on rules, language understanding, or upkeep?"
        "2":
          "zh-CN": "去找规则库规模、维护负担，以及自然语言变体为何匹配失败。"
          "en-US": "Look for rules-base scale, maintenance burden, and why natural-language variants fail to match."
        "3":
          "zh-CN": "现有规则引擎靠什么在跑？维护要花多少精力？用户换个说法会怎样？"
          "en-US": "What does the current rules engine actually run on, how heavy is upkeep, and what happens when a user rephrases?"
    - id: hl-business-impact
      topic: business-impact
      hints:
        "1":
          "zh-CN": "等太久和自动化覆盖，分别打在收入还是成本上？"
          "en-US": "Do long waits and automation coverage hit revenue, cost, or both?"
        "2":
          "zh-CN": "去找等待导致的流失价值，以及覆盖一部分工单后的可节省成本。"
          "en-US": "Look for wait-driven churn value and the cost that partial ticket coverage could save."
        "3":
          "zh-CN": "因等待流失一个客户大概损失多少？每月因此走多少人？覆盖一部分工单一年能省多少？"
          "en-US": "What is the lifetime value lost per wait-driven churn, how many customers leave monthly for that reason, and what annual saving does partial coverage imply?"
    - id: hl-constraints
      topic: constraints
      hints:
        "1":
          "zh-CN": "自动化在合规和数据放哪里跑，分别被什么拦住？"
          "en-US": "What stops automation on compliance versus where the model is allowed to run?"
        "2":
          "zh-CN": "去找必须人工复核的工单类型，以及工单数据能否出境。"
          "en-US": "Look for ticket types that require human review and whether ticket data may leave the region."
        "3":
          "zh-CN": "哪些工单绝对不能自动回复？客户工单能不能送到境外模型？"
          "en-US": "Which tickets must never be auto-replied, and may customer tickets go to an offshore model?"
    - id: hl-success
      topic: success-measures
      hints:
        "1":
          "zh-CN": "管理层用速度、成本还是质量来宣布项目成功？"
          "en-US": "Will leadership call this a win on speed, cost, or quality?"
        "2":
          "zh-CN": "去找首响、人工成本和回答质量的目标，以及不可逾越的质量红线。"
          "en-US": "Look for targets on first-response, labor cost, and answer quality, including the hard quality floor."
        "3":
          "zh-CN": "首响和人工成本要改到什么程度才算达标？回答质量有没有不能碰的底线？"
          "en-US": "What first-response and labor-cost change counts as success, and what quality floor must not be crossed?"
    - id: hl-trust
      topic: trust
      hints:
        "1":
          "zh-CN": "一线和高管对同一套 AI，分别怕什么、盼什么？"
          "en-US": "What do frontline agents versus executives fear or expect from the same AI?"
        "2":
          "zh-CN": "去找一线是否绕过系统，以及高管对一步到位全自动的预期。"
          "en-US": "Look for frontline workarounds around the system and executive expectations of one-step full automation."
        "3":
          "zh-CN": "一线会不会抵制或绕过建议？高管有没有把合规和质量想得太容易？"
          "en-US": "Will frontline staff resist or bypass suggestions, and are executives underestimating compliance and quality?"
    - id: hl-failure-modes
      topic: failure-modes
      hints:
        "1":
          "zh-CN": "AI 说错话和系统突然停，哪种更可能把支持中心打穿？"
          "en-US": "Which failure punches through first: the AI saying the wrong thing, or the system stopping suddenly?"
        "2":
          "zh-CN": "去找不确定时的胡编行为，以及高峰失效时人工队列会怎样。"
          "en-US": "Look for fabrication under uncertainty and what happens to the human queue if automation fails at peak."
        "3":
          "zh-CN": "模型没把握时会怎么回答客户？高峰一旦停摆，人工侧会看到什么？"
          "en-US": "What does the model tell the customer when it is unsure, and what does the human side see if it dies at peak?"
```

Watch tokens: do **not** put `72`, `38`, `51`, `3400`, `320`, `900`, `40`, `210`, `4`, `9`, `1`, `35`, `92`, `18`, `55` in any hint level. Constraints L3 uses 付款/退款 as **categories** (also in public constraints) — allowed; do not paste the hidden “必须保留人工复核” sentence as a stated fact with a banner.

For the **other three** YAML files: for each of the eight topics, read that topic’s disclosure units and write L1/L2/L3 with the same rule. Do not copy 「关键发现」. After each file, run the Task 5 production parse test below; fix until green.

- [ ] **Step 2: Add production-source tests** to `tests/contracts/hint-discipline.test.ts`

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ScenarioAuthoringSchema } from "../../src/scenarios/schema";
import { collectHintDisciplineIssues } from "../../src/scenarios/hint-discipline";

const SOURCES = [
  "support-automation",
  "manufacturing-alert-triage",
  "data-migration",
  "export-freight-forwarding",
] as const;

describe("production source ladders", () => {
  for (const id of SOURCES) {
    it(`${id} has no hint-discipline issues`, () => {
      const raw = readFileSync(join(process.cwd(), "scenarios", "source", `${id}.yaml`), "utf8");
      const doc = ScenarioAuthoringSchema.parse(parse(raw));
      expect(collectHintDisciplineIssues(doc)).toEqual([]);
    });
  }
});
```

Until Task 6, `ScenarioAuthoringSchema.parse` still **allows** answer L3s; this test only fails if `collectHintDisciplineIssues` is non-empty. Rewrite until it passes.

- [ ] **Step 3: Run**

Run: `npx vitest run tests/contracts/hint-discipline.test.ts tests/contracts/scenario-compiler.test.ts tests/contracts/scenario-calibration.test.ts tests/e2e/all-scenarios.test.ts`

Expected: PASS (calibration/all-scenarios still compile old-schema-valid YAML; discipline test requires the rewrites).

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add scenarios/source/*.yaml tests/contracts/hint-discipline.test.ts
git commit -m "$(cat <<'EOF'
fix: rewrite production hint ladders into Socratic L1/L2/L3

EOF
)"
```

---

### Task 6: Enforce discipline in `ScenarioAuthoringSchema` and recompile bundles

**Files:**
- Modify: `src/scenarios/schema.ts` (`superRefine` after the hint-id/topic loop)
- Modify: `tests/contracts/domain-schema.test.ts` (`validAuthoring()` L3 must be a question)
- Recompile: `scenarios/compiled/<id>/` for the four scenario ids

**Interfaces:**
- Consumes: `collectHintDisciplineIssues` from `src/scenarios/hint-discipline.ts`.
- Produces: `compileScenario` / `ScenarioAuthoringSchema.parse` fail closed on answer-shaped L3.

- [ ] **Step 1: Update `validAuthoring()`** in `tests/contracts/domain-schema.test.ts`

The shared `text` constant has no `?`. Change only the ladder L3 in `validAuthoring()` (and the duplicate-topic test’s pushed ladder) to a question, e.g. `{ "zh-CN": "该问客户哪一句？", "en-US": "What should you ask the customer?" }`. Keep L1/L2 as `text` if they introduce no hidden digits (the disclosure unit also uses `text` — no digits, so numeric overlap is empty).

Add:

```ts
  it("rejects an L3 answer banner", () => {
    const authoring = validAuthoring();
    authoring.evaluator.hintLadders[0].hints["3"] = {
      "zh-CN": "关键发现：工厂效率很低。",
      "en-US": "Key discovery: the plant is inefficient.",
    };
    expect(ScenarioAuthoringSchema.safeParse(authoring).success).toBe(false);
  });
```

Run this test **before** wiring to see RED, then wire.

- [ ] **Step 2: Run to confirm RED**

Run: `npx vitest run tests/contracts/domain-schema.test.ts`

Expected: FAIL (`rejects an L3 answer banner` still parses).

- [ ] **Step 3: Wire the helper** in `src/scenarios/schema.ts`

Add: `import { collectHintDisciplineIssues } from "./hint-discipline.js";`

At the **end** of the existing `superRefine` callback (after event-id checks), append:

```ts
    for (const issue of collectHintDisciplineIssues(doc)) {
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.path,
      });
    }
```

Duplicate-topic issues may then fire **twice** (Task 2 loop + helper). Remove the Task 2 `hintLadderTopics` block and keep a **single** duplicate-topic check inside `collectHintDisciplineIssues` so the path stays `evaluator.hintLadders[i].topic`. Keep the duplicate-**id** loop in `schema.ts` (ids are not the helper’s job).

- [ ] **Step 4: Recompile committed bundles**

From the repo root, using the same seed as `tests/contracts/scenario-compiler.test.ts`:

```ts
import { compileScenario } from "./src/scenarios/compiler.ts";
```

Use a one-off:

```bash
npx tsx -e '
import { compileScenario } from "./src/scenarios/compiler.ts";
const seed = "test-seed-2026-08-23";
for (const id of ["support-automation","manufacturing-alert-triage","data-migration","export-freight-forwarding"]) {
  compileScenario("scenarios/source/" + id + ".yaml", seed);
  console.log("compiled", id);
}
'
```

If `tsx` is not a project dependency, add a 15-line `scripts/compile-scenarios.mjs` that imports the compiled `dist` after `npm run build`, or run via `node --import tsx` only if already available. **Do not invent a second seed.** Overwrite `scenarios/compiled/<id>/`. Canary bytes will follow this seed; that is expected.

- [ ] **Step 5: Run the suite slice**

Run: `npx vitest run tests/contracts/hint-discipline.test.ts tests/contracts/domain-schema.test.ts tests/contracts/scenario-compiler.test.ts tests/contracts/scenario-calibration.test.ts tests/e2e/all-scenarios.test.ts tests/contracts/hint-command.test.ts`

Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/scenarios/schema.ts tests/contracts/domain-schema.test.ts scenarios/compiled
git add scripts/compile-scenarios.mjs   # only if you created it
git commit -m "$(cat <<'EOF'
feat: reject answer-shaped hint L3 at scenario compile time

EOF
)"
```

---

### Task 7: Docs, ADR, and L3 leak assertion

**Files:**
- Modify: `docs/architecture-decisions.md` (append ADR-0003)
- Modify: `docs/scenario-authoring.md` (hint ladder section ~80–89 and the example L3 placeholders ~254–266)
- Modify: `tests/e2e/all-scenarios.test.ts` (request L3 once per scenario and assert Socratic shape)

**Interfaces:**
- Consumes: `hintCommand` from Task 3; compiled ladders from Task 6.
- Produces: documented contract + an e2e that actually grants L3.

- [ ] **Step 1: Append ADR-0003** to `docs/architecture-decisions.md`

```markdown
## ADR-0003: Socratic production hint ladders

- **Status:** Accepted
- **Date:** 2026-08-30

### Context

The deterministic selector and evaluator-only partition were correct, but
production L3 texts stated disclosure-unit facts ("Key discovery"), so a
learner could buy the answer with `--level 3`.

### Decision

- L1 is a thinking dimension, L2 a missing-evidence category, L3 one
  actionable question without the answer.
- Selection remains `requestHint`. Skip-ahead stays allowed.
- `ScenarioAuthoringSchema` rejects answer banners and hidden numeric tokens
  in hint text.
- Runtime generation of hints is not a supported path.

### Consequences

- Production YAML must be rewritten when hidden numbers change.
- Hint grants still do not enter the evidence graph.
```

- [ ] **Step 2: Update `docs/scenario-authoring.md`**

Replace the L1/L2/L3 bullets with the D0.1 table (dimension / category / question). Mention compile-time checks: no `关键发现`/`Key discovery` in L3; L3 must contain `?`/`？`; hint text must not repeat numeric tokens from disclosure units or expected-evidence descriptions.

Replace the example L3 placeholders with a real question that would pass (no numbers from the example’s disclosure text).

- [ ] **Step 3: In `tests/e2e/all-scenarios.test.ts`**

Import `hintCommand`. After `startCommand` (or early in `driveJourney`), grant L3:

```ts
const hint = await hintCommand(ctx, {
  runId,
  topic: "workflow",
  level: 3,
  commandId: `cmd-hint-l3-${id}-${locale}`,
});
expect(hint.ok).toBe(true);
if (hint.ok) {
  const body = hint.data.hint[locale];
  expect(body.includes("?") || body.includes("？")).toBe(true);
  expect(body).not.toMatch(/关键发现|Key discovery/i);
  const unit = pack.customerCapsule.disclosureUnits.find((u) => u.topic === "workflow");
  if (unit) {
    for (const token of numericTokens(unit.text[locale])) {
      expect(body.split(/[^\d.]+/)).not.toContain(token);
    }
  }
}
```

Import `numericTokens` from `src/scenarios/hint-discipline.ts`. `driveJourney` must receive `pack` or compile inside the test after start. If `driveJourney` has no `hintCommand` today, add the grant **in the `it` body** after `driveJourney` only if the run is still in DISCOVERY — it will not be. **Grant L3 at the start of `driveJourney`**, before `frameCommand`, and keep the existing “replay must not contain L3 text” loop: after D2, L3 is a question, so it **may** appear in replay if the grant was recorded. Update that loop:

- Remove `expect(serialized).not.toContain(ladder.hints["3"]["zh-CN"])`.
- Replace with: replay must not contain any `customerCapsule.disclosureUnits[].text` (already asserted) and must not contain `关键发现`.

That is the leak contract that still holds.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/e2e/all-scenarios.test.ts tests/contracts/scenario-compiler.test.ts tests/contracts/skill-package.test.ts`

Expected: PASS. Skill package tests must still forbid the words `hidden` / `capsule` in `SKILL.md` — do **not** put those words in the Skill.

- [ ] **Step 5: Full gate and commit**

```bash
npm run typecheck
npm test
git add docs/architecture-decisions.md docs/scenario-authoring.md tests/e2e/all-scenarios.test.ts
git commit -m "$(cat <<'EOF'
docs: record Socratic hint ladders and assert L3 is a question in e2e

EOF
)"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| D1.1 illegal `--level` | Task 1 |
| D1.2 unique topic | Task 2 (Zod) + Task 4/6 (helper, single path) |
| D1.3 grant from locked ledger | Task 3 |
| D1.4 journal before phase gate | Task 3 |
| D1.5 tests | Tasks 1–3 |
| D2.1 rewrite 32 ladders | Task 5 |
| D2.2 compile-time checks | Tasks 4 and 6 |
| D2.3 tests | Tasks 4–7 |
| ADR-0003 + authoring doc | Task 7 |
| D3–D5 / mvp-acceptance / Coach deletion | out of scope |

## Placeholder scan

No TBD. Duplicate-topic enforcement is specified once after Task 6 (helper only). `tsx` vs `scripts/compile-scenarios.mjs` is an execution-time choice with a fallback.
