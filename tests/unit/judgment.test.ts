import { describe, expect, it } from "vitest";
import { JudgmentProvenanceSchema, type JudgmentProvenance } from "../../src/core/judgment";
import {
  BriefValidatedEventSchema,
  QuestionAssessedEventSchema,
  ReviewCompletedEventSchema,
} from "../../src/core/domain";

const valid: JudgmentProvenance = {
  judgmentId: "cmd-1:coach",
  invocationId: "cmd-1:coach",
  modelId: "deepseek-v4-pro",
  promptDigest: "a".repeat(64),
  schemaVersion: 1,
  scenarioDigest: "b".repeat(64),
  rawOutputDigest: "c".repeat(64),
};

describe("JudgmentProvenance", () => {
  it("accepts a complete provenance", () => {
    expect(JudgmentProvenanceSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a truncated digest", () => {
    expect(
      JudgmentProvenanceSchema.safeParse({ ...valid, promptDigest: "short" }).success,
    ).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(
      JudgmentProvenanceSchema.safeParse({ ...valid, chainOfThought: "LEAK" }).success,
    ).toBe(false);
  });

  it("modelRevision and temperature are optional", () => {
    expect(JudgmentProvenanceSchema.safeParse(valid).success).toBe(true);
    expect(
      JudgmentProvenanceSchema.safeParse({ ...valid, modelRevision: "v2", temperature: 0.3 }).success,
    ).toBe(true);
  });
});

describe("judgment envelope on judgment-bearing events", () => {
  const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

  it("question.assessed accepts an optional judgment envelope", () => {
    const ok = QuestionAssessedEventSchema.safeParse({
      type: "question.assessed",
      runId: "run-1",
      commandId: "cmd-1:evidence",
      questionId: "cmd-1",
      assessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
      judgment: valid,
    });
    expect(ok.success).toBe(true);
  });

  it("brief.validated accepts an optional judgment envelope", () => {
    const ok = BriefValidatedEventSchema.safeParse({
      type: "brief.validated",
      runId: "run-1",
      commandId: "cmd-2",
      briefId: "brief-1",
      result: {
        passed: false,
        entailments: [{ claimId: "claim-1", entailment: "supported" }],
        missingCategories: [],
        unsupportedClaimIds: ["claim-1"],
        feedback: text("缺少证据。", "Missing evidence."),
      },
      judgment: valid,
    });
    expect(ok.success).toBe(true);
  });

  it("review.completed accepts an optional judgment envelope", () => {
    const ok = ReviewCompletedEventSchema.safeParse({
      type: "review.completed",
      runId: "run-1",
      commandId: "cmd-3",
      review: {
        verdict: "pass",
        strengths: [text("强", "strong")],
        weaknesses: [],
        missedOpportunities: [],
        decisionDivergencePoints: [{ id: "ddp-1", description: text("分歧", "divergence") }],
        nextFocus: [text("聚焦", "focus")],
      },
      judgment: valid,
    });
    expect(ok.success).toBe(true);
  });

  it("events remain valid when the judgment envelope is absent (backward-compatible)", () => {
    const without = QuestionAssessedEventSchema.safeParse({
      type: "question.assessed",
      runId: "run-1",
      commandId: "cmd-1:evidence",
      questionId: "cmd-1",
      assessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
    });
    expect(without.success).toBe(true);
    expect("judgment" in (without.success ? without.data : {})).toBe(false);
  });

  it("accepts an empty scenarioDigest for provenance-legacy runs", () => {
    expect(
      JudgmentProvenanceSchema.safeParse({ ...valid, scenarioDigest: "" }).success,
    ).toBe(true);
  });
});
