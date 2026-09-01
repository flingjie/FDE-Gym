import { describe, expect, it } from "vitest";

import { InMemoryCollector } from "../../src/telemetry/collector.js";
import { aggregateNodeMetrics } from "../../src/telemetry/metrics.js";
import type { NodeSpan } from "../../src/telemetry/types.js";
import { dispatchNode, dispatchWithRetry } from "../../src/graph/runtime.js";
import type { NodeHandler } from "../../src/graph/nodes/node.js";

/**
 * Telemetry tests (Phase 4): the collector records node spans, the metrics
 * projection aggregates them deterministically, and the runtime dispatcher emits
 * a span per attempt when (and only when) a collector is supplied.
 */

function span(overrides: Partial<NodeSpan>): NodeSpan {
  return {
    graphVersion: "1",
    runId: "run-1",
    commandId: "cmd-1",
    nodeId: "n",
    attempt: 1,
    outcome: "success",
    durationMs: 10,
    ...overrides,
  };
}

describe("aggregateNodeMetrics (G4-04)", () => {
  it("counts outcomes and computes percentiles/tokens", () => {
    const metrics = aggregateNodeMetrics([
      span({ outcome: "success", durationMs: 10, tokenUsage: { input: 100, output: 50 } }),
      span({ outcome: "success", durationMs: 20, tokenUsage: { input: 200, output: 100 } }),
      span({ outcome: "failure", durationMs: 30, failureClass: "INVALID_MODEL_OUTPUT", failureCode: "AGENT_OUTPUT_INVALID" }),
      span({ outcome: "pending", durationMs: 40 }),
    ]);
    expect(metrics.total).toBe(4);
    expect(metrics.success).toBe(2);
    expect(metrics.failure).toBe(1);
    expect(metrics.pending).toBe(1);
    expect(metrics.p50DurationMs).toBe(20);
    expect(metrics.p95DurationMs).toBe(40);
    expect(metrics.invalidOutputCount).toBe(1);
    expect(metrics.totalInputTokens).toBe(300);
    expect(metrics.totalOutputTokens).toBe(150);
    expect(metrics.maxDurationMs).toBe(40);
  });

  it("counts retries by attempt > 1", () => {
    const metrics = aggregateNodeMetrics([
      span({ attempt: 1, outcome: "failure" }),
      span({ attempt: 2, outcome: "success" }),
      span({ attempt: 3, outcome: "success" }),
    ]);
    expect(metrics.retryCount).toBe(2);
  });

  it("returns zeroes for an empty span set", () => {
    const metrics = aggregateNodeMetrics([]);
    expect(metrics).toMatchObject({ total: 0, p50DurationMs: 0, p95DurationMs: 0, maxDurationMs: 0 });
  });
});

describe("InMemoryCollector", () => {
  it("records node and edge spans", () => {
    const collector = new InMemoryCollector();
    const node = span({});
    collector.recordNodeSpan(node);
    collector.recordEdgeSpan({ graphVersion: "1", runId: "run-1", commandId: "cmd-1", edgeId: "e1", action: "ask", from: "a", to: "b" });
    expect(collector.nodeSpans).toEqual([node]);
    expect(collector.edgeSpans).toHaveLength(1);
  });
});

describe("dispatch telemetry (G4-01)", () => {
  const handler: NodeHandler<undefined> = {
    definition: { id: "n", phase: "DISCOVERY", kind: "deterministic" },
    run: async () => ({ events: [], updatedState: {} as never }),
  };

  it("emits a success node span when a collector is supplied", async () => {
    const collector = new InMemoryCollector();
    const result = await dispatchNode(handler, undefined, "n", "cmd", 1, { collector, runId: "run-1", graphVersion: "1" });
    expect(result.execution).not.toBeNull();
    expect(collector.nodeSpans).toHaveLength(1);
    expect(collector.nodeSpans[0]).toMatchObject({
      nodeId: "n",
      commandId: "cmd",
      attempt: 1,
      outcome: "success",
      graphVersion: "1",
      runId: "run-1",
    });
  });

  it("emits a failure span with the classified failure class", async () => {
    const collector = new InMemoryCollector();
    const failing: NodeHandler<undefined> = {
      definition: { id: "n", phase: "DISCOVERY", kind: "agent", failurePolicy: { failureClass: "SECURITY_VIOLATION", retry: false } },
      run: async () => {
        throw { code: "LEAK_GUARD_TRIGGERED" };
      },
    };
    await dispatchNode(failing, undefined, "n", "cmd", 1, { collector, runId: "run-1" });
    expect(collector.nodeSpans[0]).toMatchObject({
      outcome: "failure",
      failureClass: "SECURITY_VIOLATION",
      failureCode: "LEAK_GUARD_TRIGGERED",
    });
  });

  it("records one span per retry attempt", async () => {
    const collector = new InMemoryCollector();
    let calls = 0;
    const flaky: NodeHandler<undefined> = {
      definition: { id: "n", phase: "DISCOVERY", kind: "agent", failurePolicy: { failureClass: "TRANSIENT_RUNTIME", retry: true, maxAttempts: 2 } },
      run: async () => {
        calls += 1;
        if (calls < 2) throw { code: "AGENT_TIMEOUT" };
        return { events: [], updatedState: {} as never };
      },
    };
    await dispatchWithRetry(flaky, undefined, "n", "cmd", { collector, runId: "run-1" });
    expect(collector.nodeSpans).toHaveLength(2);
    expect(collector.nodeSpans.map((span) => span.attempt)).toEqual([1, 2]);
    expect(collector.nodeSpans.map((span) => span.outcome)).toEqual(["failure", "success"]);
  });
});
