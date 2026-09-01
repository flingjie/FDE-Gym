import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { RunEvent } from "../../../core/domain.js";
import { assertCommandPhase } from "../../../core/state-machine.js";

/**
 * `discovery.question.accept` — the DISCOVERY ask gate (guard).
 *
 * Asserts the run is in DISCOVERY via `assertCommandPhase(state.phase, "ask")`
 * (throws `INVALID_PHASE_COMMAND` otherwise), then authors `question.asked` and
 * stows `pendingQuestion` on the aggregate. Mirrors step 1 of
 * `prepareDiscoveryTurn` without importing the orchestrator.
 *
 * Protocol: `EVENT_PROTOCOLS.ask` (required `question.asked` + `customer.replied`).
 */
export interface QuestionAcceptInput {
  state: RunAggregate;
  question: string;
  stakeholderId: string;
  commandId: string;
}

export async function runQuestionAccept(input: QuestionAcceptInput): Promise<NodeExecution> {
  const { state, question, stakeholderId, commandId } = input;
  assertCommandPhase(state.phase, "ask");

  const event: RunEvent = {
    type: "question.asked",
    runId: state.runId,
    commandId,
    questionId: commandId,
    question,
  };
  const updatedState: RunAggregate = {
    ...state,
    pendingQuestion: { question, stakeholderId },
  };
  return { events: [event], updatedState };
}

export const questionAccept: NodeHandler<QuestionAcceptInput> = {
  definition: {
    id: "discovery.question.accept",
    phase: "DISCOVERY",
    kind: "guard",
    failurePolicy: { failureClass: "DOMAIN_REJECTION", retry: false },
  },
  run: runQuestionAccept,
};
