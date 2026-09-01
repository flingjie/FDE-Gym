import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { InjectedChallengeCollection } from "../../challenge-state.js";
import { allChallengesAnsweredGuard } from "../../guards.js";

/**
 * `all-answered.guard` — every injected challenge is answered (guard branch).
 *
 * Runs the `all-challenges-answered` guard over the membership-validated fold.
 * Unlike the other challenge guards this is a BRANCH guard: it does NOT throw on
 * a "no" verdict — it returns the verdict (`ok` + the stable
 * `CHALLENGES_UNANSWERED` code and pending ids on failure) so the graph runtime
 * routes `challenge.wait` (stay) vs `pitch.prepare` (advance). Vacuously true on
 * an empty set (the empty case advances via an explicit edge, never a fabricated
 * response). No events are authored here.
 */
export interface AllAnsweredGuardInput {
  /** Aggregate (passed through unchanged). */
  state: RunAggregate;
  /** The membership-validated fold from `response.membership.guard`. */
  challenges: InjectedChallengeCollection;
}

export type AllAnsweredResult = NodeExecution &
  ({ ok: true } | { ok: false; code: string; evidence?: unknown });

export async function runAllAnsweredGuard(input: AllAnsweredGuardInput): Promise<AllAnsweredResult> {
  const { state, challenges } = input;
  const result = allChallengesAnsweredGuard(challenges);
  if (result.ok) return { events: [], updatedState: state, ok: true };
  return { events: [], updatedState: state, ok: false, code: result.code, evidence: result.evidence };
}

export const allAnsweredGuard: NodeHandler<AllAnsweredGuardInput> = {
  definition: {
    id: "all-answered.guard",
    phase: "CHALLENGE",
    kind: "guard",
    failurePolicy: { failureClass: "DOMAIN_REJECTION", retry: false },
  },
  run: runAllAnsweredGuard,
};
