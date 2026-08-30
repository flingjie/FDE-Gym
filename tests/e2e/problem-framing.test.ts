import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import {
  CLARIFICATION_BUDGET_EXCEEDED,
  DEFAULT_CLARIFICATION_BUDGET,
  prepareClarification,
  prepareFramingGate,
  type FramingGateInput,
} from "../../src/core/orchestrator";
import { loadRun } from "../../src/core/event-store";
import { commitPrepared } from "../helpers/commit-prepared";
import type { RunAggregate } from "../../src/security/context-firewall";
import type { EvaluatorCapsule } from "../../src/scenarios/schema";
import type { ProblemBrief } from "../../src/core/domain";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CANARY = "EVALUATOR_CANARY_SECRET_9d4f2a7b";

function evaluatorCapsule(): EvaluatorCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    expectedEvidence: [],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [
      {
        id: "hl-workflow",
        topic: "workflow",
        hints: {
          "1": text("想一想流程的起点。", "Think about the start of the process."),
          "2": text("关注数据量这个类别。", "Focus on the data-volume category."),
          "3": text("真正需要关注的告警占多大比例？", "What share of alerts actually need attention?"),
        },
      },
    ],
    passGates: [],
    canary: CANARY,
  };
}

/** Public evidence graph of what the learner has DISCOVERED so far. */
function discoveredGraph() {
  return {
    version: 0,
    nodes: [
      {
        id: "ev-legacy",
        kind: "fact",
        claim: text("工厂运行三套遗留系统", "The factory runs three legacy systems"),
        status: "active",
        sourceTranscriptIds: ["t1"],
        weight: 1,
        version: 0,
      },
      {
        id: "ev-automation",
        kind: "assumption",
        claim: text("自动化可以削减一半工作量", "Automation can cut half the workload"),
        status: "active",
        sourceTranscriptIds: [],
        weight: 1,
        version: 0,
      },
    ],
    edges: [],
  };
}

function framingAggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "PROBLEM_FRAMING",
    transcript: [
      {
        turnId: "t1",
        seq: 0,
        question: "你们有几套遗留系统？",
        customerReply: text("三套。", "Three."),
        stakeholderId: "s-owner",
      },
    ],
    graph: discoveredGraph(),
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: null,
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    ...overrides,
  };
}

/** A brief carrying an UNSUPPORTED automation claim grounded only in an assumption. */
function failingBrief(): ProblemBrief {
  return {
    id: "brief-1",
    problemStatement: text("告警处理效率低下", "Alert handling is inefficient"),
    goal: text("降低工程师告警处理负担", "Reduce engineer alert-handling burden"),
    constraints: [text("内网部署", "On-premises deployment")],
    claims: [
      {
        id: "claim-legacy",
        statement: text("现有系统由三套遗留系统组成", "The current system has three legacy systems"),
        weight: "major",
        evidenceIds: ["ev-legacy"],
      },
      {
        id: "claim-automation",
        statement: text("自动化可将工作量削减50%", "Automation can cut workload by 50%"),
        weight: "critical",
        evidenceIds: ["ev-automation"],
      },
    ],
    successMeasures: [text("削减50%工作量", "Cut workload by 50%")],
    unknowns: [text("集成复杂度", "Integration complexity")],
    contradictions: [],
  };
}

/** A brief whose claims are all grounded in discovered facts (supportRatio >= 0.75). */
function passingBrief(): ProblemBrief {
  return {
    id: "brief-2",
    problemStatement: text("告警处理效率低下", "Alert handling is inefficient"),
    goal: text("降低工程师告警处理负担", "Reduce engineer alert-handling burden"),
    constraints: [text("内网部署", "On-premises deployment")],
    claims: [
      {
        id: "claim-legacy",
        statement: text("现有系统由三套遗留系统组成", "The current system has three legacy systems"),
        weight: "major",
        evidenceIds: ["ev-legacy"],
      },
    ],
    successMeasures: [text("削减50%工作量", "Cut workload by 50%")],
    unknowns: [text("集成复杂度", "Integration complexity")],
    contradictions: [],
  };
}

function framingInput(
  overrides: Partial<FramingGateInput> = {},
): FramingGateInput {
  return {
    runtime: new FixtureAgentRuntime({ fixtures: {} }),
    capsule: evaluatorCapsule(),
    state: framingAggregate(),
    brief: failingBrief(),
    commandId: "cmd-1",
    timeoutMs: 1_000,
    ...overrides,
  };
}

let tempDirs: string[] = [];
function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-framing-"));
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

describe("problem framing gate — one failed brief, clarification, then a passing brief", () => {
  it("fails an unsupported automation claim, stays in PROBLEM_FRAMING, and leaks no hidden facts", async () => {
    const baseDir = makeStore();
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "coach_evaluator:cmd-1:coach": {
          passed: false,
          entailments: [
            { claimId: "claim-legacy", entailment: "supported" },
            { claimId: "claim-automation", entailment: "unsupported" },
          ],
          missingCategories: [],
          unsupportedClaimIds: ["claim-automation"],
          feedback: text("自动化论断缺乏事实证据。", "The automation claim lacks factual evidence."),
        },
      },
    });

    const input = framingInput({ runtime });
    const result = await prepareFramingGate(input);
    await commitPrepared({
      runId: input.state.runId,
      commandId: input.commandId,
      request: { type: "submit-brief", brief: input.brief },
      events: result.acceptedEvents,
      result: { passed: result.passed, supportRatio: result.supportRatio },
      store: { baseDir },
      canaries: [CANARY],
    });

    // Failure: supportRatio = (2*1 + 3*0) / 5 = 0.4 < 0.75.
    expect(result.passed).toBe(false);
    expect(result.supportRatio).toBeCloseTo(0.4);

    // brief.submitted + brief.validated(passed=false); NO phase.changed.
    expect(result.acceptedEvents.map((e) => e.type)).toEqual([
      "brief.submitted",
      "brief.validated",
    ]);
    const validated = result.acceptedEvents.find((e) => e.type === "brief.validated");
    expect(validated).toMatchObject({
      type: "brief.validated",
      briefId: "brief-1",
      result: { passed: false },
    });

    // Stay in PROBLEM_FRAMING.
    expect(result.updatedState.phase).toBe("PROBLEM_FRAMING");

    // The never-discovered hidden fact ("12,000 alerts/day") must not surface.
    const serialized = JSON.stringify(result.acceptedEvents);
    expect(serialized).not.toContain("12,000");
    expect(JSON.stringify(result.result.feedback)).not.toContain("12,000");

    const loaded = await loadRun("run-1", { baseDir });
    // Exactly two events persisted (no phase.changed on failure); the reducer
    // only learns `phase` from a phase.changed, so a null phase proves no
    // transition was recorded.
    expect(loaded.seq).toBe(2);
    expect(loaded.phase).toBeNull();
  });

  it("returns to DISCOVERY for clarification, bounded by the clarification budget", async () => {
    const baseDir = makeStore();
    const state = framingAggregate();

    // Each clarification consumes one budget unit. Between clarifications the
    // learner re-frames (returns to PROBLEM_FRAMING) after further discovery.
    let used = 0;
    let phase: "PROBLEM_FRAMING" | "DISCOVERY" = "PROBLEM_FRAMING";
    for (let i = 0; i < DEFAULT_CLARIFICATION_BUDGET; i++) {
      const input = {
        state: { ...state, phase },
        commandId: `clarify-${i}`,
        clarificationBudgetUsed: used,
      };
      const clarified = await prepareClarification(input);
      await commitPrepared({
        runId: input.state.runId,
        commandId: input.commandId,
        request: { type: "clarify" },
        events: clarified.acceptedEvents,
        result: { phase: clarified.updatedState.phase },
        store: { baseDir },
      });
      used = clarified.clarificationBudgetUsed;
      expect(clarified.acceptedEvents.map((e) => e.type)).toEqual(["phase.changed"]);
      expect(clarified.updatedState.phase).toBe("DISCOVERY");
      phase = "PROBLEM_FRAMING";
    }
    expect(used).toBe(DEFAULT_CLARIFICATION_BUDGET);

    // The next clarification exceeds the budget.
    const error = await prepareClarification({
      state: { ...state, phase: "PROBLEM_FRAMING" },
      commandId: "clarify-over",
      clarificationBudgetUsed: used,
    }).catch((e) => e);
    expect((error as { code?: string }).code).toBe(CLARIFICATION_BUDGET_EXCEEDED);
  });

  it("passes a second brief whose claims are all supported (supportRatio >= 0.75)", async () => {
    const baseDir = makeStore();
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "coach_evaluator:cmd-2:coach": {
          passed: true,
          entailments: [{ claimId: "claim-legacy", entailment: "supported" }],
          missingCategories: [],
          unsupportedClaimIds: [],
          feedback: text("通过。", "Pass."),
        },
      },
    });

    const input = framingInput({
      runtime,
      brief: passingBrief(),
      commandId: "cmd-2",
    });
    const result = await prepareFramingGate(input);
    await commitPrepared({
      runId: input.state.runId,
      commandId: input.commandId,
      request: { type: "submit-brief", brief: input.brief },
      events: result.acceptedEvents,
      result: { passed: result.passed, supportRatio: result.supportRatio },
      store: { baseDir },
      canaries: [CANARY],
    });

    expect(result.passed).toBe(true);
    expect(result.supportRatio).toBe(1);

    // brief.submitted + brief.validated(passed=true) + phase.changed.
    expect(result.acceptedEvents.map((e) => e.type)).toEqual([
      "brief.submitted",
      "brief.validated",
      "phase.changed",
    ]);
    expect(result.acceptedEvents[2]).toMatchObject({
      type: "phase.changed",
      from: "PROBLEM_FRAMING",
      to: "SOLUTION_DESIGN",
    });
    expect(result.updatedState.phase).toBe("SOLUTION_DESIGN");

    const loaded = await loadRun("run-1", { baseDir });
    expect(loaded.phase).toBe("SOLUTION_DESIGN");
    expect(loaded.seq).toBe(3);
  });

  it("rejects submit-brief outside PROBLEM_FRAMING", async () => {
    const runtime = new FixtureAgentRuntime({ fixtures: {} });
    const error = await prepareFramingGate(
      framingInput({
        runtime,
        state: framingAggregate({ phase: "DISCOVERY" }),
      }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("INVALID_PHASE_COMMAND");
  });
});
