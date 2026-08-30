import { describe, expect, it } from "vitest";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import type { AgentRuntime } from "../../src/agents/agent-runtime";
import {
  extractEvidence,
  renderEvidenceTrackerPrompt,
  type ExtractEvidenceContext,
} from "../../src/agents/evidence-tracker";
import { EvidenceTrackerOutputSchema } from "../../src/agents/contracts";
import {
  AGENT_OUTPUT_DOMAIN_INVALID,
  validateEvidenceTrackerOutput,
} from "../../src/agents/output-validation";
import type { EvidenceTrackerInput } from "../../src/agents/contracts";
import { buildRoleInput } from "../../src/security/context-firewall";
import type { RunAggregate } from "../../src/core/aggregate";
import { LEAK_GUARD_TRIGGERED } from "../../src/security/sanitizer";
import { EvidenceGraphPatchSchema, EvidenceKindSchema } from "../../src/core/domain";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CANARY = "EVALUATOR_CANARY_SECRET_9d4f2a7b";

const turn = {
  turnId: "t1",
  seq: 0,
  question: "你们有几套遗留系统？",
  customerReply: text("我们运行三套遗留系统。", "We run three legacy systems."),
  stakeholderId: "s-owner",
};

function graph() {
  return { version: 0, nodes: [], edges: [] };
}

function aggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "DISCOVERY",
    transcript: [turn],
    graph: graph(),
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

function validPatch() {
  return {
    patchId: "p1",
    expectedVersion: 0,
    addNodes: [
      {
        id: "ev-a",
        kind: "fact",
        claim: text("工厂运行三套遗留系统", "The factory runs three legacy systems"),
        status: "active",
        sourceTranscriptIds: ["t1"],
        weight: 1,
        version: 0,
      },
    ],
    addEdges: [],
    invalidateNodeIds: [],
  };
}

function validOutput() {
  return {
    patch: validPatch(),
    questionAssessment: {
      intentCount: 1,
      atomicity: 0.9,
      neutrality: 0.8,
      relevance: 1,
      redundancy: 0,
    },
  };
}

function context(
  runtime: AgentRuntime,
  overrides: Partial<ExtractEvidenceContext> = {},
): ExtractEvidenceContext {
  return {
    runtime,
    state: aggregate(),
    invocationId: "inv-e1",
    timeoutMs: 1_000,
    ...overrides,
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

describe("evidence tracker agent — strict patch and assessment", () => {
  it("returns a strict EvidenceGraphPatch and the exact 5-field QuestionAssessment", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: { "evidence_tracker:inv-e1": validOutput() },
    });

    const result = await extractEvidence(context(runtime));

    expect(EvidenceGraphPatchSchema.safeParse(result.patch).success).toBe(true);
    expect(result.patch.patchId).toBe("p1");
    expect(result.patch.expectedVersion).toBe(0);

    expect(Object.keys(result.questionAssessment).sort()).toEqual([
      "atomicity",
      "intentCount",
      "neutrality",
      "redundancy",
      "relevance",
    ]);
    expect(result.questionAssessment.intentCount).toBe(1);
    expect(result.questionAssessment.atomicity).toBe(0.9);
    expect(result.questionAssessment.neutrality).toBe(0.8);
    expect(result.questionAssessment.relevance).toBe(1);
    expect(result.questionAssessment.redundancy).toBe(0);
  });

  it("rejects a question assessment outside the 0..1 bounds", async () => {
    const bad = {
      ...validOutput(),
      questionAssessment: {
        intentCount: 1,
        atomicity: 1.5,
        neutrality: 0.8,
        relevance: 1,
        redundancy: 0,
      },
    };
    expect(EvidenceTrackerOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("sees only public dialogue + graph (no expected evidence, rubric, or canary)", async () => {
    const delegate = new FixtureAgentRuntime({
      fixtures: { "evidence_tracker:inv-e1": validOutput() },
    });
    const recording = new RecordingRuntime(delegate);

    await extractEvidence(
      context(recording, {
        state: aggregate({
          rubric: { stages: "RUBRIC_SENTINEL" },
          score: { total: "SCORE_SENTINEL" },
        }),
      }),
    );

    const input = recording.lastInput as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["graph", "locale", "turn"]);

    const serialized = JSON.stringify(input);
    for (const sentinel of [
      "RUBRIC_SENTINEL",
      "SCORE_SENTINEL",
      "expectedEvidence",
      "canary",
      "disclosureUnits",
      "stakeholders",
      "rubric",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("cannot label a claim as ground truth (evidence kinds are constrained)", () => {
    expect(EvidenceKindSchema.safeParse("ground_truth").success).toBe(false);
    expect(EvidenceKindSchema.safeParse("fact").success).toBe(true);
    expect(validPatch().addNodes[0].kind).toBe("fact");
  });

  it("rejects a leaked canary in the patch claim without echoing it", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "evidence_tracker:inv-e1": {
          patch: {
            ...validPatch(),
            addNodes: [
              {
                ...validPatch().addNodes[0],
                claim: text(CANARY, "leaked"),
              },
            ],
          },
          questionAssessment: {
            intentCount: 1,
            atomicity: 1,
            neutrality: 1,
            relevance: 1,
            redundancy: 0,
          },
        },
      },
    });

    const error = await extractEvidence(context(runtime, { canaries: [CANARY] })).catch((e) => e);
    expect((error as { code?: string }).code).toBe(LEAK_GUARD_TRIGGERED);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });
});

describe("evidence tracker prompt template", () => {
  it("wraps the learner question in UNTRUSTED_LEARNER_INPUT and excludes hidden fields", () => {
    const built = buildRoleInput("evidence_tracker", aggregate());
    expect(built.kind).toBe("evidence_tracker");
    if (built.kind !== "evidence_tracker") return;

    const rendered = renderEvidenceTrackerPrompt(built.input);

    expect(rendered).toContain("UNTRUSTED_LEARNER_INPUT");
    expect(rendered).toContain(built.input.turn.question);
    expect(rendered).not.toContain("expectedEvidence");
    expect(rendered).not.toContain(CANARY);
  });
});

function trackerInput(): EvidenceTrackerInput {
  const built = buildRoleInput("evidence_tracker", aggregate());
  expect(built.kind).toBe("evidence_tracker");
  if (built.kind !== "evidence_tracker") throw new Error("expected tracker input");
  return built.input;
}

function outputWithSources(sourceTranscriptIds: string[]) {
  const patch = validPatch();
  return {
    patch: { ...patch, addNodes: [{ ...patch.addNodes[0], sourceTranscriptIds }] },
    questionAssessment: validOutput().questionAssessment,
  };
}

describe("evidence tracker output domain validation", () => {
  it("rejects a fact node sourced from a different transcript turn", () => {
    expect(() =>
      validateEvidenceTrackerOutput(trackerInput(), outputWithSources(["t2"])),
    ).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
  });

  it("rejects a fact node with extra transcript sources beyond the current turn", () => {
    expect(() =>
      validateEvidenceTrackerOutput(trackerInput(), outputWithSources(["t1", "t2"])),
    ).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
  });

  it("rejects a fact node with no transcript source", () => {
    expect(() =>
      validateEvidenceTrackerOutput(trackerInput(), outputWithSources([])),
    ).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
  });

  it("accepts a fact node sourced exactly from the current turn", () => {
    const out = outputWithSources(["t1"]);
    expect(validateEvidenceTrackerOutput(trackerInput(), out)).toBe(out);
  });

  it("rejects a wrong-turn fact node from the runtime with AGENT_OUTPUT_DOMAIN_INVALID", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: { "evidence_tracker:inv-e1": outputWithSources(["t2"]) },
    });

    const error = await extractEvidence(context(runtime)).catch((e) => e);
    expect((error as { code?: string }).code).toBe(AGENT_OUTPUT_DOMAIN_INVALID);
  });
});
