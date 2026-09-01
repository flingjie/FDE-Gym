import { ZodError } from "zod";

import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import { ProblemBriefSchema, type ProblemBrief, type RunEvent } from "../../../core/domain.js";
import { assertCommandPhase } from "../../../core/state-machine.js";
import { BRIEF_STRUCTURE_INVALID } from "../../guards.js";
import { FRAMING_BRIEF_NOT_PROVIDED, NodeGuardError, zodEvidence } from "./shared.js";

/**
 * `brief.accept` — the submit-brief entry gate (guard).
 *
 * Asserts the run is in PROBLEM_FRAMING (`assertCommandPhase(state.phase,
 * "submit-brief")`, which throws `INVALID_PHASE_COMMAND` otherwise), rejects a
 * missing brief, and defense-in-depth schema-validates the brief before it is
 * persisted. On pass it authors `brief.submitted` and folds `brief` onto the
 * aggregate. Mirrors the top of `prepareFramingGate` without importing the
 * orchestrator.
 *
 * Protocol: `EVENT_PROTOCOLS["submit-brief"]` (`brief.submitted` here; the
 * verdict + optional `phase.changed` are authored downstream).
 */
export interface BriefAcceptInput {
  state: RunAggregate;
  /** The submitted brief; `null` models "no brief provided". */
  brief: ProblemBrief | null;
  commandId: string;
}

export async function runBriefAccept(input: BriefAcceptInput): Promise<NodeExecution> {
  const { state, brief, commandId } = input;

  assertCommandPhase(state.phase, "submit-brief");

  if (brief === null) {
    throw new NodeGuardError(FRAMING_BRIEF_NOT_PROVIDED, "submit-brief requires a problem brief");
  }

  // Defense-in-depth: the brief must satisfy the strict schema before it is
  // persisted as `brief.submitted` (mirrors `ProblemBriefSchema.parse`).
  try {
    ProblemBriefSchema.parse(brief);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new NodeGuardError(BRIEF_STRUCTURE_INVALID, "brief failed schema validation", zodEvidence(error));
    }
    throw new NodeGuardError(BRIEF_STRUCTURE_INVALID, "brief failed schema validation");
  }

  const event: RunEvent = { type: "brief.submitted", runId: state.runId, commandId, brief };
  return { events: [event], updatedState: { ...state, brief } };
}

export const briefAccept: NodeHandler<BriefAcceptInput> = {
  definition: {
    id: "brief.accept",
    phase: "PROBLEM_FRAMING",
    kind: "guard",
    failurePolicy: { failureClass: "DOMAIN_REJECTION", retry: false },
  },
  run: runBriefAccept,
};
