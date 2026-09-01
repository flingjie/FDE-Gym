import type { NodeFailureClass } from "./types.js";

/**
 * FDE Gym — failure policy (Phase 3, G3-05).
 *
 * The runtime's per-failure-class strategy, distilled from the plan's table. A
 * node's declared `FailurePolicy` (in `types.ts`) may override `maxAttempts`, but
 * the DISPOSITION of each failure class is fixed and deterministic.
 */

export type FailureDisposition =
  | "retry"        // bounded retry, then `pending` (resumable)
  | "pending"      // mark the node execution pending, no retry
  | "fail-closed"  // reject immediately, never retry (security)
  | "stay"         // stay in the current business node (domain rejection)
  | "reload";      // reload state; the caller re-sends (concurrency)

export interface ResolvedFailurePolicy {
  failureClass: NodeFailureClass;
  disposition: FailureDisposition;
  /** For `retry`: the maximum number of attempts (1 = one repair). */
  maxAttempts?: number;
}

/**
 * The default policy per failure class. `TRANSIENT_RUNTIME` retries up to 3
 * times before pending; `INVALID_MODEL_OUTPUT` gets a single structural repair;
 * `SECURITY_VIOLATION` never retries (fail closed); `DOMAIN_REJECTION` stays in
 * the node; `CONCURRENCY_CONFLICT` reloads for the caller to re-send.
 */
export const DEFAULT_FAILURE_POLICIES: Readonly<Record<NodeFailureClass, ResolvedFailurePolicy>> = {
  TRANSIENT_RUNTIME: { failureClass: "TRANSIENT_RUNTIME", disposition: "retry", maxAttempts: 3 },
  INVALID_MODEL_OUTPUT: { failureClass: "INVALID_MODEL_OUTPUT", disposition: "retry", maxAttempts: 1 },
  SECURITY_VIOLATION: { failureClass: "SECURITY_VIOLATION", disposition: "fail-closed" },
  DOMAIN_REJECTION: { failureClass: "DOMAIN_REJECTION", disposition: "stay" },
  CONCURRENCY_CONFLICT: { failureClass: "CONCURRENCY_CONFLICT", disposition: "reload" },
};

export function resolveFailurePolicy(failureClass: NodeFailureClass): ResolvedFailurePolicy {
  return DEFAULT_FAILURE_POLICIES[failureClass];
}

/** True when the disposition permits the runtime to retry the node. */
export function isRetryable(policy: ResolvedFailurePolicy): boolean {
  return policy.disposition === "retry";
}
