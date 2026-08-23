import { describe, expect, it } from "vitest";

import type { RunCommand, RunPhase } from "../../src/core/domain";
import {
  INVALID_PHASE_COMMAND,
  RUN_ALREADY_EXISTS,
  InvalidPhaseCommandError,
  RunAlreadyExistsError,
} from "../../src/core/errors";
import type { RunState } from "../../src/core/reducer";
import { decide } from "../../src/core/state-machine";

const RUN_ID = "run-1";

function state(phase: RunPhase | null, seq = 0): RunState {
  return { runId: RUN_ID, phase, seq };
}

/**
 * Payload-bearing commands (submit-brief, submit-design, respond-challenge,
 * submit-pitch) are schema-validated by Task 2's domain tests; decide() ignores
 * their payload for the Task 4 phase-changed collapse, so a cast is honest here.
 */
function payloadCommand(type: RunCommand["type"], commandId: string): RunCommand {
  return { type, commandId } as unknown as RunCommand;
}

describe("decide: transition table (happy path)", () => {
  it("start creates the run with run.started + phase.changed to SCENARIO", () => {
    const events = decide(state(null), {
      type: "start",
      commandId: "c0",
      scenarioId: "s1",
      locale: "zh-CN",
    });
    expect(events).toEqual([
      { type: "run.started", runId: RUN_ID, commandId: "c0", scenarioId: "s1", locale: "zh-CN" },
      { type: "phase.changed", runId: RUN_ID, commandId: "c0", from: "SCENARIO", to: "SCENARIO" },
    ]);
  });

  it("accept: SCENARIO -> DISCOVERY", () => {
    expect(decide(state("SCENARIO"), { type: "accept", commandId: "c1" })).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c1", from: "SCENARIO", to: "DISCOVERY" },
    ]);
  });

  it("frame: DISCOVERY -> PROBLEM_FRAMING", () => {
    expect(decide(state("DISCOVERY"), { type: "frame", commandId: "c2" })).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c2", from: "DISCOVERY", to: "PROBLEM_FRAMING" },
    ]);
  });

  it("submit-brief (brief-passed): PROBLEM_FRAMING -> SOLUTION_DESIGN", () => {
    expect(decide(state("PROBLEM_FRAMING"), payloadCommand("submit-brief", "c3"))).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c3", from: "PROBLEM_FRAMING", to: "SOLUTION_DESIGN" },
    ]);
  });

  it("submit-design (design-submitted): SOLUTION_DESIGN -> CHALLENGE", () => {
    expect(decide(state("SOLUTION_DESIGN"), payloadCommand("submit-design", "c4"))).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c4", from: "SOLUTION_DESIGN", to: "CHALLENGE" },
    ]);
  });

  it("respond-challenge (challenges-addressed): CHALLENGE -> PITCH", () => {
    expect(decide(state("CHALLENGE"), payloadCommand("respond-challenge", "c5"))).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c5", from: "CHALLENGE", to: "PITCH" },
    ]);
  });

  it("submit-pitch (pitch-submitted): PITCH -> REVIEW", () => {
    expect(decide(state("PITCH"), payloadCommand("submit-pitch", "c6"))).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c6", from: "PITCH", to: "REVIEW" },
    ]);
  });

  it("retry: REVIEW -> RETRY_READY", () => {
    expect(decide(state("REVIEW"), { type: "retry", commandId: "c7" })).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c7", from: "REVIEW", to: "RETRY_READY" },
    ]);
  });

  it("start-retry: RETRY_READY -> DISCOVERY", () => {
    expect(decide(state("RETRY_READY"), { type: "start-retry", commandId: "c8" })).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c8", from: "RETRY_READY", to: "DISCOVERY" },
    ]);
  });

  it("complete: REVIEW -> COMPLETED (with run.completed marker)", () => {
    expect(decide(state("REVIEW"), { type: "complete", commandId: "c9" })).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c9", from: "REVIEW", to: "COMPLETED" },
      { type: "run.completed", runId: RUN_ID, commandId: "c9" },
    ]);
  });

  it("abort: any active phase -> ABORTED (with run.aborted marker)", () => {
    const active: RunPhase[] = [
      "SCENARIO",
      "DISCOVERY",
      "PROBLEM_FRAMING",
      "SOLUTION_DESIGN",
      "CHALLENGE",
      "PITCH",
      "REVIEW",
      "RETRY_READY",
    ];
    for (const phase of active) {
      const commandId = "abort-" + phase;
      expect(decide(state(phase), { type: "abort", commandId })).toEqual([
        { type: "phase.changed", runId: RUN_ID, commandId, from: phase, to: "ABORTED" },
        { type: "run.aborted", runId: RUN_ID, commandId },
      ]);
    }
  });

  it("abort carries the optional reason when provided", () => {
    const events = decide(state("DISCOVERY"), {
      type: "abort",
      commandId: "cAbort",
      reason: "learner quit",
    });
    expect(events[1]).toEqual({
      type: "run.aborted",
      runId: RUN_ID,
      commandId: "cAbort",
      reason: "learner quit",
    });
  });
});

describe("decide: per-phase non-transition commands", () => {
  it("ask in DISCOVERY -> question.asked", () => {
    expect(decide(state("DISCOVERY"), { type: "ask", commandId: "c10", question: "how many alerts?" })).toEqual([
      { type: "question.asked", runId: RUN_ID, commandId: "c10", questionId: "c10", question: "how many alerts?" },
    ]);
  });

  it("hint in DISCOVERY and PROBLEM_FRAMING -> hint.granted", () => {
    for (const phase of ["DISCOVERY", "PROBLEM_FRAMING"] as RunPhase[]) {
      const events = decide(state(phase), {
        type: "hint",
        commandId: "hint-" + phase,
        topic: "workflow",
        level: 2,
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("hint.granted");
      expect(events[0]).toMatchObject({
        runId: RUN_ID,
        commandId: "hint-" + phase,
        topic: "workflow",
        level: 2,
      });
    }
  });

  it("clarify in PROBLEM_FRAMING -> back to DISCOVERY", () => {
    expect(decide(state("PROBLEM_FRAMING"), { type: "clarify", commandId: "c11" })).toEqual([
      { type: "phase.changed", runId: RUN_ID, commandId: "c11", from: "PROBLEM_FRAMING", to: "DISCOVERY" },
    ]);
  });

  it("review in REVIEW is accepted and emits no event yet (Task 9 adds review.completed)", () => {
    expect(decide(state("REVIEW"), { type: "review", commandId: "c12" })).toEqual([]);
  });
});

describe("decide: illegal commands", () => {
  const cases: Array<{ name: string; phase: RunPhase | null; command: RunCommand }> = [
    { name: "accept outside SCENARIO", phase: "DISCOVERY", command: { type: "accept", commandId: "x" } },
    { name: "frame outside DISCOVERY", phase: "SCENARIO", command: { type: "frame", commandId: "x" } },
    { name: "ask outside DISCOVERY", phase: "PROBLEM_FRAMING", command: { type: "ask", commandId: "x", question: "q?" } },
    { name: "submit-brief outside PROBLEM_FRAMING", phase: "DISCOVERY", command: payloadCommand("submit-brief", "x") },
    { name: "clarify outside PROBLEM_FRAMING", phase: "DISCOVERY", command: { type: "clarify", commandId: "x" } },
    { name: "submit-design outside SOLUTION_DESIGN", phase: "PROBLEM_FRAMING", command: payloadCommand("submit-design", "x") },
    { name: "respond-challenge outside CHALLENGE", phase: "SOLUTION_DESIGN", command: payloadCommand("respond-challenge", "x") },
    { name: "submit-pitch outside PITCH", phase: "CHALLENGE", command: payloadCommand("submit-pitch", "x") },
    { name: "review outside REVIEW", phase: "PITCH", command: { type: "review", commandId: "x" } },
    { name: "retry outside REVIEW", phase: "PITCH", command: { type: "retry", commandId: "x" } },
    { name: "start-retry outside RETRY_READY", phase: "REVIEW", command: { type: "start-retry", commandId: "x" } },
    { name: "complete outside REVIEW", phase: "PITCH", command: { type: "complete", commandId: "x" } },
    { name: "accept before start", phase: null, command: { type: "accept", commandId: "x" } },
    { name: "abort before start", phase: null, command: { type: "abort", commandId: "x" } },
    { name: "abort after completed", phase: "COMPLETED", command: { type: "abort", commandId: "x" } },
    { name: "abort after aborted", phase: "ABORTED", command: { type: "abort", commandId: "x" } },
  ];

  it.each(cases)("$name throws INVALID_PHASE_COMMAND and emits no event", ({ phase, command }) => {
    expect(() => decide(state(phase), command)).toThrow(InvalidPhaseCommandError);
    try {
      decide(state(phase), command);
    } catch (error) {
      expect((error as InvalidPhaseCommandError).code).toBe(INVALID_PHASE_COMMAND);
    }
  });

  it("start on an already-started run throws RUN_ALREADY_EXISTS", () => {
    const command = { type: "start", commandId: "cX", scenarioId: "s1", locale: "zh-CN" } as const;
    expect(() => decide(state("DISCOVERY"), command)).toThrow(RunAlreadyExistsError);
    try {
      decide(state("DISCOVERY"), command);
    } catch (error) {
      expect((error as RunAlreadyExistsError).code).toBe(RUN_ALREADY_EXISTS);
    }
  });
});
