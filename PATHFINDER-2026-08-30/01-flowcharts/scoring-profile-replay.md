# Flow: scoring-profile-replay

## Happy path

```mermaid
flowchart TD
  RevCLI["reviewCommand<br/>cli/commands.ts:720"] --> Load["loadRunState foldRunAggregate<br/>cli/commands.ts:226"]
  Load --> Txn["executeCommandTransaction"]
  Txn --> PrepR["prepareReview<br/>orchestrator.ts:1123"]
  PrepR --> FinalR["runFinalReview<br/>coach.ts:213"]
  FinalR --> BSI["buildScoreInput<br/>score-input.ts:226"]
  BSI --> Stages["deriveStageScores model or fallback<br/>score-input.ts:115"]
  Stages --> Prov["buildScoreProvenance<br/>provenance.ts:184"]
  Prov --> Calc["calculateScore<br/>formulas.ts:142"]
  Calc --> DAR["deriveAttemptReview<br/>score-input.ts:359"]
  DAR --> Eff["profile.apply-attempt effect<br/>orchestrator.ts:1177"]
  Calc --> Evts["review.completed + score.computed"]
  Evts --> Commit["appendEvents + applyEffects"]
  Eff --> EMA["updateLearnerProfile 0.7/0.3<br/>learner-profile.ts:170"]
  EMA --> SaveP["saveLearnerProfile atomic<br/>fs-store.ts:33"]

  RepCLI["replayCommand<br/>cli/commands.ts:756"] --> Proj["projectReplay<br/>projector.ts:301"]
  Proj --> Fold["foldRunAggregate<br/>projector.ts:182"]
  Fold --> LR["LearnerReplay recorded<br/>projector.ts:431"]
  FoldDef["RunAggregate type<br/>context-firewall.ts:87"] -.-> Fold
  Pub["projectPublic<br/>public-projection.ts:59"] -.->|tests twin| Proj
```

## Notes
- Score stage dual path: Coach criterion preferred; deterministic fallback if missing; provenance records which
- `projectPublic` not used by CLI today; discipline twin of projector
- Model never owns numeric weights

## Confidence: high
