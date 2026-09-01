import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { ChallengeResponse, RunEvent } from "../../../core/domain.js";
import type { InjectedChallengeCollection } from "../../challenge-state.js";
import { buildRespondEvent } from "./shared.js";

/**
 * `pitch.prepare` — advance CHALLENGE → PITCH on all-answered (deterministic).
 *
 * Commits the final response (when one is present) and emits `phase.changed`
 * (CHALLENGE → PITCH). For the vacuous empty-set advance `response` is ABSENT:
 * only `phase.changed` is emitted — a fabricated response is never invented.
 * Mirrors the advance half of `prepareRespondToChallenge`.
 *
 * Protocol: `EVENT_PROTOCOLS["respond-challenge"]` (required `challenge.responded`
 * when a response is present; `phase.changed` always).
 */
export interface PitchPrepareInput {
  /** Aggregate; `phase` must be CHALLENGE. */
  state: RunAggregate;
  commandId: string;
  /** The membership-validated fold (from `response.membership.guard`). */
  folded: InjectedChallengeCollection;
  /** Absent for the vacuous empty-set advance (no fabricated response). */
  response?: ChallengeResponse;
}

export interface PitchPrepareResult extends NodeExecution {
  challengesAddressed: boolean;
}

export async function runPitchPrepare(input: PitchPrepareInput): Promise<PitchPrepareResult> {
  const { state, commandId, folded } = input;
  const response = input.response;
  const runId = state.runId;

  const events: RunEvent[] = [];
  let challengeResponses = state.challengeResponses;
  if (response !== undefined) {
    events.push(buildRespondEvent(state, commandId, response));
    challengeResponses = [...state.challengeResponses, response];
  }
  events.push({ type: "phase.changed", runId, commandId, from: "CHALLENGE", to: "PITCH" });

  return {
    events,
    updatedState: { ...state, challengeResponses, injectedChallenges: folded, phase: "PITCH" },
    challengesAddressed: true,
  };
}

export const pitchPrepare: NodeHandler<PitchPrepareInput> = {
  definition: {
    id: "pitch.prepare",
    phase: "CHALLENGE",
    kind: "deterministic",
  },
  run: runPitchPrepare,
};
