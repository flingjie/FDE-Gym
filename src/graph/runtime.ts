import type { NodeHandler, NodeExecution } from "./nodes/node.js";
import { resolveFailurePolicy } from "./failure.js";
import type { PendingNodeExecution } from "./pending.js";
import type { NodeFailureClass, NodeId } from "./types.js";
import type { TelemetryCollector } from "../telemetry/collector.js";

/**
 * FDE Gym — graph runtime dispatch (Phase 3 integration).
 *
 * The plumbing that turns a `NodeHandler` + input into a dispatched outcome:
 * run the node, and on failure classify it by the node's declared failure class,
 * resolve the disposition (`retry` / `pending` / `fail-closed` / `stay` /
 * `reload`), and produce a resumable `PendingNodeExecution` when a retryable
 * node exhausts its attempts. This is the runtime's node-level failure tracking
 * and per-failure strategy (the plan's G3-05/G3-06), ready to be wired into the
 * orchestrator's command flow.
 *
 * Deterministic apart from the handler's own (agent) work. Telemetry (Phase 4)
 * is optional and observation-only: when a collector is supplied, a `NodeSpan`
 * is emitted per attempt; the wall-clock timing is skipped entirely when no
 * collector is present, so the deterministic path never reads the clock.
 */

export interface DispatchFailure {
  nodeId: NodeId;
  failureClass: NodeFailureClass;
  code: string;
  attempt: number;
}

export interface DispatchResult {
  execution: NodeExecution | null;
  failure: DispatchFailure | null;
  pending: PendingNodeExecution | null;
}

/** Optional telemetry context for a dispatch (omitted → no spans, no wall-clock). */
export interface DispatchTelemetry {
  collector: TelemetryCollector;
  runId: string;
  graphVersion?: string;
}

/** Extract a stable machine-readable code from a thrown value (never the message). */
export function failureCodeOf(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "NODE_FAILED";
}

/**
 * Dispatch a node once. On success returns the execution; on failure it classifies
 * the error and, when the node's failure class is retryable and this was the
 * final allowed attempt, produces a `pending` marker (resumable=false — the node
 * did not commit its events).
 */
export async function dispatchNode<I>(
  handler: NodeHandler<I>,
  input: I,
  nodeId: NodeId,
  commandId: string,
  attempt = 1,
  telemetry?: DispatchTelemetry,
): Promise<DispatchResult> {
  const failureClass: NodeFailureClass = handler.definition.failurePolicy?.failureClass ?? "TRANSIENT_RUNTIME";
  const start = telemetry ? Date.now() : 0;
  let result: DispatchResult;
  try {
    const execution = await handler.run(input);
    result = { execution, failure: null, pending: null };
  } catch (error) {
    const code = failureCodeOf(error);
    const resolved = resolveFailurePolicy(failureClass);
    const pending: PendingNodeExecution | null =
      resolved.disposition === "retry" && attempt >= (resolved.maxAttempts ?? 1)
        ? { nodeId, commandId, attempt, failureClass, failureCode: code, resumable: false }
        : null;
    result = { execution: null, failure: { nodeId, failureClass, code, attempt }, pending };
  }
  if (telemetry) {
    telemetry.collector.recordNodeSpan({
      graphVersion: telemetry.graphVersion ?? "unknown",
      runId: telemetry.runId,
      commandId,
      nodeId,
      attempt,
      outcome: result.execution ? "success" : result.pending ? "pending" : "failure",
      failureClass: result.failure?.failureClass,
      failureCode: result.failure?.code,
      durationMs: Date.now() - start,
    });
  }
  return result;
}

/**
 * Dispatch a node, retrying a retryable failure up to its policy's max attempts.
 * Returns the first success, or the terminal failure/pending after exhaustion.
 * Each attempt emits its own node span when telemetry is supplied.
 */
export async function dispatchWithRetry<I>(
  handler: NodeHandler<I>,
  input: I,
  nodeId: NodeId,
  commandId: string,
  telemetry?: DispatchTelemetry,
): Promise<DispatchResult> {
  const policy = resolveFailurePolicy(handler.definition.failurePolicy?.failureClass ?? "TRANSIENT_RUNTIME");
  const maxAttempts = policy.disposition === "retry" ? (policy.maxAttempts ?? 1) : 1;
  let last: DispatchResult = { execution: null, failure: null, pending: null };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await dispatchNode(handler, input, nodeId, commandId, attempt, telemetry);
    if (last.execution) return last;
  }
  return last;
}
