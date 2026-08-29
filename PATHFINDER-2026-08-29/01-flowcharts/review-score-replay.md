# 评审、评分、画像与重放

```mermaid
flowchart TD
  A["reviewCommand<br/>src/cli/commands.ts:718-746"] --> B["prepareReview<br/>src/core/orchestrator.ts:1123-1185"]
  B --> C["Coach final-review<br/>src/agents/coach.ts:213-241"]
  C --> D["buildScoreInput + provenance<br/>src/scoring/score-input.ts:226-334"]
  D --> E["calculateScore<br/>src/scoring/formulas.ts:142-226"]
  E --> F["review.completed + score.computed<br/>src/core/orchestrator.ts:1164-1167"]
  F --> G["profile effect exactly once<br/>src/storage/fs-store.ts:52-68"]
  G --> H["six-competency EMA<br/>src/profile/learner-profile.ts:170-215"]
  F --> I["projectReplay<br/>src/replay/projector.ts:301-451"]
  I --> J["learner-safe recorded replay"]
  F --> K["prepareRetry<br/>src/core/orchestrator.ts:982-1066"]
  K --> L["clean child run + retry.focus<br/>src/core/orchestrator.ts:1001-1052"]
```

- Coach judgment is non-deterministic; score formulas, provenance, EMA and replay projection are deterministic.
- Retry clears graph/transcript/disclosure/hints while retaining 2–3 learner-visible focus summaries.
- Dependency: event stream is the source of truth for aggregate, replay and score input.
