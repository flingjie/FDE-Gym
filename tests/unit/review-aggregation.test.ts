import { describe, expect, it } from "vitest";
import { aggregateReviews } from "../../src/scoring/review-aggregation";

function makeReview(verdict: "pass" | "fail", solution: number): any {
  return { review: { verdict, strengths: [], weaknesses: [], missedOpportunities: [], decisionDivergencePoints: [], nextFocus: [], criterionScores: { solution: { c1: solution } } }, invocationId: "x", modelId: null, rawOutputDigest: "a".repeat(64), promptDigest: "b".repeat(64) };
}

describe("aggregateReviews", () => {
  it("single sample → null confidence, passthrough", () => {
    const { review, confidence } = aggregateReviews([makeReview("pass", 80)]);
    expect(confidence).toBeNull();
    expect(review.criterionScores.solution.c1).toBe(80);
  });
  it("means criterion scores and reports 1.0 confidence for identical samples", () => {
    const { review, confidence } = aggregateReviews([makeReview("pass", 80), makeReview("pass", 80), makeReview("pass", 80)]);
    expect(review.criterionScores.solution.c1).toBe(80);
    expect(confidence).toBe(1);
  });
  it("divergent samples → confidence < 1 and mean score", () => {
    const { review, confidence } = aggregateReviews([makeReview("pass", 60), makeReview("pass", 80)]);
    expect(review.criterionScores.solution.c1).toBe(70);
    expect(confidence).toBeLessThan(1);
  });
  it("majority verdict wins", () => {
    const { review } = aggregateReviews([makeReview("pass", 80), makeReview("fail", 40), makeReview("pass", 75)]);
    expect(review.verdict).toBe("pass");
  });
});
