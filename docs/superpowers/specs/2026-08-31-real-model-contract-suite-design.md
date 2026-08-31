# Phase 3c — End-to-End Real-Model Contract Suite

**Date:** 2026-08-31
**Status:** Approved for implementation planning
**Scope:** FDEGym Phase 3 "评测可信度" — real-model contract suite

## Context

The current e2e tests drive the pipeline with `FixtureAgentRuntime` (deterministic), proving
the schema/state-machine/firewall contract but NOT that the real model path works end-to-end.
This sub-project adds a real-model contract suite that runs a full run against
`DirectModelRuntime` and asserts the learner-facing contract — valid role outputs, no hidden
content leakage, byte-stable replay, and a fully-provenanced score.

## Goal

- A gated vitest suite (`tests/e2e/real-model-contract.test.ts`) that SKIPS unless a model
  endpoint is configured (`FDE_GYM_MODEL_BASE_URL` + `FDE_GYM_MODEL`).
- When configured, it drives a full run (start → ask → frame → submit-brief → submit-design →
  respond-challenge → submit-pitch → review → replay) against the real model and asserts the
  contract. It is NOT part of CI (flaky, model-dependent).

## Non-negotiable constraints

- **Never in CI.** The suite skips cleanly (not fails) when the env vars are absent. It is
  added to `README` as a manual "real-model contract check" step, not to `release:gate`.
- **Model-agnostic assertions.** The model is non-deterministic, so assertions are STRUCTURAL
  (schema-valid, no leakage, byte-stable replay, provenance present) — never specific scores.
- No new deps; source `.js` / test extensionless (or `.mjs` if a script).

## The contract (what is asserted)

1. **Pipeline succeeds.** Each command returns an `ok` envelope (exit 0 in the CLI sense).
2. **Role outputs are schema-valid.** Implicitly enforced by `sanitizeAgentResult`/the
   firewall; the suite additionally asserts each `data` field parses against its `*Data`
   Zod schema (or simply that commands do not throw `AGENT_OUTPUT_MALFORMED`).
3. **No hidden content leaks.** The serialized CLI envelopes never contain the scenario
   canary, any disclosure-unit id, `expectedEvidence`, or `chainOfThought` (reuse the
   `PROHIBITED_OUTPUT_KEYS` + canary list).
4. **Byte-stable replay.** `replay` run twice yields byte-identical JSON.
5. **Fully-provenanced score.** `review` output carries `score`, `stageStates`,
   `measuredCapability`, `confidence`, and the `score.computed` provenance carries a
   `comparabilityKey` (the Evaluation-Identity hash) + `promptSetDigest` +
   `runtimePolicyVersion` + `modelId`.

## Shape

`tests/e2e/real-model-contract.test.ts`:

```ts
const configured = Boolean(process.env.FDE_GYM_MODEL_BASE_URL && process.env.FDE_GYM_MODEL);
describe.skipIf(!configured)("real-model contract", () => {
  // build deps with DirectModelRuntime(resolveDirectModelConfig())
  // drive start→ask→…→review→replay via the application use cases
  // assert the five contract points above
});
```

Reuse the existing e2e harness (`buildDeps`, the use cases, a compiled scenario) but with
`DirectModelRuntime` instead of a fixture runtime. Add `README` "## Verify (real model)"
documenting the env vars + `npx vitest run tests/e2e/real-model-contract.test.ts`.

## Out of scope

- Model-version drift detection and scenario-difficulty calibration (next sub-project).
- Running the suite in CI or wiring it into `release:gate`.

## Testing

- The suite is skipped in CI (no env vars) — existing 746 tests + release:gate stay green.
- A developer with a live endpoint runs it manually and sees pass/fail for the five contract
  points.

## Success criteria

- The suite skips cleanly with no endpoint, and runs + reports the five contract points when
  an endpoint is configured.
- `npm run release:gate` green (the new suite is excluded/skipped).
- `README` documents the real-model contract check.
