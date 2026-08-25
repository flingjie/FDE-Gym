import { describe, expect, it } from "vitest";

import {
  COMPETENCY_KEYS,
  createEmptyProfile,
  updateLearnerProfile,
  type AttemptReview,
  type CompetencyKey,
  type CompetencyScores,
  type LearnerProfile,
} from "../../src/profile/learner-profile";
import { RAW_STAGE_WEIGHTS, RUBRIC } from "../../src/scoring/rubric";

const text = (value: string) => ({ "zh-CN": value, "en-US": value });

function scores(value: number): CompetencyScores {
  const out = {} as CompetencyScores;
  for (const key of COMPETENCY_KEYS) out[key] = value;
  return out;
}

function review(overrides: Partial<AttemptReview> = {}): AttemptReview {
  return {
    competencies: scores(50),
    hintReliance: 0,
    repeatedQuestionRate: 0,
    unsupportedClaimRate: 0,
    contradictionHandling: 0,
    retryFocuses: [],
    ...overrides,
  };
}

function profile(overrides: Partial<LearnerProfile> = {}): LearnerProfile {
  return { ...createEmptyProfile(), ...overrides };
}

// ---------------------------------------------------------------------------
// EMA
// ---------------------------------------------------------------------------

describe("updateLearnerProfile: competency EMA", () => {
  it("computes new = 0.7×previous + 0.3×current", () => {
    const next = updateLearnerProfile(
      profile({ competencies: { ...scores(50), discovery: 50 } }),
      review({ competencies: { ...scores(50), discovery: 100 } }),
    );
    // 0.7×50 + 0.3×100 = 35 + 30 = 65.
    expect(next.competencies.discovery).toBe(65);
    // Untouched competencies: 0.7×50 + 0.3×50 = 50.
    expect(next.competencies.problemFraming).toBe(50);
    expect(next.competencies.pitching).toBe(50);
  });

  it("clamps to [0, 100]", () => {
    const atTop = updateLearnerProfile(
      profile({ competencies: scores(100) }),
      review({ competencies: scores(100) }),
    );
    expect(atTop.competencies.discovery).toBe(100);

    const atBottom = updateLearnerProfile(
      profile({ competencies: scores(0) }),
      review({ competencies: scores(0) }),
    );
    expect(atBottom.competencies.discovery).toBe(0);

    // 0.7×100 + 0.3×0 = 70 (no clamp needed — sits inside the range).
    const mixed = updateLearnerProfile(
      profile({ competencies: scores(100) }),
      review({ competencies: scores(0) }),
    );
    expect(mixed.competencies.discovery).toBe(70);
  });

  it("starts from the neutral 50 on the first attempt", () => {
    const next = updateLearnerProfile(createEmptyProfile(), review({ competencies: scores(100) }));
    // 0.7×50 + 0.3×100 = 65.
    expect(next.competencies.discovery).toBe(65);
    expect(next.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// attempts + strongest/weakest
// ---------------------------------------------------------------------------

describe("updateLearnerProfile: attempts and strongest/weakest", () => {
  it("increments the attempt counter", () => {
    let p = createEmptyProfile();
    p = updateLearnerProfile(p, review());
    p = updateLearnerProfile(p, review());
    p = updateLearnerProfile(p, review());
    expect(p.attempts).toBe(3);
  });

  it("tracks the strongest and weakest competency", () => {
    const next = updateLearnerProfile(
      profile(),
      review({
        competencies: {
          discovery: 60,
          problemFraming: 55,
          evidenceReasoning: 50,
          solutionDesign: 90,
          adaptability: 50,
          pitching: 20,
        },
      }),
    );
    expect(next.strongestCompetency).toBe("solutionDesign");
    expect(next.weakestCompetency).toBe("pitching");
  });

  it("breaks ties deterministically (first key in COMPETENCY_KEYS order)", () => {
    const next = updateLearnerProfile(profile(), review({ competencies: scores(80) }));
    expect(next.strongestCompetency).toBe(COMPETENCY_KEYS[0]);
    expect(next.weakestCompetency).toBe(COMPETENCY_KEYS[0]);
  });
});

// ---------------------------------------------------------------------------
// retry focuses + persisted metrics
// ---------------------------------------------------------------------------

describe("updateLearnerProfile: retry focuses and persisted metrics", () => {
  it("keeps only the latest three retry focuses, newest first", () => {
    let p = createEmptyProfile();
    p = updateLearnerProfile(p, review({ retryFocuses: [text("A")] }));
    p = updateLearnerProfile(p, review({ retryFocuses: [text("B")] }));
    p = updateLearnerProfile(p, review({ retryFocuses: [text("C")] }));
    expect(p.retryFocuses.map((f) => f["en-US"])).toEqual(["C", "B", "A"]);

    p = updateLearnerProfile(p, review({ retryFocuses: [text("D")] }));
    expect(p.retryFocuses.map((f) => f["en-US"])).toEqual(["D", "C", "B"]);
  });

  it("persists the latest hint reliance, rates, and contradiction handling", () => {
    const next = updateLearnerProfile(
      profile(),
      review({
        hintReliance: 60,
        repeatedQuestionRate: 0.4,
        unsupportedClaimRate: 0.1,
        contradictionHandling: 75,
      }),
    );
    expect(next.hintReliance).toBe(60);
    expect(next.repeatedQuestionRate).toBe(0.4);
    expect(next.unsupportedClaimRate).toBe(0.1);
    expect(next.contradictionHandling).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// immutability / truth-independence
// ---------------------------------------------------------------------------

describe("updateLearnerProfile: never changes truth or rubric", () => {
  it("does not mutate the profile or review inputs", () => {
    const before = profile();
    const r = review({ competencies: { ...scores(50), discovery: 100 } });
    const profileSnapshot = JSON.stringify(before);
    const reviewSnapshot = JSON.stringify(r);

    const next = updateLearnerProfile(before, r);

    expect(JSON.stringify(before)).toBe(profileSnapshot);
    expect(JSON.stringify(r)).toBe(reviewSnapshot);
    // Returns a NEW profile, not the same reference.
    expect(next).not.toBe(before);
    expect(next.competencies).not.toBe(before.competencies);
  });

  it("leaves the rubric weight constants untouched", () => {
    const rubricSnapshot = JSON.stringify(RUBRIC);
    const rawSnapshot = JSON.stringify(RAW_STAGE_WEIGHTS);
    updateLearnerProfile(profile(), review());
    expect(JSON.stringify(RUBRIC)).toBe(rubricSnapshot);
    expect(JSON.stringify(RAW_STAGE_WEIGHTS)).toBe(rawSnapshot);
  });
});

// ---------------------------------------------------------------------------
// schema round-trip
// ---------------------------------------------------------------------------

describe("LearnerProfile: createEmptyProfile", () => {
  it("produces a neutral profile with zero attempts", () => {
    const p = createEmptyProfile();
    expect(p.attempts).toBe(0);
    expect(p.strongestCompetency).toBeNull();
    expect(p.weakestCompetency).toBeNull();
    expect(p.retryFocuses).toEqual([]);
    for (const key of COMPETENCY_KEYS) {
      expect(p.competencies[key]).toBe(50);
    }
  });

  it("starts with no applied effect or run ids", () => {
    const p = createEmptyProfile();
    expect(p.appliedEffectIds).toEqual([]);
    expect(p.appliedRunIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applied-id bookkeeping
// ---------------------------------------------------------------------------

describe("updateLearnerProfile: applied-id bookkeeping", () => {
  it("carries applied effect and run ids forward unchanged", () => {
    const before = profile({ appliedEffectIds: ["e1"], appliedRunIds: ["r1"] });
    const next = updateLearnerProfile(before, review());
    expect(next.appliedEffectIds).toEqual(["e1"]);
    expect(next.appliedRunIds).toEqual(["r1"]);
  });
});
