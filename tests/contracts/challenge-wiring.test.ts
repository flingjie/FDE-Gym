import { describe, expect, it } from "vitest";

import { foldRunAggregate } from "../../src/replay/projector.js";
import { prepareRespondToChallenge } from "../../src/core/orchestrator.js";
import {
  CHALLENGE_ALREADY_ANSWERED,
  CHALLENGE_RESPONSE_TO_UNKNOWN_ID,
} from "../../src/graph/challenge-state.js";
import type { ChallengeResponse, RunEvent } from "../../src/core/domain.js";

/**
 * Challenge-aggregate wiring tests (G1-03): `prepareRespondToChallenge` now
 * derives `all-answered` and the response-target validation from the folded
 * injected-challenge aggregate — not a caller-tracked `mandatoryChallengeIds`.
 */

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

function response(challengeId: string, id = `resp-${challengeId}`): ChallengeResponse {
  return {
    id,
    challengeId,
    impact: text("影响", "impact"),
    decision: "keep",
    rationale: text("理由", "rationale"),
    newRiskOrValidation: text("风险", "risk"),
  };
}

/** Fold a run that has entered CHALLENGE with one injected challenge (optionally answered). */
function challengeAggregate(injectedId: string, answered: boolean) {
  const runId = "run-1";
  const events: RunEvent[] = [
    { type: "run.started", runId, commandId: "s", scenarioId: "scn-1", locale: "zh-CN" },
    { type: "phase.changed", runId, commandId: "s", from: "SCENARIO", to: "SCENARIO" },
    { type: "phase.changed", runId, commandId: "s:a", from: "SCENARIO", to: "DISCOVERY" },
    { type: "phase.changed", runId, commandId: "s:f", from: "DISCOVERY", to: "PROBLEM_FRAMING" },
    { type: "phase.changed", runId, commandId: "s:b", from: "PROBLEM_FRAMING", to: "SOLUTION_DESIGN" },
    { type: "phase.changed", runId, commandId: "s:d", from: "SOLUTION_DESIGN", to: "CHALLENGE" },
    {
      type: "challenge.injected",
      runId,
      commandId: "s:inject",
      challengeId: injectedId,
      prompt: text("挑战", "challenge"),
    },
  ];
  if (answered) {
    events.push({ type: "challenge.responded", runId, commandId: "s:resp", response: response(injectedId) });
  }
  return foldRunAggregate(events, "scn-1", "zh-CN");
}

describe("challenge-aggregate wiring", () => {
  it("rejects a duplicate answer to an already-answered challenge", async () => {
    const state = challengeAggregate("ch-1", true);
    await expect(
      prepareRespondToChallenge({ state, response: response("ch-1", "resp-ch-1-again"), commandId: "cmd" }),
    ).rejects.toMatchObject({ code: CHALLENGE_ALREADY_ANSWERED });
  });

  it("rejects a response to a challenge that was never injected", async () => {
    const state = challengeAggregate("ch-1", false);
    await expect(
      prepareRespondToChallenge({ state, response: response("ch-unknown"), commandId: "cmd" }),
    ).rejects.toMatchObject({ code: CHALLENGE_RESPONSE_TO_UNKNOWN_ID });
  });

  it("derives all-answered from the aggregate (advances to PITCH on the last answer)", async () => {
    const state = challengeAggregate("ch-1", false);
    const result = await prepareRespondToChallenge({
      state,
      response: response("ch-1"),
      commandId: "cmd",
    });
    expect(result.challengesAddressed).toBe(true);
    expect(result.updatedState.phase).toBe("PITCH");
    expect(result.acceptedEvents.map((e) => e.type)).toEqual(["challenge.responded", "phase.changed"]);
  });
});
