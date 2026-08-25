import { describe, expect, it } from "vitest";

import type { FinalReviewInput, FinalReviewResult, RunEvent } from "../../src/core/domain.js";
import type { RunAggregate } from "../../src/security/context-firewall.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
} from "../../src/scenarios/schema.js";
import {
  AGENT_OUTPUT_DOMAIN_INVALID,
  validateFinalReviewOutput,
} from "../../src/agents/output-validation.js";
import { buildScoreInput } from "../../src/scoring/score-input.js";
import { RUBRIC, computeStageScore } from "../../src/scoring/rubric.js";
import {
  LEGACY_COMPARABILITY_KEY,
  ScoreProvenanceSchema,
} from "../../src/scoring/provenance.js";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

function customerCapsule(): CustomerCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: [{ id: "s1", role: text("r", "r"), persona: text("p", "p"), concerns: [], blindSpots: [] }],
    disclosureUnits: [
      { id: "du-1", topic: "workflow", text: text("隐藏事实", "hidden fact"), prerequisites: [], evidenceId: "ev-1" },
    ],
    responsePolicies: [],
    privateConflicts: [],
    canary: "CUSTOMER_CANARY",
  };
}

function evaluatorCapsule(): EvaluatorCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    expectedEvidence: [
      { id: "ev-1", category: "workflow", description: text("工作流", "workflow"), weight: 2, disclosureUnitIds: ["du-1"] },
    ],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [],
    passGates: [],
    canary: "EVAL_CANARY",
  };
}

function publicScenario(): PublicScenario {
  return {
    id: "scn-1",
    schemaVersion: 1,
    locale: "zh-CN",
    openingRequest: text("opening", "opening"),
    visibleContext: text("context", "context"),
    visibleConstraints: [],
    deliverables: [],
    learnerRules: [],
    questionBudget: 10,
  };
}

function aggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "REVIEW",
    transcript: [
      { turnId: "t1", seq: 0, question: "q", customerReply: text("a", "a"), stakeholderId: "s1" },
    ],
    graph: { version: 0, nodes: [], edges: [] },
    disclosedDisclosureUnitIds: ["du-1"],
    grantedHints: [],
    pendingQuestion: null,
    hintRequest: null,
    coachTask: "final-review",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    ...overrides,
  };
}

/** A single discovery turn, optionally with the persisted tracker assessment. */
function discoveryEvents(withAssessment: boolean): RunEvent[] {
  const events: RunEvent[] = [
    { type: "run.started", runId: "run-1", commandId: "c0", scenarioId: "scn-1", locale: "zh-CN" },
    { type: "phase.changed", runId: "run-1", commandId: "c0", from: "SCENARIO", to: "DISCOVERY" },
    { type: "question.asked", runId: "run-1", commandId: "q1", questionId: "q1", question: "你们有几套系统？" },
    {
      type: "customer.replied",
      runId: "run-1",
      commandId: "q1",
      questionId: "q1",
      reply: text("三套", "three"),
      stakeholderId: "s1",
      disclosedDisclosureUnitIds: ["du-1"],
    },
  ];
  if (withAssessment) {
    events.push({
      type: "evidence.patched",
      runId: "run-1",
      commandId: "q1:evidence",
      patch: { patchId: "p1", expectedVersion: 0, addNodes: [], addEdges: [], invalidateNodeIds: [] },
    });
    events.push({
      type: "question.assessed",
      runId: "run-1",
      commandId: "q1:evidence",
      questionId: "q1",
      assessment: { intentCount: 1, atomicity: 0.5, neutrality: 0.6, relevance: 0.7, redundancy: 0.2 },
    });
  }
  return events;
}

function baseOptions(withAssessment: boolean) {
  return {
    events: discoveryEvents(withAssessment),
    aggregate: aggregate(),
    customerCapsule: customerCapsule(),
    evaluatorCapsule: evaluatorCapsule(),
    publicScenario: publicScenario(),
  };
}

describe("computeStageScore: fixed capability rubric weighting", () => {
  it("returns 100 when every criterion scores 100", () => {
    expect(
      computeStageScore("framing", {
        "evidence-support": 100,
        "goal-clarity": 100,
        "constraints-tradeoffs": 100,
        "unknown-risk-handling": 100,
      }),
    ).toBe(100);
  });

  it("weights partial scores and treats missing criteria as 0", () => {
    // 40×50 + 25×100 + 20×0 + 15×0 = 2000 + 2500 = 4500 → /100 = 45.
    expect(
      computeStageScore("framing", { "evidence-support": 50, "goal-clarity": 100 }),
    ).toBe(45);
  });

  it("returns 0 for an empty criterion map", () => {
    expect(computeStageScore("framing", {})).toBe(0);
  });
});

describe("buildScoreInput: per-question FORM metrics", () => {
  it("uses the persisted question assessment for form metrics", () => {
    const { input } = buildScoreInput(baseOptions(true));
    expect(input.questions).toHaveLength(1);
    expect(input.questions[0].atomicity).toBe(0.5);
    expect(input.questions[0].neutrality).toBe(0.6);
    expect(input.questions[0].relevance).toBe(0.7);
    expect(input.questions[0].redundancy).toBe(0.2);
  });

  it("falls back to the revelation heuristic when no assessment is persisted", () => {
    const { input } = buildScoreInput(baseOptions(false));
    expect(input.questions).toHaveLength(1);
    // Revealed new evidence → clean, relevant, non-redundant.
    expect(input.questions[0].atomicity).toBe(1);
    expect(input.questions[0].neutrality).toBe(1);
    expect(input.questions[0].relevance).toBe(1);
    expect(input.questions[0].redundancy).toBe(0);
  });
});

describe("buildScoreInput: per-criterion stage scores", () => {
  it("derives stage scores from the Coach's criterion scores when present", () => {
    const withoutCriterion = buildScoreInput(baseOptions(true));
    // brief is null → fallback framing = briefSupport × 100 = 0.
    expect(withoutCriterion.input.stageScores.framing).toBe(0);

    const withCriterion = buildScoreInput({
      ...baseOptions(true),
      criterionScores: {
        framing: {
          "evidence-support": 100,
          "goal-clarity": 100,
          "constraints-tradeoffs": 100,
          "unknown-risk-handling": 100,
        },
      },
    });
    expect(withCriterion.input.stageScores.framing).toBe(100);
    // solution has no criterion scores → falls back (proposal null → 0).
    expect(withCriterion.input.stageScores.solution).toBe(0);
  });

  it("falls back per-stage when a stage's criterion scores are empty", () => {
    const { input } = buildScoreInput({
      ...baseOptions(true),
      criterionScores: {
        framing: { "evidence-support": 50, "goal-clarity": 100 },
        solution: {},
      },
    });
    // framing weighted; solution empty → fallback (proposal null → 0).
    expect(input.stageScores.framing).toBe(45);
    expect(input.stageScores.solution).toBe(0);
  });
});

describe("buildScoreInput: score provenance", () => {
  it("reports separate model vs deterministic-fallback stage sources", () => {
    const { provenance } = buildScoreInput({
      ...baseOptions(true),
      criterionScores: {
        framing: {
          "evidence-support": 100,
          "goal-clarity": 100,
          "constraints-tradeoffs": 100,
          "unknown-risk-handling": 100,
        },
      },
    });
    expect(ScoreProvenanceSchema.safeParse(provenance).success).toBe(true);
    expect(provenance.stages.framing.source).toBe("model");
    expect(provenance.stages.solution.source).toBe("deterministic-fallback");
    expect(provenance.stages.solution.fallbackReason).toBeDefined();
    expect(provenance.stages.challenge.source).toBe("deterministic-fallback");
    expect(provenance.stages.pitch.source).toBe("deterministic-fallback");
    expect(provenance.stages.process.source).toBe("deterministic-fallback");
  });

  it("marks every stage deterministic-fallback when there are no criterion scores", () => {
    const { provenance } = buildScoreInput(baseOptions(true));
    for (const stage of Object.values(provenance.stages)) {
      expect(stage.source).toBe("deterministic-fallback");
    }
    expect(provenance.comparabilityKey).not.toBe(LEGACY_COMPARABILITY_KEY);
  });

  it("carries the rubric, model, and scenario-bundle identity into provenance", () => {
    const { provenance } = buildScoreInput({
      ...baseOptions(true),
      evaluatorInvocationId: "cmd-review:coach",
      modelId: "model-family-a",
      scenarioBundleSha256: "c".repeat(64),
    });
    expect(provenance.scoreSchemaVersion).toBe(1);
    expect(provenance.formulaVersion).toBe(1);
    expect(provenance.capabilityRubricId).toBe("fde-capability");
    expect(provenance.capabilityRubricVersion).toBe(1);
    expect(provenance.capabilityRubricSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.outputSchemaVersion).toBe(1);
    expect(provenance.evaluatorInvocationId).toBe("cmd-review:coach");
    expect(provenance.modelId).toBe("model-family-a");
    expect(provenance.scenarioBundleSha256).toBe("c".repeat(64));
  });

  it("derives a deterministic comparability key that changes with the model family", () => {
    const a = buildScoreInput({ ...baseOptions(true), modelId: "model-family-a" }).provenance;
    const b = buildScoreInput({ ...baseOptions(true), modelId: "model-family-b" }).provenance;
    expect(a.comparabilityKey).not.toBe(b.comparabilityKey);
  });
});

// ---------------------------------------------------------------------------
// validateFinalReviewOutput: fixed-rubric criterion membership (Task 2)
// ---------------------------------------------------------------------------

function fixedRubric() {
  return {
    framing: RUBRIC.framing.map(({ id, label, weight }) => ({ id, label, weight })),
    solution: RUBRIC.solution.map(({ id, label, weight }) => ({ id, label, weight })),
    challenge: RUBRIC.challenge.map(({ id, label, weight }) => ({ id, label, weight })),
    pitch: RUBRIC.pitch.map(({ id, label, weight }) => ({ id, label, weight })),
    process: RUBRIC.process.map(({ id, label, weight }) => ({ id, label, weight })),
  };
}

function finalReviewInput(overrides: Partial<FinalReviewInput> = {}): FinalReviewInput {
  return {
    locale: "zh-CN",
    brief: {
      id: "brief-1",
      problemStatement: text("p", "p"),
      goal: text("g", "g"),
      constraints: [],
      claims: [],
      successMeasures: [],
      unknowns: [],
      contradictions: [],
    },
    proposal: {
      id: "prop-1",
      objective: text("o", "o"),
      approach: text("a", "a"),
      approachEvidenceIds: ["ev-1"],
      assumptions: [],
      alternatives: [{ id: "alt-1", description: text("d", "d"), tradeoff: text("t", "t") }],
      tradeoffs: [],
      risks: [],
      validationPlan: [],
      rolloutPlan: [],
      decisions: [],
    },
    pitch: {
      id: "pitch-1",
      audience: text("a", "a"),
      problem: text("p", "p"),
      recommendation: text("r", "r"),
      expectedValue: text("v", "v"),
      evidenceIds: ["ev-1"],
      risks: [],
      ask: text("ask", "ask"),
      nextSteps: [],
    },
    challengeResponses: [],
    graph: { version: 0, nodes: [], edges: [] },
    transcript: [],
    hintLedger: [],
    rubric: fixedRubric(),
    ...overrides,
  };
}

function reviewOutput(): FinalReviewResult {
  return {
    verdict: "pass",
    strengths: [],
    weaknesses: [],
    missedOpportunities: [],
    decisionDivergencePoints: [],
    nextFocus: [],
  };
}

describe("validateFinalReviewOutput: fixed-rubric criterion membership", () => {
  const fullFraming = {
    "evidence-support": 100,
    "goal-clarity": 100,
    "constraints-tradeoffs": 100,
    "unknown-risk-handling": 100,
  };

  it("accepts an exact fixed-rubric criterion map", () => {
    const out: FinalReviewResult = { ...reviewOutput(), criterionScores: { framing: fullFraming } };
    expect(validateFinalReviewOutput(finalReviewInput(), out)).toBe(out);
  });

  it("rejects an unknown criterion id", () => {
    expect(() =>
      validateFinalReviewOutput(finalReviewInput(), {
        ...reviewOutput(),
        criterionScores: { framing: { ...fullFraming, "bogus-criterion": 50 } },
      }),
    ).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
  });

  it("rejects a criterion map missing a fixed-rubric criterion id", () => {
    expect(() =>
      validateFinalReviewOutput(finalReviewInput(), {
        ...reviewOutput(),
        criterionScores: { framing: { "evidence-support": 100 } },
      }),
    ).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
  });

  it("rejects a duplicate criterion id in the fixed rubric", () => {
    const input = finalReviewInput({
      rubric: {
        framing: [
          { id: "evidence-support", label: "a", weight: 40 },
          { id: "evidence-support", label: "b", weight: 25 },
        ],
        solution: [],
        challenge: [],
        pitch: [],
        process: [],
      },
    });
    expect(() =>
      validateFinalReviewOutput(input, {
        ...reviewOutput(),
        criterionScores: { framing: fullFraming },
      }),
    ).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
  });

  it("accepts a stage with no criterion scores (scoring falls back)", () => {
    const out = reviewOutput();
    expect(validateFinalReviewOutput(finalReviewInput(), out)).toBe(out);
  });

  it("accepts an explicitly-empty stage map (scoring falls back)", () => {
    const out: FinalReviewResult = { ...reviewOutput(), criterionScores: { solution: {} } };
    expect(validateFinalReviewOutput(finalReviewInput(), out)).toBe(out);
  });
});
