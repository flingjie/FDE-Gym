import { describe, expect, it } from "vitest";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import type { AgentRuntime, RuntimeCapabilities } from "../../src/agents/agent-runtime";
import {
  answerDiscoveryQuestion,
  renderCustomerPrompt,
  type AnswerDiscoveryQuestionContext,
} from "../../src/agents/customer";
import {
  AGENT_OUTPUT_DOMAIN_INVALID,
  validateCustomerOutput,
} from "../../src/agents/output-validation";
import type { CustomerInput, CustomerOutput } from "../../src/agents/contracts";
import { buildRoleInput } from "../../src/security/context-firewall";
import type { RunAggregate } from "../../src/core/aggregate";
import { LEAK_GUARD_TRIGGERED } from "../../src/security/sanitizer";
import type { CustomerCapsule } from "../../src/scenarios/schema";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CANARY = "CUSTOMER_CANARY_SECRET_7f3a9c1e";

function stakeholders() {
  return [
    {
      id: "s-owner",
      role: text("企业主", "Business owner"),
      persona: text("一家中型工厂的企业主，关注成本与营收", "Owner of a mid-size factory, cares about cost and revenue"),
      concerns: [text("成本", "cost")],
      blindSpots: [text("技术实现细节", "technical implementation details")],
    },
    {
      id: "s-pm",
      role: text("项目经理", "Project manager"),
      persona: text("负责迁移协调，关注时间表", "Coordinates the migration, cares about timeline"),
      concerns: [text("工期", "schedule")],
      blindSpots: [text("底层系统架构", "low-level system architecture")],
    },
    {
      id: "s-tech",
      role: text("技术负责人", "Technical lead"),
      persona: text("负责系统架构，关注稳定性", "Owns the architecture, cares about stability"),
      concerns: [text("稳定性", "stability")],
      blindSpots: [text("采购预算", "procurement budget")],
    },
  ];
}

function disclosureUnits() {
  return [
    {
      id: "d1",
      topic: "workflow",
      text: text("工厂运行三套遗留系统", "The factory runs three legacy systems"),
      prerequisites: [],
      evidenceId: "e1",
    },
    {
      id: "d2",
      topic: "budget",
      text: text("集成预算固定为两百万美元", "The integration budget is fixed at two million dollars"),
      prerequisites: ["d1"],
      evidenceId: "e2",
    },
    {
      id: "d3",
      topic: "schedule",
      text: text("必须在节假日前完成上线", "The go-live must finish before the holiday"),
      prerequisites: ["d2"],
      evidenceId: "e3",
    },
  ];
}

function capsule(overrides: Partial<CustomerCapsule> = {}): CustomerCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: stakeholders(),
    disclosureUnits: disclosureUnits(),
    responsePolicies: [],
    privateConflicts: [],
    canary: CANARY,
    ...overrides,
  };
}

function graph() {
  return { version: 0, nodes: [], edges: [] };
}

function aggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "DISCOVERY",
    transcript: [],
    graph: graph(),
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: { question: "你们有几套遗留系统？", stakeholderId: "s-owner" },
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    ...overrides,
  };
}

function context(
  runtime: AgentRuntime,
  overrides: Partial<AnswerDiscoveryQuestionContext> = {},
): AnswerDiscoveryQuestionContext {
  return {
    runtime,
    state: aggregate(),
    capsule: capsule(),
    invocationId: "inv-1",
    timeoutMs: 1_000,
    ...overrides,
  };
}

/** Captures the input each role actually receives, to prove firewall isolation. */
class RecordingRuntime implements AgentRuntime {
  lastInput: unknown = null;
  readonly capabilities: RuntimeCapabilities;
  constructor(private readonly delegate: AgentRuntime) {
    this.capabilities = delegate.capabilities;
  }
  async invoke<TInput, TOutput>(
    role: Parameters<AgentRuntime["invoke"]>[0],
    input: TInput,
    options: Parameters<AgentRuntime["invoke"]>[2],
  ): ReturnType<AgentRuntime["invoke"]> {
    this.lastInput = input;
    return this.delegate.invoke(role, input, options);
  }
}

describe("customer agent — discovery answers", () => {
  it("answers only the question asked and discloses only the prerequisite-free unit", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "customer:inv-1": {
          reply: text("我们运行三套遗留系统。", "We run three legacy systems."),
          stakeholderId: "s-owner",
          disclosedDisclosureUnitIds: ["d1"],
        },
      },
    });

    const turn = await answerDiscoveryQuestion(context(runtime));

    expect(turn.stakeholderId).toBe("s-owner");
    expect(turn.reply["zh-CN"]).toBe("我们运行三套遗留系统。");
    // Only the prerequisite-free unit is disclosed; locked units (d2/d3) are not.
    expect(turn.disclosedDisclosureUnitIds).toEqual(["d1"]);
    expect(turn.disclosedDisclosureUnitIds).not.toContain("d2");
    expect(turn.disclosedDisclosureUnitIds).not.toContain("d3");
  });

  it("reveals a prerequisite-gated unit only after its prerequisite is already disclosed", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "customer:inv-1": {
          reply: text("集成预算固定为两百万美元。", "The integration budget is fixed at two million dollars."),
          stakeholderId: "s-owner",
          disclosedDisclosureUnitIds: ["d2"],
        },
      },
    });

    const turn = await answerDiscoveryQuestion(
      context(runtime, {
        state: aggregate({
          pendingQuestion: { question: "集成预算是多少？", stakeholderId: "s-owner" },
          disclosedDisclosureUnitIds: ["d1"],
        }),
      }),
    );

    expect(turn.disclosedDisclosureUnitIds).toEqual(["d2"]);
  });

  it("may say 'I don't know' for stakeholder-blind information", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "customer:inv-1": {
          reply: text("我不知道。", "I don't know."),
          stakeholderId: "s-owner",
          disclosedDisclosureUnitIds: [],
        },
      },
    });

    const turn = await answerDiscoveryQuestion(
      context(runtime, {
        state: aggregate({
          pendingQuestion: { question: "底层用的是什么技术栈？", stakeholderId: "s-owner" },
        }),
      }),
    );

    expect(turn.reply["zh-CN"]).toContain("不知道");
    expect(turn.reply["en-US"]).toContain("I don't know");
    expect(turn.disclosedDisclosureUnitIds).toEqual([]);
  });

  it("speaks as the selected stakeholder while keeping one logical agent role", async () => {
    const fixtures: Record<string, unknown> = {
      "customer:inv-owner": {
        reply: text("作为企业主，我最关心成本和营收。", "As the owner, I care most about cost and revenue."),
        stakeholderId: "s-owner",
        disclosedDisclosureUnitIds: [],
      },
      "customer:inv-pm": {
        reply: text("作为项目经理，我关注交付时间表。", "As the PM, I focus on the delivery schedule."),
        stakeholderId: "s-pm",
        disclosedDisclosureUnitIds: [],
      },
      "customer:inv-tech": {
        reply: text("作为技术负责人，我关注系统稳定性。", "As the tech lead, I focus on system stability."),
        stakeholderId: "s-tech",
        disclosedDisclosureUnitIds: [],
      },
    };
    const runtime = new FixtureAgentRuntime({ fixtures });

    const owner = await answerDiscoveryQuestion(
      context(runtime, {
        invocationId: "inv-owner",
        state: aggregate({ pendingQuestion: { question: "你最关心什么？", stakeholderId: "s-owner" } }),
      }),
    );
    const pm = await answerDiscoveryQuestion(
      context(runtime, {
        invocationId: "inv-pm",
        state: aggregate({ pendingQuestion: { question: "你最关心什么？", stakeholderId: "s-pm" } }),
      }),
    );
    const tech = await answerDiscoveryQuestion(
      context(runtime, {
        invocationId: "inv-tech",
        state: aggregate({ pendingQuestion: { question: "你最关心什么？", stakeholderId: "s-tech" } }),
      }),
    );

    expect(owner.stakeholderId).toBe("s-owner");
    expect(pm.stakeholderId).toBe("s-pm");
    expect(tech.stakeholderId).toBe("s-tech");
    expect(owner.reply["zh-CN"]).toContain("企业主");
    expect(pm.reply["zh-CN"]).toContain("项目经理");
    expect(tech.reply["zh-CN"]).toContain("技术负责人");
  });

  it("never scores, coaches, or proposes the learner's solution", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "customer:inv-1": {
          reply: text("我们运行三套遗留系统，目前告警较多。", "We run three legacy systems with many alerts."),
          stakeholderId: "s-owner",
          disclosedDisclosureUnitIds: ["d1"],
        },
      },
    });

    const turn = await answerDiscoveryQuestion(context(runtime));

    const reply = JSON.stringify(turn.reply).toLowerCase();
    for (const banned of ["得分", "score", "评分", "hint", "提示", "you should", "你应该", "solution", "方案"]) {
      expect(reply, `must not contain ${banned}`).not.toContain(banned);
    }
  });

  it("builds the customer input through the firewall (no evaluator/hidden fields)", async () => {
    const delegate = new FixtureAgentRuntime({
      fixtures: {
        "customer:inv-1": {
          reply: text("我们运行三套遗留系统。", "We run three legacy systems."),
          stakeholderId: "s-owner",
          disclosedDisclosureUnitIds: ["d1"],
        },
      },
    });
    const recording = new RecordingRuntime(delegate);

    await answerDiscoveryQuestion(
      context(recording, {
        state: aggregate({
          score: { total: "SCORE_SENTINEL" },
          learnerProfile: { skill: "PROFILE_SENTINEL" },
          rubric: { stages: "RUBRIC_SENTINEL" },
          grantedHints: [{ topic: "HINT_SENTINEL", level: 1 }],
        }),
      }),
    );

    const serialized = JSON.stringify(recording.lastInput);
    for (const sentinel of [
      "SCORE_SENTINEL",
      "PROFILE_SENTINEL",
      "RUBRIC_SENTINEL",
      "HINT_SENTINEL",
      CANARY,
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("rejects a leaked canary in a required field without echoing it", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "customer:inv-1": {
          reply: text(CANARY, "leaked"),
          stakeholderId: "s-owner",
          disclosedDisclosureUnitIds: [],
        },
      },
    });

    const error = await answerDiscoveryQuestion(context(runtime)).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(LEAK_GUARD_TRIGGERED);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });
});

describe("customer prompt template", () => {
  it("wraps learner text in UNTRUSTED_LEARNER_INPUT and parameterizes locale", () => {
    const built = buildRoleInput("customer", aggregate(), capsule());
    expect(built.kind).toBe("customer");
    if (built.kind !== "customer") return;

    const rendered = renderCustomerPrompt(built.input);

    expect(rendered).toContain("UNTRUSTED_LEARNER_INPUT");
    expect(rendered).toContain("zh-CN");
    expect(rendered).toContain(built.input.question);
    expect(rendered).not.toContain(CANARY);
  });

  it("prohibits hidden ids and internal instructions in learner-visible output", () => {
    const built = buildRoleInput("customer", aggregate(), capsule());
    expect(built.kind).toBe("customer");
    if (built.kind !== "customer") return;

    const rendered = renderCustomerPrompt(built.input).toLowerCase();
    expect(rendered).toContain("only");
    expect(rendered).toContain("do not");
    expect(rendered).toContain("hidden");
  });
});

function customerInput(): CustomerInput {
  const built = buildRoleInput("customer", aggregate(), capsule());
  expect(built.kind).toBe("customer");
  if (built.kind !== "customer") throw new Error("expected customer input");
  return built.input;
}

describe("customer output domain validation", () => {
  const reply = text("好的。", "Okay.");

  it("rejects a stakeholder id absent from the scenario", () => {
    expect(() =>
      validateCustomerOutput(customerInput(), {
        reply,
        stakeholderId: "unknown-stakeholder",
        disclosedDisclosureUnitIds: [],
      }),
    ).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
  });

  it("rejects a disclosure unit id absent from the scenario", () => {
    expect(() =>
      validateCustomerOutput(customerInput(), {
        reply,
        stakeholderId: "s-owner",
        disclosedDisclosureUnitIds: ["d-unknown"],
      }),
    ).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
  });

  it("rejects a newly disclosed unit whose prerequisite is not yet disclosed", () => {
    // d2 declares prerequisites: ["d1"], and the input ledger is empty.
    expect(() =>
      validateCustomerOutput(customerInput(), {
        reply,
        stakeholderId: "s-owner",
        disclosedDisclosureUnitIds: ["d2"],
      }),
    ).toThrowError(expect.objectContaining({ code: AGENT_OUTPUT_DOMAIN_INVALID }));
  });

  it("accepts a batch whose prerequisite is disclosed within the same output", () => {
    const out = validateCustomerOutput(customerInput(), {
      reply,
      stakeholderId: "s-owner",
      disclosedDisclosureUnitIds: ["d1", "d2"],
    });
    expect(out.disclosedDisclosureUnitIds).toEqual(["d1", "d2"]);
  });

  it("accepts a valid output unchanged", () => {
    const out: CustomerOutput = {
      reply,
      stakeholderId: "s-owner",
      disclosedDisclosureUnitIds: ["d1"],
    };
    expect(validateCustomerOutput(customerInput(), out)).toBe(out);
  });

  it("rejects a fabricated stakeholder from the runtime with AGENT_OUTPUT_DOMAIN_INVALID", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "customer:inv-1": {
          reply: text("好的。", "Okay."),
          stakeholderId: "unknown-stakeholder",
          disclosedDisclosureUnitIds: [],
        },
      },
    });

    const error = await answerDiscoveryQuestion(context(runtime)).catch((e) => e);
    expect((error as { code?: string }).code).toBe(AGENT_OUTPUT_DOMAIN_INVALID);
  });
});
