import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { ChallengeResponse } from "../../../core/domain.js";
import type { InjectedChallengeCollection } from "../../challenge-state.js";
import { buildRespondEvent } from "./shared.js";

/**
 * `challenge.wait` — record a non-final answer and stay in CHALLENGE
 * (deterministic).
 *
 * Commits the membership-validated response: emits `challenge.responded`, appends
 * the response to `challengeResponses`, and folds `injectedChallenges`. NO
 * `phase.changed` is emitted — the run stays in CHALLENGE until the last
 * mandatory challenge is answered. Mirrors the stay half of
 * `prepareRespondToChallenge`.
 *
 * Protocol: `EVENT_PROTOCOLS["respond-challenge"]` (required `challenge.responded`,
 * no `phase.changed`).
 */
export interface ChallengeWaitInput {
  /** Aggregate; `phase` must be CHALLENGE. */
  state: RunAggregate;
  response: ChallengeResponse;
  commandId: string;
  /** The membership-validated fold (from `response.membership.guard`). */
  folded: InjectedChallengeCollection;
}

export async function runChallengeWait(input: ChallengeWaitInput): Promise<NodeExecution> {
  const { state, response, commandId, folded } = input;
  return {
    events: [buildRespondEvent(state, commandId, response)],
    updatedState: {
      ...state,
      challengeResponses: [...state.challengeResponses, response],
      injectedChallenges: folded,
    },
  };
}

export const challengeWait: NodeHandler<ChallengeWaitInput> = {
  definition: {
    id: "challenge.wait",
    phase: "CHALLENGE",
    kind: "deterministic",
  },
  run: runChallengeWait,
};
