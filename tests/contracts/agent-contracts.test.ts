import { describe, expect, it } from "vitest";

// NOTE: unresolved imports are intentional until Step 3 implements the contracts.
import {
  CustomerInputSchema,
  CustomerOutputSchema,
  EvidenceTrackerInputSchema,
  EvidenceTrackerOutputSchema,
  CoachHintInputSchema,
  CoachHintOutputSchema,
  BriefValidationInputSchema,
  BriefValidationOutputSchema,
  FinalReviewInputSchema,
  FinalReviewOutputSchema,
  PROHIBITED_OUTPUT_KEYS,
  stripProhibitedKeys,
} from "../../src/agents/contracts";
import type { z } from "zod";

const text = {
  "zh-CN": "提高工厂运营效率",
  "en-US": "Improve factory operational efficiency",
};

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
      { id: "ev-a", kind: "fact", claim: text, status: "active", sourceTranscriptIds: ["t1"], weight: 1, version: 0 },
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

describe("role input/output contracts", () => {
  it("validates a CustomerInput and CustomerOutput", () => {
    const input = {
      locale: "zh-CN",
      question: "每天有多少告警？",
      stakeholderId: "s1",
      stakeholders: [validStakeholder()],
      disclosureUnits: [validDisclosureUnit()],
      disclosedDisclosureUnitIds: [],
      responsePolicies: [],
    };
    expect(CustomerInputSchema.safeParse(input).success).toBe(true);

    const output = {
      reply: text,
      stakeholderId: "s1",
      disclosedDisclosureUnitIds: ["d1"],
    };
    expect(CustomerOutputSchema.safeParse(output).success).toBe(true);
  });

  it("validates an EvidenceTrackerInput and Output", () => {
    const input = {
      locale: "en-US",
      turn: { turnId: "t1", seq: 0, question: "how many alerts?", customerReply: text, stakeholderId: "s1" },
      graph: validGraph(),
    };
    expect(EvidenceTrackerInputSchema.safeParse(input).success).toBe(true);

    const output = {
      patch: { patchId: "p1", expectedVersion: 0, addNodes: [], addEdges: [], invalidateNodeIds: [] },
      questionAssessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
    };
    expect(EvidenceTrackerOutputSchema.safeParse(output).success).toBe(true);
  });

  it("rejects a question assessment outside 0..1", () => {
    const output = {
      patch: { patchId: "p1", expectedVersion: 0, addNodes: [], addEdges: [], invalidateNodeIds: [] },
      questionAssessment: { intentCount: 1, atomicity: 1.5, neutrality: 1, relevance: 1, redundancy: 0 },
    };
    expect(EvidenceTrackerOutputSchema.safeParse(output).success).toBe(false);
  });

  it("validates CoachHint input/output and enforces hint levels", () => {
    const input = {
      locale: "zh-CN",
      topic: "workflow",
      requestedLevel: 2,
      grantedLevels: [{ topic: "workflow", level: 1 }],
      hintLadders: [validHintLadder()],
    };
    expect(CoachHintInputSchema.safeParse(input).success).toBe(true);
    expect(CoachHintInputSchema.safeParse({ ...input, requestedLevel: 4 }).success).toBe(false);

    const output = { level: 2, hint: text };
    expect(CoachHintOutputSchema.safeParse(output).success).toBe(true);
  });

  it("validates BriefValidationInput/Output and cross-references evidence ids", () => {
    const input = {
      locale: "zh-CN",
      brief: validBrief(),
      graph: validGraph(),
      transcript: [],
    };
    expect(BriefValidationInputSchema.safeParse(input).success).toBe(true);

    // A brief whose claim references a node absent from the graph must be rejected.
    const badBrief = validBrief();
    badBrief.claims = [{ id: "claim-1", statement: text, weight: "major", evidenceIds: ["ghost"] }];
    expect(BriefValidationInputSchema.safeParse({ ...input, brief: badBrief }).success).toBe(false);

    const output = {
      passed: true,
      entailments: [{ claimId: "claim-1", entailment: "supported" }],
      missingCategories: [],
      unsupportedClaimIds: [],
      feedback: text,
    };
    expect(BriefValidationOutputSchema.safeParse(output).success).toBe(true);
  });

  it("validates FinalReviewInput/Output", () => {
    const input = {
      locale: "zh-CN",
      brief: validBrief(),
      proposal: validProposal(),
      pitch: validPitch(),
      challengeResponses: [validChallengeResponse()],
      graph: validGraph(),
      transcript: [],
      hintLedger: [],
      rubric: {
        framing: [{ id: "evidence-support", label: "Evidence Support", weight: 40 }],
        solution: [{ id: "traceability", label: "Traceability", weight: 30 }],
        challenge: [{ id: "adaptation", label: "Adaptation", weight: 40 }],
        pitch: [{ id: "audience-fit", label: "Audience Fit", weight: 25 }],
        process: [{ id: "evidence-hygiene", label: "Evidence Hygiene", weight: 40 }],
      },
    };
    expect(FinalReviewInputSchema.safeParse(input).success).toBe(true);

    const output = {
      verdict: "pass",
      strengths: [text],
      weaknesses: [text],
      missedOpportunities: [text],
      decisionDivergencePoints: [{ id: "ddp-1", description: text }],
      nextFocus: [text],
    };
    expect(FinalReviewOutputSchema.safeParse(output).success).toBe(true);
  });

  it("accepts optional per-criterion scores in FinalReviewOutput and bounds them 0..100", () => {
    const withScores = {
      verdict: "fail",
      strengths: [text],
      weaknesses: [text],
      missedOpportunities: [text],
      decisionDivergencePoints: [],
      nextFocus: [text],
      criterionScores: {
        framing: { "evidence-support": 90, "goal-clarity": 80 },
        solution: { traceability: 70 },
        challenge: { adaptation: 60 },
        pitch: { "audience-fit": 50 },
        process: { "evidence-hygiene": 95 },
      },
    };
    expect(FinalReviewOutputSchema.safeParse(withScores).success).toBe(true);

    const outOfRange = {
      ...withScores,
      criterionScores: { framing: { "evidence-support": 101 } },
    };
    expect(FinalReviewOutputSchema.safeParse(outOfRange).success).toBe(false);
  });
});

describe("prohibited output fields", () => {
  const outputSchemas: Record<string, z.ZodType> = {
    CustomerOutputSchema,
    EvidenceTrackerOutputSchema,
    CoachHintOutputSchema,
    BriefValidationOutputSchema,
    FinalReviewOutputSchema,
  };

  const prohibited = new Set<string>(PROHIBITED_OUTPUT_KEYS);

  function collectDeclaredKeys(schema: unknown, out: Set<string> = new Set()): Set<string> {
    if (schema === null || typeof schema !== "object") return out;
    const s = schema as {
      shape?: Record<string, unknown>;
      element?: unknown;
      options?: unknown[];
      unwrap?: () => unknown;
    };
    if (s.shape) {
      for (const key of Object.keys(s.shape)) {
        if (prohibited.has(key)) out.add(key);
        collectDeclaredKeys(s.shape[key], out);
      }
    } else if (s.element) {
      collectDeclaredKeys(s.element, out);
    } else if (Array.isArray(s.options)) {
      for (const option of s.options) collectDeclaredKeys(option, out);
    } else if (typeof s.unwrap === "function") {
      collectDeclaredKeys(s.unwrap(), out);
    }
    return out;
  }

  it("declares no prohibited output field names in any output schema", () => {
    for (const [name, schema] of Object.entries(outputSchemas)) {
      const found = collectDeclaredKeys(schema);
      expect([...found], `${name} declares a prohibited field`).toEqual([]);
    }
  });

  it("strips prohibited keys recursively at any depth", () => {
    const dirty = {
      reply: text,
      reasoning: "SECRET_REASONING",
      nested: {
        keep: 1,
        list: [{ ok: true, chainOfThought: "SECRET_COT" }],
        rawPrompt: "SECRET_RAW",
      },
      systemPrompt: "SECRET_SYS",
      analysis: "SECRET_ANALYSIS",
    };
    const clean = stripProhibitedKeys(dirty) as Record<string, unknown>;
    expect(clean).not.toHaveProperty("reasoning");
    expect(clean).not.toHaveProperty("systemPrompt");
    expect(clean).not.toHaveProperty("analysis");
    expect(clean.reply).toEqual(text);
    const nested = clean.nested as Record<string, unknown>;
    expect(nested).not.toHaveProperty("rawPrompt");
    expect(nested.keep).toBe(1);
    const list = nested.list as Array<Record<string, unknown>>;
    expect(list[0]).not.toHaveProperty("chainOfThought");
    expect(list[0].ok).toBe(true);
    expect(JSON.stringify(clean)).not.toContain("SECRET");
  });

  it("preserves primitives, arrays of primitives, and null untouched", () => {
    expect(stripProhibitedKeys("abc")).toBe("abc");
    expect(stripProhibitedKeys(42)).toBe(42);
    expect(stripProhibitedKeys(null)).toBe(null);
    expect(stripProhibitedKeys([1, "a", null])).toEqual([1, "a", null]);
  });

  it("rejects a prohibited key injected into a valid output object (strict)", () => {
    const withReasoning = {
      reply: text,
      stakeholderId: "s1",
      disclosedDisclosureUnitIds: [],
      reasoning: "SECRET",
    };
    expect(CustomerOutputSchema.safeParse(withReasoning).success).toBe(false);
  });
});
