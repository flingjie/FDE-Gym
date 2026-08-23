import { describe, expect, it } from "vitest";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import type { AgentRuntime } from "../../src/agents/agent-runtime";
import {
  renderCoachPrompt,
  requestHint,
  validateProblemBrief,
  type CoachContext,
} from "../../src/agents/coach";
import { CoachHintOutputSchema } from "../../src/agents/contracts";
import { BriefValidationResultSchema } from "../../src/core/domain";
import { buildRoleInput, type RunAggregate } from "../../src/security/context-firewall";
import { LEAK_GUARD_TRIGGERED } from "../../src/security/sanitizer";
import type { EvaluatorCapsule } from "../../src/scenarios/schema";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CANARY = "EVALUATOR_CANARY_SECRET_9d4f2a7b";

function hintLadder() {
  return {
    id: "hl-workflow",
    topic: "workflow",
    hints: {
      "1": text("想一想流程的起点。", "Think about the start of the process."),
      "2": text("关注数据量这个类别。", "Focus on the data-volume category."),
      "3": text("真正需要关注的告警占多大比例？", "What share of alerts actually need attention?"),
    },
  };
}

function evaluatorCapsule(overrides: Partial<EvaluatorCapsule> = {}): EvaluatorCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    expectedEvidence: [],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [hintLadder()],
    passGates: [],
    canary: CANARY,
    ...overrides,
  };
}

function graph() {
  return {
    version: 0,
    nodes: [
      {
        id: "ev-a",
        kind: "fact",
        claim: text("工厂运行三套遗留系统", "The factory runs three legacy systems"),
        status: "active",
        sourceTranscriptIds: ["t1"],
        weight: 1,
        version: 0,
      },
      {
        id: "ev-b",
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

function brief() {
  return {
    id: "brief-1",
    problemStatement: text("告警处理效率低下", "Alert handling is inefficient"),
    goal: text("降低工程师告警处理负担", "Reduce engineer alert-handling burden"),
    constraints: [text("必须在工厂内网部署", "Must deploy within the factory network")],
    claims: [
      {
        id: "claim-1",
        statement: text("现有系统由三套遗留系统组成", "The current system has three legacy systems"),
        weight: "major",
        evidenceIds: ["ev-a"],
      },
      {
        id: "claim-2",
        statement: text("自动化可将工作量削减50%", "Automation can cut workload by 50%"),
        weight: "critical",
        evidenceIds: ["ev-b"],
      },
    ],
    successMeasures: [text("削减50%工作量", "Cut workload by 50%")],
    unknowns: [text("集成复杂度", "Integration complexity")],
    contradictions: [],
  };
}

function aggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
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
    graph: graph(),
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: null,
    hintRequest: null,
    coachTask: "brief-validation",
    brief: brief(),
    proposal: null,
    pitch: null,
    challengeResponses: [],
    ...overrides,
  };
}

function context(
  runtime: AgentRuntime,
  overrides: Partial<CoachContext> = {},
): CoachContext {
  return {
    runtime,
    state: aggregate(),
    capsule: evaluatorCapsule(),
    invocationId: "inv-1",
    timeoutMs: 1_000,
    ...overrides,
  };
}

function coachEntailmentOutput() {
  return {
    passed: false,
    entailments: [
      { claimId: "claim-1", entailment: "supported" },
      { claimId: "claim-2", entailment: "unsupported" },
    ],
    missingCategories: [],
    unsupportedClaimIds: ["claim-2"],
    feedback: text("自动化论断缺乏事实证据。", "The automation claim lacks factual evidence."),
  };
}

class RecordingRuntime implements AgentRuntime {
  lastInput: unknown = null;
  constructor(private readonly delegate: AgentRuntime) {}
  async invoke<TInput, TOutput>(
    role: Parameters<AgentRuntime["invoke"]>[0],
    input: TInput,
    options: Parameters<AgentRuntime["invoke"]>[2],
  ): ReturnType<AgentRuntime["invoke"]> {
    this.lastInput = input;
    return this.delegate.invoke(role, input, options);
  }
}

describe("coach agent — problem brief validation", () => {
  it("returns schema-validated entailment classification for the brief", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: { "coach_evaluator:inv-1": coachEntailmentOutput() },
    });

    const result = await validateProblemBrief(context(runtime));

    expect(BriefValidationResultSchema.safeParse(result).success).toBe(true);
    expect(result.entailments).toEqual([
      { claimId: "claim-1", entailment: "supported" },
      { claimId: "claim-2", entailment: "unsupported" },
    ]);
    expect(result.unsupportedClaimIds).toEqual(["claim-2"]);
  });

  it("builds the brief-validation input through the firewall (locale+brief+graph+transcript only)", async () => {
    const delegate = new FixtureAgentRuntime({
      fixtures: { "coach_evaluator:inv-1": coachEntailmentOutput() },
    });
    const recording = new RecordingRuntime(delegate);

    await validateProblemBrief(
      context(recording, {
        state: aggregate({
          customerPrompt: "PROMPT_SENTINEL_777",
          customerSessionId: "SESSION_SENTINEL_888",
          rawCustomerOutput: "RAW_SENTINEL_999",
          chainOfThought: "COT_SENTINEL_aaa",
        }),
      }),
    );

    const input = recording.lastInput as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["brief", "graph", "locale", "transcript"]);

    const serialized = JSON.stringify(input);
    for (const sentinel of [
      "PROMPT_SENTINEL_777",
      "SESSION_SENTINEL_888",
      "RAW_SENTINEL_999",
      "COT_SENTINEL_aaa",
      "stakeholders",
      "disclosureUnits",
      "responsePolicies",
      "rubric",
      "expectedEvidence",
      "hintLadders",
      CANARY,
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("identifies unsupported public claims and missing categories without hidden text", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "coach_evaluator:inv-1": {
          passed: false,
          entailments: [
            { claimId: "claim-1", entailment: "supported" },
            { claimId: "claim-2", entailment: "unsupported" },
          ],
          missingCategories: ["trust"],
          unsupportedClaimIds: ["claim-2"],
          feedback: text("缺少信任证据。", "Missing trust evidence."),
        },
      },
    });

    const result = await validateProblemBrief(context(runtime));

    expect(result.missingCategories).toContain("trust");
    expect(result.unsupportedClaimIds).toContain("claim-2");
    // A hidden fact never in the public input cannot surface in the output.
    expect(JSON.stringify(result)).not.toContain("12,000");
  });

  it("rejects a leaked canary in the coach output without echoing it", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "coach_evaluator:inv-1": {
          passed: false,
          entailments: [],
          missingCategories: [],
          unsupportedClaimIds: [],
          feedback: text(CANARY, "leaked"),
        },
      },
    });

    const error = await validateProblemBrief(context(runtime)).catch((e) => e);
    expect((error as { code?: string }).code).toBe(LEAK_GUARD_TRIGGERED);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });
});

describe("coach agent — hints", () => {
  it("builds the hint input through the firewall and returns { level, hint }", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "coach_evaluator:inv-hint": {
          level: 2,
          hint: text("关注数据量这个类别。", "Focus on the data-volume category."),
        },
      },
    });

    const out = await requestHint(
      context(runtime, {
        invocationId: "inv-hint",
        state: aggregate({
          coachTask: "hint",
          brief: null,
          hintRequest: { topic: "workflow", level: 2 },
        }),
      }),
    );

    expect(CoachHintOutputSchema.safeParse(out).success).toBe(true);
    expect(out.level).toBe(2);
    expect(out.hint["zh-CN"]).toContain("数据量");
  });
});

describe("coach prompt template", () => {
  it("wraps learner brief prose in UNTRUSTED_LEARNER_INPUT and parameterizes locale", () => {
    const built = buildRoleInput("coach_evaluator", aggregate(), evaluatorCapsule());
    expect(built.kind).toBe("brief-validation");
    if (built.kind !== "brief-validation") return;

    const rendered = renderCoachPrompt(built.input);

    expect(rendered).toContain("UNTRUSTED_LEARNER_INPUT");
    expect(rendered).toContain("zh-CN");
    expect(rendered).toContain(built.input.brief.problemStatement["zh-CN"]);
    expect(rendered).not.toContain(CANARY);
  });

  it("excludes hidden ids and internal instructions from the rendered prompt", () => {
    const built = buildRoleInput("coach_evaluator", aggregate(), evaluatorCapsule());
    expect(built.kind).toBe("brief-validation");
    if (built.kind !== "brief-validation") return;

    const rendered = renderCoachPrompt(built.input).toLowerCase();
    expect(rendered).toContain("only");
    expect(rendered).toContain("do not");
    expect(rendered).toContain("hidden");
  });
});
