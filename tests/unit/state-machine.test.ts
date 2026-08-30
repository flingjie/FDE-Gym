import { describe, expect, it } from "vitest";

import type { RunCommand, RunPhase } from "../../src/core/domain";
import {
  INVALID_PHASE_COMMAND,
  RUN_ALREADY_EXISTS,
  InvalidPhaseCommandError,
  RunAlreadyExistsError,
} from "../../src/core/errors";
import {
  assertCommandPhase,
  buildPhaseChangedEvent,
  buildRunStartedEvents,
} from "../../src/core/state-machine";

const RUN_ID = "run-1";

describe("assertCommandPhase: phase legality only (no events)", () => {
  it("returns void (does not throw) for every legal phase/command pairing", () => {
    const legal: Array<[RunPhase | null, RunCommand["type"]]> = [
      [null, "start"],
      ["SCENARIO", "accept"],
      ["DISCOVERY", "ask"],
      ["DISCOVERY", "frame"],
      ["DISCOVERY", "hint"],
      ["PROBLEM_FRAMING", "hint"],
      ["PROBLEM_FRAMING", "submit-brief"],
      ["PROBLEM_FRAMING", "clarify"],
      ["SOLUTION_DESIGN", "submit-design"],
      ["CHALLENGE", "respond-challenge"],
      ["PITCH", "submit-pitch"],
      ["REVIEW", "review"],
      ["REVIEW", "retry"],
      ["RETRY_READY", "start-retry"],
      ["REVIEW", "complete"],
      ["SCENARIO", "abort"],
      ["DISCOVERY", "abort"],
      ["PROBLEM_FRAMING", "abort"],
      ["SOLUTION_DESIGN", "abort"],
      ["CHALLENGE", "abort"],
      ["PITCH", "abort"],
      ["REVIEW", "abort"],
      ["RETRY_READY", "abort"],
    ];
    for (const [phase, type] of legal) {
      expect(() => assertCommandPhase(phase, type)).not.toThrow();
    }
  });

  const illegal: Array<{ name: string; phase: RunPhase | null; type: RunCommand["type"] }> = [
    { name: "accept outside SCENARIO", phase: "DISCOVERY", type: "accept" },
    { name: "accept before start", phase: null, type: "accept" },
    { name: "frame outside DISCOVERY", phase: "SCENARIO", type: "frame" },
    { name: "ask outside DISCOVERY", phase: "PROBLEM_FRAMING", type: "ask" },
    { name: "hint outside DISCOVERY/PROBLEM_FRAMING", phase: "SOLUTION_DESIGN", type: "hint" },
    { name: "submit-brief outside PROBLEM_FRAMING", phase: "DISCOVERY", type: "submit-brief" },
    { name: "clarify outside PROBLEM_FRAMING", phase: "DISCOVERY", type: "clarify" },
    { name: "submit-design outside SOLUTION_DESIGN", phase: "PROBLEM_FRAMING", type: "submit-design" },
    { name: "respond-challenge outside CHALLENGE", phase: "SOLUTION_DESIGN", type: "respond-challenge" },
    { name: "submit-pitch outside PITCH", phase: "CHALLENGE", type: "submit-pitch" },
    { name: "review outside REVIEW", phase: "PITCH", type: "review" },
    { name: "retry outside REVIEW", phase: "PITCH", type: "retry" },
    { name: "start-retry outside RETRY_READY", phase: "REVIEW", type: "start-retry" },
    { name: "complete outside REVIEW", phase: "PITCH", type: "complete" },
    { name: "abort before start", phase: null, type: "abort" },
    { name: "abort after completed", phase: "COMPLETED", type: "abort" },
    { name: "abort after aborted", phase: "ABORTED", type: "abort" },
  ];

  it.each(illegal)("$name throws INVALID_PHASE_COMMAND", ({ phase, type }) => {
    expect(() => assertCommandPhase(phase, type)).toThrow(InvalidPhaseCommandError);
    try {
      assertCommandPhase(phase, type);
    } catch (error) {
      expect((error as InvalidPhaseCommandError).code).toBe(INVALID_PHASE_COMMAND);
    }
  });

  it("start when phase is non-null throws RUN_ALREADY_EXISTS", () => {
    expect(() => assertCommandPhase("DISCOVERY", "start")).toThrow(RunAlreadyExistsError);
    try {
      assertCommandPhase("DISCOVERY", "start");
    } catch (error) {
      expect((error as RunAlreadyExistsError).code).toBe(RUN_ALREADY_EXISTS);
    }
  });

  it("start when phase is null is legal (no throw)", () => {
    expect(() => assertCommandPhase(null, "start")).not.toThrow();
  });
});

describe("buildRunStartedEvents", () => {
  it("emits run.started + the SCENARIO anchor phase.changed (no digest)", () => {
    expect(
      buildRunStartedEvents(RUN_ID, {
        type: "start",
        commandId: "c0",
        scenarioId: "s1",
        locale: "zh-CN",
      }),
    ).toEqual([
      { type: "run.started", runId: RUN_ID, commandId: "c0", scenarioId: "s1", locale: "zh-CN" },
      { type: "phase.changed", runId: RUN_ID, commandId: "c0", from: "SCENARIO", to: "SCENARIO" },
    ]);
  });

  it("stamps scenarioBundleDigest onto run.started when present", () => {
    const digest = "a".repeat(64);
    expect(
      buildRunStartedEvents(RUN_ID, {
        type: "start",
        commandId: "c0",
        scenarioId: "s1",
        locale: "en-US",
        scenarioBundleDigest: digest,
      }),
    ).toEqual([
      {
        type: "run.started",
        runId: RUN_ID,
        commandId: "c0",
        scenarioId: "s1",
        locale: "en-US",
        scenarioBundleDigest: digest,
      },
      { type: "phase.changed", runId: RUN_ID, commandId: "c0", from: "SCENARIO", to: "SCENARIO" },
    ]);
  });
});

describe("buildPhaseChangedEvent", () => {
  it("builds the exact accept event (SCENARIO -> DISCOVERY)", () => {
    expect(buildPhaseChangedEvent(RUN_ID, "c1", "SCENARIO", "DISCOVERY")).toEqual({
      type: "phase.changed",
      runId: RUN_ID,
      commandId: "c1",
      from: "SCENARIO",
      to: "DISCOVERY",
    });
  });

  it("builds the exact frame event (DISCOVERY -> PROBLEM_FRAMING)", () => {
    expect(buildPhaseChangedEvent(RUN_ID, "c2", "DISCOVERY", "PROBLEM_FRAMING")).toEqual({
      type: "phase.changed",
      runId: RUN_ID,
      commandId: "c2",
      from: "DISCOVERY",
      to: "PROBLEM_FRAMING",
    });
  });
});
