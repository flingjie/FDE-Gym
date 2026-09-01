import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime.js";
import { appendEvents, loadEvents, loadRun } from "../../src/core/event-store.js";
import { prepareAbort, prepareComplete } from "../../src/core/orchestrator.js";
import type { RunAggregate } from "../../src/core/aggregate.js";
import type { RunEvent } from "../../src/core/domain.js";
import {
  abortCommand,
  completeCommand,
  type CommandContext,
} from "../../src/cli/commands.js";

/**
 * Terminal lifecycle contract tests: `complete` (REVIEW → COMPLETED) and
 * `abort` (any active phase → ABORTED). Both are pure transitions — no model,
 * no I/O beyond the write-ahead command transaction.
 */

const REVIEW_LADDER: RunEvent[] = [
  { type: "run.started", runId: "run-1", commandId: "s", scenarioId: "scn-1", locale: "zh-CN" },
  { type: "phase.changed", runId: "run-1", commandId: "s", from: "SCENARIO", to: "SCENARIO" },
  { type: "phase.changed", runId: "run-1", commandId: "s:accept", from: "SCENARIO", to: "DISCOVERY" },
  { type: "phase.changed", runId: "run-1", commandId: "s:frame", from: "DISCOVERY", to: "PROBLEM_FRAMING" },
  { type: "phase.changed", runId: "run-1", commandId: "s:brief", from: "PROBLEM_FRAMING", to: "SOLUTION_DESIGN" },
  { type: "phase.changed", runId: "run-1", commandId: "s:design", from: "SOLUTION_DESIGN", to: "CHALLENGE" },
  { type: "phase.changed", runId: "run-1", commandId: "s:challenge", from: "CHALLENGE", to: "PITCH" },
  { type: "phase.changed", runId: "run-1", commandId: "s:pitch", from: "PITCH", to: "REVIEW" },
];

const DISCOVERY_LADDER: RunEvent[] = [
  { type: "run.started", runId: "run-2", commandId: "s", scenarioId: "scn-1", locale: "zh-CN" },
  { type: "phase.changed", runId: "run-2", commandId: "s", from: "SCENARIO", to: "SCENARIO" },
  { type: "phase.changed", runId: "run-2", commandId: "s:accept", from: "SCENARIO", to: "DISCOVERY" },
];

function aggregateAt(phase: "REVIEW" | "DISCOVERY" | "COMPLETED" | "ABORTED"): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase,
    transcript: [],
    graph: { version: 0, nodes: [], edges: [] },
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: null,
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    pendingEvidence: null,
    clarificationBudgetUsed: 0,
  };
}

let tempDirs: string[] = [];
function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tempDirs = [];
});

describe("prepareComplete", () => {
  it("emits run.completed + REVIEW→COMPLETED", () => {
    const result = prepareComplete(aggregateAt("REVIEW"), "cmd-complete");
    expect(result.events.map((event) => event.type)).toEqual(["run.completed", "phase.changed"]);
    expect(result.events[1]).toMatchObject({ from: "REVIEW", to: "COMPLETED" });
    expect(result.state.phase).toBe("COMPLETED");
  });

  it("rejects a non-REVIEW phase", () => {
    expect(() => prepareComplete(aggregateAt("DISCOVERY"), "cmd-complete")).toThrowError(
      /INVALID_PHASE_COMMAND|not valid/,
    );
  });
});

describe("prepareAbort", () => {
  it("emits run.aborted + DISCOVERY→ABORTED", () => {
    const result = prepareAbort(aggregateAt("DISCOVERY"), "cmd-abort");
    expect(result.events.map((event) => event.type)).toEqual(["run.aborted", "phase.changed"]);
    expect(result.events[1]).toMatchObject({ from: "DISCOVERY", to: "ABORTED" });
    expect(result.state.phase).toBe("ABORTED");
  });

  it("carries the optional reason", () => {
    const result = prepareAbort(aggregateAt("REVIEW"), "cmd-abort", "learner gave up");
    expect(result.events[0]).toMatchObject({ type: "run.aborted", reason: "learner gave up" });
  });

  it("rejects an unstarted (null-phase) run", () => {
    const agg = { ...aggregateAt("REVIEW"), phase: null as never };
    expect(() => prepareAbort(agg, "cmd-abort")).toThrowError(/INVALID_PHASE_COMMAND|not valid/);
  });
});

describe("complete / abort CLI contract", () => {
  it("complete moves a REVIEW run to COMPLETED and persists run.completed", async () => {
    const baseDir = makeStore();
    await appendEvents("run-1", REVIEW_LADDER, { baseDir });
    const ctx: CommandContext = { runtime: new FixtureAgentRuntime(), baseDir };

    const result = await completeCommand(ctx, { runId: "run-1", commandId: "cmd-complete" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe("COMPLETED");
      expect(result.data.phase).toBe("COMPLETED");
    }

    const loaded = await loadRun("run-1", { baseDir });
    expect(loaded.phase).toBe("COMPLETED");
    const types = (await loadEvents("run-1", { baseDir })).map((event) => event.type);
    expect(types.slice(-2)).toEqual(["run.completed", "phase.changed"]);
  });

  it("complete outside REVIEW fails with INVALID_PHASE_COMMAND", async () => {
    const baseDir = makeStore();
    await appendEvents("run-2", DISCOVERY_LADDER, { baseDir });
    const ctx: CommandContext = { runtime: new FixtureAgentRuntime(), baseDir };

    const result = await completeCommand(ctx, { runId: "run-2", commandId: "cmd-complete" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PHASE_COMMAND");
  });

  it("abort moves an active run to ABORTED and persists run.aborted with reason", async () => {
    const baseDir = makeStore();
    await appendEvents("run-2", DISCOVERY_LADDER, { baseDir });
    const ctx: CommandContext = { runtime: new FixtureAgentRuntime(), baseDir };

    const result = await abortCommand(ctx, {
      runId: "run-2",
      commandId: "cmd-abort",
      reason: "learner gave up",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe("ABORTED");
      expect(result.data.phase).toBe("ABORTED");
    }

    const loaded = await loadRun("run-2", { baseDir });
    expect(loaded.phase).toBe("ABORTED");
    const events = await loadEvents("run-2", { baseDir });
    const aborted = events[events.length - 2];
    expect(aborted).toMatchObject({ type: "run.aborted", reason: "learner gave up" });
  });

  it("abort a completed run fails with INVALID_PHASE_COMMAND (terminal is not active)", async () => {
    const baseDir = makeStore();
    await appendEvents("run-1", REVIEW_LADDER, { baseDir });
    const ctx: CommandContext = { runtime: new FixtureAgentRuntime(), baseDir };
    await completeCommand(ctx, { runId: "run-1", commandId: "cmd-complete" });

    const result = await abortCommand(ctx, { runId: "run-1", commandId: "cmd-abort" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PHASE_COMMAND");
  });
});
