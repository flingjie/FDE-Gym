import { describe, expect, it } from "vitest";

import { FixtureAgentRuntime } from "../../../src/agents/fixture-runtime";
import type { RunAggregate } from "../../../src/core/aggregate";
import {
  BriefSubmittedEventSchema,
  BriefValidatedEventSchema,
  type BriefValidationResult,
  type ClaimEntailment,
  type ProblemBrief,
} from "../../../src/core/domain";
import type { EvaluatorCapsule } from "../../../src/scenarios/schema";
import { EVENT_PROTOCOLS } from "../../../src/graph/event-protocols";
import {
  BRIEF_STRUCTURE_INVALID,
  BRIEF_SUPPORT_INSUFFICIENT,
  CLARIFICATION_BUDGET_EXCEEDED,
  DEFAULT_CLARIFICATION_BUDGET,
  GUARD_IDS,
} from "../../../src/graph/guards";
import {
  FRAMING_BRIEF_NOT_PROVIDED,
  handlers,
  runBriefAccept,
  runBriefStructureGuard,
  runBriefSupportGuard,
  runCoachBriefInvoke,
  runDiscoveryClarify,
  runFramingRevise,
} from "../../../src/graph/nodes/framing/index";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CANARY = "EVALUATOR_CANARY_SECRET_9d4f2a7b";
const COMMAND_ID = "cmd-1";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function framingGraph() {
  return {
    version: 0,
    nodes: [
      {
        id: "e1",
        kind: "fact",
        claim: text("工厂运行三套遗留系统", "The factory runs three legacy systems"),
        status: "active",
        sourceTranscriptIds: ["turn-1"],
        weight: 1,
        version: 0,
      },
    ],
    edges: [],
  };
}

function baseAggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "PROBLEM_FRAMING",
    transcript: [],
    graph: framingGraph(),
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: null,
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    injectedChallenges: [],
    pendingEvidence: null,
    clarificationBudgetUsed: 0,
    ...overrides,
  };
}

function framingBrief(overrides: Partial<ProblemBrief> = {}): ProblemBrief {
  return {
    id: "brief-1",
    problemStatement: text("告警处理效率低下", "Alert handling is inefficient"),
    goal: text("降低告警处理负担", "Reduce alert-handling burden"),
    constraints: [],
    claims: [{ id: "claim-1", statement: text("三套遗留系统", "Three legacy systems"), weight: "minor", evidenceIds: ["e1"] }],
    successMeasures: [text("平均处理时间下降", "Mean handling time drops")],
    unknowns: [text("根本原因", "Root cause")],
    contradictions: [],
    ...overrides,
  };
}

function evaluatorCapsule(): EvaluatorCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    expectedEvidence: [],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [],
    passGates: [],
    canary: CANARY,
  };
}

function coachOutput(entailments: ClaimEntailment[] = []): BriefValidationResult {
  return {
    passed: true,
    entailments,
    missingCategories: [],
    unsupportedClaimIds: [],
    feedback: text("语义校验通过", "Semantic checks passed"),
  };
}

/** A Coach fixture that classifies the single claim as supported. */
const SUPPORTED = coachOutput([{ claimId: "claim-1", entailment: "supported" }]);
/** A Coach fixture that classifies the single claim as unsupported. */
const UNSUPPORTED = coachOutput([{ claimId: "claim-1", entailment: "unsupported" }]);

function coachRuntime(fixture: BriefValidationResult): FixtureAgentRuntime {
  return new FixtureAgentRuntime({
    fixtures: { [`coach_evaluator:${COMMAND_ID}:coach`]: fixture },
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("framing subgraph — happy path", () => {
  it("passes the gate: SOLUTION_DESIGN with brief.submitted + brief.validated + phase.changed", async () => {
    const state = baseAggregate();
    const brief = framingBrief();

    const accepted = await runBriefAccept({ state, brief, commandId: COMMAND_ID });
    expect(accepted.events.map((event) => event.type)).toEqual(["brief.submitted"]);
    expect(accepted.updatedState.brief).toEqual(brief);

    const structure = await runBriefStructureGuard({ state: accepted.updatedState });
    expect(structure.passed).toBe(true);
    expect(structure.guardId).toBe(GUARD_IDS.BRIEF_STRUCTURE_VALID);

    const coach = await runCoachBriefInvoke({
      runtime: coachRuntime(SUPPORTED),
      state: accepted.updatedState,
      capsule: evaluatorCapsule(),
      structure: structure.structure,
      commandId: COMMAND_ID,
    });
    expect(coach.coachResult).not.toBeNull();

    const gate = await runBriefSupportGuard({
      state: accepted.updatedState,
      structure: structure.structure,
      coachResult: coach.coachResult,
      commandId: COMMAND_ID,
    });

    expect(gate.passed).toBe(true);
    expect(gate.supportRatio).toBe(1);
    expect(gate.events.map((event) => event.type)).toEqual(["brief.validated", "phase.changed"]);
    expect(gate.updatedState.phase).toBe("SOLUTION_DESIGN");

    // The full submit-brief batch: required brief.submitted + brief.validated,
    // optional phase.changed — exactly the protocol's contract.
    const events = [...accepted.events, ...gate.events];
    expect(events.map((event) => event.type)).toEqual([
      "brief.submitted",
      "brief.validated",
      "phase.changed",
    ]);
    const proto = EVENT_PROTOCOLS["submit-brief"];
    const allowed = new Set([...proto.required, ...(proto.optional ?? [])]);
    for (const event of events) expect(allowed.has(event.type)).toBe(true);
    for (const required of proto.required) {
      expect(events.map((event) => event.type)).toContain(required);
    }

    // The authored events satisfy the strict domain schemas.
    expect(BriefSubmittedEventSchema.safeParse(events[0]).success).toBe(true);
    expect(BriefValidatedEventSchema.safeParse(events[1]).success).toBe(true);

    const validated = events[1];
    expect(validated.type === "brief.validated" && validated.result.passed).toBe(true);
    expect(validated.type === "brief.validated" && validated.judgment?.judgmentId).toBe(
      `${COMMAND_ID}:coach`,
    );
    const phaseChanged = events[2];
    expect(phaseChanged.type === "phase.changed" && phaseChanged.from).toBe("PROBLEM_FRAMING");
    expect(phaseChanged.type === "phase.changed" && phaseChanged.to).toBe("SOLUTION_DESIGN");
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

describe("framing subgraph — rejections", () => {
  it("rejects on insufficient support: stays PROBLEM_FRAMING with no phase.changed", async () => {
    const brief = framingBrief();
    const state = { ...baseAggregate(), brief };

    const structure = await runBriefStructureGuard({ state });
    expect(structure.passed).toBe(true);

    const coach = await runCoachBriefInvoke({
      runtime: coachRuntime(UNSUPPORTED),
      state,
      capsule: evaluatorCapsule(),
      structure: structure.structure,
      commandId: COMMAND_ID,
    });
    expect(coach.coachResult).not.toBeNull();

    const gate = await runBriefSupportGuard({
      state,
      structure: structure.structure,
      coachResult: coach.coachResult,
      commandId: COMMAND_ID,
    });

    expect(gate.passed).toBe(false);
    expect(gate.code).toBe(BRIEF_SUPPORT_INSUFFICIENT);
    expect(gate.supportRatio).toBeLessThan(0.75);
    expect(gate.events.map((event) => event.type)).toEqual(["brief.validated"]);
    expect(gate.updatedState.phase).toBe("PROBLEM_FRAMING");
    expect(gate.events.map((event) => event.type)).not.toContain("phase.changed");

    // The reject self-loop emits nothing and stays put.
    const revise = await runFramingRevise({ state: gate.updatedState });
    expect(revise.events).toEqual([]);
    expect(revise.updatedState.phase).toBe("PROBLEM_FRAMING");
  });

  it("rejects a structurally invalid brief (dangling reference) and stays in PROBLEM_FRAMING", async () => {
    const brief = framingBrief({
      claims: [{ id: "claim-1", statement: text("三套遗留系统", "Three legacy systems"), weight: "minor", evidenceIds: ["missing"] }],
    });
    const state = { ...baseAggregate(), brief };

    const structure = await runBriefStructureGuard({ state });
    expect(structure.passed).toBe(false);

    // A dangling reference skips the Coach (its strict input schema would reject it).
    const coach = await runCoachBriefInvoke({
      runtime: coachRuntime(SUPPORTED),
      state,
      capsule: evaluatorCapsule(),
      structure: structure.structure,
      commandId: COMMAND_ID,
    });
    expect(coach.coachResult).toBeNull();

    const gate = await runBriefSupportGuard({
      state,
      structure: structure.structure,
      coachResult: coach.coachResult,
      commandId: COMMAND_ID,
    });

    expect(gate.passed).toBe(false);
    expect(gate.code).toBe(BRIEF_STRUCTURE_INVALID);
    expect(gate.events.map((event) => event.type)).toEqual(["brief.validated"]);
    expect(gate.updatedState.phase).toBe("PROBLEM_FRAMING");
    expect(gate.events.map((event) => event.type)).not.toContain("phase.changed");

    const validated = gate.events[0];
    expect(validated.type === "brief.validated" && validated.result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clarify back-edge
// ---------------------------------------------------------------------------

describe("framing subgraph — clarify back-edge", () => {
  it("returns to DISCOVERY and consumes one clarification when budget is available", async () => {
    const result = await runDiscoveryClarify({ state: baseAggregate(), commandId: COMMAND_ID });

    expect(result.events.map((event) => event.type)).toEqual(["phase.changed"]);
    expect(result.updatedState.phase).toBe("DISCOVERY");
    expect(result.updatedState.clarificationBudgetUsed).toBe(1);

    const phaseChanged = result.events[0];
    expect(phaseChanged.type === "phase.changed" && phaseChanged.from).toBe("PROBLEM_FRAMING");
    expect(phaseChanged.type === "phase.changed" && phaseChanged.to).toBe("DISCOVERY");
    expect(EVENT_PROTOCOLS.clarify.required).toEqual(["phase.changed"]);
  });

  it("throws CLARIFICATION_BUDGET_EXCEEDED when the budget is exhausted", async () => {
    const state = { ...baseAggregate(), clarificationBudgetUsed: DEFAULT_CLARIFICATION_BUDGET };
    const error = await runDiscoveryClarify({ state, commandId: COMMAND_ID }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(CLARIFICATION_BUDGET_EXCEEDED);
  });

  it("throws INVALID_PHASE_COMMAND when clarify is attempted outside PROBLEM_FRAMING", async () => {
    const error = await runDiscoveryClarify({
      state: baseAggregate({ phase: "DISCOVERY" }),
      commandId: COMMAND_ID,
    }).catch((e) => e);
    expect((error as { code?: string }).code).toBe("INVALID_PHASE_COMMAND");
  });
});

// ---------------------------------------------------------------------------
// brief.accept guard
// ---------------------------------------------------------------------------

describe("framing subgraph — brief.accept guard", () => {
  it("rejects a missing brief with FRAMING_BRIEF_NOT_PROVIDED", async () => {
    const error = await runBriefAccept({
      state: baseAggregate(),
      brief: null,
      commandId: COMMAND_ID,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(FRAMING_BRIEF_NOT_PROVIDED);
  });

  it("rejects a non-PROBLEM_FRAMING phase with INVALID_PHASE_COMMAND", async () => {
    const error = await runBriefAccept({
      state: baseAggregate({ phase: "DISCOVERY" }),
      brief: framingBrief(),
      commandId: COMMAND_ID,
    }).catch((e) => e);
    expect((error as { code?: string }).code).toBe("INVALID_PHASE_COMMAND");
  });
});

// ---------------------------------------------------------------------------
// Handler definitions
// ---------------------------------------------------------------------------

describe("framing subgraph — handler definitions", () => {
  it("declares the six nodes with the expected ids, kinds, and policies", () => {
    const byId = new Map(handlers.map((h) => [h.definition.id, h.definition]));

    expect(handlers.map((h) => h.definition.id).sort()).toEqual([
      "brief.accept",
      "brief.structure.guard",
      "brief.support.guard",
      "coach.brief.invoke",
      "discovery.clarify",
      "framing.revise",
    ]);

    expect(byId.get("brief.accept")).toMatchObject({ phase: "PROBLEM_FRAMING", kind: "guard" });
    expect(byId.get("brief.structure.guard")).toMatchObject({ phase: "PROBLEM_FRAMING", kind: "guard" });
    expect(byId.get("brief.support.guard")).toMatchObject({ phase: "PROBLEM_FRAMING", kind: "guard" });
    expect(byId.get("framing.revise")).toMatchObject({ phase: "PROBLEM_FRAMING", kind: "deterministic" });
    expect(byId.get("discovery.clarify")).toMatchObject({ phase: "PROBLEM_FRAMING", kind: "deterministic" });

    expect(byId.get("coach.brief.invoke")).toMatchObject({
      phase: "PROBLEM_FRAMING",
      kind: "agent",
      contextPolicy: { role: "coach_evaluator", capsule: "evaluator" },
    });
    expect(byId.get("coach.brief.invoke")?.failurePolicy).toMatchObject({
      failureClass: "INVALID_MODEL_OUTPUT",
      retry: true,
    });
  });
});
