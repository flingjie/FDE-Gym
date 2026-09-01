import { describe, expect, it } from "vitest";

import { FinalReviewOutputSchema } from "../../../src/agents/contracts.js";
import { FixtureAgentRuntime } from "../../../src/agents/fixture-runtime.js";
import type { RunAggregate } from "../../../src/core/aggregate.js";
import {
  ReviewCompletedEventSchema,
  ScoreComputedEventSchema,
  type LocalizedText,
  type PitchArtifact,
  type ProblemBrief,
  type RunEvent,
  type SolutionProposal,
} from "../../../src/core/domain.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
} from "../../../src/scenarios/schema.js";
import {
  AGENT_OUTPUT_INVALID,
  LEAK_GUARD_TRIGGERED,
  type RawAgentResult,
} from "../../../src/security/sanitizer.js";
import {
  coachReviewInvoke,
  handlers,
  judgmentGuard,
  profileEffectPrepare,
  reviewCommit,
  reviewInputBuild,
  scoreCompute,
} from "../../../src/graph/nodes/review/handlers.js";

const text = (zh: string, en: string): LocalizedText => ({ "zh-CN": zh, "en-US": en });
const CANARY = "EVALUATOR_CANARY_SECRET_9d4f2a7b";
const SCENARIO_DIGEST = "a".repeat(64);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function evaluatorCapsule(): EvaluatorCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    expectedEvidence: [],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [],
    passGates: [],
    canary: CANARY,
  };
}

function customerCapsule(): CustomerCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: [
      { id: "s-owner", role: text("运维负责人", "Ops owner"), persona: text("负责运维", "Runs operations"), concerns: [], blindSpots: [] },
    ],
    disclosureUnits: [],
    responsePolicies: [],
    privateConflicts: [],
    canary: "CUSTOMER_CANARY_111111",
  };
}

function publicScenario(): PublicScenario {
  return {
    id: "scn-1",
    schemaVersion: 1,
    locale: "zh-CN",
    openingRequest: text("请调查告警处理效率问题", "Investigate alert-handling efficiency"),
    visibleContext: text("工厂", "Factory"),
    visibleConstraints: [],
    deliverables: [],
    learnerRules: [],
    questionBudget: 5,
  };
}

function brief(): ProblemBrief {
  return {
    id: "brief-1",
    problemStatement: text("告警处理效率低下", "Alert handling is inefficient"),
    goal: text("降低告警处理负担", "Reduce alert-handling burden"),
    constraints: [text("内网部署", "On-premises")],
    claims: [{ id: "claim-1", statement: text("三套遗留系统", "Three legacy systems"), weight: "major", evidenceIds: ["ev-a"] }],
    successMeasures: [],
    unknowns: [],
    contradictions: [],
  };
}

function proposal(): SolutionProposal {
  return {
    id: "proposal-1",
    objective: text("降低告警负担", "Reduce alert burden"),
    approach: text("分层分类", "Tiered classification"),
    approachEvidenceIds: ["ev-a"],
    assumptions: [],
    alternatives: [{ id: "alt-1", description: text("外包", "Outsource"), tradeoff: text("成本高", "Costly") }],
    tradeoffs: [],
    risks: [],
    validationPlan: [],
    rolloutPlan: [],
    decisions: [],
  };
}

function pitch(): PitchArtifact {
  return {
    id: "pitch-1",
    audience: text("管理层", "Leadership"),
    problem: text("告警低效", "Inefficient alerts"),
    recommendation: text("分层AI", "Tiered AI"),
    expectedValue: text("削减工作量", "Cut workload"),
    evidenceIds: ["ev-a"],
    risks: [],
    ask: text("批准试点", "Approve pilot"),
    nextSteps: [],
  };
}

function reviewState(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "REVIEW",
    transcript: [],
    graph: {
      version: 0,
      nodes: [
        { id: "ev-a", kind: "assumption", claim: text("三套遗留系统", "Three legacy systems"), status: "active", sourceTranscriptIds: [], weight: 1, version: 0 },
      ],
      edges: [],
    },
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: null,
    coachTask: "final-review",
    brief: brief(),
    proposal: proposal(),
    pitch: pitch(),
    challengeResponses: [],
    pendingEvidence: null,
    clarificationBudgetUsed: 0,
    ...overrides,
  };
}

function runStartedEvent(): RunEvent {
  return {
    type: "run.started",
    runId: "run-1",
    commandId: "cmd-start",
    scenarioId: "scn-1",
    locale: "zh-CN",
    scenarioBundleDigest: SCENARIO_DIGEST,
  };
}

function finalReviewOutput(verdict: "pass" | "fail", note: string) {
  return {
    verdict,
    strengths: [text(note, note)],
    weaknesses: [text("假设未验证", "Assumptions unverified")],
    missedOpportunities: [],
    decisionDivergencePoints: [],
    nextFocus: [text(note, note)],
  };
}

function solutionCriterionScores(values: [number, number, number, number, number]) {
  const [traceability, feasibility, tradeoffs, validation, scopeDiscipline] = values;
  return {
    solution: {
      traceability,
      feasibility,
      tradeoffs,
      validation,
      "scope-discipline": scopeDiscipline,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("review subgraph — handlers list (G3-04)", () => {
  it("declares the six nodes in the plan's flow order", () => {
    expect(handlers.map((h) => h.definition.id)).toEqual([
      "review.input.build",
      "coach.review.invoke",
      "judgment.guard",
      "score.compute",
      "profile.effect.prepare",
      "review.commit",
    ]);
  });

  it("declares the coach node as an evaluator-capsule agent", () => {
    const coach = handlers.find((h) => h.definition.id === "coach.review.invoke")!;
    expect(coach.definition.kind).toBe("agent");
    expect(coach.definition.contextPolicy).toEqual({ role: "coach_evaluator", capsule: "evaluator" });
  });
});

describe("review subgraph — happy path", () => {
  it("coach output → schema-valid review.completed + score.computed with provenance", async () => {
    const state = reviewState();
    const events = [runStartedEvent()];
    const commandId = "cmd-review";

    // 1. coach.review.invoke (single sample)
    const runtime = new FixtureAgentRuntime({
      fixtures: { "coach_evaluator:cmd-review:coach": finalReviewOutput("pass", "first") },
    });
    const coach = await coachReviewInvoke.run({
      runtime,
      state,
      capsule: evaluatorCapsule(),
      commandId,
      scenarioBundleSha256: SCENARIO_DIGEST,
    });
    expect(coach.review.confidence).toBeNull();
    expect(coach.review.judgment).toBeDefined();

    // 2. review.input.build (deterministic score input + provenance + stage states)
    const built = await reviewInputBuild.run({
      state,
      events,
      customerCapsule: customerCapsule(),
      evaluatorCapsule: evaluatorCapsule(),
      publicScenario: publicScenario(),
      criterionScores: coach.review.review.criterionScores,
      evaluatorInvocationId: coach.review.evaluatorInvocationId,
      modelId: coach.review.modelId,
      scenarioBundleSha256: SCENARIO_DIGEST,
    });

    // 3. score.compute (calculateScore + measured capability)
    const computed = await scoreCompute.run({ state, built: built.built });
    expect(computed.score.provenance.comparabilityKey).toMatch(/^[0-9a-f]{64}$/);

    // 4. profile.effect.prepare (profile.apply-attempt effect)
    const prepared = await profileEffectPrepare.run({
      state,
      commandId,
      events,
      scoreInput: built.built.input,
      score: computed.score.score,
      stageStates: computed.score.stageStates,
      comparabilityKey: computed.score.provenance.comparabilityKey,
      retryFocuses: coach.review.review.nextFocus,
    });
    expect(prepared.effect.type).toBe("profile.apply-attempt");
    expect(prepared.effect.review.comparabilityKey).toBe(computed.score.provenance.comparabilityKey);

    // 5. review.commit (review.completed + score.computed)
    const committed = await reviewCommit.run({
      state,
      commandId,
      review: coach.review.review,
      judgment: coach.review.judgment,
      score: computed.score.score,
      provenance: computed.score.provenance,
    });
    expect(committed.events.map((e) => e.type)).toEqual(["review.completed", "score.computed"]);

    const [reviewEvent, scoreEvent] = committed.events;
    expect(ReviewCompletedEventSchema.safeParse(reviewEvent).success).toBe(true);
    expect(ScoreComputedEventSchema.safeParse(scoreEvent).success).toBe(true);
    // Single-invocation path carries the per-invocation judgment envelope.
    expect(reviewEvent.type === "review.completed" && reviewEvent.judgment?.judgmentId).toBe("cmd-review:coach");
    expect(scoreEvent.type === "score.computed" && scoreEvent.provenance.stages.framing.source).toBe("deterministic-fallback");
  });
});

describe("review subgraph — judgment.guard rejection", () => {
  it("rejects schema-invalid coach output with AGENT_OUTPUT_INVALID", async () => {
    const bad: RawAgentResult = { invocationId: "inv-bad", output: { verdict: "maybe" } };
    await expect(
      judgmentGuard.run({
        state: reviewState(),
        role: "coach_evaluator",
        result: bad,
        outputSchema: FinalReviewOutputSchema,
      }),
    ).rejects.toMatchObject({ code: AGENT_OUTPUT_INVALID });
  });

  it("rejects a leaked canary with LEAK_GUARD_TRIGGERED without echoing it", async () => {
    const leak: RawAgentResult = {
      invocationId: "inv-leak",
      output: {
        ...finalReviewOutput("pass", "ok"),
        strengths: [text(CANARY, "leaked")],
      },
    };
    const error = await judgmentGuard
      .run({
        state: reviewState(),
        role: "coach_evaluator",
        result: leak,
        outputSchema: FinalReviewOutputSchema,
        canaries: [CANARY],
      })
      .catch((e) => e);
    expect((error as { code?: string }).code).toBe(LEAK_GUARD_TRIGGERED);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });
});

describe("review subgraph — aggregation path (samples > 1)", () => {
  it("mean-aggregates criterion scores, reports confidence, and omits the judgment envelope", async () => {
    const state = reviewState();
    const commandId = "cmd-agg";
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "coach_evaluator:cmd-agg:coach:1": { ...finalReviewOutput("pass", "one"), criterionScores: solutionCriterionScores([60, 70, 80, 90, 100]) },
        "coach_evaluator:cmd-agg:coach:2": { ...finalReviewOutput("fail", "two"), criterionScores: solutionCriterionScores([40, 50, 60, 70, 80]) },
        "coach_evaluator:cmd-agg:coach:3": { ...finalReviewOutput("pass", "three"), criterionScores: solutionCriterionScores([80, 80, 80, 80, 80]) },
      },
    });

    const coach = await coachReviewInvoke.run({
      runtime,
      state,
      capsule: evaluatorCapsule(),
      commandId,
      samples: 3,
    });

    // Majority verdict wins; criterion scores are mean-aggregated.
    expect(coach.review.review.verdict).toBe("pass");
    expect(coach.review.review.criterionScores?.solution?.traceability).toBeCloseTo(60);
    expect(coach.review.confidence).not.toBeNull();
    expect(coach.review.confidence).toBeGreaterThan(0);
    expect(coach.review.confidence).toBeLessThan(1);
    // The aggregated path has no single per-invocation judgment.
    expect(coach.review.judgment).toBeUndefined();

    const built = await reviewInputBuild.run({
      state,
      events: [runStartedEvent()],
      customerCapsule: customerCapsule(),
      evaluatorCapsule: evaluatorCapsule(),
      publicScenario: publicScenario(),
      criterionScores: coach.review.review.criterionScores,
      evaluatorInvocationId: coach.review.evaluatorInvocationId,
      modelId: coach.review.modelId,
      scenarioBundleSha256: SCENARIO_DIGEST,
    });
    const computed = await scoreCompute.run({ state, built: built.built });

    const committed = await reviewCommit.run({
      state,
      commandId,
      review: coach.review.review,
      judgment: coach.review.judgment,
      score: computed.score.score,
      provenance: computed.score.provenance,
    });

    const reviewEvent = committed.events[0];
    expect(reviewEvent.type).toBe("review.completed");
    if (reviewEvent.type === "review.completed") {
      expect(reviewEvent.judgment).toBeUndefined();
    }
  });
});
