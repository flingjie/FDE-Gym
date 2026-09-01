import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { RunEvent } from "../../../core/domain.js";
import type { EvidenceTurnResult } from "../../../agents/evidence-tracker.js";
import { applyEvidencePatch } from "../../../evidence/graph.js";

/**
 * `evidence.patch.apply` — apply the Evidence Tracker's patch (deterministic).
 *
 * Applies `applyEvidencePatch` (the SAME function `evidence.patch.guard` checks
 * with) to produce a brand-new graph, authors `evidence.patched`, and folds the
 * new graph into the aggregate. A replayed, fully-absorbed patch is a no-op
 * (the reducer returns the graph unchanged). Throws `EvidenceGraphError` on an
 * invariant violation (the guard has already checked it, so this is
 * defense-in-depth).
 *
 * Protocol: `EVENT_PROTOCOLS.ask` (optional `evidence.patched`).
 */
export interface EvidencePatchApplyInput {
  /** The post-reply aggregate (its graph is the patch's target version). */
  state: RunAggregate;
  evidence: EvidenceTurnResult;
  commandId: string;
}

export async function runEvidencePatchApply(input: EvidencePatchApplyInput): Promise<NodeExecution> {
  const { state, evidence, commandId } = input;
  const nextGraph = applyEvidencePatch(state.graph, evidence.patch);

  const event: RunEvent = {
    type: "evidence.patched",
    runId: state.runId,
    commandId: `${commandId}:evidence`,
    patch: evidence.patch,
  };
  return { events: [event], updatedState: { ...state, graph: nextGraph } };
}

export const evidencePatchApply: NodeHandler<EvidencePatchApplyInput> = {
  definition: {
    id: "evidence.patch.apply",
    phase: "DISCOVERY",
    kind: "deterministic",
    failurePolicy: { failureClass: "DOMAIN_REJECTION", retry: false },
  },
  run: runEvidencePatchApply,
};
