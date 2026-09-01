import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { ChallengeResponse } from "../../../core/domain.js";
import { challengeResponseValid, GUARD_IDS } from "../../guards.js";
import { NodeGuardError } from "./shared.js";

/**
 * `response.accept` — the Challenge Response structural gate (guard).
 *
 * Runs the `challenge-response-valid` guard (`GUARD_IDS.CHALLENGE_RESPONSE_VALID`),
 * which re-validates the response against `ChallengeResponseSchema` (impact,
 * keep/change decision, rationale, a new risk-or-validation action). An invalid
 * response throws a `NodeGuardError` carrying the stable `CHALLENGE_RESPONSE_INVALID`
 * code; the runtime maps that throw to the node's `DOMAIN_REJECTION` failure
 * policy. No events are authored here.
 *
 * Protocol: `EVENT_PROTOCOLS["respond-challenge"]` (no events authored here).
 */
export interface ResponseAcceptInput {
  /** Aggregate (passed through unchanged on acceptance). */
  state: RunAggregate;
  response: ChallengeResponse;
}

export async function runResponseAccept(input: ResponseAcceptInput): Promise<NodeExecution> {
  const { state, response } = input;
  const result = challengeResponseValid(response);
  if (!result.ok) {
    throw new NodeGuardError(
      result.code,
      `challenge response rejected by guard ${GUARD_IDS.CHALLENGE_RESPONSE_VALID}: ${result.code}`,
    );
  }
  return { events: [], updatedState: state };
}

export const responseAccept: NodeHandler<ResponseAcceptInput> = {
  definition: {
    id: "response.accept",
    phase: "CHALLENGE",
    kind: "guard",
    failurePolicy: { failureClass: "DOMAIN_REJECTION", retry: false },
  },
  run: runResponseAccept,
};
