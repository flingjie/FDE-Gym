import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  ChallengeResponse,
  ClaimEntailment,
  Entailment,
  EvidenceGraphPatch,
  PitchArtifact,
  ProblemBrief,
  ProblemBriefClaim,
  SolutionProposal,
} from "../../src/core/domain";
import {
  EVIDENCE_PATCH_VERSION_MISMATCH,
  createEmptyEvidenceGraph,
} from "../../src/evidence/graph";
import { AGENT_OUTPUT_INVALID, LEAK_GUARD_TRIGGERED } from "../../src/security/sanitizer";
import {
  BRIEF_STRUCTURE_INVALID,
  BRIEF_SUPPORT_INSUFFICIENT,
  CHALLENGE_RESPONSE_INVALID,
  CHALLENGES_UNANSWERED,
  CLARIFICATION_BUDGET_EXCEEDED,
  DEFAULT_CLARIFICATION_BUDGET,
  FRAME_BLOCKED,
  GUARD_INPUT_INVALID,
  GUARD_IDS,
  GUARD_REGISTRY,
  PITCH_STRUCTURE_INVALID,
  PROPOSAL_STRUCTURE_INVALID,
  allChallengesAnsweredGuard,
  briefStructureValid,
  briefSupportSufficient,
  challengeResponseValid,
  clarificationBudgetAvailable,
  evidencePatchValid,
  judgmentValid,
  noPendingEvidence,
  pitchStructureValid,
  proposalStructureValid,
} from "../../src/graph/guards";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function text(value: string) {
  return { "zh-CN": value, "en-US": value };
}

function factNode(id: string) {
  return {
    id,
    kind: "fact" as const,
    claim: text(`claim-${id}`),
    status: "active" as const,
    sourceTranscriptIds: ["turn-1"],
    weight: 1,
    version: 0,
  };
}

function patch(over: Partial<EvidenceGraphPatch> = {}): EvidenceGraphPatch {
  return {
    patchId: "p1",
    expectedVersion: 0,
    addNodes: [],
    addEdges: [],
    invalidateNodeIds: [],
    ...over,
  };
}

function brief(over: Partial<ProblemBrief> = {}): ProblemBrief {
  return {
    id: "b1",
    problemStatement: text("problem"),
    goal: text("goal"),
    constraints: [],
    claims: [],
    successMeasures: [text("sm1")],
    unknowns: [text("u1")],
    contradictions: [],
    ...over,
  };
}

function proposal(over: Partial<SolutionProposal> = {}): SolutionProposal {
  return {
    id: "p1",
    objective: text("objective"),
    approach: text("approach"),
    approachEvidenceIds: ["e1"],
    assumptions: [],
    alternatives: [{ id: "alt1", description: text("alt"), tradeoff: text("tradeoff") }],
    tradeoffs: [],
    risks: [],
    validationPlan: [],
    rolloutPlan: [],
    decisions: [],
    ...over,
  };
}

function response(over: Partial<ChallengeResponse> = {}): ChallengeResponse {
  return {
    id: "r1",
    challengeId: "c1",
    impact: text("impact"),
    decision: "keep",
    rationale: text("rationale"),
    newRiskOrValidation: text("new"),
    ...over,
  };
}

function pitchArtifact(over: Partial<PitchArtifact> = {}): PitchArtifact {
  return {
    id: "p1",
    audience: text("audience"),
    problem: text("problem"),
    recommendation: text("recommendation"),
    expectedValue: text("expectedValue"),
    evidenceIds: ["e1"],
    risks: [],
    ask: text("ask"),
    nextSteps: [],
    ...over,
  };
}

function minorClaims(n: number): ProblemBriefClaim[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    statement: text(`s${i}`),
    weight: "minor",
    evidenceIds: ["e1"],
  }));
}

function entailmentsFor(
  claims: readonly ProblemBriefClaim[],
  supported: number,
  partial: number,
): ClaimEntailment[] {
  return claims.map((claim, i): ClaimEntailment => {
    const entailment: Entailment =
      i < supported ? "supported" : i < supported + partial ? "partial" : "unsupported";
    return { claimId: claim.id, entailment };
  });
}

const judgmentSchema = z.object({ value: z.string().min(1) }).strict();
const validJudgmentResult = { invocationId: "i1", output: { value: "hello" } };
const invalidJudgmentResult = { invocationId: "i2", output: { value: 42 } };
const leakJudgmentResult = { invocationId: "i3", output: { value: "SECRET" } };

// ---------------------------------------------------------------------------
// no-pending-evidence
// ---------------------------------------------------------------------------

describe("noPendingEvidence", () => {
  it("passes when there is no pending evidence", () => {
    expect(noPendingEvidence(null)).toEqual({ ok: true });
  });

  it("rejects with FRAME_BLOCKED and the pending turn id", () => {
    expect(noPendingEvidence({ turnId: "t1", code: "EVIDENCE_EXTRACTION_FAILED" })).toEqual({
      ok: false,
      code: FRAME_BLOCKED,
      evidence: { turnId: "t1" },
    });
  });

  it("registry entry validates its input contract", () => {
    expect(GUARD_REGISTRY[GUARD_IDS.NO_PENDING_EVIDENCE](null)).toEqual({ ok: true });
    expect(
      GUARD_REGISTRY[GUARD_IDS.NO_PENDING_EVIDENCE]({ turnId: "t1", code: "X" }),
    ).toEqual({ ok: false, code: FRAME_BLOCKED, evidence: { turnId: "t1" } });
    expect(GUARD_REGISTRY[GUARD_IDS.NO_PENDING_EVIDENCE]("nope")).toEqual({
      ok: false,
      code: GUARD_INPUT_INVALID,
    });
  });
});

// ---------------------------------------------------------------------------
// evidence-patch-valid
// ---------------------------------------------------------------------------

describe("evidencePatchValid", () => {
  it("passes a valid patch", () => {
    expect(
      evidencePatchValid(createEmptyEvidenceGraph(), patch({ addNodes: [factNode("n1")] })),
    ).toEqual({ ok: true });
  });

  it("rejects an invalid patch with the EvidenceGraphError code", () => {
    expect(
      evidencePatchValid(createEmptyEvidenceGraph(), patch({ expectedVersion: 1 })),
    ).toEqual({
      ok: false,
      code: EVIDENCE_PATCH_VERSION_MISMATCH,
      evidence: { patchId: "p1" },
    });
  });

  it("registry entry validates its input contract", () => {
    expect(
      GUARD_REGISTRY[GUARD_IDS.EVIDENCE_PATCH_VALID]({
        graph: createEmptyEvidenceGraph(),
        patch: patch({ expectedVersion: 1 }),
      }),
    ).toEqual({ ok: false, code: EVIDENCE_PATCH_VERSION_MISMATCH, evidence: { patchId: "p1" } });
    expect(GUARD_REGISTRY[GUARD_IDS.EVIDENCE_PATCH_VALID]({ graph: 42, patch: {} })).toEqual({
      ok: false,
      code: GUARD_INPUT_INVALID,
    });
  });
});

// ---------------------------------------------------------------------------
// brief-structure-valid
// ---------------------------------------------------------------------------

describe("briefStructureValid", () => {
  it("passes a structurally valid brief", () => {
    expect(briefStructureValid(brief(), createEmptyEvidenceGraph())).toEqual({ ok: true });
  });

  it("rejects a brief missing a success measure with the category key", () => {
    const result = briefStructureValid(
      brief({ successMeasures: [] }),
      createEmptyEvidenceGraph(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(BRIEF_STRUCTURE_INVALID);
      expect(result.evidence).toEqual({
        missingCategories: ["successMeasures"],
        unsupportedClaimIds: [],
      });
    }
  });

  it("rejects a schema-invalid brief with zod evidence (no messages)", () => {
    const malformed = { id: "b1" } as ProblemBrief;
    const result = briefStructureValid(malformed, createEmptyEvidenceGraph());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(BRIEF_STRUCTURE_INVALID);
      expect(result.evidence).toHaveProperty("codes");
      expect(result.evidence).toHaveProperty("paths");
    }
  });
});

// ---------------------------------------------------------------------------
// brief-support-sufficient
// ---------------------------------------------------------------------------

describe("briefSupportSufficient", () => {
  it("rejects a support ratio of 0.749", () => {
    const claims = minorClaims(500);
    const result = briefSupportSufficient(claims, entailmentsFor(claims, 374, 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(BRIEF_SUPPORT_INSUFFICIENT);
      const evidence = result.evidence as { supportRatio: number; threshold: number };
      expect(evidence.supportRatio).toBeLessThan(0.75);
      expect(evidence.threshold).toBe(0.75);
    }
  });

  it("accepts a support ratio of exactly 0.750", () => {
    const claims = minorClaims(500);
    expect(briefSupportSufficient(claims, entailmentsFor(claims, 375, 0))).toEqual({ ok: true });
  });

  it("accepts a ratio above the threshold", () => {
    const claims = minorClaims(2);
    expect(briefSupportSufficient(claims, entailmentsFor(claims, 2, 0))).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// clarification-budget-available
// ---------------------------------------------------------------------------

describe("clarificationBudgetAvailable", () => {
  it("passes while budget remains", () => {
    expect(clarificationBudgetAvailable(0)).toEqual({ ok: true });
    expect(clarificationBudgetAvailable(2)).toEqual({ ok: true });
    expect(clarificationBudgetAvailable(0, 3)).toEqual({ ok: true });
  });

  it("rejects when the budget is exhausted (used >= limit)", () => {
    expect(clarificationBudgetAvailable(3)).toEqual({
      ok: false,
      code: CLARIFICATION_BUDGET_EXCEEDED,
      evidence: { clarificationBudgetUsed: 3, clarificationBudgetLimit: DEFAULT_CLARIFICATION_BUDGET },
    });
    expect(clarificationBudgetAvailable(2, 2)).toEqual({
      ok: false,
      code: CLARIFICATION_BUDGET_EXCEEDED,
      evidence: { clarificationBudgetUsed: 2, clarificationBudgetLimit: 2 },
    });
  });

  it("registry entry rejects a negative budget as invalid input", () => {
    expect(
      GUARD_REGISTRY[GUARD_IDS.CLARIFICATION_BUDGET_AVAILABLE]({ clarificationBudgetUsed: -1 }),
    ).toEqual({ ok: false, code: GUARD_INPUT_INVALID });
  });
});

// ---------------------------------------------------------------------------
// proposal-structure-valid
// ---------------------------------------------------------------------------

describe("proposalStructureValid", () => {
  it("passes a valid proposal", () => {
    expect(proposalStructureValid(proposal())).toEqual({ ok: true });
  });

  it("rejects a proposal with no approach evidence", () => {
    const result = proposalStructureValid(proposal({ approachEvidenceIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PROPOSAL_STRUCTURE_INVALID);
  });

  it("registry entry rejects a non-object proposal as invalid input", () => {
    expect(
      GUARD_REGISTRY[GUARD_IDS.PROPOSAL_STRUCTURE_VALID]({ proposal: "nope" }),
    ).toEqual({ ok: false, code: GUARD_INPUT_INVALID });
  });
});

// ---------------------------------------------------------------------------
// challenge-response-valid
// ---------------------------------------------------------------------------

describe("challengeResponseValid", () => {
  it("passes a valid challenge response", () => {
    expect(challengeResponseValid(response())).toEqual({ ok: true });
  });

  it("rejects a response with an invalid decision", () => {
    const invalid = { ...response(), decision: "maybe" } as unknown as ChallengeResponse;
    const result = challengeResponseValid(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CHALLENGE_RESPONSE_INVALID);
  });
});

// ---------------------------------------------------------------------------
// all-challenges-answered
// ---------------------------------------------------------------------------

describe("allChallengesAnsweredGuard", () => {
  it("is vacuously true on an empty challenge set", () => {
    expect(allChallengesAnsweredGuard([])).toEqual({ ok: true });
  });

  it("rejects with the pending challenge ids when any is pending", () => {
    const challenges = [
      { id: "c1", status: "answered" as const, responseId: "r1" },
      { id: "c2", status: "pending" as const },
    ];
    expect(allChallengesAnsweredGuard(challenges)).toEqual({
      ok: false,
      code: CHALLENGES_UNANSWERED,
      evidence: { pendingChallengeIds: ["c2"] },
    });
  });

  it("passes when every challenge is answered", () => {
    const challenges = [{ id: "c1", status: "answered" as const, responseId: "r1" }];
    expect(allChallengesAnsweredGuard(challenges)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// pitch-structure-valid
// ---------------------------------------------------------------------------

describe("pitchStructureValid", () => {
  it("passes a valid pitch", () => {
    expect(pitchStructureValid(pitchArtifact())).toEqual({ ok: true });
  });

  it("rejects a pitch with no evidence ids", () => {
    const result = pitchStructureValid(pitchArtifact({ evidenceIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PITCH_STRUCTURE_INVALID);
  });
});

// ---------------------------------------------------------------------------
// judgment-valid
// ---------------------------------------------------------------------------

describe("judgmentValid", () => {
  it("passes a sanitized, schema-valid output", () => {
    expect(judgmentValid("coach_evaluator", validJudgmentResult, judgmentSchema)).toEqual({
      ok: true,
    });
  });

  it("rejects a schema-invalid output with the sanitizer's code", () => {
    const result = judgmentValid("coach_evaluator", invalidJudgmentResult, judgmentSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(AGENT_OUTPUT_INVALID);
      expect(result.evidence).toEqual({ prohibitedPaths: [] });
    }
  });

  it("rejects a canary leak with LEAK_GUARD_TRIGGERED", () => {
    const result = judgmentValid("coach_evaluator", leakJudgmentResult, judgmentSchema, ["SECRET"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(LEAK_GUARD_TRIGGERED);
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe("GUARD_REGISTRY", () => {
  it("registers exactly the ten named guards", () => {
    const expected = Object.values(GUARD_IDS).sort();
    const actual = Object.keys(GUARD_REGISTRY).sort();
    expect(actual).toEqual(expected);
  });

  it("every registry entry is callable with a single unknown input and returns a GuardResult", () => {
    for (const id of Object.values(GUARD_IDS)) {
      const entry = GUARD_REGISTRY[id];
      expect(typeof entry, `entry ${id} must be a function`).toBe("function");
      // A grossly invalid input must still return a GuardResult, never throw.
      const result = entry(null);
      expect(result).toHaveProperty("ok");
    }
  });
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  it("two calls with equal (fresh) inputs give equal results", () => {
    const cases: [string, () => unknown][] = [
      ["no-pending-evidence", () => ({ turnId: "t1", code: "E" })],
      [
        "evidence-patch-valid",
        () => ({ graph: createEmptyEvidenceGraph(), patch: patch({ expectedVersion: 1 }) }),
      ],
      [
        "brief-structure-valid",
        () => ({ brief: brief({ successMeasures: [] }), graph: createEmptyEvidenceGraph() }),
      ],
      [
        "brief-support-sufficient",
        () => {
          const claims = minorClaims(4);
          return { claims, entailments: entailmentsFor(claims, 2, 0) };
        },
      ],
      ["clarification-budget-available", () => ({ clarificationBudgetUsed: 3 })],
      ["proposal-structure-valid", () => ({ proposal: proposal() })],
      ["challenge-response-valid", () => ({ response: response() })],
      [
        "all-challenges-answered",
        () => ({ challenges: [{ id: "c2", status: "pending" }] }),
      ],
      ["pitch-structure-valid", () => ({ pitch: pitchArtifact() })],
      [
        "judgment-valid",
        () => ({ role: "coach_evaluator", result: validJudgmentResult, outputSchema: judgmentSchema }),
      ],
    ];

    for (const [id, make] of cases) {
      const first = GUARD_REGISTRY[id](make());
      const second = GUARD_REGISTRY[id](make());
      expect(second, `guard ${id} must be pure`).toEqual(first);
    }
  });
});
