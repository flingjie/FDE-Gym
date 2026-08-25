# Replay

`src/replay/projector.ts` provides two deterministic consumers of the committed
event stream. **Claim (determinism #3): the same event log → byte-stable
recorded replay** — `projectReplay` is a pure projection, so identical committed
events yield identical bytes in every locale, across runs.

- `foldRunAggregate(events, scenarioId, locale)` rebuilds the **full internal**
  `RunAggregate` so the orchestrator/firewall can resume a persisted run
  (phase, transcript, evidence graph, disclosure ledger, granted hints, brief,
  proposal, pitch, challenge responses). Transient working state
  (`pendingQuestion`) is never resurrected.
- `projectReplay(events, locale)` renders the learner-safe `LearnerReplay`.

## Recorded replay (byte-stable) vs re-simulation

| Mode | Guarantee |
|---|---|
| `"recorded"` | **Byte-stable** projection of the committed events. Same events → identical bytes, in every locale, across runs. Deterministic: no model, no wall-clock. |
| `"re-simulation"` | A separate mode promising only deterministic **event/state order**, never identical model prose. Not implemented in Task 11; the label exists so a future command cannot conflate the two. |

`projectReplay` always emits `mode: "recorded"` today. It is
locale-parameterized: every `LocalizedText` resolves to the requested locale,
and the output does not depend on the locale used at run time.

## `LearnerReplay` shape

```ts
interface LearnerReplay {
  mode: ReplayMode;                 // "recorded"
  runId: string;
  scenarioId: string;
  locale: Locale;
  phase: RunPhase | null;
  stages: ReplayStageChange[];      // { from, to }
  transcript: ReplayTurn[];         // { turnId, seq, question, customerReply, stakeholderId }
  graphDiffs: ReplayGraphDiff[];    // per-patch addNodes/addEdges/invalidateNodeIds
  questionMetrics: ReplayQuestionMetric[]; // { turnId, informationGain, nodeCount }
  hints: ReplayHint[];              // { topic, level, hint }
  eventInjections: ReplayEventInjection[]; // { challengeId, prompt }
  artifacts: ReplayArtifacts;       // brief/proposal/pitch ids + submission counts
  score: ScoreBreakdown | null;     // the persisted score.computed breakdown
  strengths: string[];
  weaknesses: string[];
  missedOpportunities: string[];
  decisionDivergencePoints: ReplayDecisionDivergencePoint[];
  nextFocus: string[];
}
```

## What is excluded (by construction)

`projectReplay` builds each field **field-by-field** (never spreading an event),
so the following are structurally incapable of surfacing in the replay:

- **Canaries** (customer/evaluator role canaries).
- **Chain-of-thought** / raw role reasoning (never stored; the Codex JSONL
  parser drops `reasoning` events).
- **Disclosure-unit ids** (the disclosure ledger is internal only).
- **Hidden capsules** (customer facts, expected evidence, rubric weights, hint
  ladders, pass gates, critical contradictions).
- **Raw evaluator output** beyond the sanitized `FinalReviewResult` fields.

The replay exposes only learner-safe numbers, public ids, and the sanitized
Coach review (strengths/weaknesses/missed opportunities/decision-divergence
points/next focus) over public input. The `"score"` is the numeric
`ScoreBreakdown` persisted by the `score.computed` event — numbers and booleans
only, no hidden content.
