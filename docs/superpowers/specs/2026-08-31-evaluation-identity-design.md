# Phase 3a — Evaluation Identity (content-addressed score comparability)

**Date:** 2026-08-31
**Status:** Approved for implementation planning
**Scope:** FDEGym Phase 3 "评测可信度" — first sub-project (Evaluation Identity)

## Context

`ScoreProvenance.comparabilityKey` (`src/scoring/provenance.ts`) currently hashes the
scoring identity (`scoreSchemaVersion`, `formulaVersion`, `capabilityRubricId/Version/Sha256`,
`outputSchemaVersion`, `modelFamily`) and DELIBERATELY EXCLUDES the scenario
(`scenarioBundleSha256`) — its comment reads "the fixed rubric is scenario-independent".
Consequently the learner profile's EMA blends scores across DIFFERENT scenarios, and even
across different prompt templates, as long as the rubric/formula/model match.

This sub-project makes score comparability **content-addressed** over the full evaluation
identity — scenario content, prompt set, rubric, scoring formula, runtime policy, and model
family — so "did a model or prompt change make this score non-comparable?" is answerable, and
the identity becomes the profile EMA comparability key and the score's report key.

## Non-negotiable constraints

- **Behavior-preserving for the single-(scenario,prompt,rubric,scoring,runtime,model) tuple.**
  The full suite (730 tests) and golden replay stay green; the change is additive to
  `ScoreProvenance` (new fields + a richer hash).
- **Semantic change (intended, flagged):** the profile EMA comparability key becomes
  scenario- AND prompt-inclusive, so an attempt on a different scenario or with a changed
  prompt template no longer blends into the same EMA (it increments `discontinuities`
  instead). Existing tests that fold multiple attempts against the SAME scenario+prompt are
  unaffected; any test that blended across scenarios must be updated to the new contract.
- Source imports `.js`; test imports extensionless; no new deps.

## The identity (`src/scoring/identity.ts`)

```ts
export interface EvaluationIdentity {
  scenarioDigest: string;      // scenarioBundleSha256 ("" for provenance-legacy)
  promptSetDigest: string;     // sha256 over the three role prompt templates
  rubricVersion: number;       // CAPABILITY_RUBRIC_VERSION
  scoringVersion: number;      // SCORE_SCHEMA_VERSION + FORMULA_VERSION (a single hash/number)
  runtimePolicyVersion: number;// NEW constant (bumps when runtime behavior changes)
  modelFamily: string | null;  // modelId
}

export function computeEvaluationIdentity(input: {
  scenarioBundleSha256: string | null;
  rubricVersion: number;
  scoringVersion: number;      // or { scoreSchemaVersion, formulaVersion }
  runtimePolicyVersion: number;
  modelId: string | null;
}): EvaluationIdentity;

/** sha256 over the three `resources/prompts/*.md` file contents, in sorted filename order. */
export function promptSetDigest(): string;
```

`computeEvaluationIdentityHash(identity): string` = `sha256(canonicalJson(identity))` — the
comparability key.

## Prompt set digest

`resources/prompts/{coach-evaluator,customer,evidence-tracker}.md` are read (as the render
functions already do) and hashed in sorted filename order into `promptSetDigest()`. Changing
any prompt template changes the digest → changes the identity → the EMA no longer blends.

## Runtime policy version

Introduce `RUNTIME_POLICY_VERSION = 1` (next to the other version constants) — a manual
version bumped when the runtime's observable behavior (timeout, structured-output approach,
cancellation semantics) changes. No runtime code reads it yet; it is provenance only.

## Wiring

- `buildScoreProvenance` (`src/scoring/provenance.ts`) gains the full identity: it already has
  `scenarioBundleSha256` + `modelId` + the rubric/scoring versions; add `promptSetDigest` +
  `runtimePolicyVersion` and compute the `comparabilityKey` as
  `computeEvaluationIdentityHash(...)` over the FULL identity (now including the scenario and
  prompt set, where today `computeComparabilityKey` excludes the scenario).
- `ScoreProvenanceSchema` gains `promptSetDigest` and `runtimePolicyVersion` (additive;
  legacy `legacyScoreProvenance()` leaves them with neutral defaults).
- The profile EMA (`src/profile/learner-profile.ts`) is unchanged in code — it already keys on
  `comparabilityKey`; the richer key now makes it scenario/prompt-inclusive automatically.

## Out of scope (later Phase-3 sub-projects)

- Evaluator repeated sampling / double-review and a derived confidence score.
- Model-version drift detection and scenario-difficulty calibration (these CONSUME the
  identity but are separate work).
- End-to-end real-model contract suite.
- A standalone "eval report" artifact (the identity lives on `score.computed` provenance for
  now).

## Testing

- Unit-test `promptSetDigest()` (stable across calls; changes when a template file changes).
- Unit-test `computeEvaluationIdentity`/hash (deterministic; scenario- and prompt-sensitive).
- Update any profile test that relied on cross-scenario blending to assert the new
  discontinuity behavior. Full suite green; golden replay byte-stable.

## Success criteria

- `npm run release:gate` green; golden replay byte-stable.
- The `comparabilityKey` is content-addressed over scenario + prompt set + rubric + scoring +
  runtime + model, so a scenario or prompt change yields a different key and a profile
  `discontinuity`.
