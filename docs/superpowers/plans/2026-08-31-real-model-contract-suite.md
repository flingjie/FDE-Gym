# Real-Model Contract Suite (Phase 3c) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gated, real-model end-to-end contract suite that runs a full run against `DirectModelRuntime` and asserts the learner-facing contract — skips cleanly (never fails) without a model endpoint, and is excluded from CI.

**Architecture:** A `tests/e2e/real-model-contract.test.ts` gated by `describe.skipIf`, reusing the existing e2e harness (`*Command` functions + a compiled scenario) but with `DirectModelRuntime` instead of a fixture; plus `README` documentation of the manual check.

**Tech Stack:** TypeScript (Node ≥ 22), Vitest. No new deps.

**Spec:** `docs/superpowers/specs/2026-08-31-real-model-contract-suite-design.md`

## Global Constraints

- **Never in CI.** The suite skips (not fails) when `FDE_GYM_MODEL_BASE_URL`/`FDE_GYM_MODEL` are absent; NOT wired into `release:gate`.
- **Model-agnostic assertions** (structural, never specific scores).
- Source `.js`; test extensionless; no new deps.

---

### Task 1: The gated contract suite

**Files:**
- Create: `tests/e2e/real-model-contract.test.ts`

- [ ] **Step 1: Build the real-runtime harness.** Reuse the existing e2e helpers from `tests/e2e/cli-flow.test.ts` (read it first): its `context(...)` builder, `mustOk` unwrap, and scenario loading (`loadScenarioBundle` → preloaded `CommandContext.scenario`). In the new file:

```ts
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDirectModelConfig } from "../../src/integrations/direct/config";
import { DirectModelRuntime } from "../../src/integrations/direct/direct-runtime";
// ... import the *Command functions + a compiled scenario loader as in cli-flow.test.ts

const config = resolveDirectModelConfig();
const configured = config !== null;
```

`describe.skipIf(!configured)("real-model contract", () => { ... })`.

- [ ] **Step 2: Drive the full pipeline.** In `beforeAll` (or a single `it`), build `deps`/`ctx` with `runtime: new DirectModelRuntime(config!)`, a temp `baseDir`, and a preloaded compiled scenario; then run the sequence `startCommand → askCommand → frameCommand → submitBriefCommand → submitDesignCommand → respondChallengeCommand → submitPitchCommand → reviewCommand → replayCommand` via the `*Command` functions (same call shapes as `cli-flow.test.ts`).

- [ ] **Step 3: Assert the five contract points.**

```ts
// 1. pipeline succeeded — every mustOk() unwrap already asserts ok === true
// 2. schema-valid role outputs — assert the *Data fields parse (or that no AGENT_OUTPUT_MALFORMED was thrown)
// 3. no hidden leakage — for each serialized envelope, assert none of:
//    [canary, ...disclosureUnitIds, "expectedEvidence", "chainOfThought", "rubric"] appears
// 4. byte-stable replay — run replayCommand twice, expect JSON.stringify(r1.data) === JSON.stringify(r2.data)
// 5. fully-provenanced score — review result has score/stageStates/measuredCapability/confidence;
//    loadEvents the run and assert the score.computed provenance carries a 64-hex comparabilityKey,
//    promptSetDigest, runtimePolicyVersion, and modelId
```

- [ ] **Step 4: Verify + commit.** `npm run typecheck && npm test` — the suite must SKIP (no endpoint) with the existing 746 tests green. If an endpoint is present in this environment, the suite may RUN; do not let it fail the commit — treat a model-dependent failure as a note, not a blocker (the assertions are structural).

```bash
git add -A && git commit -m "test: add gated real-model end-to-end contract suite"
```

---

### Task 2: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Verify (real model)" section.** Document:

```markdown
## Verify (real model)

The deterministic suite runs on fixtures; to additionally check the real model path
end-to-end, point the direct runtime at a chat-completions endpoint and run the contract
suite (it skips when the endpoint is absent):

    FDE_GYM_MODEL_BASE_URL=http://127.0.0.1:15721/v1 \
    FDE_GYM_MODEL=deepseek-v4-pro \
    npx vitest run tests/e2e/real-model-contract.test.ts

The suite asserts the learner-facing contract: the full run (start→…→review→replay) succeeds,
role outputs are schema-valid, no hidden content leaks, replay is byte-stable, and the score
carries full provenance (evaluation identity + confidence). It is not part of CI.
```

- [ ] **Step 2: Verify + commit.**

```bash
git add -A && git commit -m "docs: document the real-model contract check"
```

---

## Execution order

1 → 2.

## Verification checklist

- [ ] Suite skips cleanly with no endpoint; `npm run release:gate` green (excluded/skipped).
- [ ] README documents the env vars + command.
- [ ] The five contract points are asserted (structure-only, no specific-score expectations).
