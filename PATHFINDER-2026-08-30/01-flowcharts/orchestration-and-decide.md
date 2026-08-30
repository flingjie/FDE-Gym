# Flow: phase-decision-kernel + command-orchestration

## Architecture one-liner

`decide()` is a **phase guard + collapsed success path**; the orchestrator **re-implements richer multi-step event batches**, often **discarding** `decide()`’s returned events; CLI persists via `executeCommandTransaction` (not the `run*` wrappers).

## decide vs orchestrator emission matrix

| Command | Phase in | `decide()` returns | Orchestrator happy emits | decide used as |
|---------|----------|--------------------|--------------------------|----------------|
| `ask` | DISCOVERY | `question.asked` | `question.asked` + `customer.replied` + `evidence.patched` + `question.assessed` | **source of first event** |
| `submit-brief` | PROBLEM_FRAMING | `phase.changed→SOLUTION_DESIGN` | `brief.submitted` + `brief.validated` + optional `phase.changed` | **guard only (DISCARDED)** |
| `respond-challenge` | CHALLENGE | `phase.changed→PITCH` | `challenge.responded` + optional `phase.changed` | **guard only (DISCARDED)** |
| `review` | REVIEW | `[]` | `review.completed` + `score.computed` (+ profile effect) | **guard only (empty)** |
| `submit-design` | SOLUTION_DESIGN | `phase.changed→CHALLENGE` | `design.submitted` + `phase.changed` | **DISCARDED** |
| `submit-pitch` | PITCH | `phase.changed→REVIEW` | `pitch.submitted` + `phase.changed` | **DISCARDED** |
| `hint` | D/PF | `hint.granted` w/ **placeholder text** | CLI bypasses decide; uses pure `simulation/hints` | **dead if used** |

## Mermaid

```mermaid
flowchart TD
  ASK_CMD["askCommand<br/>commands.ts:382"] --> TXN["executeCommandTransaction<br/>command-transaction.ts:256"]
  BRIEF_CMD["submitBriefCommand<br/>commands.ts:562"] --> TXN
  RESP_CMD["respondChallengeCommand<br/>commands.ts:651"] --> TXN
  REV_CMD["reviewCommand<br/>commands.ts:720"] --> TXN

  TXN --> P_ASK["prepareDiscoveryTurn<br/>orchestrator.ts:200"]
  TXN --> P_BRIEF["prepareFramingGate<br/>orchestrator.ts:423"]
  TXN --> P_RESP["prepareRespondToChallenge<br/>orchestrator.ts:823"]
  TXN --> P_REV["prepareReview<br/>orchestrator.ts:1123"]

  P_ASK --> D_ASK["decide ask<br/>state-machine.ts:59"]
  D_ASK --> KEEP["KEEP question.asked<br/>orchestrator.ts:211"]
  KEEP --> M_CUST["answerDiscoveryQuestion<br/>orchestrator.ts:217"]
  M_CUST --> M_EV["extractEvidence<br/>orchestrator.ts:244"]
  M_EV --> OUT_ASK["4 events batch<br/>orchestrator.ts:301"]

  P_BRIEF --> D_BRIEF["decide submit-brief<br/>state-machine.ts:90"]
  D_BRIEF --> DISC_B["DISCARD return<br/>orchestrator.ts:432"]
  DISC_B --> GATES["Zod+structure+coach+ratio<br/>orchestrator.ts:435-458"]
  GATES --> OUT_B["submitted+validated±phase<br/>orchestrator.ts:463"]

  P_RESP --> D_RESP["decide respond-challenge<br/>state-machine.ts:102"]
  D_RESP --> DISC_R["DISCARD unconditional phase<br/>orchestrator.ts:831"]
  DISC_R --> OUT_R["responded±conditional phase<br/>orchestrator.ts:841"]

  P_REV --> D_REV["decide review → []<br/>state-machine.ts:110"]
  D_REV --> M_FR["runFinalReview<br/>orchestrator.ts:1134"]
  M_FR --> SCORE["buildScoreInput+calculateScore<br/>orchestrator.ts:1149"]
  SCORE --> OUT_REV["review.completed+score.computed<br/>orchestrator.ts:1184"]
  OUT_REV --> EFF["profile.apply-attempt effect<br/>orchestrator.ts:1177"]

  OUT_ASK --> APPEND["appendEvents via txn<br/>command-transaction.ts:312"]
  OUT_B --> APPEND
  OUT_R --> APPEND
  OUT_REV --> APPEND
  EFF --> FX["applyEffects<br/>command-transaction.ts:313"]

  OUT_ASK -.-> BYPASS["run* direct appendEvents<br/>orchestrator.ts:313+"]
  OUT_B -.-> BYPASS
```

## Side-effect summary

```
prepare*  = plan (may call models) → { acceptedEvents, effects? }
run*      = prepare* + appendEvents   // bypass journal
CLI path  = prepare* inside executeCommandTransaction
```

## External deps

- agents (customer, evidence-tracker, coach)
- evidence graph + brief-validator
- scoring formulas + score-input
- command-transaction + event-store
- RunAggregate from context-firewall
- scenario capsules via CLI resolveScenario

## Confidence: high

Sources: state-machine.ts, reducer.ts, orchestrator.ts key ranges, commands.ts call sites, command-transaction.ts.
