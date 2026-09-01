import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { RunEvent } from "../../../core/domain.js";
import { assertCommandPhase } from "../../../core/state-machine.js";
import {
  CLARIFICATION_BUDGET_EXCEEDED,
  DEFAULT_CLARIFICATION_BUDGET,
  clarificationBudgetAvailable,
} from "../../guards.js";
import { NodeGuardError } from "./shared.js";

/**
 * `discovery.clarify` — the clarify back-edge to DISCOVERY (deterministic).
 *
 * The "返回探索" (return to exploration) edge: gated by the
 * `clarification-budget-available` guard (`GUARD_IDS.CLARIFICATION_BUDGET_
 * AVAILABLE`), which throws `CLARIFICATION_BUDGET_EXCEEDED` when the caller-
 * managed budget is exhausted; the phase guard (`assertCommandPhase(state.phase,
 * "clarify")`) then enforces PROBLEM_FRAMING. On pass it authors `phase.changed`
 * (PROBLEM_FRAMING → DISCOVERY) and consumes one clarification from the budget.
 * Mirrors `prepareClarification` without importing the orchestrator.
 *
 * Protocol: `EVENT_PROTOCOLS.clarify` (`phase.changed` required).
 */
export interface DiscoveryClarifyInput {
  state: RunAggregate;
  commandId: string;
  /** Overrides `state.clarificationBudgetUsed` when supplied. */
  clarificationBudgetUsed?: number;
  clarificationBudgetLimit?: number;
}

export async function runDiscoveryClarify(input: DiscoveryClarifyInput): Promise<NodeExecution> {
  const { state, commandId } = input;
  const limit = input.clarificationBudgetLimit ?? DEFAULT_CLARIFICATION_BUDGET;
  const used = input.clarificationBudgetUsed ?? state.clarificationBudgetUsed ?? 0;

  // Mirrors `prepareClarification`: the budget gate precedes the phase guard.
  const budget = clarificationBudgetAvailable(used, limit);
  if (!budget.ok) {
    throw new NodeGuardError(
      CLARIFICATION_BUDGET_EXCEEDED,
      `clarification budget exhausted (limit ${limit})`,
    );
  }
  assertCommandPhase(state.phase, "clarify");

  const events: RunEvent[] = [
    { type: "phase.changed", runId: state.runId, commandId, from: "PROBLEM_FRAMING", to: "DISCOVERY" },
  ];
  return {
    events,
    updatedState: { ...state, phase: "DISCOVERY", clarificationBudgetUsed: used + 1 },
  };
}

export const discoveryClarify: NodeHandler<DiscoveryClarifyInput> = {
  definition: { id: "discovery.clarify", phase: "PROBLEM_FRAMING", kind: "deterministic" },
  run: runDiscoveryClarify,
};
