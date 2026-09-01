import { describe, expect, it } from "vitest";

import {
  DEFAULT_FAILURE_POLICIES,
  isRetryable,
  resolveFailurePolicy,
} from "../../src/graph/failure.js";
import { isResumable, setPendingExecution, type PendingNodeExecution } from "../../src/graph/pending.js";
import type { NodeFailureClass } from "../../src/graph/types.js";

describe("failure policy (G3-05)", () => {
  it("retries TRANSIENT_RUNTIME (bounded), then pending", () => {
    const policy = resolveFailurePolicy("TRANSIENT_RUNTIME");
    expect(policy.disposition).toBe("retry");
    expect(policy.maxAttempts).toBe(3);
    expect(isRetryable(policy)).toBe(true);
  });

  it("gives INVALID_MODEL_OUTPUT a single structural repair", () => {
    const policy = resolveFailurePolicy("INVALID_MODEL_OUTPUT");
    expect(policy.disposition).toBe("retry");
    expect(policy.maxAttempts).toBe(1);
  });

  it("never retries SECURITY_VIOLATION (fail closed)", () => {
    const policy = resolveFailurePolicy("SECURITY_VIOLATION");
    expect(policy.disposition).toBe("fail-closed");
    expect(isRetryable(policy)).toBe(false);
  });

  it("stays in the node on DOMAIN_REJECTION", () => {
    expect(resolveFailurePolicy("DOMAIN_REJECTION").disposition).toBe("stay");
  });

  it("reloads on CONCURRENCY_CONFLICT", () => {
    expect(resolveFailurePolicy("CONCURRENCY_CONFLICT").disposition).toBe("reload");
  });

  it("defines a policy for every failure class", () => {
    const classes: NodeFailureClass[] = [
      "TRANSIENT_RUNTIME",
      "INVALID_MODEL_OUTPUT",
      "SECURITY_VIOLATION",
      "DOMAIN_REJECTION",
      "CONCURRENCY_CONFLICT",
    ];
    for (const cls of classes) {
      expect(DEFAULT_FAILURE_POLICIES[cls], cls).toBeDefined();
    }
  });
});

describe("pending node execution (G3-06)", () => {
  const pending: PendingNodeExecution = {
    nodeId: "customer.invoke",
    commandId: "cmd-ask",
    attempt: 2,
    failureClass: "TRANSIENT_RUNTIME",
    failureCode: "AGENT_TIMEOUT",
    resumable: true,
  };

  it("holds at most one pending execution (single slot)", () => {
    expect(setPendingExecution(null, pending)).toBe(pending);
    expect(setPendingExecution(pending, null)).toBe(null);
    const other = { ...pending, nodeId: "evidence.invoke" };
    expect(setPendingExecution(pending, other)).toBe(other);
  });

  it("reports resumability", () => {
    expect(isResumable(pending)).toBe(true);
    expect(isResumable({ ...pending, resumable: false })).toBe(false);
    expect(isResumable(null)).toBe(false);
  });
});
