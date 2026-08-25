import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunCommand, RunEvent } from "../../src/core/domain";
import { EVENT_CHAIN_INVALID, RUN_NOT_FOUND, UNSUPPORTED_SCHEMA_VERSION } from "../../src/core/errors";
import { createInitialRunState, reduce } from "../../src/core/reducer";
import { appendEvents, loadEvents, loadRun } from "../../src/core/event-store";
import { decide } from "../../src/core/state-machine";

const RUN_ID = "run-1";

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "fde-gym-store-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function eventsFile(): string {
  return join(baseDir, "runs", RUN_ID, "events.jsonl");
}

/** Drive decide() + reduce() to produce a deterministic 4-event journey (start, accept, frame). */
function journeyEvents(runId: string): RunEvent[] {
  const out: RunEvent[] = [];
  let s = createInitialRunState(runId);
  const step = (command: RunCommand): void => {
    out.push(...decide(s, command));
    s = out.reduce(reduce, createInitialRunState(runId));
  };
  step({ type: "start", commandId: "c0", scenarioId: "s1", locale: "zh-CN" });
  step({ type: "accept", commandId: "c1" });
  step({ type: "frame", commandId: "c2" });
  return out;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect((caught as { code?: string }).code).toBe(code);
}

describe("event store", () => {
  it("appends a hash-chained JSONL and reconstructs the run on load", async () => {
    await appendEvents(RUN_ID, journeyEvents(RUN_ID), { baseDir });

    const raw = readFileSync(eventsFile(), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(4);

    const recorded = lines.map((line) => JSON.parse(line) as {
      seq: number;
      logicalTime: number;
      previousHash: string;
      hash: string;
    });
    recorded.forEach((event, i) => {
      expect(event.seq).toBe(i + 1);
      expect(event.logicalTime).toBe(i + 1);
      expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
      if (i === 0) {
        expect(event.previousHash).toBe("");
      } else {
        expect(event.previousHash).toBe(recorded[i - 1].hash);
      }
    });

    const state = await loadRun(RUN_ID, { baseDir });
    expect(state).toEqual({ runId: RUN_ID, phase: "PROBLEM_FRAMING", seq: 4 });
  });

  it("detects a tampered committed line with EVENT_CHAIN_INVALID", async () => {
    await appendEvents(RUN_ID, journeyEvents(RUN_ID), { baseDir });

    const lines = readFileSync(eventsFile(), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    // Flip the first phase.changed target; this is fully parseable but hash-mismatched.
    parsed[1].to = "DISCOVERY";
    writeFileSync(eventsFile(), parsed.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

    await expectCode(loadRun(RUN_ID, { baseDir }), EVENT_CHAIN_INVALID);
  });

  it("tolerates a final incomplete line from an interrupted write", async () => {
    await appendEvents(RUN_ID, journeyEvents(RUN_ID), { baseDir });
    appendFileSync(eventsFile(), '{"type":"phase.changed","runId":"run-1","commandId":"c9","from":"PROB', "utf8");

    const state = await loadRun(RUN_ID, { baseDir });
    expect(state.seq).toBe(4);
    expect(state.phase).toBe("PROBLEM_FRAMING");
  });

  it("is idempotent on a repeated commandId", async () => {
    const events = journeyEvents(RUN_ID);
    await appendEvents(RUN_ID, events, { baseDir });
    const before = await loadRun(RUN_ID, { baseDir });

    await appendEvents(RUN_ID, events, { baseDir });

    const after = await loadRun(RUN_ID, { baseDir });
    expect(after.seq).toBe(before.seq);
    const lineCount = readFileSync(eventsFile(), "utf8").split("\n").filter(Boolean).length;
    expect(lineCount).toBe(4);
  });

  it("appends only unseen commandIds from a mixed batch", async () => {
    await appendEvents(RUN_ID, journeyEvents(RUN_ID), { baseDir });
    const before = await loadRun(RUN_ID, { baseDir });

    const seen: RunEvent = { type: "phase.changed", runId: RUN_ID, commandId: "c1", from: "SCENARIO", to: "DISCOVERY" };
    const fresh: RunEvent = { type: "question.asked", runId: RUN_ID, commandId: "c9", questionId: "c9", question: "new q?" };
    await appendEvents(RUN_ID, [seen, fresh], { baseDir });

    const after = await loadRun(RUN_ID, { baseDir });
    expect(after.seq).toBe(before.seq + 1);
    expect(after.phase).toBe("PROBLEM_FRAMING");
  });

  it("throws RUN_NOT_FOUND for a missing run", async () => {
    await expectCode(loadRun("missing-run", { baseDir }), RUN_NOT_FOUND);
  });

  it("writes a run manifest carrying schemaVersion 1", async () => {
    await appendEvents(RUN_ID, journeyEvents(RUN_ID), { baseDir });
    const manifest = JSON.parse(
      readFileSync(join(baseDir, "runs", RUN_ID, "manifest.json"), "utf8"),
    ) as { schemaVersion?: number };
    expect(manifest.schemaVersion).toBe(1);
  });

  it("rejects a run whose manifest schemaVersion is unsupported with UNSUPPORTED_SCHEMA_VERSION", async () => {
    await appendEvents(RUN_ID, journeyEvents(RUN_ID), { baseDir });
    writeFileSync(
      join(baseDir, "runs", RUN_ID, "manifest.json"),
      JSON.stringify({ schemaVersion: 2 }) + "\n",
      "utf8",
    );
    await expectCode(loadRun(RUN_ID, { baseDir }), UNSUPPORTED_SCHEMA_VERSION);
  });

  it("round-trips evidence.pending and evidence.resolved events", async () => {
    const events: RunEvent[] = [
      {
        type: "evidence.pending",
        runId: RUN_ID,
        commandId: "cp",
        turnId: "cp:turn",
        failureCode: "EVIDENCE_EXTRACTION_FAILED",
      },
      {
        type: "evidence.resolved",
        runId: RUN_ID,
        commandId: "cr",
        turnId: "cp:turn",
      },
    ];
    await appendEvents(RUN_ID, events, { baseDir });

    const recorded = await loadEvents(RUN_ID, { baseDir });
    expect(recorded.map((event) => event.type)).toEqual(["evidence.pending", "evidence.resolved"]);
    expect(recorded[0]).toMatchObject({
      turnId: "cp:turn",
      failureCode: "EVIDENCE_EXTRACTION_FAILED",
    });
    expect(recorded[1]).toMatchObject({ turnId: "cp:turn" });
  });
});
