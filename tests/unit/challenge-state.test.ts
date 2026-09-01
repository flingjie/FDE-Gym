import { describe, expect, it } from "vitest";

import type { RunEvent } from "../../src/core/domain";
import {
  CHALLENGE_ALREADY_ANSWERED,
  CHALLENGE_RESPONSE_TO_UNKNOWN_ID,
  ChallengeStateError,
  allChallengesAnswered,
  canonicalInjectedChallenges,
  emptyInjectedChallenges,
  reduceInjectedChallenges,
} from "../../src/graph/challenge-state";

const text = { "zh-CN": "提示", "en-US": "hint" };

function injected(challengeId: string): RunEvent {
  return {
    type: "challenge.injected",
    runId: "run-1",
    commandId: `inject:${challengeId}`,
    challengeId,
    prompt: text,
  };
}

function responded(responseId: string, challengeId: string): RunEvent {
  return {
    type: "challenge.responded",
    runId: "run-1",
    commandId: `respond:${responseId}`,
    response: {
      id: responseId,
      challengeId,
      impact: text,
      decision: "keep",
      rationale: text,
      newRiskOrValidation: text,
    },
  };
}

describe("reduceInjectedChallenges", () => {
  it("challenge.injected appends a pending entry", () => {
    expect(reduceInjectedChallenges(emptyInjectedChallenges(), injected("c1"))).toEqual([
      { id: "c1", status: "pending" },
    ]);
  });

  it("challenge.responded marks the matching pending entry answered with the responseId", () => {
    const state = [injected("c1"), injected("c2")].reduce(
      reduceInjectedChallenges,
      emptyInjectedChallenges(),
    );
    expect(reduceInjectedChallenges(state, responded("r1", "c1"))).toEqual([
      { id: "c1", status: "answered", responseId: "r1" },
      { id: "c2", status: "pending" },
    ]);
  });

  it("throws on a response to an unknown challenge id", () => {
    expect(() => reduceInjectedChallenges(emptyInjectedChallenges(), responded("r1", "nope"))).toThrow(
      ChallengeStateError,
    );
    try {
      reduceInjectedChallenges(emptyInjectedChallenges(), responded("r1", "nope"));
    } catch (error) {
      expect((error as ChallengeStateError).code).toBe(CHALLENGE_RESPONSE_TO_UNKNOWN_ID);
    }
  });

  it("throws on a duplicate response to the same challenge", () => {
    const pending = reduceInjectedChallenges(emptyInjectedChallenges(), injected("c1"));
    const answered = reduceInjectedChallenges(pending, responded("r1", "c1"));
    expect(() => reduceInjectedChallenges(answered, responded("r2", "c1"))).toThrow(
      ChallengeStateError,
    );
    try {
      reduceInjectedChallenges(answered, responded("r2", "c1"));
    } catch (error) {
      expect((error as ChallengeStateError).code).toBe(CHALLENGE_ALREADY_ANSWERED);
    }
  });

  it("duplicate challenge.injected id is idempotent (same reference returned)", () => {
    const once = reduceInjectedChallenges(emptyInjectedChallenges(), injected("c1"));
    const twice = reduceInjectedChallenges(once, injected("c1"));
    expect(twice).toEqual([{ id: "c1", status: "pending" }]);
    expect(twice).toBe(once);
  });

  it("unrelated events are a no-op", () => {
    const state = reduceInjectedChallenges(emptyInjectedChallenges(), injected("c1"));
    const phaseChanged: RunEvent = {
      type: "phase.changed",
      runId: "run-1",
      commandId: "c0",
      from: "SOLUTION_DESIGN",
      to: "CHALLENGE",
    };
    expect(reduceInjectedChallenges(state, phaseChanged)).toBe(state);
  });
});

describe("allChallengesAnswered", () => {
  it("is vacuously true on an empty set", () => {
    expect(allChallengesAnswered(emptyInjectedChallenges())).toBe(true);
  });

  it("is false when any challenge is still pending", () => {
    const state = [injected("c1"), injected("c2")].reduce(
      reduceInjectedChallenges,
      emptyInjectedChallenges(),
    );
    const partlyAnswered = reduceInjectedChallenges(state, responded("r1", "c1"));
    expect(allChallengesAnswered(partlyAnswered)).toBe(false);
  });

  it("is true only when every challenge is answered", () => {
    const state = [injected("c1"), injected("c2")].reduce(
      reduceInjectedChallenges,
      emptyInjectedChallenges(),
    );
    const allAnswered = [responded("r1", "c1"), responded("r2", "c2")].reduce(
      reduceInjectedChallenges,
      state,
    );
    expect(allChallengesAnswered(allAnswered)).toBe(true);
  });
});

describe("deterministic reconstruction", () => {
  it("folds the same sequence to byte-identical canonical state", () => {
    const events: RunEvent[] = [
      injected("c1"),
      injected("c2"),
      responded("r1", "c1"),
      responded("r2", "c2"),
    ];
    const a = events.reduce(reduceInjectedChallenges, emptyInjectedChallenges());
    const b = events.reduce(reduceInjectedChallenges, emptyInjectedChallenges());
    expect(canonicalInjectedChallenges(a)).toBe(canonicalInjectedChallenges(b));
    expect(canonicalInjectedChallenges(a)).toBe(
      '[{"id":"c1","status":"answered","responseId":"r1"},{"id":"c2","status":"answered","responseId":"r2"}]',
    );
  });

  it("is independent of the replay loop shape", () => {
    const events: RunEvent[] = [injected("c1"), responded("r1", "c1")];
    let folded = emptyInjectedChallenges();
    for (const event of events) folded = reduceInjectedChallenges(folded, event);
    const reduced = events.reduce(reduceInjectedChallenges, emptyInjectedChallenges());
    expect(canonicalInjectedChallenges(folded)).toBe(canonicalInjectedChallenges(reduced));
  });
});
