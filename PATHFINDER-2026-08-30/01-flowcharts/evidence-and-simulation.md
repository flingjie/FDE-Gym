# Flow: evidence-and-simulation

## Happy paths

```mermaid
flowchart TD
  PATCH["EvidenceTracker patch<br/>src/agents/evidence-tracker.ts"] --> APPLY["applyEvidencePatch<br/>src/evidence/graph.ts"]
  APPLY --> GRAPH["EvidenceGraph state<br/>in RunAggregate"]

  BRIEF["ProblemBrief"] --> STRUCT["validateBriefStructure<br/>src/evidence/brief-validator.ts"]
  GRAPH --> STRUCT
  STRUCT --> RATIO["calculateSupportRatio<br/>src/evidence/brief-validator.ts"]

  CTX["buildTriggerContext<br/>src/core/orchestrator.ts:690"] --> SEL["selectScenarioEvents<br/>src/simulation/event-scheduler.ts"]
  RNG["createRng mulberry32<br/>src/simulation/rng.ts"] --> SEL
  SEL --> INJ["prepareChallengeInjection<br/>src/core/orchestrator.ts:726"]

  TOPIC["hint topic+level"] --> HINT["requestHint pure<br/>src/simulation/hints.ts:72"]
  LADDER["evaluator.hintLadders"] --> HINT
  LEDGER["aggregate.grantedHints"] --> HINT
  HINT --> EVT["hint.granted event<br/>src/cli/commands.ts:500"]
```

## Side effects
- None of these modules I/O themselves; orchestrator/CLI persist events
- Hints never enter evidence graph or Customer context (by design)

## Dead / dual path
- `src/agents/coach.ts` also exports `requestHint` (model path) — production CLI uses pure `simulation/hints.ts` only (ADR-0003)

## External deps
- Orchestrator discovery/framing/challenge
- CLI hintCommand
