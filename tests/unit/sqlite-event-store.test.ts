import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunEvent } from "../../src/core/domain";
import { RUN_ALREADY_EXISTS, RUN_NOT_FOUND } from "../../src/core/errors";
import {
  appendEvents as appendEventsFile,
  loadEvents as loadEventsFile,
} from "../../src/core/event-store";
import { buildPhaseChangedEvent, buildRunStartedEvents } from "../../src/core/state-machine";
import { SqliteEventStore } from "../../src/storage/sqlite-event-store";

const RUN_ID = "run-1";

let baseDir: string;
let dbDir: string;
let store: SqliteEventStore;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "fde-gym-file-"));
  dbDir = mkdtempSync(join(tmpdir(), "fde-gym-sqlite-"));
  store = new SqliteEventStore({ dbPath: join(dbDir, "store.sqlite") });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

/** Build a deterministic 4-event journey (start, accept, frame) via the event helpers. */
function journeyEvents(runId: string): RunEvent[] {
  return [
    ...buildRunStartedEvents(runId, {
      type: "start",
      commandId: "c0",
      scenarioId: "s1",
      locale: "zh-CN",
    }),
    buildPhaseChangedEvent(runId, "c1", "SCENARIO", "DISCOVERY"),
    buildPhaseChangedEvent(runId, "c2", "DISCOVERY", "PROBLEM_FRAMING"),
  ];
}

describe("SqliteEventStore", () => {
  it("round-trips the SAME recorded events as the file store", async () => {
    const events = journeyEvents(RUN_ID);
    await appendEventsFile(RUN_ID, events, { baseDir });
    await store.appendEvents(RUN_ID, events);

    const fileEvents = await loadEventsFile(RUN_ID, { baseDir });
    const sqliteEvents = await store.loadEvents(RUN_ID);

    expect(sqliteEvents).toEqual(fileEvents);

    const state = await store.loadRun(RUN_ID);
    expect(state).toEqual({ runId: RUN_ID, phase: "PROBLEM_FRAMING", seq: 4 });
  });

  it("readHead returns null for a fresh run and the last { seq, hash } after append", async () => {
    expect(await store.readHead(RUN_ID)).toBeNull();

    await store.appendEvents(RUN_ID, journeyEvents(RUN_ID));

    const head = await store.readHead(RUN_ID);
    expect(head).not.toBeNull();
    expect(head!.seq).toBe(4);
    expect(head!.hash).toHaveLength(64);
  });

  it("is idempotent on a repeated commandId", async () => {
    const events = journeyEvents(RUN_ID);
    await store.appendEvents(RUN_ID, events);
    const before = await store.loadRun(RUN_ID);

    await store.appendEvents(RUN_ID, events);

    const after = await store.loadRun(RUN_ID);
    expect(after.seq).toBe(before.seq);
    expect(await store.loadEvents(RUN_ID)).toHaveLength(4);
  });

  it("rejects a second run.started with RUN_ALREADY_EXISTS", async () => {
    await store.appendEvents(RUN_ID, journeyEvents(RUN_ID));

    await expect(
      store.appendEvents(RUN_ID, [
        { type: "run.started", runId: RUN_ID, commandId: "cX", scenarioId: "s1", locale: "zh-CN" },
      ]),
    ).rejects.toMatchObject({ code: RUN_ALREADY_EXISTS });
  });

  it("throws RUN_NOT_FOUND for a missing run", async () => {
    await expect(store.loadEvents("missing-run")).rejects.toMatchObject({ code: RUN_NOT_FOUND });
  });

  it("writes a run manifest carrying runFormatVersion 2 on first append", async () => {
    await store.appendEvents(RUN_ID, journeyEvents(RUN_ID));

    const db = new DatabaseSync(join(dbDir, "store.sqlite"));
    try {
      const row = db
        .prepare("SELECT manifest_json FROM runs WHERE run_id = ?")
        .get(RUN_ID) as { manifest_json: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.manifest_json)).toEqual({ runFormatVersion: 2 });
    } finally {
      db.close();
    }
  });
});
