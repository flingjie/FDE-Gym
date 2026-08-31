import { describe, expect, it } from "vitest";
import {
  computeEvaluationIdentity,
  computeEvaluationIdentityHash,
  promptSetDigest,
} from "../../src/scoring/identity";

describe("EvaluationIdentity", () => {
  it("promptSetDigest is stable and 64-hex", () => {
    const d = promptSetDigest();
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(promptSetDigest()).toBe(d);
  });

  it("hash is scenario- and model-sensitive", () => {
    const a = computeEvaluationIdentity({ scenarioBundleSha256: "a".repeat(64), modelId: "m" });
    const b = computeEvaluationIdentity({ scenarioBundleSha256: "b".repeat(64), modelId: "m" });
    const c = computeEvaluationIdentity({ scenarioBundleSha256: "a".repeat(64), modelId: "n" });
    expect(computeEvaluationIdentityHash(a)).not.toBe(computeEvaluationIdentityHash(b));
    expect(computeEvaluationIdentityHash(a)).not.toBe(computeEvaluationIdentityHash(c));
  });
});
