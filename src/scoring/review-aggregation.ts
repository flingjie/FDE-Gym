import type { CriterionScores, FinalReviewResult } from "../core/domain.js";
import type { FinalReviewInvocation } from "../agents/coach.js";

export interface AggregatedReview {
  review: FinalReviewResult;
  confidence: number | null; // null when samples === 1
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, x) => s + x, 0) / values.length;
}

/** Population std dev. */
function stdDev(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, x) => s + (x - m) * (x - m), 0) / values.length);
}

/** Mean criterion scores across samples, per stage, per criterion id present in any sample. */
function meanCriterionScores(samples: readonly FinalReviewInvocation[]): CriterionScores {
  const out: CriterionScores = {};
  const stages = ["framing", "solution", "challenge", "pitch", "process"] as const;
  for (const stage of stages) {
    const byCriterion = new Map<string, number[]>();
    for (const s of samples) {
      const map = s.review.criterionScores?.[stage];
      if (!map) continue;
      for (const [id, score] of Object.entries(map)) {
        const arr = byCriterion.get(id) ?? [];
        arr.push(score);
        byCriterion.set(id, arr);
      }
    }
    if (byCriterion.size > 0) {
      out[stage] = {};
      for (const [id, arr] of byCriterion) out[stage]![id] = mean(arr);
    }
  }
  return out;
}

/** Mean absolute distance from the mean scores — used to break a verdict tie. */
function distanceToMean(s: FinalReviewInvocation, meanScores: CriterionScores): number {
  let total = 0;
  let count = 0;
  const stages = ["framing", "solution", "challenge", "pitch", "process"] as const;
  for (const stage of stages) {
    const map = s.review.criterionScores?.[stage];
    const meanMap = meanScores[stage];
    if (!map || !meanMap) continue;
    for (const [id, score] of Object.entries(map)) {
      const m = meanMap[id];
      if (m === undefined) continue;
      total += Math.abs(score - m);
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

export function aggregateReviews(reviews: readonly FinalReviewInvocation[]): AggregatedReview {
  if (reviews.length === 0) throw new Error("cannot aggregate zero reviews");
  const criterionScores = meanCriterionScores(reviews);

  // Majority verdict; on a tie, the review closest to the mean scores.
  let pass = 0;
  let fail = 0;
  for (const r of reviews) {
    if (r.review.verdict === "pass") pass += 1; else fail += 1;
  }
  let verdict: FinalReviewResult["verdict"];
  if (pass !== fail) verdict = pass > fail ? "pass" : "fail";
  else {
    let best = reviews[0];
    let bestDist = Infinity;
    for (const r of reviews) {
      const d = distanceToMean(r, criterionScores);
      if (d < bestDist) { bestDist = d; best = r; }
    }
    verdict = best.review.verdict;
  }

  // Prose fields from the first sample.
  const first = reviews[0].review;
  const review: FinalReviewResult = {
    verdict,
    strengths: first.strengths,
    weaknesses: first.weaknesses,
    missedOpportunities: first.missedOpportunities,
    decisionDivergencePoints: first.decisionDivergencePoints,
    nextFocus: first.nextFocus,
    criterionScores,
  };

  // Confidence: null for a single sample; else 1 - meanStdDev/100 over all criteria.
  let confidence: number | null = null;
  if (reviews.length > 1) {
    const byCriterion = new Map<string, number[]>();
    for (const s of reviews) {
      for (const stage of ["framing", "solution", "challenge", "pitch", "process"] as const) {
        const map = s.review.criterionScores?.[stage];
        if (!map) continue;
        for (const [id, score] of Object.entries(map)) {
          const arr = byCriterion.get(id) ?? [];
          arr.push(score);
          byCriterion.set(id, arr);
        }
      }
    }
    const deviations = [...byCriterion.values()].map((arr) => stdDev(arr));
    confidence = clamp01(1 - mean(deviations) / 100);
  }

  return { review, confidence };
}
