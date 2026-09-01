import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { RunEvent } from "../../../core/domain.js";
import {
  EVIDENCE_EXTRACTION_FAILED,
  normalizeFailure,
  type PendingEvidence,
} from "./shared.js";

/**
 * `evidence.pending` — the Evidence Tracker failure branch (deterministic).
 *
 * The catch block of the ask turn: when `evidence.invoke` throws, the customer
 * reply is RETAINED and the turn is marked pending with the durable
 * `evidence.pending` event. Only the STABLE learner-visible code
 * (`EVIDENCE_EXTRACTION_FAILED`) is persisted — never the thrown error's
 * internal failure-mode code (e.g. `LEAK_GUARD_TRIGGERED`). Mirrors the catch
 * block of `prepareDiscoveryTurn`.
 *
 * Protocol: `EVENT_PROTOCOLS.ask` (optional `evidence.pending`; replaces
 * `evidence.patched`/`question.assessed` on this branch).
 */
export interface EvidencePendingInput {
  /** The post-reply aggregate (the customer reply is retained). */
  state: RunAggregate;
  commandId: string;
  /** The error thrown by `evidence.invoke` / `extractEvidence`. */
  error: unknown;
}

export interface EvidencePendingResult extends NodeExecution {
  /** The in-memory pending marker (also foldable from the event on resume). */
  pendingEvidence: PendingEvidence;
}

export async function runEvidencePending(input: EvidencePendingInput): Promise<EvidencePendingResult> {
  const { state, commandId, error } = input;
  const failure = normalizeFailure(error);

  const pending: PendingEvidence = {
    turnId: `${commandId}:turn`,
    code: EVIDENCE_EXTRACTION_FAILED,
    message: failure.message,
  };
  const event: RunEvent = {
    type: "evidence.pending",
    runId: state.runId,
    commandId: `${commandId}:evidence-pending`,
    turnId: `${commandId}:turn`,
    failureCode: EVIDENCE_EXTRACTION_FAILED,
  };
  return { events: [event], updatedState: state, pendingEvidence: pending };
}

export const evidencePending: NodeHandler<EvidencePendingInput> = {
  definition: {
    id: "evidence.pending",
    phase: "DISCOVERY",
    kind: "deterministic",
  },
  run: runEvidencePending,
};
