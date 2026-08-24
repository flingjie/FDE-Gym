# Scoring

Scoring is **deterministic**: integer/float math only, no `Math.random`, no
`Date.now`, and rounding only where the spec says `round` (the final score). The
single source of truth is `src/scoring/formulas.ts` (`calculateScore`), with
stage/criterion weights in `src/scoring/rubric.ts` and input derivation in
`src/scoring/score-input.ts`.

## Inputs

- `coverage` — ratio `0..1`: revealed expected-evidence weight / total
  expected-evidence weight (question-driven revelation + automatic event
  disclosure).
- `totalExpectedWeight` — Σ of every expected-evidence `weight`.
- `questionBudget` — the scenario's public question budget.
- `questions[]` — per-question inputs in asked order.
- `stakeholderCoverage`, `contradictionHandling` — percentages `0..100`.
- `stageScores` — `{ framing, solution, challenge, pitch, process }` `0..100`.
- `hintCounts` — `{ l1, l2, l3 }`.
- `criticalUnsupported`, `unacknowledgedCriticalContradictions` — counts.
- `briefSupport` — weighted support ratio `0..1`.
- `pitchExplicitAsk`, `leakGuardViolation` — booleans.

## Per-question information gain / efficiency

For each question (`computeQuestion`):

```
gq            = newlyRevealedWeight / totalExpectedWeight        (0 if denominator 0)
informationGain (IGq) = 100 × min(1, questionBudget × gq)
form (Formq)  = atomicity × neutrality × relevance × (1 − redundancy)
                (each factor clamped to 0..1)
efficiency (QuestionEfficiencyq) = IGq × Formq
```

Only **question-driven** revelation counts toward a question's `gq`/`IGq`;
automatic event disclosure contributes to `coverage` but never to a question's
gain. `newlyRevealedWeight` is the weight of evidence revealed **by this
question** and not already revealed.

## Aggregates

```
averageForm     = (questionCount === 0) ? 0 : Σ(Formq) / questionCount
budgetFactor    = min(1, questionBudget / max(questionCount, 1))
questionEfficiency (QE) = clamp100(100 × coverage × (0.6 + 0.4 × averageForm) × budgetFactor)

coveragePercent = 100 × coverage
discovery       = clamp100(0.35 × coveragePercent
                           + 0.25 × QE
                           + 0.20 × stakeholderCoverage
                           + 0.20 × contradictionHandling)
```

`stakeholderCoverage` is the percentage of distinct stakeholders asked;
`contradictionHandling` is the percentage of `contradiction`-kind evidence
nodes referenced by the brief's contradiction dispositions (100 when there are
none).

## Stage scores and Raw

Stage scores are percentages `0..100` (weighted criterion means; see
`computeStageScore`). The fixed capability rubric (`src/scoring/rubric.ts`):

| Stage | Criteria (weight %) |
|---|---|
| Framing | Evidence Support 40 · Goal Clarity 25 · Constraints/Trade-offs 20 · Unknown/Risk Handling 15 |
| Solution | Traceability 30 · Feasibility 25 · Trade-offs 20 · Validation 15 · Scope Discipline 10 |
| Challenge | Adaptation 40 · Valid Invariants 30 · New Evidence 30 |
| Pitch | Audience Fit 25 · Problem/Evidence 25 · Recommendation 20 · Risks/Ask 15 · Concision/Structure 15 |
| Process | Evidence Hygiene 40 · Fact/Assumption Separation 25 · Contradictions 20 · Stage Discipline 15 |

```
Raw = 0.25×discovery + 0.20×framing + 0.20×solution
      + 0.10×challenge + 0.15×pitch + 0.10×process
```

(`RAW_STAGE_WEIGHTS`: discovery 25 · framing 20 · solution 20 · challenge 10 ·
pitch 15 · process 10.)

## Penalties and final score

```
hintPenalty = min(12, l1 + 3×l2 + 6×l3)
integrity   = min(10, 2×criticalUnsupported + 5×unacknowledgedCriticalContradictions)
final       = round(clamp100(Raw − hintPenalty − integrity))
```

All intermediate scores clamp to `0..100`; `final` is additionally rounded
(half-up, JS `Math.round`).

## Pass gates

```
passes.finalScore                            = final ≥ 75
passes.briefSupport                          = briefSupport ≥ 0.75
passes.noUnacknowledgedCriticalContradiction = unacknowledgedCriticalContradictions === 0
passes.pitchExplicitAsk                      = pitch has a non-empty explicit ask
passes.noLeakGuardViolation                  = no leak-guard violation
```

The weighted **support ratio** (`src/evidence/brief-validator.ts`):

```
SupportRatio = Σ(claimWeight × entailmentScore) / Σ(claimWeight)
claimWeight: critical=3, major=2, minor=1
entailmentScore: supported=1, partial=0.5, unsupported=0
```

The framing gate passes when `structure.passed && supportRatio ≥ 0.75`.

## Learner-profile EMA

`src/profile/learner-profile.ts` updates each of six competencies after an
attempt (coaching recommendations only — it never changes truth or rubric
weights):

```
new competency = clamp(0, 100, 0.7 × previous + 0.3 × current)
```

## Stage scores and per-question form — real inputs, deterministic fallback

Two scoring inputs have a **real model source** but remain deterministic and
byte-stable when that source is absent:

- The Coach's `FinalReviewResult` now carries an **optional** `criterionScores`
  field — per-stage, per-criterion numeric scores (0..100) against the fixed
  capability rubric. `src/scoring/score-input.ts` derives each stage score with
  `computeStageScore` (the weighted criterion mean) when that stage has at least
  one criterion score.
- The Evidence Tracker's per-question `questionAssessment` is now persisted as a
  `question.assessed` event; `score-input.ts` reads its
  `atomicity/neutrality/relevance/redundancy` for the per-question FORM metric.

When a source is absent (an older committed run, or a Coach/tracker output
without the field), the documented deterministic fallback applies:

```
framing   = clamp100(briefSupport × 100)
solution  = proposalPresent ? 100 : 0
challenge = mandatory === 0 ? 100 : clamp100(100 × answered/mandatory)
pitch     = pitchExplicitAsk ? 100 : 0
process   = clamp100(100 − hintPenalty)
```

Per-question form fallback: a question that revealed new evidence scores
`atomicity=neutrality=relevance=1, redundancy=0`; one that revealed nothing
scores `relevance=0, redundancy=1`. A stage whose `criterionScores` map is empty
falls back per-stage (never collapses to 0). Both fallbacks are deterministic
(no model call) so replay and score remain byte-stable.
