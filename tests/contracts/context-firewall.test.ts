import { describe, expect, it } from "vitest";
import {
  buildRoleInput,
  ContextFirewallError,
  FIREWALL_CAPSULE_FORBIDDEN,
  FIREWALL_UNRECOGNIZED_FIELD,
  roleInputSchema,
} from "../../src/security/context-firewall";
import { RunAggregateSchema, type RunAggregate } from "../../src/core/aggregate";
import {
  BriefValidationInputSchema,
  CustomerInputSchema,
  EvidenceTrackerInputSchema,
  FinalReviewInputSchema,
} from "../../src/agents/contracts";

const text = { "zh-CN": "提高工厂运营效率", "en-US": "Improve factory operational efficiency" };

function validStakeholder() {
  return { id: "s1", role: text, persona: text, concerns: [text], blindSpots: [text] };
}

function validDisclosureUnit() {
  return { id: "d1", topic: "workflow", text, prerequisites: [], evidenceId: "e1" };
}

function validHintLadder() {
  return { id: "h1", topic: "workflow", hints: { "1": text, "2": text, "3": text } };
}

function validGraph() {
  return {
    version: 0,
    nodes: [
      {
        id: "ev-a",
        kind: "fact",
        claim: text,
        status: "active",
        sourceTranscriptIds: ["t1"],
        weight: 1,
        version: 0,
      },
    ],
    edges: [],
  };
}

function validBrief() {
  return {
    id: "brief-1",
    problemStatement: text,
    goal: text,
    constraints: [text],
    claims: [{ id: "claim-1", statement: text, weight: "major", evidenceIds: ["ev-a"] }],
    successMeasures: [text],
    unknowns: [text],
    contradictions: [],
  };
}

function validProposal() {
  return {
    id: "proposal-1",
    objective: text,
    approach: text,
    approachEvidenceIds: ["ev-a"],
    assumptions: [text],
    alternatives: [{ id: "alt-1", description: text, tradeoff: text }],
    tradeoffs: [text],
    risks: [{ id: "risk-1", description: text, mitigation: text }],
    validationPlan: [text],
    rolloutPlan: [text],
    decisions: [{ id: "dec-1", decision: text, rationale: text, evidenceIds: ["ev-a"] }],
  };
}

function validPitch() {
  return {
    id: "pitch-1",
    audience: text,
    problem: text,
    recommendation: text,
    expectedValue: text,
    evidenceIds: ["ev-a"],
    risks: [text],
    ask: text,
    nextSteps: [text],
  };
}

function validChallengeResponse() {
  return {
    id: "resp-1",
    challengeId: "ch-1",
    impact: text,
    decision: "keep",
    rationale: text,
    newRiskOrValidation: text,
  };
}

function validCustomerCapsule() {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: [validStakeholder()],
    disclosureUnits: [validDisclosureUnit()],
    responsePolicies: [],
    privateConflicts: [],
    canary: "CUSTOMER_CANARY_abc123",
  };
}

function validEvaluatorCapsule() {
  return {
    id: "scn-1",
    schemaVersion: 1,
    expectedEvidence: [],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [validHintLadder()],
    passGates: [],
    canary: "EVALUATOR_CANARY_xyz789",
  };
}

function validAggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "DISCOVERY",
    transcript: [
      { turnId: "t1", seq: 0, question: "每天有多少告警？", customerReply: text, stakeholderId: "s1" },
    ],
    graph: validGraph(),
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: { question: "每天有多少告警？", stakeholderId: "s1" },
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    ...overrides,
  };
}

function expectFirewallError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ContextFirewallError);
    expect((error as ContextFirewallError).code).toBe(code);
    return;
  }
  throw new Error(`expected ContextFirewallError(${code})`);
}

describe("role context firewall — per-role allowlist", () => {
  it("customer input never contains evaluator/hidden fields (score, hints, learner profile, prior review, rubric)", () => {
    const state = validAggregate({
      grantedHints: [{ topic: "HINT_SENTINEL_111", level: 1 }],
      score: { total: "SCORE_SENTINEL_222" },
      learnerProfile: { skill: "PROFILE_SENTINEL_333" },
      previousAttemptReview: { verdict: "REVIEW_SENTINEL_444" },
      rubric: { stages: "RUBRIC_SENTINEL_666" },
    });

    const out = buildRoleInput("customer", state, validCustomerCapsule());
    expect(out.kind).toBe("customer");
    expect(CustomerInputSchema.safeParse(out.input).success).toBe(true);

    const serialized = JSON.stringify(out);
    for (const sentinel of [
      "HINT_SENTINEL_111",
      "SCORE_SENTINEL_222",
      "PROFILE_SENTINEL_333",
      "REVIEW_SENTINEL_444",
      "RUBRIC_SENTINEL_666",
      "EVALUATOR_CANARY_xyz789",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("evidence tracker input contains only locale + turn + graph (no capsule or rubric)", () => {
    const state = validAggregate({
      rubric: { stages: "RUBRIC_SENTINEL_666" },
    });

    const out = buildRoleInput("evidence_tracker", state);
    expect(out.kind).toBe("evidence_tracker");
    expect(EvidenceTrackerInputSchema.safeParse(out.input).success).toBe(true);
    expect(Object.keys(out.input).sort()).toEqual(["graph", "locale", "turn"]);

    const serialized = JSON.stringify(out);
    for (const sentinel of [
      "RUBRIC_SENTINEL_666",
      "canary",
      "disclosureUnits",
      "stakeholders",
      "expectedEvidence",
      "hintLadders",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("builds both coach input kinds from the aggregate", () => {
    const bv = buildRoleInput(
      "coach_evaluator",
      validAggregate({ coachTask: "brief-validation", brief: validBrief() }),
      validEvaluatorCapsule(),
    );
    expect(bv.kind).toBe("brief-validation");
    expect(BriefValidationInputSchema.safeParse(bv.input).success).toBe(true);

    const fr = buildRoleInput(
      "coach_evaluator",
      validAggregate({
        coachTask: "final-review",
        brief: validBrief(),
        proposal: validProposal(),
        pitch: validPitch(),
        challengeResponses: [validChallengeResponse()],
      }),
      validEvaluatorCapsule(),
    );
    expect(fr.kind).toBe("final-review");
    expect(FinalReviewInputSchema.safeParse(fr.input).success).toBe(true);
  });
});

describe("role context firewall — fail closed", () => {
  it("fails closed on an unrecognized aggregate field", () => {
    const state = validAggregate({ unknownSecret: "LEAK" } as Partial<RunAggregate>);
    expectFirewallError(
      () => buildRoleInput("customer", state, validCustomerCapsule()),
      FIREWALL_UNRECOGNIZED_FIELD,
    );
  });

  it("rejects an evaluator capsule handed to the customer role", () => {
    expectFirewallError(
      () => buildRoleInput("customer", validAggregate(), validEvaluatorCapsule() as never),
      FIREWALL_CAPSULE_FORBIDDEN,
    );
  });

  it("rejects ANY capsule handed to the evidence tracker (customer or evaluator)", () => {
    expectFirewallError(
      () => buildRoleInput("evidence_tracker", validAggregate(), validEvaluatorCapsule() as never),
      FIREWALL_CAPSULE_FORBIDDEN,
    );
    expectFirewallError(
      () => buildRoleInput("evidence_tracker", validAggregate(), validCustomerCapsule() as never),
      FIREWALL_CAPSULE_FORBIDDEN,
    );
  });

  it("rejects a customer capsule handed to the coach role", () => {
    expectFirewallError(
      () => buildRoleInput("coach_evaluator", validAggregate(), validCustomerCapsule() as never),
      FIREWALL_CAPSULE_FORBIDDEN,
    );
  });

  it("roleInputSchema rejects capsules as evidence-tracker inputs", () => {
    expect(roleInputSchema("evidence_tracker").safeParse(validEvaluatorCapsule()).success).toBe(false);
    expect(roleInputSchema("evidence_tracker").safeParse(validCustomerCapsule()).success).toBe(false);
  });

  it("RunAggregateSchema accepts a valid aggregate and rejects unknown fields", () => {
    expect(RunAggregateSchema.safeParse(validAggregate()).success).toBe(true);
    expect(
      RunAggregateSchema.safeParse(validAggregate({ injectedField: "x" } as Partial<RunAggregate>))
        .success,
    ).toBe(false);
  });
});
