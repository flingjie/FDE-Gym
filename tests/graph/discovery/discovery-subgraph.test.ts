import { describe, expect, it } from "vitest";

import { FixtureAgentRuntime } from "../../../src/agents/fixture-runtime";
import type { CustomerTurn } from "../../../src/agents/customer";
import type { EvidenceTurnResult } from "../../../src/agents/evidence-tracker";
import type { EvidenceTrackerOutput } from "../../../src/agents/contracts";
import type { RunAggregate } from "../../../src/core/aggregate";
import type { CustomerCapsule } from "../../../src/scenarios/schema";
import type { EvidenceGraphPatch } from "../../../src/core/domain";
import {
  FRAME_BLOCKED,
  GUARD_IDS,
  GUARD_REGISTRY,
  noPendingEvidence,
} from "../../../src/graph/guards";
import { EVENT_PROTOCOLS } from "../../../src/graph/event-protocols";
import {
  handlers,
  runCustomerInvoke,
  runCustomerProject,
  runEvidenceInvoke,
  runEvidencePatchApply,
  runEvidencePatchGuard,
  runEvidencePending,
  runMetricsCompute,
  runQuestionAccept,
} from "../../../src/graph/nodes/discovery/index";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CANARY = "CUSTOMER_CANARY_SECRET_7f3a9c1e";
const COMMAND_ID = "ask-1";
const STAKEHOLDER_ID = "s-owner";
const QUESTION = "你们有几套遗留系统？";
const TURN_ID = `${COMMAND_ID}:turn`;

function stakeholders() {
  return [
    {
      id: "s-owner",
      role: text("企业主", "Business owner"),
      persona: text("一家中型工厂的企业主", "Owner of a mid-size factory"),
      concerns: [text("成本", "cost")],
      blindSpots: [text("技术实现细节", "technical implementation details")],
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
  ];
}

function capsule(): CustomerCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: stakeholders(),
    disclosureUnits: disclosureUnits(),
    responsePolicies: [],
    privateConflicts: [],
    canary: CANARY,
  };
}

function emptyGraph() {
  return { version: 0, nodes: [], edges: [] };
}

function baseAggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "DISCOVERY",
    transcript: [],
    graph: emptyGraph(),
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

function validPatch(): EvidenceGraphPatch {
  return {
    patchId: "p1",
    expectedVersion: 0,
    addNodes: [
      {
        id: "ev-a",
        kind: "fact",
        claim: text("工厂运行三套遗留系统", "The factory runs three legacy systems"),
        status: "active",
        sourceTranscriptIds: [TURN_ID],
        weight: 1,
        version: 0,
      },
    ],
    addEdges: [],
    invalidateNodeIds: [],
  };
}

function validEvidenceOutput(): EvidenceTrackerOutput {
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

function customerFixture() {
  return {
    reply: text("我们运行三套遗留系统。", "We run three legacy systems."),
    stakeholderId: STAKEHOLDER_ID,
    disclosedDisclosureUnitIds: ["d1"],
  };
}

/** Run question.accept → customer.invoke → customer.project, returning the reply aggregate. */
async function runAskCustomer(runtime: FixtureAgentRuntime): Promise<{
  accepted: Awaited<ReturnType<typeof runQuestionAccept>>;
  projected: Awaited<ReturnType<typeof runCustomerProject>>;
}> {
  const state = baseAggregate();
  const accepted = await runQuestionAccept({
    state,
    question: QUESTION,
    stakeholderId: STAKEHOLDER_ID,
    commandId: COMMAND_ID,
  });
  const customer = await runCustomerInvoke({
    runtime,
    state: accepted.updatedState,
    capsule: capsule(),
    commandId: COMMAND_ID,
  });
  const projected = await runCustomerProject({
    state: accepted.updatedState,
    capsule: capsule(),
    turn: customer.turn,
    commandId: COMMAND_ID,
  });
  return { accepted, projected };
}

describe("discovery subgraph — happy path ask turn", () => {
  it("produces the ordered ask-turn events", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        [`customer:${COMMAND_ID}:customer`]: customerFixture(),
        [`evidence_tracker:${COMMAND_ID}:evidence`]: validEvidenceOutput(),
      },
    });
    const { accepted, projected } = await runAskCustomer(runtime);

    const evidence = await runEvidenceInvoke({
      runtime,
      state: projected.updatedState,
      commandId: COMMAND_ID,
    });
    const guarded = await runEvidencePatchGuard({
      state: projected.updatedState,
      evidence: evidence.evidence,
    });
    const applied = await runEvidencePatchApply({
      state: projected.updatedState,
      evidence: evidence.evidence,
      commandId: COMMAND_ID,
    });
    const metrics = await runMetricsCompute({
      state: applied.updatedState,
      evidence: evidence.evidence,
      commandId: COMMAND_ID,
    });

    const events = [
      ...accepted.events,
      ...projected.events,
      ...guarded.events,
      ...applied.events,
      ...metrics.events,
    ];
    expect(events.map((event) => event.type)).toEqual([
      "question.asked",
      "customer.replied",
      "evidence.patched",
      "question.assessed",
    ]);

    // The ask protocol admits exactly these (required + optional) event types.
    const proto = EVENT_PROTOCOLS.ask;
    const allowed = new Set([...proto.required, ...(proto.optional ?? [])]);
    for (const event of events) expect(allowed.has(event.type)).toBe(true);
    for (const required of proto.required) {
      expect(events.map((event) => event.type)).toContain(required);
    }
  });

  it("folds the customer reply into the transcript and the patch into the graph", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        [`customer:${COMMAND_ID}:customer`]: customerFixture(),
        [`evidence_tracker:${COMMAND_ID}:evidence`]: validEvidenceOutput(),
      },
    });
    const { accepted, projected } = await runAskCustomer(runtime);

    expect(accepted.updatedState.pendingQuestion).toEqual({
      question: QUESTION,
      stakeholderId: STAKEHOLDER_ID,
    });
    expect(projected.updatedState.pendingQuestion).toBeNull();
    expect(projected.updatedState.transcript).toHaveLength(1);
    expect(projected.updatedState.transcript[0].turnId).toBe(TURN_ID);
    expect(projected.updatedState.disclosedDisclosureUnitIds).toEqual(["d1"]);

    const evidence = await runEvidenceInvoke({
      runtime,
      state: projected.updatedState,
      commandId: COMMAND_ID,
    });
    const applied = await runEvidencePatchApply({
      state: projected.updatedState,
      evidence: evidence.evidence,
      commandId: COMMAND_ID,
    });
    expect(applied.updatedState.graph.version).toBe(1);
    expect(applied.updatedState.graph.nodes).toHaveLength(1);
  });

  it("computes the deterministic 0..1 composite metric", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        [`customer:${COMMAND_ID}:customer`]: customerFixture(),
        [`evidence_tracker:${COMMAND_ID}:evidence`]: validEvidenceOutput(),
      },
    });
    const { projected } = await runAskCustomer(runtime);
    const evidence = await runEvidenceInvoke({
      runtime,
      state: projected.updatedState,
      commandId: COMMAND_ID,
    });
    const applied = await runEvidencePatchApply({
      state: projected.updatedState,
      evidence: evidence.evidence,
      commandId: COMMAND_ID,
    });
    const metrics = await runMetricsCompute({
      state: applied.updatedState,
      evidence: evidence.evidence,
      commandId: COMMAND_ID,
    });

    // (0.9 + 0.8 + 1 + (1 - 0)) / 4 = 0.925
    expect(metrics.metrics.composite).toBeCloseTo(0.925);
    expect(metrics.metrics.questionAssessment).toEqual(
      validEvidenceOutput().questionAssessment,
    );
    expect(metrics.events[0]).toMatchObject({
      type: "question.assessed",
      questionId: COMMAND_ID,
      judgment: { judgmentId: `${COMMAND_ID}:evidence` },
    });
  });
});

describe("discovery subgraph — rejections and failures", () => {
  it("question.accept rejects a non-DISCOVERY phase", async () => {
    const error = await runQuestionAccept({
      state: baseAggregate({ phase: "PROBLEM_FRAMING" }),
      question: QUESTION,
      stakeholderId: STAKEHOLDER_ID,
      commandId: COMMAND_ID,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("INVALID_PHASE_COMMAND");
  });

  it("customer.project re-validates the turn's domain references", async () => {
    const accepted = await runQuestionAccept({
      state: baseAggregate(),
      question: QUESTION,
      stakeholderId: STAKEHOLDER_ID,
      commandId: COMMAND_ID,
    });
    const badTurn: CustomerTurn = {
      reply: text("好的。", "Okay."),
      stakeholderId: "unknown-stakeholder",
      disclosedDisclosureUnitIds: [],
    };
    const error = await runCustomerProject({
      state: accepted.updatedState,
      capsule: capsule(),
      turn: badTurn,
      commandId: COMMAND_ID,
    }).catch((e) => e);
    expect((error as { code?: string }).code).toBe("AGENT_OUTPUT_DOMAIN_INVALID");
  });

  it("evidence.patch.guard rejects a version-mismatched patch", async () => {
    const fakeEvidence: EvidenceTurnResult = {
      patch: { ...validPatch(), expectedVersion: 5 },
      questionAssessment: validEvidenceOutput().questionAssessment,
      invocationId: "inv-1",
      modelId: null,
      rawOutputDigest: "a".repeat(64),
      promptDigest: "b".repeat(64),
    };
    const error = await runEvidencePatchGuard({
      state: baseAggregate(),
      evidence: fakeEvidence,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("EVIDENCE_PATCH_VERSION_MISMATCH");
  });

  it("tracker failure routes to evidence.pending, not evidence.patched", async () => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        [`customer:${COMMAND_ID}:customer`]: customerFixture(),
        // Deliberately no `evidence_tracker` fixture: extraction must fail.
      },
    });
    const { accepted, projected } = await runAskCustomer(runtime);

    const error = await runEvidenceInvoke({
      runtime,
      state: projected.updatedState,
      commandId: COMMAND_ID,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);

    const pending = await runEvidencePending({
      state: projected.updatedState,
      commandId: COMMAND_ID,
      error,
    });

    const events = [...accepted.events, ...projected.events, ...pending.events];
    expect(events.map((event) => event.type)).toEqual([
      "question.asked",
      "customer.replied",
      "evidence.pending",
    ]);
    expect(events.map((event) => event.type)).not.toContain("evidence.patched");

    // The customer reply is retained; only the STABLE code is learner-visible.
    expect(pending.updatedState.transcript).toHaveLength(1);
    expect(pending.pendingEvidence.code).toBe("EVIDENCE_EXTRACTION_FAILED");
    expect(pending.pendingEvidence.turnId).toBe(TURN_ID);
    expect(JSON.stringify(pending)).not.toContain(CANARY);
  });

  it("frame gate rejects with FRAME_BLOCKED on pending evidence", () => {
    expect(noPendingEvidence(null)).toEqual({ ok: true });

    const blocked = noPendingEvidence({
      turnId: TURN_ID,
      code: "EVIDENCE_EXTRACTION_FAILED",
    });
    expect(blocked).toEqual({
      ok: false,
      code: FRAME_BLOCKED,
      evidence: { turnId: TURN_ID },
    });

    const registered = GUARD_REGISTRY[GUARD_IDS.NO_PENDING_EVIDENCE];
    expect(typeof registered).toBe("function");
    expect(registered({ turnId: TURN_ID, code: "x" })).toEqual(blocked);
  });
});

describe("discovery subgraph — handler definitions", () => {
  it("declares phase, kind, context policy, and failure policy", () => {
    const byId = new Map(handlers.map((h) => [h.definition.id, h.definition]));

    expect(byId.get("discovery.question.accept")).toMatchObject({
      phase: "DISCOVERY",
      kind: "guard",
    });
    expect(byId.get("customer.invoke")).toMatchObject({
      phase: "DISCOVERY",
      kind: "agent",
    });
    expect(byId.get("customer.invoke")?.contextPolicy).toEqual({
      role: "customer",
      capsule: "customer",
    });
    expect(byId.get("customer.invoke")?.failurePolicy).toMatchObject({
      failureClass: "TRANSIENT_RUNTIME",
      retry: true,
    });

    expect(byId.get("customer.project")).toMatchObject({
      phase: "DISCOVERY",
      kind: "deterministic",
    });

    expect(byId.get("evidence.invoke")).toMatchObject({
      phase: "DISCOVERY",
      kind: "agent",
    });
    expect(byId.get("evidence.invoke")?.contextPolicy).toEqual({
      role: "evidence_tracker",
    });
    expect(byId.get("evidence.invoke")?.failurePolicy).toMatchObject({
      failureClass: "TRANSIENT_RUNTIME",
      retry: true,
    });

    expect(byId.get("evidence.patch.guard")).toMatchObject({
      phase: "DISCOVERY",
      kind: "guard",
    });
    expect(byId.get("evidence.patch.apply")).toMatchObject({
      phase: "DISCOVERY",
      kind: "deterministic",
    });
    expect(byId.get("discovery.metrics.compute")).toMatchObject({
      phase: "DISCOVERY",
      kind: "deterministic",
    });
    expect(byId.get("evidence.pending")).toMatchObject({
      phase: "DISCOVERY",
      kind: "deterministic",
    });

    // Exactly the discovery handlers are exported.
    expect(handlers.map((h) => h.definition.id).sort()).toEqual([
      "customer.invoke",
      "customer.project",
      "discovery.metrics.compute",
      "discovery.question.accept",
      "evidence.invoke",
      "evidence.patch.apply",
      "evidence.patch.guard",
      "evidence.pending",
    ]);
  });
});
