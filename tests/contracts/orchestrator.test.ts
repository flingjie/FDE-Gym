import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import {
  assertFrameAllowed,
  computeDiscoveryMetrics,
  FRAME_BLOCKED,
  prepareDiscoveryTurn,
  prepareRepairPendingEvidence,
  type RunDiscoveryTurnInput,
} from "../../src/core/orchestrator";
import { loadEvents, loadRun } from "../../src/core/event-store";
import { commitPrepared } from "../helpers/commit-prepared";
import { foldRunAggregate } from "../../src/replay/projector";
import type { RunAggregate } from "../../src/core/aggregate";
import type { CustomerCapsule } from "../../src/scenarios/schema";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CANARY = "CUSTOMER_CANARY_SECRET_7f3a9c1e";

function capsule(): CustomerCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: [
      {
        id: "s-owner",
        role: text("企业主", "Business owner"),
        persona: text("企业主", "Owner"),
        concerns: [text("成本", "cost")],
        blindSpots: [],
      },
    ],
    disclosureUnits: [
      { id: "d1", topic: "workflow", text: text("三套遗留系统", "three legacy systems"), prerequisites: [], evidenceId: "e1" },
    ],
    responsePolicies: [],
    privateConflicts: [],
    canary: CANARY,
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
    pendingQuestion: null,
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    pendingEvidence: null,
    clarificationBudgetUsed: 0,
    ...overrides,
  };
}

function customerOutput() {
  return {
    reply: text("我们运行三套遗留系统。", "We run three legacy systems."),
    stakeholderId: "s-owner",
    disclosedDisclosureUnitIds: ["d1"],
  };
}

function trackerOutput(expectedVersion: number) {
  return {
    patch: {
      patchId: "p1",
      expectedVersion,
      addNodes: [
        {
          id: "ev-a",
          kind: "fact",
          claim: text("工厂运行三套遗留系统", "The factory runs three legacy systems"),
          status: "active",
          sourceTranscriptIds: ["cmd-1:turn"],
          weight: 1,
          version: 0,
        },
      ],
      addEdges: [],
      invalidateNodeIds: [],
    },
    questionAssessment: {
      intentCount: 1,
      atomicity: 1,
      neutrality: 1,
      relevance: 1,
      redundancy: 0,
    },
  };
}

function happyRuntime() {
  return new FixtureAgentRuntime({
    fixtures: {
      "customer:cmd-1:customer": customerOutput(),
      "evidence_tracker:cmd-1:evidence": trackerOutput(0),
    },
  });
}

function runInput(overrides: Partial<RunDiscoveryTurnInput> = {}): RunDiscoveryTurnInput {
  return {
    runtime: happyRuntime(),
    capsule: capsule(),
    state: aggregate(),
    question: "你们有几套遗留系统？",
    stakeholderId: "s-owner",
    commandId: "cmd-1",
    timeoutMs: 1_000,
    ...overrides,
  };
}

let tempDirs: string[] = [];
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "fde-orch-"));
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

describe("discovery turn pipeline", () => {
  it("records question → reply → evidence patch and computes metrics", async () => {
    const baseDir = makeStore();
    const input = runInput();
    const result = await prepareDiscoveryTurn(input);
    await commitPrepared({
      runId: input.state.runId,
      commandId: input.commandId,
      request: { type: "ask", question: input.question, stakeholderId: input.stakeholderId },
      events: result.acceptedEvents,
      result: { runId: result.runId },
      store: { baseDir },
      canaries: [CANARY],
    });

    expect(result.pendingEvidence).toBeNull();
    expect(result.acceptedEvents.map((e) => e.type)).toEqual([
      "question.asked",
      "customer.replied",
      "evidence.patched",
      "question.assessed",
    ]);
    expect(result.metrics).not.toBeNull();
    expect(result.metrics!.questionAssessment.intentCount).toBe(1);
    expect(result.metrics!.composite).toBeCloseTo((1 + 1 + 1 + (1 - 0)) / 4);

    expect(result.updatedState.transcript).toHaveLength(1);
    expect(result.updatedState.transcript[0].question).toBe("你们有几套遗留系统？");
    expect(result.updatedState.disclosedDisclosureUnitIds).toEqual(["d1"]);
    expect(result.updatedState.graph.version).toBe(1);
    expect(result.updatedState.pendingQuestion).toBeNull();

    const loaded = await loadRun("run-1", { baseDir });
    expect(loaded.seq).toBe(4);
  });

  it("retains the customer reply and marks EVIDENCE_PENDING when the tracker fails", async () => {
    const baseDir = makeStore();
    const runtime = new FixtureAgentRuntime({
      fixtures: { "customer:cmd-1:customer": customerOutput() }, // no evidence fixture
    });

    const input = runInput({ runtime });
    const result = await prepareDiscoveryTurn(input);
    await commitPrepared({
      runId: input.state.runId,
      commandId: input.commandId,
      request: { type: "ask", question: input.question, stakeholderId: input.stakeholderId },
      events: result.acceptedEvents,
      result: { runId: result.runId },
      store: { baseDir },
      canaries: [CANARY],
    });

    expect(result.acceptedEvents.map((e) => e.type)).toEqual([
      "question.asked",
      "customer.replied",
      "evidence.pending",
    ]);
    expect(result.pendingEvidence).not.toBeNull();
    expect(result.metrics).toBeNull();
    // The reply is retained even though evidence failed.
    expect(result.updatedState.transcript).toHaveLength(1);
    expect(result.updatedState.graph.version).toBe(0);

    // frame must be blocked while evidence is pending.
    expect(result.pendingEvidence!.code).toBe("EVIDENCE_EXTRACTION_FAILED");
    let frameError: unknown = null;
    try {
      assertFrameAllowed(result.pendingEvidence);
    } catch (error) {
      frameError = error;
    }
    expect((frameError as { code?: string } | null)?.code).toBe(FRAME_BLOCKED);

    const loaded = await loadRun("run-1", { baseDir });
    expect(loaded.seq).toBe(3);
  });

  it("persists the pending marker as a durable event and folds it back on reload", async () => {
    const baseDir = makeStore();
    const runtime = new FixtureAgentRuntime({
      fixtures: { "customer:cmd-1:customer": customerOutput() }, // no evidence fixture
    });

    const input = runInput({ runtime });
    const prepared = await prepareDiscoveryTurn(input);
    await commitPrepared({
      runId: input.state.runId,
      commandId: input.commandId,
      request: { type: "ask", question: input.question, stakeholderId: input.stakeholderId },
      events: prepared.acceptedEvents,
      result: { runId: prepared.runId },
      store: { baseDir },
      canaries: [CANARY],
    });

    // Reload + fold: pendingEvidence is reconstructed from committed events.
    const recorded = await loadEvents("run-1", { baseDir });
    const folded = foldRunAggregate(recorded, "scn-1", "zh-CN");
    expect(folded.pendingEvidence).toEqual({
      turnId: "cmd-1:turn",
      code: "EVIDENCE_EXTRACTION_FAILED",
    });
    expect(() => assertFrameAllowed(folded.pendingEvidence)).toThrow();

    // The persisted failure event carries ONLY turnId + the stable code —
    // never the thrown error message.
    const pendingRecord = recorded.find((event) => event.type === "evidence.pending");
    expect(pendingRecord).toBeDefined();
    expect(pendingRecord).toHaveProperty("turnId", "cmd-1:turn");
    expect(pendingRecord).toHaveProperty("failureCode", "EVIDENCE_EXTRACTION_FAILED");
    expect(pendingRecord).not.toHaveProperty("message");
    expect(pendingRecord).not.toHaveProperty("error");
  });

  it("persists the stable code even when the tracker fails with a distinct internal code", async () => {
    const baseDir = makeStore();
    // A schema-valid tracker output that still trips the leak guard by
    // embedding the hidden canary inside a claim value. `extractEvidence`
    // surfaces this as `LEAK_GUARD_TRIGGERED` — a distinct internal code that
    // must NOT leak into the persisted failure event.
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "customer:cmd-1:customer": customerOutput(),
        "evidence_tracker:cmd-1:evidence": {
          patch: {
            patchId: "p1",
            expectedVersion: 0,
            addNodes: [
              {
                id: "ev-a",
                kind: "fact",
                claim: text(`泄漏 ${CANARY}`, `leak ${CANARY}`),
                status: "active",
                sourceTranscriptIds: ["cmd-1:turn"],
                weight: 1,
                version: 0,
              },
            ],
            addEdges: [],
            invalidateNodeIds: [],
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

    const input = runInput({ runtime });
    const result = await prepareDiscoveryTurn(input);
    await commitPrepared({
      runId: input.state.runId,
      commandId: input.commandId,
      request: { type: "ask", question: input.question, stakeholderId: input.stakeholderId },
      events: result.acceptedEvents,
      result: { runId: result.runId },
      store: { baseDir },
      canaries: [CANARY],
    });

    // The in-memory pendingEvidence must also carry the stable code, never the
    // distinct internal code — this is the object the CLI `ask` projects from.
    expect(result.pendingEvidence).not.toBeNull();
    expect(result.pendingEvidence!.code).toBe("EVIDENCE_EXTRACTION_FAILED");
    expect(result.pendingEvidence!.code).not.toBe("LEAK_GUARD_TRIGGERED");

    const recorded = await loadEvents("run-1", { baseDir });
    const pendingRecord = recorded.find((event) => event.type === "evidence.pending");
    expect(pendingRecord).toBeDefined();
    // The distinct internal code (LEAK_GUARD_TRIGGERED) must NOT be persisted.
    expect(pendingRecord).toHaveProperty("failureCode", "EVIDENCE_EXTRACTION_FAILED");
    expect(pendingRecord).not.toHaveProperty("failureCode", "LEAK_GUARD_TRIGGERED");

    const folded = foldRunAggregate(recorded, "scn-1", "zh-CN");
    expect(folded.pendingEvidence).toEqual({
      turnId: "cmd-1:turn",
      code: "EVIDENCE_EXTRACTION_FAILED",
    });
  });

  it("clears EVIDENCE_PENDING on a successful repair", async () => {
    const baseDir = makeStore();
    const fixtures: Record<string, unknown> = {
      "customer:cmd-1:customer": customerOutput(),
    };
    const noEvidenceRuntime = new FixtureAgentRuntime({ fixtures });

    const input = runInput({ runtime: noEvidenceRuntime });
    const failed = await prepareDiscoveryTurn(input);
    await commitPrepared({
      runId: input.state.runId,
      commandId: input.commandId,
      request: { type: "ask", question: input.question, stakeholderId: input.stakeholderId },
      events: failed.acceptedEvents,
      result: { runId: failed.runId },
      store: { baseDir },
      canaries: [CANARY],
    });
    expect(failed.pendingEvidence).not.toBeNull();

    // Repair: now the evidence fixture exists; extractEvidence reads the last
    // transcript turn (already retained) and applies the patch.
    fixtures["evidence_tracker:cmd-1:evidence"] = trackerOutput(0);
    const repaired = await prepareRepairPendingEvidence({
      runtime: new FixtureAgentRuntime({ fixtures }),
      state: failed.updatedState,
      commandId: "cmd-1",
      timeoutMs: 1_000,
      canaries: [CANARY],
    });
    await commitPrepared({
      runId: repaired.runId,
      commandId: "repair-1",
      request: { type: "repair-evidence" },
      events: repaired.acceptedEvents,
      result: { runId: repaired.runId },
      store: { baseDir },
      canaries: [CANARY],
    });

    expect(repaired.pendingEvidence).toBeNull();
    expect(repaired.metrics).not.toBeNull();
    expect(repaired.updatedState.graph.version).toBe(1);
    expect(() => assertFrameAllowed(repaired.pendingEvidence)).not.toThrow();
    expect(repaired.acceptedEvents.map((e) => e.type)).toEqual([
      "evidence.patched",
      "question.assessed",
      "evidence.resolved",
    ]);

    const loaded = await loadRun("run-1", { baseDir });
    expect(loaded.seq).toBe(6);
  });
});

describe("deterministic per-question metrics", () => {
  it("clamps the composite to 0..1 and is a pure function", () => {
    const a = computeDiscoveryMetrics({
      intentCount: 2,
      atomicity: 0.5,
      neutrality: 0.5,
      relevance: 0.5,
      redundancy: 0.5,
    });
    const b = computeDiscoveryMetrics({
      intentCount: 2,
      atomicity: 0.5,
      neutrality: 0.5,
      relevance: 0.5,
      redundancy: 0.5,
    });
    expect(a).toEqual(b);
    expect(a.composite).toBeCloseTo((0.5 + 0.5 + 0.5 + 0.5) / 4);
    expect(a.composite).toBeGreaterThanOrEqual(0);
    expect(a.composite).toBeLessThanOrEqual(1);
  });
});
