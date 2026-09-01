import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { ChallengeResponse } from "../../../core/domain.js";
import { ChallengeStateError, reduceInjectedChallenges } from "../../challenge-state.js";
import type { InjectedChallengeCollection } from "../../challenge-state.js";
import { buildRespondEvent, NodeGuardError } from "./shared.js";

/**
 * `response.membership.guard` — the response targets an injected+pending
 * challenge (guard).
 *
 * Folds `challenge.responded` through `reduceInjectedChallenges`, which both
 * VALIDATES (the target challenge must be injected and pending — it throws
 * `ChallengeStateError` on an unknown or already-answered id) and marks it
 * `answered`. The rejection is re-thrown as a `NodeGuardError` carrying the
 * stable code (`CHALLENGE_RESPONSE_TO_UNKNOWN_ID` /
 * `CHALLENGE_ALREADY_ANSWERED`); on success the membership-validated fold is
 * carried in the result for `all-answered.guard` / `challenge.wait` /
 * `pitch.prepare` to commit. No events are authored here.
 */
export interface ResponseMembershipInput {
  /** Aggregate; `injectedChallenges` must be folded (post-inject). */
  state: RunAggregate;
  response: ChallengeResponse;
  commandId: string;
}

export interface ResponseMembershipResult extends NodeExecution {
  /** The membership-validated fold (the response marks its target `answered`). */
  folded: InjectedChallengeCollection;
}

export async function runResponseMembershipGuard(
  input: ResponseMembershipInput,
): Promise<ResponseMembershipResult> {
  const { state, response, commandId } = input;
  const respondEvent = buildRespondEvent(state, commandId, response);
  try {
    const folded = reduceInjectedChallenges(state.injectedChallenges ?? [], respondEvent);
    return { events: [], updatedState: state, folded };
  } catch (error) {
    if (error instanceof ChallengeStateError) {
      throw new NodeGuardError(error.code, `challenge response failed membership: ${error.code}`);
    }
    throw error;
  }
}

export const responseMembershipGuard: NodeHandler<ResponseMembershipInput> = {
  definition: {
    id: "response.membership.guard",
    phase: "CHALLENGE",
    kind: "guard",
    failurePolicy: { failureClass: "DOMAIN_REJECTION", retry: false },
  },
  run: runResponseMembershipGuard,
};
