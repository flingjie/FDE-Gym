import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunEvent } from "../../src/core/domain";
import { EVENT_CHAIN_INVALID, RUN_ALREADY_EXISTS, RUN_NOT_FOUND } from "../../src/core/errors";
import {
  appendEvents,
  loadEvents,
  loadRun,
  readHead,
} from "../../src/core/event-store";
import type { EventStorePort } from "../../src/ports/event-store";
import { buildPhaseChangedEvent, buildRunStartedEvents } from "../../src/core/state-machine";
import { SqliteEventStore } from "../../src/storage/sqlite-event-store";

const RUN_ID = "run-1";

/**
 * A concrete store under test. `tamper` breaks the committed hash chain the way
 * each backend exposes one: the file store edits a stored record's payload, the
 * SQLite store UPDATEs the row's `payload_json` directly through the DB handle.
 */
interface StoreFixture {
  name: string;
  store: EventStorePort;
  baseDir: string;
  cleanup: () => void;
  tamper: (runId: string) => void;
}

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

function fileFactory(): StoreFixture {
  const baseDir = mkdtempSync(join(tmpdir(), "fde-gym-contract-file-"));
  const store: EventStorePort = {
    loadRun: (runId, options) => loadRun(runId, { ...options, baseDir }),
    loadEvents: (runId, options) => loadEvents(runId, { ...options, baseDir }),
    appendEvents: (runId, events, options) => appendEvents(runId, events, { ...options, baseDir }),
    readHead: (runId, options) => readHead(runId, { ...options, baseDir }),
  };
  return {
    name: "file",
    store,
    baseDir,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
    tamper(runId) {
      const file = join(baseDir, "runs", runId, "events.jsonl");
      const parsed = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // Flip the anchor phase.changed target; fully parseable but hash-mismatched.
      parsed[1].to = "DISCOVERY";
      writeFileSync(file, parsed.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    },
  };
}

function sqliteFactory(): StoreFixture {
  const baseDir = mkdtempSync(join(tmpdir(), "fde-gym-contract-sqlite-"));
  const dbPath = join(baseDir, "store.sqlite");
  const store = new SqliteEventStore({ dbPath });
  return {
    name: "sqlite",
    store,
    baseDir,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
    tamper(runId) {
      const db = new DatabaseSync(dbPath);
      try {
        const row = db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND seq = 2")
          .get(runId) as { payload_json: string } | undefined;
        if (row === undefined) throw new Error(`no seq=2 row for run ${runId}`);
        const recorded = JSON.parse(row.payload_json) as Record<string, unknown>;
        recorded.to = "DISCOVERY";
        db.prepare("UPDATE events SET payload_json = ? WHERE run_id = ? AND seq = 2").run(
          JSON.stringify(recorded),
          runId,
        );
      } finally {
        db.close();
      }
    },
  };
}

const FIXTURES: Array<[string, () => StoreFixture]> = [
  ["file", fileFactory],
  ["sqlite", sqliteFactory],
];

describe.each(FIXTURES)("event-store contract (%s)", (_name, factory) => {
  let fx: StoreFixture;

  beforeEach(() => {
    fx = factory();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it("round-trips append -> loadEvents with a hash-chained envelope and reconstructs the run", async () => {
    await fx.store.appendEvents(RUN_ID, journeyEvents(RUN_ID));

    const recorded = await fx.store.loadEvents(RUN_ID);
    expect(recorded).toHaveLength(4);
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

    const state = await fx.store.loadRun(RUN_ID);
    expect(state).toEqual({ runId: RUN_ID, phase: "PROBLEM_FRAMING", seq: 4 });
  });

  it("detects a tampered committed record with EVENT_CHAIN_INVALID", async () => {
    await fx.store.appendEvents(RUN_ID, journeyEvents(RUN_ID));

    fx.tamper(RUN_ID);

    await expect(fx.store.loadEvents(RUN_ID)).rejects.toMatchObject({ code: EVENT_CHAIN_INVALID });
  });

  it("is idempotent on a repeated commandId", async () => {
    const events = journeyEvents(RUN_ID);
    await fx.store.appendEvents(RUN_ID, events);
    const before = await fx.store.loadRun(RUN_ID);

    await fx.store.appendEvents(RUN_ID, events);

    const after = await fx.store.loadRun(RUN_ID);
    expect(after.seq).toBe(before.seq);
    expect(await fx.store.loadEvents(RUN_ID)).toHaveLength(4);
  });

  it("readHead returns null for a fresh run and { seq, hash } after append", async () => {
    expect(await fx.store.readHead(RUN_ID)).toBeNull();

    await fx.store.appendEvents(RUN_ID, journeyEvents(RUN_ID));

    const head = await fx.store.readHead(RUN_ID);
    expect(head).not.toBeNull();
    expect(head!.seq).toBe(4);
    expect(head!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a second run.started with RUN_ALREADY_EXISTS", async () => {
    await fx.store.appendEvents(RUN_ID, journeyEvents(RUN_ID));

    await expect(
      fx.store.appendEvents(RUN_ID, [
        { type: "run.started", runId: RUN_ID, commandId: "cX", scenarioId: "s1", locale: "zh-CN" },
      ]),
    ).rejects.toMatchObject({ code: RUN_ALREADY_EXISTS });
  });

  it("throws RUN_NOT_FOUND for a missing run", async () => {
    await expect(fx.store.loadEvents("missing-run")).rejects.toMatchObject({ code: RUN_NOT_FOUND });
    await expect(fx.store.loadRun("missing-run")).rejects.toMatchObject({ code: RUN_NOT_FOUND });
  });
});

describe("event-store byte-equivalence", () => {
  it("file and SQLite stores record byte-identical chains for the same events", async () => {
    const fileFx = fileFactory();
    const sqliteFx = sqliteFactory();
    try {
      const events = journeyEvents(RUN_ID);
      await fileFx.store.appendEvents(RUN_ID, events);
      await sqliteFx.store.appendEvents(RUN_ID, events);

      expect(await sqliteFx.store.loadEvents(RUN_ID)).toEqual(await fileFx.store.loadEvents(RUN_ID));
      expect(await sqliteFx.store.readHead(RUN_ID)).toEqual(await fileFx.store.readHead(RUN_ID));
    } finally {
      fileFx.cleanup();
      sqliteFx.cleanup();
    }
  });
});
