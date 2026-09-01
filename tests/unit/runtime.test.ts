import { describe, expect, it } from "vitest";

import {
  dispatchNode,
  dispatchWithRetry,
  failureCodeOf,
} from "../../src/graph/runtime.js";
import type { NodeHandler } from "../../src/graph/nodes/node.js";

/**
 * Graph runtime dispatch tests (Phase 3 integration): node-level failure
 * tracking and per-failure-class strategy (G3-05/G3-06).
 */

function makeHandler<I>(overrides: Partial<NodeHandler<I>>["definition"] = {}): NodeHandler<I> {
  return {
    definition: { id: "n", phase: "DISCOVERY", kind: "deterministic", ...overrides },
    run: async () => ({ events: [], updatedState: {} as never }),
  };
}

describe("failureCodeOf", () => {
  it("extracts a stable code from a thrown object", () => {
    expect(failureCodeOf({ code: "FRAME_BLOCKED" })).toBe("FRAME_BLOCKED");
  });

  it("falls back to NODE_FAILED for a code-less error", () => {
    expect(failureCodeOf(new Error("boom"))).toBe("NODE_FAILED");
  });
});

describe("dispatchNode", () => {
  it("returns the execution on success", async () => {
    const handler = makeHandler();
    const result = await dispatchNode(handler, undefined, "n", "cmd");
    expect(result.execution).not.toBeNull();
    expect(result.failure).toBeNull();
    expect(result.pending).toBeNull();
  });

  it("classifies a SECURITY_VIOLATION as fail-closed (no pending)", async () => {
    const handler = makeHandler({
      failurePolicy: { failureClass: "SECURITY_VIOLATION", retry: false },
    });
    handler.run = async () => {
      throw { code: "LEAK_GUARD_TRIGGERED" };
    };
    const result = await dispatchNode(handler, undefined, "n", "cmd");
    expect(result.execution).toBeNull();
    expect(result.failure).toMatchObject({ failureClass: "SECURITY_VIOLATION", code: "LEAK_GUARD_TRIGGERED" });
    expect(result.pending).toBeNull();
  });

  it("marks a retryable node pending after its final attempt", async () => {
    const handler = makeHandler({
      failurePolicy: { failureClass: "TRANSIENT_RUNTIME", retry: true, maxAttempts: 3 },
    });
    handler.run = async () => {
      throw { code: "AGENT_TIMEOUT" };
    };
    const result = await dispatchNode(handler, undefined, "customer.invoke", "cmd-ask", 3);
    expect(result.pending).toMatchObject({
      nodeId: "customer.invoke",
      attempt: 3,
      failureClass: "TRANSIENT_RUNTIME",
      failureCode: "AGENT_TIMEOUT",
    });
  });
});

describe("dispatchWithRetry", () => {
  it("succeeds on a later attempt (transient failure)", async () => {
    let calls = 0;
    const handler = makeHandler({
      failurePolicy: { failureClass: "TRANSIENT_RUNTIME", retry: true, maxAttempts: 3 },
    });
    handler.run = async () => {
      calls += 1;
      if (calls < 2) throw { code: "AGENT_TIMEOUT" };
      return { events: [], updatedState: {} as never };
    };
    const result = await dispatchWithRetry(handler, undefined, "n", "cmd");
    expect(result.execution).not.toBeNull();
    expect(calls).toBe(2);
  });

  it("does not retry a fail-closed failure", async () => {
    let calls = 0;
    const handler = makeHandler({
      failurePolicy: { failureClass: "SECURITY_VIOLATION", retry: false },
    });
    handler.run = async () => {
      calls += 1;
      throw { code: "LEAK_GUARD_TRIGGERED" };
    };
    const result = await dispatchWithRetry(handler, undefined, "n", "cmd");
    expect(result.execution).toBeNull();
    expect(calls).toBe(1);
  });
});
