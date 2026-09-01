import type { NodeFailureClass, NodeId } from "./types.js";

/**
 * FDE Gym — pending node execution (Phase 3, G3-06).
 *
 * A durable marker for a node execution that failed and may be resumed. The
 * first version allows AT MOST ONE pending execution per run (a single
 * in-flight failure point), mirroring the existing single `pendingEvidence`
 * marker. It records which node failed, under which command, on which attempt,
 * with a stable failure code — never the thrown message or hidden content.
 */
export interface PendingNodeExecution {
  nodeId: NodeId;
  commandId: string;
  attempt: number;
  failureClass: NodeFailureClass;
  failureCode: string;
  /** True when a committed node may be resumed WITHOUT re-invoking a model. */
  resumable: boolean;
}

/**
 * The single-slot fold. `setPendingExecution` replaces the (at most one) pending
 * execution with `next` — setting it on a failure, or clearing it (`null`) on a
 * successful resume. Deterministic and side-effect-free.
 */
export function setPendingExecution(
  _current: PendingNodeExecution | null,
  next: PendingNodeExecution | null,
): PendingNodeExecution | null {
  return next;
}

/** True when there is a pending execution that may be resumed without a model call. */
export function isResumable(pending: PendingNodeExecution | null): boolean {
  return pending !== null && pending.resumable;
}
