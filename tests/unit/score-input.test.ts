import { describe, expect, it } from "vitest";

import type { RunEvent } from "../../src/core/domain.js";
import type { RunAggregate } from "../../src/security/context-firewall.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
} from "../../src/scenarios/schema.js";
import { buildScoreInput } from "../../src/scoring/score-input.js";
import { computeStageScore } from "../../src/scoring/rubric.js";

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
    const input = buildScoreInput(baseOptions(true));
    expect(input.questions).toHaveLength(1);
    expect(input.questions[0].atomicity).toBe(0.5);
    expect(input.questions[0].neutrality).toBe(0.6);
    expect(input.questions[0].relevance).toBe(0.7);
    expect(input.questions[0].redundancy).toBe(0.2);
  });

  it("falls back to the revelation heuristic when no assessment is persisted", () => {
    const input = buildScoreInput(baseOptions(false));
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
    expect(withoutCriterion.stageScores.framing).toBe(0);

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
    expect(withCriterion.stageScores.framing).toBe(100);
    // solution has no criterion scores → falls back (proposal null → 0).
    expect(withCriterion.stageScores.solution).toBe(0);
  });

  it("falls back per-stage when a stage's criterion scores are empty", () => {
    const input = buildScoreInput({
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
