import { describe, expect, it } from "vitest";

import { validateEventBatch } from "../../src/core/event-batch-validator.js";
import { EVENT_BATCH_INVALID } from "../../src/core/errors.js";
import type { RunEvent } from "../../src/core/domain.js";

/**
 * Event batch validator unit tests (G1-01): an illegal batch is rejected before
 * it can be journaled — mixed run id, an illegal transition, a broken in-batch
 * phase chain, or an event after a terminal phase.
 */

function phase(runId: string, commandId: string, from: string, to: string): RunEvent {
  return { type: "phase.changed", runId, commandId, from: from as never, to: to as never };
}

describe("validateEventBatch", () => {
  it("accepts a legal single-transition batch", () => {
    expect(() =>
      validateEventBatch({
        events: [phase("r", "c", "DISCOVERY", "PROBLEM_FRAMING")],
        expectedRunId: "r",
      }),
    ).not.toThrow();
  });

  it("accepts an empty batch (e.g. start-retry emits no parent events)", () => {
    expect(() => validateEventBatch({ events: [], expectedRunId: "r" })).not.toThrow();
  });

  it("rejects a mixed-run batch", () => {
    const events: RunEvent[] = [
      phase("r", "c", "DISCOVERY", "PROBLEM_FRAMING"),
      { type: "phase.changed", runId: "other", commandId: "c", from: "DISCOVERY", to: "PROBLEM_FRAMING" },
    ];
    expect(() => validateEventBatch({ events, expectedRunId: "r" })).toThrowError(/runId other/);
  });

  it("rejects an illegal transition", () => {
    const events: RunEvent[] = [phase("r", "c", "DISCOVERY", "PITCH")];
    expect(() => validateEventBatch({ events, expectedRunId: "r" })).toThrowError(
      /illegal phase transition DISCOVERY → PITCH/,
    );
  });

  it("rejects a broken in-batch phase chain", () => {
    const events: RunEvent[] = [
      phase("r", "c", "DISCOVERY", "PROBLEM_FRAMING"),
      phase("r", "c", "SOLUTION_DESIGN", "CHALLENGE"), // from != prior to
    ];
    expect(() => validateEventBatch({ events, expectedRunId: "r" })).toThrowError(
      /phase continuity broken/,
    );
  });

  it("rejects an event after a terminal phase within the batch", () => {
    const events: RunEvent[] = [
      phase("r", "c", "REVIEW", "COMPLETED"),
      phase("r", "c", "COMPLETED", "ABORTED"),
    ];
    expect(() => validateEventBatch({ events, expectedRunId: "r" })).toThrowError(/terminal phase/);
  });

  it("throws the stable EVENT_BATCH_INVALID code", () => {
    try {
      validateEventBatch({ events: [phase("r", "c", "DISCOVERY", "PITCH")], expectedRunId: "r" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(EVENT_BATCH_INVALID);
    }
  });
});
