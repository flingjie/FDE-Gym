import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { EvidenceTurnResult } from "../../../agents/evidence-tracker.js";
import { evidencePatchValid, GUARD_IDS } from "../../guards.js";
import { NodeGuardError } from "./shared.js";

/**
 * `evidence.patch.guard` — the `applyEvidencePatch` invariant check (guard).
 *
 * Runs the `evidence-patch-valid` guard (`GUARD_IDS.EVIDENCE_PATCH_VALID`),
 * which calls `applyEvidencePatch` and discards the result — the SAME function
 * `evidence.patch.apply` applies for real. A rejected patch throws a
 * `NodeGuardError` carrying the stable `EvidenceGraphError` code (or
 * `EVIDENCE_PATCH_INVALID`); the runtime maps that throw to the node's
 * `DOMAIN_REJECTION` failure policy.
 *
 * Protocol: `EVENT_PROTOCOLS.ask` (no events authored here).
 */
export interface EvidencePatchGuardInput {
  /** The post-reply aggregate (its graph is the patch's target version). */
  state: RunAggregate;
  evidence: EvidenceTurnResult;
}

export async function runEvidencePatchGuard(input: EvidencePatchGuardInput): Promise<NodeExecution> {
  const { state, evidence } = input;
  const result = evidencePatchValid(state.graph, evidence.patch);
  if (!result.ok) {
    throw new NodeGuardError(
      result.code,
      `evidence patch rejected by guard ${GUARD_IDS.EVIDENCE_PATCH_VALID}: ${result.code}`,
    );
  }
  return { events: [], updatedState: state };
}

export const evidencePatchGuard: NodeHandler<EvidencePatchGuardInput> = {
  definition: {
    id: "evidence.patch.guard",
    phase: "DISCOVERY",
    kind: "guard",
    failurePolicy: { failureClass: "DOMAIN_REJECTION", retry: false },
  },
  run: runEvidencePatchGuard,
};
