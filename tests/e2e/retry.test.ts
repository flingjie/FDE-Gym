import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRetry,
  INVALID_RETRY_FOCUS,
} from "../../src/core/orchestrator";
import { appendEvents, loadRun } from "../../src/core/event-store";
import {
  ContextFirewallError,
  FIREWALL_INVALID_STATE,
  buildRoleInput,
  type RunAggregate,
} from "../../src/security/context-firewall";
import type { CustomerCapsule } from "../../src/scenarios/schema";
import { calculateScore } from "../../src/scoring/formulas";
import type { RunEvent } from "../../src/core/domain";

const text = (value: string) => ({ "zh-CN": value, "en-US": value });

function customerCapsule(): CustomerCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: [
      { id: "s1", role: text("role"), persona: text("persona"), concerns: [], blindSpots: [] },
    ],
    disclosureUnits: [],
    responsePolicies: [],
    privateConflicts: [],
    canary: "canary",
  };
}

/** A REVIEW-phase parent carrying hidden state that a retry must NOT inherit. */
function parentAggregate(): RunAggregate {
  return {
    runId: "run-parent",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "REVIEW",
    transcript: [
      {
        turnId: "t1",
        seq: 0,
        question: "what is your downtime?",
        customerReply: text("about $2M"),
        stakeholderId: "s1",
      },
    ],
    graph: {
      version: 0,
      nodes: [
        {
          id: "n1",
          kind: "fact",
          claim: text("hidden fact"),
          status: "active",
          sourceTranscriptIds: ["t1"],
          weight: 1,
          version: 0,
        },
      ],
      edges: [],
    },
    disclosedDisclosureUnitIds: ["du-secret"],
    grantedHints: [{ topic: "workflow", level: 1 }],
    pendingQuestion: null,
    hintRequest: null,
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
  };
}

/** Persist the parent run through the phase ladder to REVIEW (8 events). */
async function seedParent(store: { baseDir: string }): Promise<void> {
  const runId = "run-parent";
  const scenarioId = "scn-1";
  const locale = "zh-CN" as const;
  const events: RunEvent[] = [
    { type: "run.started", runId, commandId: "p:start", scenarioId, locale },
    { type: "phase.changed", runId, commandId: "p:start", from: "SCENARIO", to: "SCENARIO" },
    { type: "phase.changed", runId, commandId: "p:accept", from: "SCENARIO", to: "DISCOVERY" },
    { type: "phase.changed", runId, commandId: "p:frame", from: "DISCOVERY", to: "PROBLEM_FRAMING" },
    { type: "phase.changed", runId, commandId: "p:brief", from: "PROBLEM_FRAMING", to: "SOLUTION_DESIGN" },
    { type: "phase.changed", runId, commandId: "p:design", from: "SOLUTION_DESIGN", to: "CHALLENGE" },
    { type: "phase.changed", runId, commandId: "p:challenge", from: "CHALLENGE", to: "PITCH" },
    { type: "phase.changed", runId, commandId: "p:pitch", from: "PITCH", to: "REVIEW" },
  ];
  await appendEvents(runId, events, store);
}

let tempDirs: string[] = [];
function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-retry-"));
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

const FOCUS = [text("Focus on evidence support"), text("Address the trust contradiction")];

describe("retry: clean second attempt", () => {
  it("creates a new run linked to its parent, cleared of all previous state", async () => {
    const baseDir = makeStore();
    const store = { baseDir };
    await seedParent(store);

    const result = await createRetry(parentAggregate(), {
      newRunId: "run-child",
      commandId: "cmd-retry",
      seed: 7,
      focusSummaries: FOCUS,
      store,
    });

    // New id + parent link.
    expect(result.runId).toBe("run-child");
    expect(result.parentRunId).toBe("run-parent");
    expect(result.runId).not.toBe(result.parentRunId);

    // Scenario + seed kept; locale kept.
    expect(result.scenarioId).toBe("scn-1");
    expect(result.locale).toBe("zh-CN");
    expect(result.seed).toBe(7);

    // New run starts in DISCOVERY.
    expect(result.state).toEqual({ runId: "run-child", phase: "DISCOVERY", seq: 3 });

    // Cleared graph / ledger / transcript / hints / artifacts.
    expect(result.aggregate.graph).toEqual({ version: 0, nodes: [], edges: [] });
    expect(result.aggregate.disclosedDisclosureUnitIds).toEqual([]);
    expect(result.aggregate.transcript).toEqual([]);
    expect(result.aggregate.grantedHints).toEqual([]);
    expect(result.aggregate.brief).toBeNull();
    expect(result.aggregate.proposal).toBeNull();
    expect(result.aggregate.pitch).toBeNull();
    expect(result.aggregate.challengeResponses).toEqual([]);

    // Only the 2-3 focus summaries are carried into the new run.
    expect(result.aggregate.previousAttemptReview).toEqual({ focusSummaries: FOCUS });

    // Durable link recorded on the parent; the new run replays to DISCOVERY.
    const parentEvents = readFileSync(
      join(baseDir, "runs", "run-parent", "events.jsonl"),
      "utf8",
    );
    expect(parentEvents).toContain("retry.started");
    expect(parentEvents).toContain("run-child");

    const parentLoaded = await loadRun("run-parent", store);
    expect(parentLoaded.phase).toBe("REVIEW");
    expect(parentLoaded.seq).toBe(9); // 8 seeded + retry.started

    const childLoaded = await loadRun("run-child", store);
    expect(childLoaded.phase).toBe("DISCOVERY");
    expect(childLoaded.seq).toBe(3);
  });

  it("gives Customer and Evidence Tracker no previous transcript", async () => {
    const baseDir = makeStore();
    const store = { baseDir };
    await seedParent(store);

    const result = await createRetry(parentAggregate(), {
      newRunId: "run-child",
      commandId: "cmd-retry",
      focusSummaries: FOCUS,
      store,
    });

    // Evidence Tracker has no turn to see.
    const trackerError = (() => {
      try {
        buildRoleInput("evidence_tracker", result.aggregate);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(trackerError).toBeInstanceOf(ContextFirewallError);
    expect((trackerError as ContextFirewallError).code).toBe(FIREWALL_INVALID_STATE);

    // Customer has no pending question (no stale dialogue).
    const customerError = (() => {
      try {
        buildRoleInput("customer", result.aggregate, customerCapsule());
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(customerError).toBeInstanceOf(ContextFirewallError);
    expect((customerError as ContextFirewallError).code).toBe(FIREWALL_INVALID_STATE);
  });

  it("rejects a retry outside REVIEW and with the wrong number of focus summaries", async () => {
    const baseDir = makeStore();
    const store = { baseDir };

    const wrongPhase = await createRetry(
      { ...parentAggregate(), phase: "DISCOVERY" },
      { newRunId: "run-x", commandId: "cmd-x", focusSummaries: FOCUS, store },
    ).catch((error) => error);
    expect((wrongPhase as { code?: string }).code).toBe("INVALID_PHASE_COMMAND");

    const tooFew = await createRetry(parentAggregate(), {
      newRunId: "run-y",
      commandId: "cmd-y",
      focusSummaries: [text("only one")],
      store,
    }).catch((error) => error);
    expect((tooFew as { code?: string }).code).toBe(INVALID_RETRY_FOCUS);

    const tooMany = await createRetry(parentAggregate(), {
      newRunId: "run-z",
      commandId: "cmd-z",
      focusSummaries: [text("a"), text("b"), text("c"), text("d")],
      store,
    }).catch((error) => error);
    expect((tooMany as { code?: string }).code).toBe(INVALID_RETRY_FOCUS);
  });

  it("scores a repeated question as strictly less efficient (scoring path)", () => {
    const fresh = calculateScore({
      coverage: 0.5,
      totalExpectedWeight: 10,
      questionBudget: 10,
      questions: [
        { newlyRevealedWeight: 5, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
      ],
      stakeholderCoverage: 50,
      contradictionHandling: 50,
      stageScores: { framing: 70, solution: 70, challenge: 70, pitch: 70, process: 70 },
      hintCounts: { l1: 0, l2: 0, l3: 0 },
      criticalUnsupported: 0,
      unacknowledgedCriticalContradictions: 0,
      briefSupport: 0.8,
      pitchExplicitAsk: true,
      leakGuardViolation: false,
    });

    const repeated = calculateScore({
      coverage: 0.5,
      totalExpectedWeight: 10,
      questionBudget: 10,
      questions: [
        { newlyRevealedWeight: 0, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 1 },
      ],
      stakeholderCoverage: 50,
      contradictionHandling: 50,
      stageScores: { framing: 70, solution: 70, challenge: 70, pitch: 70, process: 70 },
      hintCounts: { l1: 0, l2: 0, l3: 0 },
      criticalUnsupported: 0,
      unacknowledgedCriticalContradictions: 0,
      briefSupport: 0.8,
      pitchExplicitAsk: true,
      leakGuardViolation: false,
    });

    expect(repeated.questions[0].efficiency).toBe(0);
    expect(repeated.questions[0].efficiency).toBeLessThan(fresh.questions[0].efficiency);
    expect(fresh.questions[0].efficiency).toBe(100);
  });
});
