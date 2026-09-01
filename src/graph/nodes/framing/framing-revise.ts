import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";

/**
 * `framing.revise` — the reject self-loop terminal (deterministic).
 *
 * The "重新整理" (re-frame) outcome of a `submit-brief` rejection: the run STAYS
 * in PROBLEM_FRAMING with no `phase.changed`. The rejection's `brief.validated`
 * (passed=false) was already authored by `brief.support.guard`; this node is the
 * distinct terminal the runtime routes to so the two failure edges cannot be
 * conflated — `framing.revise` (re-frame) vs `discovery.clarify` (return to
 * exploration).
 *
 * Protocol: `EVENT_PROTOCOLS["submit-brief"]` (the `phase.changed` is absent by
 * design here).
 */
export interface FramingReviseInput {
  /** Still PROBLEM_FRAMING. */
  state: RunAggregate;
}

export async function runFramingRevise(input: FramingReviseInput): Promise<NodeExecution> {
  return { events: [], updatedState: input.state };
}

export const framingRevise: NodeHandler<FramingReviseInput> = {
  definition: { id: "framing.revise", phase: "PROBLEM_FRAMING", kind: "deterministic" },
  run: runFramingRevise,
};
