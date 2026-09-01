import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INVALID_RETRY_FOCUS,
  prepareRetry,
  prepareStartRetry,
} from "../../src/core/orchestrator";
import { appendEvents, canonicalJson, loadEvents, loadRun } from "../../src/core/event-store";
import {
  executeCommandTransaction,
  type JsonValue,
} from "../../src/core/command-transaction";
import { commitPrepared } from "../helpers/commit-prepared";
import { COMMAND_ID_CONFLICT } from "../../src/core/errors";
import { foldRunAggregate } from "../../src/replay/projector";
import {
  ContextFirewallError,
  FIREWALL_INVALID_STATE,
  buildRoleInput,
} from "../../src/security/context-firewall";
import type { RunAggregate } from "../../src/core/aggregate";
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
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
  };
}

function retryReadyAggregate(): RunAggregate {
  return { ...parentAggregate(), phase: "RETRY_READY" };
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

/** Invoke a pure prepare function and return its stable error code (or undefined). */
function errorCodeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: unknown }).code as string | undefined;
  }
}

describe("retry: two-step clean second attempt", () => {
  it("step 1: retry marks the parent RETRY_READY and persists focus summaries", async () => {
    const baseDir = makeStore();
    const store = { baseDir };
    await seedParent(store);

    const prepared = prepareRetry(parentAggregate(), {
      commandId: "cmd-retry",
      focusSummaries: FOCUS,
    });
    expect(prepared.parentEvents.map((event) => event.type)).toEqual([
      "retry.started",
      "phase.changed",
    ]);
    expect(prepared.state.phase).toBe("RETRY_READY");

    const result = await commitPrepared({
      runId: prepared.parentRunId,
      commandId: "cmd-retry",
      request: { type: "retry", focusSummaries: FOCUS },
      events: prepared.parentEvents,
      result: {
        runId: prepared.parentRunId,
        scenarioId: prepared.scenarioId,
        locale: prepared.locale,
        phase: "RETRY_READY",
        focusSummaries: FOCUS,
      },
      store,
    });
    expect(result.phase).toBe("RETRY_READY");

    // No child exists yet — retry only marks readiness.
    const parentLoaded = await loadRun("run-parent", store);
    expect(parentLoaded.phase).toBe("RETRY_READY");
    expect(parentLoaded.seq).toBe(10); // 8 seeded + retry.started + phase.changed

    const parentEvents = readFileSync(join(baseDir, "runs", "run-parent", "events.jsonl"), "utf8");
    expect(parentEvents).toContain("retry.started");
    expect(parentEvents).toContain("RETRY_READY");
  });

  it("step 2: start-retry spawns a cleared child at DISCOVERY", async () => {
    const baseDir = makeStore();
    const store = { baseDir };
    await seedParent(store);

    // Step 1: retry -> RETRY_READY.
    await commitPrepared({
      runId: "run-parent",
      commandId: "cmd-retry",
      request: { type: "retry", focusSummaries: FOCUS },
      events: prepareRetry(parentAggregate(), { commandId: "cmd-retry", focusSummaries: FOCUS })
        .parentEvents,
      result: { runId: "run-parent", scenarioId: "scn-1", locale: "zh-CN", phase: "RETRY_READY", focusSummaries: FOCUS },
      store,
    });

    // Step 2: start-retry -> child.
    const prepared = prepareStartRetry(retryReadyAggregate(), {
      newRunId: "run-child",
      commandId: "cmd-start-retry",
      seed: 7,
      focusSummaries: FOCUS,
    });
    expect(prepared.newRunEvents.map((event) => event.type)).toEqual([
      "run.started",
      "phase.changed",
      "retry.focus",
      "phase.changed",
    ]);

    const result = await commitPrepared({
      runId: "run-parent",
      commandId: "cmd-start-retry",
      request: { type: "start-retry", newRunId: "run-child", seed: 7 },
      events: [],
      effects: [
        {
          type: "retry.ensure-child",
          effectId: `${prepared.parentRunId}:cmd-start-retry:child`,
          parentRunId: prepared.parentRunId,
          childRunId: prepared.runId,
          events: prepared.newRunEvents,
        },
      ],
      result: {
        runId: prepared.runId,
        parentRunId: prepared.parentRunId,
        scenarioId: prepared.scenarioId,
        locale: prepared.locale,
        phase: "DISCOVERY",
        focusSummaries: FOCUS,
      },
      store,
    });

    expect(result.runId).toBe("run-child");
    expect(result.parentRunId).toBe("run-parent");

    const childLoaded = await loadRun("run-child", store);
    expect(childLoaded.phase).toBe("DISCOVERY");
    expect(childLoaded.seq).toBe(4);

    // Cleared graph / ledger / transcript / hints / artifacts; only focus carried.
    const folded = foldRunAggregate(await loadEvents("run-child", store), "scn-1", "zh-CN");
    expect(folded.graph).toEqual({ version: 0, nodes: [], edges: [] });
    expect(folded.disclosedDisclosureUnitIds).toEqual([]);
    expect(folded.transcript).toEqual([]);
    expect(folded.grantedHints).toEqual([]);
    expect(folded.brief).toBeNull();
    expect(folded.proposal).toBeNull();
    expect(folded.pitch).toBeNull();
    expect(folded.challengeResponses).toEqual([]);
    expect(folded.previousAttemptReview).toEqual({ focusSummaries: FOCUS });

    // The parent rests at RETRY_READY.
    const parentLoaded = await loadRun("run-parent", store);
    expect(parentLoaded.phase).toBe("RETRY_READY");
  });

  it("gives Customer and Evidence Tracker no previous transcript", () => {
    const prepared = prepareStartRetry(retryReadyAggregate(), {
      newRunId: "run-child",
      commandId: "cmd-start-retry",
      focusSummaries: FOCUS,
    });

    const trackerError = (() => {
      try {
        buildRoleInput("evidence_tracker", prepared.aggregate);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(trackerError).toBeInstanceOf(ContextFirewallError);
    expect((trackerError as ContextFirewallError).code).toBe(FIREWALL_INVALID_STATE);

    const customerError = (() => {
      try {
        buildRoleInput("customer", prepared.aggregate, customerCapsule());
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(customerError).toBeInstanceOf(ContextFirewallError);
    expect((customerError as ContextFirewallError).code).toBe(FIREWALL_INVALID_STATE);
  });

  it("rejects retry outside REVIEW and with the wrong number of focus summaries", () => {
    expect(
      errorCodeOf(() =>
        prepareRetry(
          { ...parentAggregate(), phase: "DISCOVERY" },
          { commandId: "cmd-x", focusSummaries: FOCUS },
        ),
      ),
    ).toBe("INVALID_PHASE_COMMAND");

    expect(
      errorCodeOf(() =>
        prepareRetry(parentAggregate(), {
          commandId: "cmd-y",
          focusSummaries: [text("only one")],
        }),
      ),
    ).toBe(INVALID_RETRY_FOCUS);

    expect(
      errorCodeOf(() =>
        prepareRetry(parentAggregate(), {
          commandId: "cmd-z",
          focusSummaries: [text("a"), text("b"), text("c"), text("d")],
        }),
      ),
    ).toBe(INVALID_RETRY_FOCUS);
  });

  it("rejects start-retry outside RETRY_READY", () => {
    const wrongPhase = (() => {
      try {
        prepareStartRetry(parentAggregate(), {
          newRunId: "run-x",
          commandId: "cmd-x",
          focusSummaries: FOCUS,
        });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect((wrongPhase as { code?: string }).code).toBe("INVALID_PHASE_COMMAND");
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

// ---------------------------------------------------------------------------
// Recoverable start-retry child creation
// ---------------------------------------------------------------------------

function requestHash(request: JsonValue): string {
  return createHash("sha256").update(canonicalJson(request), "utf8").digest("hex");
}

function writePreparedStartRetry(
  baseDir: string,
  runId: string,
  commandId: string,
  request: JsonValue,
  childRunId: string,
  childEvents: RunEvent[],
): void {
  const dir = join(baseDir, "runs", runId, "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${commandId}.json`),
    JSON.stringify({
      journalVersion: 1,
      runId,
      commandId,
      requestHash: requestHash(request),
      status: "prepared",
      events: [],
      result: {
        runId: childRunId,
        parentRunId: runId,
        scenarioId: "scn-1",
        locale: "zh-CN",
        phase: "DISCOVERY",
        focusSummaries: FOCUS,
      },
      effects: [
        {
          type: "retry.ensure-child",
          effectId: `${runId}:${commandId}:child`,
          parentRunId: runId,
          childRunId,
          events: childEvents,
        },
      ],
    }) + "\n",
    "utf8",
  );
}

/** Step 1 committed: move the seeded parent REVIEW -> RETRY_READY. */
async function markParentRetryReady(store: { baseDir: string }): Promise<void> {
  await seedParent(store);
  const prepared = prepareRetry(parentAggregate(), { commandId: "cmd-retry", focusSummaries: FOCUS });
  await commitPrepared({
    runId: "run-parent",
    commandId: "cmd-retry",
    request: { type: "retry", focusSummaries: FOCUS },
    events: prepared.parentEvents,
    result: {
      runId: "run-parent",
      scenarioId: "scn-1",
      locale: "zh-CN",
      phase: "RETRY_READY",
      focusSummaries: FOCUS,
    },
    store,
  });
}

describe("retry: recoverable start-retry child creation and conflict", () => {
  it("reconstructs previousAttemptReview from the child's committed events", async () => {
    const baseDir = makeStore();
    const store = { baseDir };
    await markParentRetryReady(store);

    const prepared = prepareStartRetry(retryReadyAggregate(), {
      newRunId: "run-child",
      commandId: "cmd-start-retry",
      focusSummaries: FOCUS,
    });
    await commitPrepared({
      runId: "run-parent",
      commandId: "cmd-start-retry",
      request: { type: "start-retry", newRunId: "run-child", seed: null },
      events: [],
      effects: [
        {
          type: "retry.ensure-child",
          effectId: `${prepared.parentRunId}:cmd-start-retry:child`,
          parentRunId: prepared.parentRunId,
          childRunId: prepared.runId,
          events: prepared.newRunEvents,
        },
      ],
      result: { runId: "run-child", parentRunId: "run-parent", scenarioId: "scn-1", locale: "zh-CN", phase: "DISCOVERY", focusSummaries: FOCUS },
      store,
    });

    const childEvents = await loadEvents("run-child", store);
    const folded = foldRunAggregate(childEvents, "scn-1", "zh-CN");
    expect(folded.previousAttemptReview).toEqual({ focusSummaries: FOCUS });
  });

  it("recovers an interrupted start-retry child creation exactly once", async () => {
    const baseDir = makeStore();
    const store = { baseDir };
    await markParentRetryReady(store);

    const prepared = prepareStartRetry(retryReadyAggregate(), {
      newRunId: "run-child",
      commandId: "cmd-start-retry-recover",
      focusSummaries: FOCUS,
    });
    const request = { type: "start-retry", newRunId: "run-child", seed: null };

    // Simulate the crash: the start-retry journal is `prepared` but its child
    // effect was never applied (the child run does not yet exist).
    writePreparedStartRetry(
      baseDir,
      "run-parent",
      "cmd-start-retry-recover",
      request,
      prepared.runId,
      prepared.newRunEvents,
    );

    const out = await executeCommandTransaction<{ runId: string }>({
      runId: "run-parent",
      commandId: "cmd-start-retry-recover",
      request,
      store,
      prepare: async () => {
        throw new Error("prepare must not be re-invoked during recovery");
      },
    });

    expect(out.runId).toBe("run-child");

    const childEvents = await loadEvents("run-child", store);
    expect(childEvents.map((event) => event.type)).toEqual([
      "run.started",
      "phase.changed",
      "retry.focus",
      "phase.changed",
    ]);
    expect(foldRunAggregate(childEvents, "scn-1", "zh-CN").previousAttemptReview).toEqual({
      focusSummaries: FOCUS,
    });

    // A second recovery (now committed) must not re-append the child batch.
    await executeCommandTransaction<{ runId: string }>({
      runId: "run-parent",
      commandId: "cmd-start-retry-recover",
      request,
      store,
      prepare: async () => {
        throw new Error("prepare must not be re-invoked for a committed journal");
      },
    });
    expect(await loadEvents("run-child", store)).toHaveLength(4);
  });

  it("returns COMMAND_ID_CONFLICT for the same start-retry command with a different newRunId", async () => {
    const baseDir = makeStore();
    const store = { baseDir };
    await markParentRetryReady(store);

    const commandId = "cmd-start-retry-conflict";
    const first = await executeCommandTransaction<{ runId: string }>({
      runId: "run-parent",
      commandId,
      request: { type: "start-retry", newRunId: "run-child-a", seed: null },
      store,
      prepare: async () => {
        const prepared = prepareStartRetry(retryReadyAggregate(), {
          newRunId: "run-child-a",
          commandId,
          focusSummaries: FOCUS,
        });
        return {
          events: [],
          effects: [
            {
              type: "retry.ensure-child",
              effectId: `${prepared.parentRunId}:${commandId}:child`,
              parentRunId: prepared.parentRunId,
              childRunId: prepared.runId,
              events: prepared.newRunEvents,
            },
          ],
          result: { runId: prepared.runId },
        };
      },
    });
    expect(first.runId).toBe("run-child-a");

    await expect(
      executeCommandTransaction<{ runId: string }>({
        runId: "run-parent",
        commandId,
        request: { type: "start-retry", newRunId: "run-child-b", seed: null },
        store,
        prepare: async () => {
          throw new Error("prepare must not run for a conflicting command id");
        },
      }),
    ).rejects.toMatchObject({ code: COMMAND_ID_CONFLICT });
  });
});
