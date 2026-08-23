import { describe, expect, it } from "vitest";

// NOTE: these imports are intentionally unresolved until Step 2 implements the
// schemas. The first run of this file must FAIL (RED) with module-not-found.
import {
  LocalizedTextSchema,
  RunPhaseSchema,
  RunCommandSchema,
  RunEventSchema,
  EvidenceGraphSchema,
  EvidenceNodeSchema,
  ProblemBriefSchema,
  SolutionProposalSchema,
  PitchArtifactSchema,
} from "../../src/core/domain";
import {
  ScenarioAuthoringSchema,
  PublicScenarioSchema,
  CustomerCapsuleSchema,
  EvaluatorCapsuleSchema,
  ExpectedEvidenceSchema,
  HintLadderSchema,
} from "../../src/scenarios/schema";

const text = {
  "zh-CN": "提高工厂运营效率",
  "en-US": "Improve factory operational efficiency",
};

function validPublicScenario() {
  return {
    id: "manufacturing-alert-triage",
    schemaVersion: 1,
    locale: "zh-CN",
    openingRequest: text,
    visibleContext: text,
    visibleConstraints: [text],
    deliverables: [text],
    learnerRules: [text],
    questionBudget: 12,
  };
}

function validCustomerCapsule() {
  return {
    id: "manufacturing-alert-triage",
    schemaVersion: 1,
    stakeholders: [
      {
        id: "vp-operations",
        role: text,
        persona: text,
        concerns: [text],
        blindSpots: [text],
      },
    ],
    disclosureUnits: [],
    responsePolicies: [],
    privateConflicts: [],
    canary: "CUSTOMER_CANARY",
  };
}

function validEvaluatorCapsule() {
  return {
    id: "manufacturing-alert-triage",
    schemaVersion: 1,
    expectedEvidence: [],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [],
    passGates: [],
    canary: "EVALUATOR_CANARY",
  };
}

describe("LocalizedTextSchema", () => {
  it("accepts both locale keys with non-empty values", () => {
    const result = LocalizedTextSchema.safeParse(text);
    expect(result.success).toBe(true);
  });

  it("rejects a missing zh-CN key", () => {
    const result = LocalizedTextSchema.safeParse({ "en-US": "hello" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing en-US key", () => {
    const result = LocalizedTextSchema.safeParse({ "zh-CN": "你好" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty locale value", () => {
    const result = LocalizedTextSchema.safeParse({ "zh-CN": "你好", "en-US": "" });
    expect(result.success).toBe(false);
  });

  it("rejects extra keys (strict)", () => {
    const result = LocalizedTextSchema.safeParse({ "zh-CN": "你好", "en-US": "hello", fr: "salut" });
    expect(result.success).toBe(false);
  });
});

describe("scenario partitions are structurally independent", () => {
  it("rejects an evaluator key on a public scenario", () => {
    const result = PublicScenarioSchema.safeParse({ openingRequest: text, evaluator: {} });
    expect(result.success).toBe(false);
  });

  it("rejects a rubric key on a customer capsule", () => {
    const result = CustomerCapsuleSchema.safeParse({ stakeholders: [], rubric: {} });
    expect(result.success).toBe(false);
  });

  it("rejects a customerPrompt key on an evaluator capsule", () => {
    const result = EvaluatorCapsuleSchema.safeParse({ expectedEvidence: [], customerPrompt: "x" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid public scenario and rejects an unknown extra field", () => {
    expect(PublicScenarioSchema.safeParse(validPublicScenario()).success).toBe(true);
    const withExtra = { ...validPublicScenario(), customer: {} };
    expect(PublicScenarioSchema.safeParse(withExtra).success).toBe(false);
  });
});

describe("evidence graph invariants", () => {
  function node(id: string) {
    return {
      id,
      kind: "fact",
      claim: text,
      status: "active",
      sourceTranscriptIds: ["t1"],
      weight: 1,
      version: 0,
    };
  }

  it("rejects duplicate node ids", () => {
    const graph = { version: 0, nodes: [node("a"), node("a")], edges: [] };
    expect(EvidenceGraphSchema.safeParse(graph).success).toBe(false);
  });

  it("rejects duplicate edge ids", () => {
    const edge = (id: string) => ({ id, from: "a", to: "b", relation: "supports", version: 0 });
    const graph = {
      version: 0,
      nodes: [node("a"), node("b")],
      edges: [edge("e1"), edge("e1")],
    };
    expect(EvidenceGraphSchema.safeParse(graph).success).toBe(false);
  });

  it("rejects an edge referencing a missing node (cross-reference)", () => {
    const graph = {
      version: 0,
      nodes: [node("a")],
      edges: [{ id: "e1", from: "a", to: "ghost", relation: "supports", version: 0 }],
    };
    expect(EvidenceGraphSchema.safeParse(graph).success).toBe(false);
  });

  it("accepts a well-formed graph with valid cross-references", () => {
    const graph = {
      version: 0,
      nodes: [node("a"), node("b")],
      edges: [{ id: "e1", from: "a", to: "b", relation: "supports", version: 0 }],
    };
    expect(EvidenceGraphSchema.safeParse(graph).success).toBe(true);
  });

  it("rejects a non-positive evidence node weight", () => {
    expect(EvidenceNodeSchema.safeParse({ ...node("a"), weight: 0 }).success).toBe(false);
    expect(EvidenceNodeSchema.safeParse({ ...node("a"), weight: -1 }).success).toBe(false);
    expect(EvidenceNodeSchema.safeParse({ ...node("a"), weight: 0.5 }).success).toBe(true);
  });
});

describe("scenario authoring cross-references and hint completeness", () => {
  function validAuthoring() {
    return {
      id: "manufacturing-alert-triage",
      schemaVersion: 1,
      locale: "zh-CN",
      public: {
        openingRequest: text,
        visibleContext: text,
        visibleConstraints: [text],
        deliverables: [text],
        learnerRules: [text],
        questionBudget: 12,
      },
      customer: {
        stakeholders: [
          { id: "s1", role: text, persona: text, concerns: [text], blindSpots: [text] },
        ],
        disclosureUnits: [
          { id: "d1", topic: "workflow", text, prerequisites: [], evidenceId: "e1" },
        ],
        responsePolicies: [],
        privateConflicts: [],
      },
      evaluator: {
        expectedEvidence: [
          { id: "e1", category: "workflow", description: text, weight: 2, disclosureUnitIds: ["d1"] },
        ],
        rubric: { stages: [] },
        criticalContradictions: [
          { id: "c1", statement: text, expectedEvidenceIds: ["e1"] },
        ],
        hintLadders: [
          { id: "h1", topic: "workflow", hints: { "1": text, "2": text, "3": text } },
        ],
        passGates: [],
      },
      events: [
        { id: "ev1", trigger: { kind: "after_evidence_revealed", evidenceId: "e1" }, prompt: text },
      ],
    };
  }

  it("rejects negative expected evidence weight", () => {
    const capsule = {
      id: "x",
      schemaVersion: 1,
      expectedEvidence: [{ id: "e1", category: "c", description: text, weight: 0, disclosureUnitIds: [] }],
      rubric: { stages: [] },
      criticalContradictions: [],
      hintLadders: [],
      passGates: [],
      canary: "x",
    };
    expect(EvaluatorCapsuleSchema.safeParse(capsule).success).toBe(false);
  });

  it("accepts positive expected evidence weight", () => {
    const evidence = {
      id: "e1",
      category: "c",
      description: text,
      weight: 3,
      disclosureUnitIds: [],
    };
    expect(ExpectedEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(ExpectedEvidenceSchema.safeParse({ ...evidence, weight: 0 }).success).toBe(false);
  });

  it("requires complete hint levels 1|2|3", () => {
    const full = { id: "h1", topic: "workflow", hints: { "1": text, "2": text, "3": text } };
    expect(HintLadderSchema.safeParse(full).success).toBe(true);
    const missingLevel = { id: "h1", topic: "workflow", hints: { "1": text, "2": text } };
    expect(HintLadderSchema.safeParse(missingLevel).success).toBe(false);
    const extraLevel = { id: "h1", topic: "workflow", hints: { "1": text, "2": text, "3": text, "4": text } };
    expect(HintLadderSchema.safeParse(extraLevel).success).toBe(false);
  });

  it("rejects a disclosure unit referencing missing expected evidence", () => {
    const authoring = validAuthoring();
    authoring.customer.disclosureUnits[0].evidenceId = "ghost";
    expect(ScenarioAuthoringSchema.safeParse(authoring).success).toBe(false);
  });

  it("rejects a disclosure unit prerequisite referencing a missing disclosure unit", () => {
    const authoring = validAuthoring();
    authoring.customer.disclosureUnits[0].prerequisites = ["ghost"];
    expect(ScenarioAuthoringSchema.safeParse(authoring).success).toBe(false);
  });

  it("rejects an event trigger referencing missing evidence", () => {
    const authoring = validAuthoring();
    authoring.events[0] = {
      id: "ev1",
      trigger: { kind: "after_evidence_revealed", evidenceId: "ghost" },
      prompt: text,
    };
    expect(ScenarioAuthoringSchema.safeParse(authoring).success).toBe(false);
  });

  it("accepts a fully valid authoring document", () => {
    expect(ScenarioAuthoringSchema.safeParse(validAuthoring()).success).toBe(true);
  });
});

describe("RunPhase / RunCommand / RunEvent", () => {
  it("accepts every RunPhase value", () => {
    const phases = [
      "SCENARIO", "DISCOVERY", "PROBLEM_FRAMING", "SOLUTION_DESIGN", "CHALLENGE",
      "PITCH", "REVIEW", "RETRY_READY", "COMPLETED", "ABORTED",
    ];
    for (const phase of phases) {
      expect(RunPhaseSchema.safeParse(phase).success).toBe(true);
    }
    expect(RunPhaseSchema.safeParse("NOT_A_PHASE").success).toBe(false);
  });

  it("parses each RunCommand variant and rejects an unknown type", () => {
    const commands = [
      { type: "start", commandId: "c1", scenarioId: "s1", locale: "zh-CN" },
      { type: "accept", commandId: "c1" },
      { type: "ask", commandId: "c1", question: "how many alerts?" },
      { type: "frame", commandId: "c1" },
      { type: "hint", commandId: "c1", topic: "workflow", level: 2 },
      { type: "submit-brief", commandId: "c1", brief: validBrief() },
      { type: "clarify", commandId: "c1" },
      { type: "submit-design", commandId: "c1", proposal: validProposal() },
      { type: "respond-challenge", commandId: "c1", response: validChallengeResponse() },
      { type: "submit-pitch", commandId: "c1", pitch: validPitch() },
      { type: "review", commandId: "c1" },
      { type: "retry", commandId: "c1" },
      { type: "start-retry", commandId: "c1" },
      { type: "complete", commandId: "c1" },
      { type: "abort", commandId: "c1", reason: "done" },
    ];
    for (const command of commands) {
      expect(RunCommandSchema.safeParse(command).success).toBe(true);
    }
    expect(RunCommandSchema.safeParse({ type: "unknown", commandId: "c1" }).success).toBe(false);
  });

  it("requires a commandId on every command", () => {
    expect(RunCommandSchema.safeParse({ type: "accept" }).success).toBe(false);
  });

  it("rejects a hint level outside 1|2|3", () => {
    expect(
      RunCommandSchema.safeParse({ type: "hint", commandId: "c1", topic: "x", level: 4 }).success,
    ).toBe(false);
  });

  it("parses phase.changed and artifact events", () => {
    const phaseChanged = {
      type: "phase.changed", runId: "r1", commandId: "c1",
      from: "SCENARIO", to: "DISCOVERY",
    };
    expect(RunEventSchema.safeParse(phaseChanged).success).toBe(true);

    const briefSubmitted = {
      type: "brief.submitted", runId: "r1", commandId: "c1", brief: validBrief(),
    };
    expect(RunEventSchema.safeParse(briefSubmitted).success).toBe(true);
  });

  it("rejects an event with an unknown type", () => {
    expect(RunEventSchema.safeParse({ type: "nope", runId: "r1" }).success).toBe(false);
  });
});

// --- minimal valid fixtures for artifact-bearing commands/events ---

function validBrief() {
  return {
    id: "brief-1",
    problemStatement: text,
    goal: text,
    constraints: [text],
    claims: [
      { id: "claim-1", statement: text, weight: "major", evidenceIds: ["ev-a"] },
    ],
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
    decisions: [
      { id: "dec-1", decision: text, rationale: text, evidenceIds: ["ev-a"] },
    ],
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

describe("ProblemBrief / SolutionProposal / PitchArtifact claim discipline", () => {
  it("rejects a ProblemBrief claim without evidenceIds", () => {
    const brief = validBrief();
    brief.claims = [{ id: "claim-1", statement: text, weight: "major", evidenceIds: [] }];
    expect(ProblemBriefSchema.safeParse(brief).success).toBe(false);
  });

  it("rejects a SolutionProposal decision without evidenceIds", () => {
    const proposal = validProposal();
    proposal.decisions = [{ id: "dec-1", decision: text, rationale: text, evidenceIds: [] }];
    expect(SolutionProposalSchema.safeParse(proposal).success).toBe(false);
  });

  it("rejects a SolutionProposal with an evidence-less approach", () => {
    const proposal = validProposal();
    proposal.approachEvidenceIds = [];
    expect(SolutionProposalSchema.safeParse(proposal).success).toBe(false);
  });

  it("accepts a SolutionProposal whose decisions carry evidenceIds", () => {
    expect(SolutionProposalSchema.safeParse(validProposal()).success).toBe(true);
  });

  it("accepts a full PitchArtifact", () => {
    expect(PitchArtifactSchema.safeParse(validPitch()).success).toBe(true);
  });

  it("rejects a duplicate ProblemBrief claim id", () => {
    const brief = validBrief();
    brief.claims = [
      { id: "claim-1", statement: text, weight: "major", evidenceIds: ["ev-a"] },
      { id: "claim-1", statement: text, weight: "minor", evidenceIds: ["ev-a"] },
    ];
    expect(ProblemBriefSchema.safeParse(brief).success).toBe(false);
  });
});
