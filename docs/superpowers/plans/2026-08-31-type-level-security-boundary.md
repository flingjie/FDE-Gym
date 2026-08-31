# Type-Level Security Boundary (Phase 2b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the role-context firewall's security boundary a compile-time guarantee — `buildRoleInput` takes a `PublicRunView` (not the full `RunAggregate`), so the four `unknown` sensitive fields (`score`/`learnerProfile`/`previousAttemptReview`/`rubric`) are out of type scope inside the firewall.

**Architecture:** Split the `RunAggregate` **type** into `PublicRunView` (public fields) + `SensitiveRunState` (the four `unknown` fields), with `RunAggregate = PublicRunView & SensitiveRunState`. `RunAggregateSchema` stays unchanged (fail-closed over the full aggregate); the narrowing is type-only. Callers are unmodified (structural subtyping).

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-type-level-security-boundary-design.md`

## Global Constraints

- **Behavior-preserving.** The 705-test suite, golden replay byte-stability, and every committed event/score stay identical. No runtime change.
- Structural subtyping only — no caller edit; `RunAggregateSchema` is NOT modified (fail-closed must keep accepting the full aggregate).
- Source imports `.js`; test imports extensionless; no new deps.
- The four sensitive fields stay `unknown`-typed and stay in `RunAggregate`; only their exclusion from `PublicRunView` is new.

---

### Task 1: Split the `RunAggregate` type in `aggregate.ts`

**Files:**
- Modify: `src/core/aggregate.ts`

**Interfaces:**
- Produces: `PublicRunView`, `SensitiveRunState`, and keeps `RunAggregate` (now `PublicRunView & SensitiveRunState`) and `RunAggregateSchema` (unchanged).

- [ ] **Step 1: Replace the `RunAggregate` interface with the split.** In `src/core/aggregate.ts`, replace the single `RunAggregate` interface with the public view, the sensitive state, and the type alias (copy the exact existing field list + types):

```ts
/** The learner-safe public view of a run — every field a role input may be built from. */
export interface PublicRunView {
  runId: string;
  scenarioId: string;
  locale: Locale;
  phase: RunPhase | null;
  transcript: TranscriptTurn[];
  graph: EvidenceGraph;
  disclosedDisclosureUnitIds: string[];
  grantedHints: HintLedgerEntry[];
  pendingQuestion: { question: string; stakeholderId: string } | null;
  coachTask: CoachTask;
  brief: ProblemBrief | null;
  proposal: SolutionProposal | null;
  pitch: PitchArtifact | null;
  challengeResponses: ChallengeResponse[];
  pendingEvidence: { turnId: string; code: string } | null;
  clarificationBudgetUsed: number;
}

/** Fields that must NEVER reach a role input. Recognized by the schema (so they
 *  never trip fail-closed) but excluded from the public view's type. */
export interface SensitiveRunState {
  score?: unknown;
  learnerProfile?: unknown;
  previousAttemptReview?: unknown;
  rubric?: unknown;
}

export type RunAggregate = PublicRunView & SensitiveRunState;
```

Leave `RunAggregateSchema` exactly as-is (the single strict object over all fields, including the four `.optional()` sensitive fields).

- [ ] **Step 2: Verify typecheck + tests.** `npm run typecheck && npm test` — 705 green (type-only change; nothing consumes `PublicRunView` yet).

- [ ] **Step 3: Commit.**

```bash
git add src/core/aggregate.ts
git commit -m "refactor: split RunAggregate type into PublicRunView + SensitiveRunState"
```

---

### Task 2: Narrow the firewall to `PublicRunView`

**Files:**
- Modify: `src/security/context-firewall.ts`
- Create: `tests/contracts/firewall-type-boundary.test.ts` (a `@ts-expect-error` type-guard)

**Interfaces:**
- Consumes: `PublicRunView` (Task 1).
- Produces: `buildRoleInput` overloads whose `state` param is `PublicRunView`.

- [ ] **Step 1: Narrow the parameter + the local.** In `src/security/context-firewall.ts`:
  - Change the three `buildRoleInput` overloads AND the implementation's `state` parameter from `RunAggregate` to `PublicRunView` (update the import from `../core/aggregate.js`).
  - Keep `RunAggregateSchema.safeParse(state)` as-is (fail-closed over the full aggregate).
  - After the parse, narrow the local: change `const agg = parsed.data;` to `const agg: PublicRunView = parsed.data;`.

- [ ] **Step 2: Add the type-guard test** `tests/contracts/firewall-type-boundary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRoleInput } from "../../src/security/context-firewall";
import type { PublicRunView } from "../../src/core/aggregate";

const validPublic = {
  locale: "zh-CN",
  pendingQuestion: { question: "q", stakeholderId: "s1" },
  disclosedDisclosureUnitIds: [],
} as unknown as PublicRunView;

describe("firewall type boundary", () => {
  it("buildRoleInput is callable", () => {
    expect(typeof buildRoleInput).toBe("function");
  });

  it("rejects an aggregate carrying a sensitive field at compile time", () => {
    // @ts-expect-error — score is not on PublicRunView; this line is a type error
    buildRoleInput("customer", { ...validPublic, score: "LEAK" }, { stakeholders: [], disclosureUnits: [], responsePolicies: [] });
    expect(validPublic.locale).toBe("zh-CN");
  });
});
```

- [ ] **Step 3: Verify.** `npm run typecheck && npm test` — typecheck must PASS (the `@ts-expect-error` suppresses the intentional error; if the firewall param were still `RunAggregate`, that line would NOT error and the `@ts-expect-error` would itself be flagged "unused", failing typecheck). 706 tests green; golden replay byte-stable.

- [ ] **Step 4: Commit.**

```bash
git add src/security/context-firewall.ts tests/contracts/firewall-type-boundary.test.ts
git commit -m "refactor: narrow firewall buildRoleInput to PublicRunView"
```

---

## Execution order

1 → 2 (serial; Task 2 depends on Task 1's type).

## Verification checklist

- [ ] `npm run release:gate` green; golden replay byte-stable.
- [ ] Inside `context-firewall.ts`, `agg.score`/`agg.learnerProfile`/`agg.previousAttemptReview`/`agg.rubric` are compile errors (the local `agg` is `PublicRunView`).
- [ ] `buildRoleInput` callers (agent functions) are unmodified and type-check.
- [ ] `RunAggregateSchema` still rejects unknown fields (fail-closed), and still accepts a full aggregate carrying the four sensitive fields.
