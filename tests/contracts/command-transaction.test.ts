import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeCommandTransaction,
  type CommandPlan,
  type JsonValue,
} from "../../src/core/command-transaction.js";
import { appendEvents, canonicalJson, loadEvents } from "../../src/core/event-store.js";
import { COMMAND_ID_CONFLICT, JOURNAL_CANARY_LEAK, RUN_VERSION_CONFLICT } from "../../src/core/errors.js";
import type { RunEvent } from "../../src/core/domain.js";

/**
 * Write-ahead command journal contract (Task 5).
 *
 * The transaction must replay a committed command from its journal without
 * re-invoking `prepare`, recover an interrupted command at either failure
 * boundary, and serialize concurrent identical commands to one journal + one
 * event batch.
 */

const RUN_ID = "run-tx";

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "fde-tx-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function journalPath(commandId: string): string {
  return join(baseDir, "runs", RUN_ID, "commands", `${commandId}.json`);
}

function requestHash(request: JsonValue): string {
  return createHash("sha256").update(canonicalJson(request), "utf8").digest("hex");
}

function writePrepared(commandId: string, request: JsonValue, journal: {
  events: RunEvent[];
  result: JsonValue;
  effects?: unknown[];
}): void {
  mkdirSync(join(baseDir, "runs", RUN_ID, "commands"), { recursive: true });
  writeFileSync(
    journalPath(commandId),
    JSON.stringify({
      journalVersion: 1,
      runId: RUN_ID,
      commandId,
      requestHash: requestHash(request),
      status: "prepared",
      events: journal.events,
      result: journal.result,
      effects: journal.effects ?? [],
    }) + "\n",
    "utf8",
  );
}

function hintEvent(commandId: string): RunEvent {
  return {
    type: "hint.granted",
    runId: RUN_ID,
    commandId,
    topic: "workflow",
    level: 1,
    hint: { "zh-CN": "提示", "en-US": "hint" },
  };
}

describe("command transaction journal", () => {
  it("returns the first stored result and calls prepare once for a repeated command", async () => {
    let calls = 0;
    const plan: CommandPlan<{ n: number }> = { events: [hintEvent("cmd-1")], result: { n: 1 } };
    const request = { type: "hint", topic: "workflow", level: 1 };

    const run = () =>
      executeCommandTransaction({
        runId: RUN_ID,
        commandId: "cmd-1",
        request,
        store: { baseDir },
        prepare: async () => {
          calls += 1;
          return plan;
        },
      });

    expect(await run()).toEqual({ n: 1 });
    expect(await run()).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  it("throws COMMAND_ID_CONFLICT for the same command id with a different request", async () => {
    const plan: CommandPlan<{ n: number }> = { events: [hintEvent("cmd-2")], result: { n: 1 } };
    await executeCommandTransaction({
      runId: RUN_ID,
      commandId: "cmd-2",
      request: { type: "hint", topic: "workflow" },
      store: { baseDir },
      prepare: async () => plan,
    });

    await expect(
      executeCommandTransaction({
        runId: RUN_ID,
        commandId: "cmd-2",
        request: { type: "hint", topic: "different" },
        store: { baseDir },
        prepare: async () => ({ events: [], result: { n: 2 } }),
      }),
    ).rejects.toMatchObject({ code: COMMAND_ID_CONFLICT });
  });

  it("recovers a prepared journal (crash before event commit) without calling prepare", async () => {
    const request = { type: "hint", topic: "workflow", level: 1 };
    const result = { topic: "workflow", level: 1, hint: { "zh-CN": "提示", "en-US": "hint" } };
    writePrepared("cmd-3", request, { events: [hintEvent("cmd-3")], result });

    let calls = 0;
    const out = await executeCommandTransaction<typeof result>({
      runId: RUN_ID,
      commandId: "cmd-3",
      request,
      store: { baseDir },
      prepare: async () => {
        calls += 1;
        return { events: [], result };
      },
    });

    expect(calls).toBe(0);
    expect(out).toEqual(result);

    const recorded = await loadEvents(RUN_ID, { baseDir });
    expect(recorded.map((event) => event.type)).toEqual(["hint.granted"]);

    const persisted = JSON.parse(readFileSync(journalPath("cmd-3"), "utf8")) as { status: string };
    expect(persisted.status).toBe("committed");
  });

  it("replays a prepared effect (crash after event commit) exactly once", async () => {
    const request = { type: "retry", newRunId: "child-run" };
    const parentEvent: RunEvent = {
      type: "retry.started",
      runId: RUN_ID,
      commandId: "cmd-4",
      newRunId: "child-run",
    };
    const childEvents: RunEvent[] = [
      { type: "run.started", runId: "child-run", commandId: "cmd-4", scenarioId: "scn-1", locale: "zh-CN" },
      { type: "phase.changed", runId: "child-run", commandId: "cmd-4", from: "SCENARIO", to: "SCENARIO" },
      { type: "phase.changed", runId: "child-run", commandId: "cmd-4:accept", from: "SCENARIO", to: "DISCOVERY" },
    ];

    // Simulate: the parent event already committed, then the process crashed
    // before the effect was applied / the journal was marked committed.
    writePrepared("cmd-4", request, {
      events: [parentEvent],
      result: { runId: "child-run" },
      effects: [
        {
          type: "retry.ensure-child",
          effectId: "cmd-4:child",
          parentRunId: RUN_ID,
          childRunId: "child-run",
          events: childEvents,
        },
      ],
    });

    const out = await executeCommandTransaction<{ runId: string }>({
      runId: RUN_ID,
      commandId: "cmd-4",
      request,
      store: { baseDir },
      prepare: async () => ({ events: [], result: { runId: "child-run" } }),
    });

    expect(out).toEqual({ runId: "child-run" });

    const childRecorded = await loadEvents("child-run", { baseDir });
    expect(childRecorded.map((event) => event.type)).toEqual([
      "run.started",
      "phase.changed",
      "phase.changed",
    ]);

    // A second run (now committed) must not re-append the child batch.
    await executeCommandTransaction<{ runId: string }>({
      runId: RUN_ID,
      commandId: "cmd-4",
      request,
      store: { baseDir },
      prepare: async () => ({ events: [], result: { runId: "child-run" } }),
    });
    expect(await loadEvents("child-run", { baseDir })).toHaveLength(3);
  });

  it("produces one journal and one event batch for concurrent identical commands", async () => {
    const plan: CommandPlan<{ n: number }> = { events: [hintEvent("cmd-5")], result: { n: 1 } };
    const options = {
      runId: RUN_ID,
      commandId: "cmd-5",
      request: { type: "hint", topic: "workflow" },
      store: { baseDir },
      prepare: async () => plan,
    };

    const settled = await Promise.allSettled([
      executeCommandTransaction(options),
      executeCommandTransaction(options),
    ]);

    // Idempotency is the durable guarantee: exactly one committed journal and
    // one event batch, and every caller that commits converges on the stored
    // result. Which caller wins the run lock — and whether the loser rejects
    // with RUN_LOCKED or re-observes the committed journal — is the lock
    // layer's contract (covered by run-lock.test.ts), not asserted here.
    expect(await loadEvents(RUN_ID, { baseDir })).toHaveLength(1);
    expect(readdirSync(join(baseDir, "runs", RUN_ID, "commands"))).toEqual(["cmd-5.json"]);

    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<{ n: number }> => result.status === "fulfilled",
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const result of fulfilled) {
      expect(result.value).toEqual({ n: 1 });
    }
  });

  it("rejects a non-JSON result before writing the journal", async () => {
    await expect(
      executeCommandTransaction({
        runId: RUN_ID,
        commandId: "cmd-6",
        request: { type: "hint", topic: "workflow" },
        store: { baseDir },
        prepare: async () => ({
          events: [],
          // `undefined` is not a valid JsonValue.
          result: { value: undefined } as unknown as JsonValue,
        }),
      }),
    ).rejects.toThrow(/not a JSON value/);
  });

  it("rejects a journal whose content contains a canary value before write", async () => {
    const canary = "CANARY-9f2c1b";
    await expect(
      executeCommandTransaction({
        runId: RUN_ID,
        commandId: "cmd-7",
        request: { type: "hint", topic: "workflow" },
        store: { baseDir },
        canaries: [canary],
        prepare: async () => ({
          events: [],
          result: { topic: "workflow", note: `hidden ${canary}` },
        }),
      }),
    ).rejects.toMatchObject({ code: JOURNAL_CANARY_LEAK });

    // The journal boundary must fail closed: no file is persisted, so the
    // canary never reaches the journal (nor any sibling file).
    const commandsDir = join(baseDir, "runs", RUN_ID, "commands");
    const files = existsSync(commandsDir) ? readdirSync(commandsDir) : [];
    expect(files).toEqual([]);
    for (const file of files) {
      expect(readFileSync(join(commandsDir, file), "utf8")).not.toContain(canary);
    }
  });

  it("does not re-invoke prepare when the head is unchanged", async () => {
    let calls = 0;
    const prepare = async () => {
      calls += 1;
      return { events: [], result: { ok: true } };
    };
    await executeCommandTransaction({
      runId: "run-1",
      commandId: "cmd-1",
      request: { type: "ask", question: "q", stakeholderId: "s" },
      store: { baseDir },
      prepare,
    });
    expect(calls).toBe(1);
  });

  it("throws RUN_VERSION_CONFLICT (without re-running prepare) when the head moves", async () => {
    await appendEvents(
      "run-1",
      [
        {
          type: "run.started",
          runId: "run-1",
          commandId: "start",
          scenarioId: "s",
          locale: "zh-CN",
        },
      ],
      { baseDir },
    );
    let calls = 0;
    const prepare = async () => {
      calls += 1;
      // Simulate another writer committing here (prepare runs outside the lock).
      await appendEvents(
        "run-1",
        [
          {
            type: "phase.changed",
            runId: "run-1",
            commandId: "other",
            from: "SCENARIO",
            to: "SCENARIO",
          },
        ],
        { baseDir },
      );
      return { events: [], result: { ok: true } };
    };
    await expect(
      executeCommandTransaction({
        runId: "run-1",
        commandId: "cmd-2",
        request: { type: "ask", question: "q", stakeholderId: "s" },
        store: { baseDir },
        prepare,
      }),
    ).rejects.toMatchObject({ code: RUN_VERSION_CONFLICT });
    expect(calls).toBe(1);
  });
});
