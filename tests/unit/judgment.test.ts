import { describe, expect, it } from "vitest";
import { JudgmentProvenanceSchema, type JudgmentProvenance } from "../../src/core/judgment";

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
