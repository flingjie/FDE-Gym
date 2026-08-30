import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import { hintCommand, startCommand, type CommandContext } from "../../src/cli/commands";
import { appendEvents } from "../../src/core/event-store";
import type { EvaluatorCapsule, PublicScenario, CustomerCapsule } from "../../src/scenarios/schema";
import type { ScenarioEventCandidate } from "../../src/scenarios/schema";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

function scenario(): NonNullable<CommandContext["scenario"]> {
  const publicScenario: PublicScenario = {
    id: "scn-hint",
    schemaVersion: 1,
    locale: "zh-CN",
    openingRequest: text("开场", "Opening"),
    visibleContext: text("背景", "Context"),
    visibleConstraints: [text("约束", "Constraint")],
    deliverables: [text("交付", "Deliverable")],
    learnerRules: [text("规则", "Rule")],
    questionBudget: 12,
  };
  const customer: CustomerCapsule = {
    id: "scn-hint",
    schemaVersion: 1,
    stakeholders: [
      {
        id: "s1",
        role: text("角色", "Role"),
        persona: text("画像", "Persona"),
        concerns: [],
        blindSpots: [],
      },
    ],
    disclosureUnits: [],
    responsePolicies: [],
    privateConflicts: [],
    canary: "customer-canary",
  };
  const evaluator: EvaluatorCapsule = {
    id: "scn-hint",
    schemaVersion: 1,
    expectedEvidence: [],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [
      {
        id: "hl-workflow",
        topic: "workflow",
        hints: {
          "1": text("L1 角度", "L1 dimension"),
          "2": text("L2 类别", "L2 category"),
          "3": text("L3 该问什么？", "L3 what to ask?"),
        },
      },
    ],
    passGates: [],
    canary: "evaluator-canary",
  };
  const events: ScenarioEventCandidate[] = [];
  return { public: publicScenario, customer, evaluator, events };
}

describe("hintCommand ledger and journal", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function ctx(): { ctx: CommandContext; runId: string; baseDir: string } {
    const baseDir = mkdtempSync(join(tmpdir(), "fde-hint-cmd-"));
    dirs.push(baseDir);
    return {
      baseDir,
      runId: "run-hint-1",
      ctx: { runtime: new FixtureAgentRuntime({ fixtures: {} }), baseDir, scenario: scenario() },
    };
  }

  it("auto-escalates using the committed ledger", async () => {
    const { ctx: commandCtx, runId } = ctx();
    const started = await startCommand(commandCtx, {
      runId,
      scenarioId: "scn-hint",
      locale: "zh-CN",
      commandId: "cmd-start",
    });
    expect(started.ok).toBe(true);
    const first = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      commandId: "cmd-h1",
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.level).toBe(1);
    const second = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      commandId: "cmd-h2",
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.level).toBe(2);
  });

  it("replays a committed hint after the phase has moved on", async () => {
    const { ctx: commandCtx, runId, baseDir } = ctx();
    expect(
      (await startCommand(commandCtx, {
        runId,
        scenarioId: "scn-hint",
        locale: "zh-CN",
        commandId: "cmd-start",
      })).ok,
    ).toBe(true);
    const granted = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      level: 1,
      commandId: "cmd-h1",
    });
    expect(granted.ok).toBe(true);
    await appendEvents(
      runId,
      [
        {
          type: "phase.changed",
          runId,
          commandId: "cmd-force-phase",
          from: "DISCOVERY",
          to: "SOLUTION_DESIGN",
        },
      ],
      { baseDir },
    );
    const replayed = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      level: 1,
      commandId: "cmd-h1",
    });
    expect(replayed.ok).toBe(true);
    if (replayed.ok && granted.ok) {
      expect(replayed.data.level).toBe(granted.data.level);
      expect(replayed.data.hint).toEqual(granted.data.hint);
    }
    const fresh = await hintCommand(commandCtx, {
      runId,
      topic: "workflow",
      commandId: "cmd-h-new",
    });
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.code).toBe("INVALID_PHASE_COMMAND");
  });

  it("concurrent auto hints grant distinct levels from the locked ledger", async () => {
    const { ctx: commandCtx, runId } = ctx();
    expect(
      (
        await startCommand(commandCtx, {
          runId,
          scenarioId: "scn-hint",
          locale: "zh-CN",
          commandId: "cmd-start",
        })
      ).ok,
    ).toBe(true);
    const requests = [
      { commandId: "cmd-race-a" },
      { commandId: "cmd-race-b" },
    ] as const;
    const raced = await Promise.all(
      requests.map((r) =>
        hintCommand(commandCtx, { runId, topic: "workflow", commandId: r.commandId }),
      ),
    );
    const levels: Array<1 | 2 | 3> = [];
    for (let i = 0; i < raced.length; i++) {
      const result = raced[i];
      if (result.ok) {
        levels.push(result.data.level);
        continue;
      }
      // withRunLock fail-closes on live-owner contention instead of queueing.
      expect(result.code).toBe("RUN_LOCKED");
      const retried = await hintCommand(commandCtx, {
        runId,
        topic: "workflow",
        commandId: requests[i].commandId,
      });
      expect(retried.ok).toBe(true);
      if (retried.ok) levels.push(retried.data.level);
    }
    expect(new Set(levels)).toEqual(new Set([1, 2]));
  });
});
