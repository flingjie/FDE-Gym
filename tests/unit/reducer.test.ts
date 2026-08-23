import { describe, expect, it } from "vitest";

import type { RunEvent } from "../../src/core/domain";
import { canonicalRunState, createInitialRunState, reduce } from "../../src/core/reducer";

const text = { "zh-CN": "提示", "en-US": "hint" };

describe("reduce", () => {
  it("starts pristine", () => {
    expect(createInitialRunState("run-1")).toEqual({ runId: "run-1", phase: null, seq: 0 });
  });

  it("run.started anchors the runId and advances seq without setting phase", () => {
    const s = reduce(createInitialRunState("run-1"), {
      type: "run.started",
      runId: "run-1",
      commandId: "c0",
      scenarioId: "s1",
      locale: "zh-CN",
    });
    expect(s).toEqual({ runId: "run-1", phase: null, seq: 1 });
  });

  it("phase.changed sets the phase", () => {
    const s = reduce(createInitialRunState("run-1"), {
      type: "phase.changed",
      runId: "run-1",
      commandId: "c1",
      from: "SCENARIO",
      to: "DISCOVERY",
    });
    expect(s.phase).toBe("DISCOVERY");
    expect(s.seq).toBe(1);
  });

  it("non-transition events advance seq and leave phase untouched", () => {
    const s0 = createInitialRunState("run-1");
    const s1 = reduce(s0, {
      type: "phase.changed",
      runId: "run-1",
      commandId: "c1",
      from: "SCENARIO",
      to: "DISCOVERY",
    });
    const s2 = reduce(s1, {
      type: "question.asked",
      runId: "run-1",
      commandId: "c2",
      questionId: "c2",
      question: "q?",
    });
    expect(s2).toEqual({ runId: "run-1", phase: "DISCOVERY", seq: 2 });
  });
});

describe("deterministic reconstruction", () => {
  const events: RunEvent[] = [
    { type: "run.started", runId: "run-1", commandId: "c0", scenarioId: "s1", locale: "zh-CN" },
    { type: "phase.changed", runId: "run-1", commandId: "c0", from: "SCENARIO", to: "SCENARIO" },
    { type: "phase.changed", runId: "run-1", commandId: "c1", from: "SCENARIO", to: "DISCOVERY" },
    { type: "question.asked", runId: "run-1", commandId: "c2", questionId: "c2", question: "q?" },
    { type: "hint.granted", runId: "run-1", commandId: "c3", topic: "t", level: 2, hint: text },
    { type: "phase.changed", runId: "run-1", commandId: "c4", from: "DISCOVERY", to: "PROBLEM_FRAMING" },
  ];

  it("replays the same sequence to byte-identical canonical state", () => {
    const a = events.reduce(reduce, createInitialRunState("run-1"));
    const b = events.reduce(reduce, createInitialRunState("run-1"));
    expect(canonicalRunState(a)).toBe(canonicalRunState(b));
    expect(canonicalRunState(a)).toBe('{"runId":"run-1","phase":"PROBLEM_FRAMING","seq":6}');
  });

  it("is independent of the replay loop shape", () => {
    let folded = createInitialRunState("run-1");
    for (const event of events) folded = reduce(folded, event);
    const reduced = events.reduce(reduce, createInitialRunState("run-1"));
    expect(canonicalRunState(folded)).toBe(canonicalRunState(reduced));
  });
});
