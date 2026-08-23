import { describe, expect, it } from "vitest";

import type {
  ClaimEntailment,
  EvidenceNode,
  LocalizedText,
  ProblemBrief,
  ProblemBriefClaim,
  ProblemBriefContradiction,
} from "../../src/core/domain";
import { BriefValidationResultSchema } from "../../src/core/domain";
import { applyEvidencePatch, createEmptyEvidenceGraph } from "../../src/evidence/graph";
import {
  BRIEF_DANGLING_EVIDENCE_REFERENCE,
  BRIEF_MISSING_SUCCESS_MEASURE,
  BRIEF_MISSING_UNKNOWN,
  BRIEF_UNDISPOSED_CONTRADICTION,
  BRIEF_UNGROUNDED_CRITICAL_CLAIM,
  calculateSupportRatio,
  validateBriefStructure,
} from "../../src/evidence/brief-validator";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A marker that must never leak into validator feedback. */
const HIDDEN = "HIDDEN_EVIDENCE_TEXT";

function text(value: string): LocalizedText {
  return { "zh-CN": value, "en-US": value };
}

function node(id: string, over: Partial<EvidenceNode> = {}): EvidenceNode {
  return {
    id,
    kind: "fact",
    claim: text(`${HIDDEN} ${id}`),
    status: "active",
    sourceTranscriptIds: ["turn-1"],
    weight: 1,
    version: 0,
    ...over,
  };
}

/**
 * Graph with:
 *   ev-fact        active fact
 *   ev-fact-2      active fact
 *   ev-assumption  active assumption (sourceless)
 *   ev-unknown     active unknown
 *   ev-stale       invalidated fact
 *   ev-contra      active contradiction wired to ev-fact + ev-fact-2
 */
function graph() {
  const seeded = applyEvidencePatch(createEmptyEvidenceGraph(), {
    patchId: "p1",
    expectedVersion: 0,
    addNodes: [
      node("ev-fact"),
      node("ev-fact-2"),
      node("ev-assumption", { kind: "assumption", sourceTranscriptIds: [] }),
      node("ev-unknown", { kind: "unknown", sourceTranscriptIds: [] }),
      node("ev-stale"),
      node("ev-contra", { kind: "contradiction" }),
    ],
    addEdges: [
      { id: "e1", from: "ev-contra", to: "ev-fact", relation: "contradicts", version: 0 },
      { id: "e2", from: "ev-contra", to: "ev-fact-2", relation: "contradicts", version: 0 },
    ],
    invalidateNodeIds: [],
  });
  return applyEvidencePatch(seeded, {
    patchId: "p2",
    expectedVersion: seeded.version,
    addNodes: [],
    addEdges: [],
    invalidateNodeIds: ["ev-stale"],
  });
}

function claim(id: string, over: Partial<ProblemBriefClaim> = {}): ProblemBriefClaim {
  return { id, statement: text(`statement ${id}`), weight: "major", evidenceIds: ["ev-fact"], ...over };
}

function contradiction(
  id: string,
  over: Partial<ProblemBriefContradiction> = {},
): ProblemBriefContradiction {
  return {
    id,
    statement: text(`contradiction ${id}`),
    evidenceIds: ["ev-contra"],
    disposition: "resolved",
    ...over,
  };
}

function brief(over: Partial<ProblemBrief> = {}): ProblemBrief {
  return {
    id: "brief-1",
    problemStatement: text("problem"),
    goal: text("goal"),
    constraints: [text("constraint")],
    claims: [claim("claim-1"), claim("claim-2", { weight: "critical" })],
    successMeasures: [text("measure")],
    unknowns: [text("unknown")],
    contradictions: [contradiction("contra-1")],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe("validateBriefStructure: passing brief", () => {
  it("passes a structurally complete brief", () => {
    const result = validateBriefStructure(brief(), graph());
    expect(result.passed).toBe(true);
    expect(result.missingCategories).toEqual([]);
    expect(result.unsupportedClaimIds).toEqual([]);
    expect(result.entailments).toEqual([]);
    expect(BriefValidationResultSchema.safeParse(result).success).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const a = validateBriefStructure(brief(), graph());
    const b = validateBriefStructure(brief(), graph());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never mutates the brief or the graph", () => {
    const b = brief();
    const g = graph();
    const beforeBrief = JSON.stringify(b);
    const beforeGraph = JSON.stringify(g);
    validateBriefStructure(b, g);
    expect(JSON.stringify(b)).toBe(beforeBrief);
    expect(JSON.stringify(g)).toBe(beforeGraph);
  });
});

// ---------------------------------------------------------------------------
// (a) at least one success measure
// ---------------------------------------------------------------------------

describe("validateBriefStructure: success measures", () => {
  it("fails when successMeasures is empty", () => {
    const result = validateBriefStructure(brief({ successMeasures: [] }), graph());
    expect(result.passed).toBe(false);
    expect(result.missingCategories).toContain(BRIEF_MISSING_SUCCESS_MEASURE);
  });

  it("passes with exactly one success measure", () => {
    const result = validateBriefStructure(brief({ successMeasures: [text("one")] }), graph());
    expect(result.missingCategories).not.toContain(BRIEF_MISSING_SUCCESS_MEASURE);
  });
});

// ---------------------------------------------------------------------------
// (b) at least one remaining unknown
// ---------------------------------------------------------------------------

describe("validateBriefStructure: remaining unknowns", () => {
  it("fails when unknowns is empty", () => {
    const result = validateBriefStructure(brief({ unknowns: [] }), graph());
    expect(result.passed).toBe(false);
    expect(result.missingCategories).toContain(BRIEF_MISSING_UNKNOWN);
  });

  it("reports both missing categories at once, in stable order", () => {
    const result = validateBriefStructure(brief({ successMeasures: [], unknowns: [] }), graph());
    expect(result.missingCategories).toEqual([BRIEF_MISSING_SUCCESS_MEASURE, BRIEF_MISSING_UNKNOWN]);
  });
});

// ---------------------------------------------------------------------------
// (c) contradictions must be disposed
// ---------------------------------------------------------------------------

describe("validateBriefStructure: contradiction disposition", () => {
  it("accepts each of the three dispositions", () => {
    for (const disposition of ["resolved", "accepted_risk", "needs_follow_up"] as const) {
      const result = validateBriefStructure(
        brief({ contradictions: [contradiction("contra-1", { disposition })] }),
        graph(),
      );
      expect(result.missingCategories).not.toContain(BRIEF_UNDISPOSED_CONTRADICTION);
      expect(result.passed).toBe(true);
    }
  });

  it("fails on an out-of-vocabulary disposition and cites the contradiction id", () => {
    const bad = {
      ...contradiction("contra-1"),
      disposition: "ignored",
    } as unknown as ProblemBriefContradiction;
    const result = validateBriefStructure(brief({ contradictions: [bad] }), graph());
    expect(result.passed).toBe(false);
    expect(result.missingCategories).toContain(BRIEF_UNDISPOSED_CONTRADICTION);
    expect(result.feedback["en-US"]).toContain("contra-1");
  });

  it("fails when an active contradiction node in the graph is left undisposed", () => {
    const result = validateBriefStructure(brief({ contradictions: [] }), graph());
    expect(result.passed).toBe(false);
    expect(result.missingCategories).toContain(BRIEF_UNDISPOSED_CONTRADICTION);
    expect(result.feedback["en-US"]).toContain("ev-contra");
    expect(result.feedback["zh-CN"]).toContain("ev-contra");
  });

  it("does not require a disposition for an invalidated contradiction node", () => {
    const g = graph();
    const withInvalidated = applyEvidencePatch(g, {
      patchId: "p3",
      expectedVersion: g.version,
      addNodes: [],
      addEdges: [],
      invalidateNodeIds: ["ev-contra"],
    });
    const result = validateBriefStructure(brief({ contradictions: [] }), withInvalidated);
    expect(result.missingCategories).not.toContain(BRIEF_UNDISPOSED_CONTRADICTION);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (d) every evidenceIds entry must reference an existing graph node
// ---------------------------------------------------------------------------

describe("validateBriefStructure: evidence references", () => {
  it("fails on a claim citing a non-existent evidence id, naming claim + evidence", () => {
    const result = validateBriefStructure(
      brief({ claims: [claim("claim-1", { evidenceIds: ["ev-ghost"] })] }),
      graph(),
    );
    expect(result.passed).toBe(false);
    expect(result.missingCategories).toContain(BRIEF_DANGLING_EVIDENCE_REFERENCE);
    expect(result.unsupportedClaimIds).toContain("claim-1");
    expect(result.feedback["en-US"]).toContain("claim-1");
    expect(result.feedback["en-US"]).toContain("ev-ghost");
  });

  it("fails on a contradiction citing a non-existent evidence id", () => {
    const result = validateBriefStructure(
      brief({ contradictions: [contradiction("contra-1", { evidenceIds: ["ev-contra", "ev-ghost"] })] }),
      graph(),
    );
    expect(result.passed).toBe(false);
    expect(result.missingCategories).toContain(BRIEF_DANGLING_EVIDENCE_REFERENCE);
    expect(result.feedback["en-US"]).toContain("contra-1");
    expect(result.feedback["en-US"]).toContain("ev-ghost");
  });

  it("accepts a reference to an invalidated node (it exists; it just cannot ground a claim)", () => {
    const result = validateBriefStructure(
      brief({ claims: [claim("claim-1", { evidenceIds: ["ev-stale"] })] }),
      graph(),
    );
    expect(result.missingCategories).not.toContain(BRIEF_DANGLING_EVIDENCE_REFERENCE);
  });

  it("lists every dangling reference, deduplicated and ordered", () => {
    const result = validateBriefStructure(
      brief({
        claims: [
          claim("claim-1", { evidenceIds: ["ev-ghost", "ev-ghost"] }),
          claim("claim-2", { weight: "critical", evidenceIds: ["ev-fact", "ev-phantom"] }),
        ],
      }),
      graph(),
    );
    expect(result.unsupportedClaimIds).toEqual(["claim-1", "claim-2"]);
    expect(result.feedback["en-US"]).toContain("ev-ghost");
    expect(result.feedback["en-US"]).toContain("ev-phantom");
  });
});

// ---------------------------------------------------------------------------
// (e) no critical claim grounded only in assumption/unknown nodes
// ---------------------------------------------------------------------------

describe("validateBriefStructure: critical claim grounding", () => {
  it("fails a critical claim grounded only in an assumption", () => {
    const result = validateBriefStructure(
      brief({ claims: [claim("claim-1", { weight: "critical", evidenceIds: ["ev-assumption"] })] }),
      graph(),
    );
    expect(result.passed).toBe(false);
    expect(result.missingCategories).toContain(BRIEF_UNGROUNDED_CRITICAL_CLAIM);
    expect(result.unsupportedClaimIds).toContain("claim-1");
    expect(result.feedback["en-US"]).toContain("claim-1");
  });

  it("fails a critical claim grounded only in assumption + unknown nodes", () => {
    const result = validateBriefStructure(
      brief({
        claims: [claim("claim-1", { weight: "critical", evidenceIds: ["ev-assumption", "ev-unknown"] })],
      }),
      graph(),
    );
    expect(result.missingCategories).toContain(BRIEF_UNGROUNDED_CRITICAL_CLAIM);
  });

  it("fails a critical claim whose only fact node is invalidated", () => {
    const result = validateBriefStructure(
      brief({
        claims: [claim("claim-1", { weight: "critical", evidenceIds: ["ev-stale", "ev-assumption"] })],
      }),
      graph(),
    );
    expect(result.missingCategories).toContain(BRIEF_UNGROUNDED_CRITICAL_CLAIM);
    expect(result.unsupportedClaimIds).toContain("claim-1");
  });

  it("passes a critical claim with at least one active fact node alongside assumptions", () => {
    const result = validateBriefStructure(
      brief({
        claims: [claim("claim-1", { weight: "critical", evidenceIds: ["ev-assumption", "ev-fact"] })],
      }),
      graph(),
    );
    expect(result.missingCategories).not.toContain(BRIEF_UNGROUNDED_CRITICAL_CLAIM);
    expect(result.passed).toBe(true);
  });

  it("allows major and minor claims grounded only in assumptions", () => {
    for (const weight of ["major", "minor"] as const) {
      const result = validateBriefStructure(
        brief({ claims: [claim("claim-1", { weight, evidenceIds: ["ev-assumption"] })] }),
        graph(),
      );
      expect(result.missingCategories).not.toContain(BRIEF_UNGROUNDED_CRITICAL_CLAIM);
      expect(result.passed).toBe(true);
    }
  });

  it("accepts a contradiction node as grounding for a critical claim only via a fact", () => {
    const result = validateBriefStructure(
      brief({ claims: [claim("claim-1", { weight: "critical", evidenceIds: ["ev-contra"] })] }),
      graph(),
    );
    expect(result.missingCategories).toContain(BRIEF_UNGROUNDED_CRITICAL_CLAIM);
  });
});

// ---------------------------------------------------------------------------
// leakage discipline
// ---------------------------------------------------------------------------

describe("validateBriefStructure: feedback cites ids only", () => {
  it("never echoes evidence node claim text", () => {
    const result = validateBriefStructure(
      brief({
        claims: [
          claim("claim-1", { weight: "critical", evidenceIds: ["ev-assumption"] }),
          claim("claim-2", { evidenceIds: ["ev-ghost"] }),
        ],
        successMeasures: [],
        unknowns: [],
        contradictions: [],
      }),
      graph(),
    );
    expect(result.passed).toBe(false);
    expect(result.feedback["en-US"]).not.toContain(HIDDEN);
    expect(result.feedback["zh-CN"]).not.toContain(HIDDEN);
  });

  it("never echoes learner statement text, only ids", () => {
    const result = validateBriefStructure(
      brief({ claims: [claim("claim-1", { evidenceIds: ["ev-ghost"] })] }),
      graph(),
    );
    expect(result.feedback["en-US"]).not.toContain("statement claim-1");
  });

  it("emits non-empty bilingual feedback in both the pass and fail case", () => {
    const pass = validateBriefStructure(brief(), graph());
    expect(pass.feedback["zh-CN"].length).toBeGreaterThan(0);
    expect(pass.feedback["en-US"].length).toBeGreaterThan(0);
    const fail = validateBriefStructure(brief({ unknowns: [] }), graph());
    expect(fail.feedback["zh-CN"].length).toBeGreaterThan(0);
    expect(fail.feedback["en-US"].length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// calculateSupportRatio
// ---------------------------------------------------------------------------

describe("calculateSupportRatio", () => {
  function claims(...specs: [string, ProblemBriefClaim["weight"]][]): ProblemBriefClaim[] {
    return specs.map(([id, weight]) => claim(id, { weight }));
  }

  function entailments(...specs: [string, ClaimEntailment["entailment"]][]): ClaimEntailment[] {
    return specs.map(([claimId, entailment]) => ({ claimId, entailment }));
  }

  it("returns 0 when there are no claims", () => {
    expect(calculateSupportRatio([], [])).toBe(0);
    expect(calculateSupportRatio([], entailments(["claim-1", "supported"]))).toBe(0);
  });

  it("scores a single critical supported claim as 1 (3x1 / 3)", () => {
    expect(calculateSupportRatio(claims(["claim-1", "critical"]), entailments(["claim-1", "supported"]))).toBe(1);
  });

  it("scores a single critical unsupported claim as 0", () => {
    expect(calculateSupportRatio(claims(["claim-1", "critical"]), entailments(["claim-1", "unsupported"]))).toBe(0);
  });

  it("scores a single major partial claim as 0.5 (2x0.5 / 2)", () => {
    expect(calculateSupportRatio(claims(["claim-1", "major"]), entailments(["claim-1", "partial"]))).toBe(0.5);
  });

  it("hits the 0.75 boundary for critical supported + minor unsupported (3 / 4)", () => {
    const ratio = calculateSupportRatio(
      claims(["claim-1", "critical"], ["claim-2", "minor"]),
      entailments(["claim-1", "supported"], ["claim-2", "unsupported"]),
    );
    expect(ratio).toBe(0.75);
  });

  it("computes a mixed set exactly: (3x0.5 + 2x1 + 1x0) / 6", () => {
    const ratio = calculateSupportRatio(
      claims(["claim-1", "critical"], ["claim-2", "major"], ["claim-3", "minor"]),
      entailments(["claim-1", "partial"], ["claim-2", "supported"], ["claim-3", "unsupported"]),
    );
    expect(ratio).toBeCloseTo(3.5 / 6, 12);
  });

  it("weights critical=3, major=2, minor=1 (all supported => 1)", () => {
    const ratio = calculateSupportRatio(
      claims(["claim-1", "critical"], ["claim-2", "major"], ["claim-3", "minor"]),
      entailments(["claim-1", "supported"], ["claim-2", "supported"], ["claim-3", "supported"]),
    );
    expect(ratio).toBe(1);
  });

  it("treats a claim with no entailment entry as unsupported", () => {
    const ratio = calculateSupportRatio(
      claims(["claim-1", "critical"], ["claim-2", "critical"]),
      entailments(["claim-1", "supported"]),
    );
    expect(ratio).toBe(0.5);
  });

  it("ignores entailments for claim ids not present in the brief", () => {
    const ratio = calculateSupportRatio(
      claims(["claim-1", "major"]),
      entailments(["claim-1", "supported"], ["claim-ghost", "supported"]),
    );
    expect(ratio).toBe(1);
  });

  it("uses the first entailment when a claim id is repeated (deterministic)", () => {
    const ratio = calculateSupportRatio(
      claims(["claim-1", "minor"]),
      entailments(["claim-1", "supported"], ["claim-1", "unsupported"]),
    );
    expect(ratio).toBe(1);
  });

  it("stays within [0,1] and is order-independent", () => {
    const c = claims(["claim-1", "critical"], ["claim-2", "major"], ["claim-3", "minor"]);
    const e = entailments(["claim-3", "supported"], ["claim-1", "partial"], ["claim-2", "unsupported"]);
    const ratio = calculateSupportRatio(c, e);
    expect(ratio).toBeGreaterThanOrEqual(0);
    expect(ratio).toBeLessThanOrEqual(1);
    expect(ratio).toBeCloseTo(2.5 / 6, 12);
    expect(calculateSupportRatio([...c].reverse(), [...e].reverse())).toBeCloseTo(ratio, 12);
  });

  it("falls below the 0.75 gate when a critical claim is only partial", () => {
    const ratio = calculateSupportRatio(
      claims(["claim-1", "critical"], ["claim-2", "minor"]),
      entailments(["claim-1", "partial"], ["claim-2", "supported"]),
    );
    expect(ratio).toBeCloseTo(2.5 / 4, 12);
    expect(ratio).toBeLessThan(0.75);
  });
});
