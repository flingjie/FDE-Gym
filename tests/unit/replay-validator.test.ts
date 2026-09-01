import { describe, expect, it } from "vitest";

import { validatePhaseContinuity } from "../../src/graph/replay-validator.js";
import { REPLAY_INVALID } from "../../src/core/errors.js";
import type { RunEvent } from "../../src/core/domain.js";

/**
 * Strict replay validation unit tests (G1-02): an illegal committed log must
 * fail closed — broken phase continuity, an illegal transition, or an event
 * after a terminal phase all throw `REPLAY_INVALID`.
 */

const start = (runId: string, commandId: string): RunEvent[] => [
  { type: "run.started", runId, commandId, scenarioId: "scn-1", locale: "zh-CN" },
  { type: "phase.changed", runId, commandId, from: "SCENARIO", to: "SCENARIO" },
  { type: "phase.changed", runId, commandId: `${commandId}:accept`, from: "SCENARIO", to: "DISCOVERY" },
];

function frame(runId: string, commandId: string): RunEvent {
  return { type: "phase.changed", runId, commandId, from: "DISCOVERY", to: "PROBLEM_FRAMING" };
}

describe("validatePhaseContinuity", () => {
  it("accepts a valid start → discovery → framing path", () => {
    expect(() => validatePhaseContinuity([...start("r", "c"), frame("r", "c:f")])).not.toThrow();
  });

  it("accepts an empty stream", () => {
    expect(() => validatePhaseContinuity([])).not.toThrow();
  });

  it("rejects broken continuity (a phase.changed whose from != running phase)", () => {
    const events: RunEvent[] = [
      ...start("r", "c"),
      { type: "phase.changed", runId: "r", commandId: "c:x", from: "PROBLEM_FRAMING", to: "SOLUTION_DESIGN" },
    ];
    expect(() => validatePhaseContinuity(events)).toThrowError(/phase continuity broken/);
  });

  it("rejects an illegal transition not in PHASE_TRANSITIONS", () => {
    const events: RunEvent[] = [
      ...start("r", "c"),
      { type: "phase.changed", runId: "r", commandId: "c:x", from: "DISCOVERY", to: "PITCH" },
    ];
    expect(() => validatePhaseContinuity(events)).toThrowError(/illegal phase transition DISCOVERY → PITCH/);
  });

  it("rejects an event after a terminal phase", () => {
    const events: RunEvent[] = [
      ...start("r", "c"),
      { type: "phase.changed", runId: "r", commandId: "c:f", from: "DISCOVERY", to: "PROBLEM_FRAMING" },
      { type: "phase.changed", runId: "r", commandId: "c:b", from: "PROBLEM_FRAMING", to: "SOLUTION_DESIGN" },
      { type: "phase.changed", runId: "r", commandId: "c:d", from: "SOLUTION_DESIGN", to: "CHALLENGE" },
      { type: "phase.changed", runId: "r", commandId: "c:ch", from: "CHALLENGE", to: "PITCH" },
      { type: "phase.changed", runId: "r", commandId: "c:p", from: "PITCH", to: "REVIEW" },
      { type: "phase.changed", runId: "r", commandId: "c:done", from: "REVIEW", to: "COMPLETED" },
      // terminal-after: any further event is illegal
      { type: "phase.changed", runId: "r", commandId: "c:z", from: "COMPLETED", to: "ABORTED" },
    ];
    expect(() => validatePhaseContinuity(events)).toThrowError(/terminal phase/);
  });

  it("throws the stable REPLAY_INVALID code", () => {
    const events: RunEvent[] = [
      ...start("r", "c"),
      { type: "phase.changed", runId: "r", commandId: "c:x", from: "PROBLEM_FRAMING", to: "SOLUTION_DESIGN" },
    ];
    try {
      validatePhaseContinuity(events);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(REPLAY_INVALID);
    }
  });
});
