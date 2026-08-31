import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RecordedEvent, RunEvent } from "../core/domain.js";
import { RunAlreadyExistsError, RunNotFoundError } from "../core/errors.js";
import { assertSafeResourceId } from "../core/event-store.js";
import { createInitialRunState, reduce, type RunState } from "../core/reducer.js";
import { RUN_FORMAT_VERSION, resolveRunFormatVersion } from "../core/versioning.js";
import type { EventStorePort } from "../ports/event-store.js";
import { canonicalJson, recordEvent, verifyChain } from "./event-chain.js";

export interface SqliteEventStoreOptions {
  dbPath: string;
}

/**
 * Append-only, hash-chained SQLite event store implementing `EventStorePort`
 * with byte-equivalent chain semantics to the file store
 * (`src/core/event-store.ts`). Events live in the `events` table keyed by
 * `(run_id, seq)`; each row stores the full `RecordedEvent` canonical JSON in
 * `payload_json`. The `runs` table stores the run manifest (the same
 * `{ runFormatVersion }` JSON the file store writes) so `runFormatVersion`
 * can select the event upcaster. `loadEvents` re-runs `verifyChain` over the
 * stored rows, so a tampered/corrupted chain fails with `EVENT_CHAIN_INVALID`
 * exactly like the file store.
 */
export class SqliteEventStore implements EventStorePort {
  private readonly db: DatabaseSync;

  constructor(options: SqliteEventStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, command_id TEXT NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL
      );
    `);
  }

  async appendEvents(
    runId: string,
    events: RunEvent[],
    options?: { baseDir?: string },
  ): Promise<void> {
    assertSafeResourceId("run", runId);
    if (events.length === 0) return;

    const existing = this.loadEventsSync(runId);
    const alreadyStarted = existing.some((event) => event.type === "run.started");

    // Idempotency keyed by commandId at the COMMAND level: a single command may
    // legitimately emit several events (e.g. `start` emits run.started +
    // phase.changed) that share one commandId, so we group and skip per command.
    const seen = new Set(existing.map((event) => event.commandId));
    const toAppend: RunEvent[] = [];
    let index = 0;
    while (index < events.length) {
      const commandId = events[index].commandId;
      const group: RunEvent[] = [];
      while (index < events.length && events[index].commandId === commandId) {
        group.push(events[index]);
        index += 1;
      }
      if (seen.has(commandId)) continue;
      seen.add(commandId);
      toAppend.push(...group);
    }
    if (toAppend.length === 0) return;

    // A second `run.started` for an already-started run is rejected at the store
    // boundary (the in-memory state machine can't see the persisted start).
    if (alreadyStarted && toAppend.some((event) => event.type === "run.started")) {
      throw new RunAlreadyExistsError(runId);
    }

    // The run manifest is immutable after creation: created exclusively for a
    // new run, validated (never rewritten) for an existing one — mirroring the
    // file store's manifest handling on append.
    const manifestRow = this.db
      .prepare("SELECT manifest_json FROM runs WHERE run_id = ?")
      .get(runId) as { manifest_json: string } | undefined;
    const freshRun = manifestRow === undefined;
    if (!freshRun) {
      resolveRunFormatVersion(JSON.parse(manifestRow.manifest_json));
    }

    let seq = existing.length + 1;
    let logicalTime = existing.length === 0 ? 1 : existing[existing.length - 1].logicalTime + 1;
    let previousHash = existing.length === 0 ? "" : existing[existing.length - 1].hash;

    const insertEvent = this.db.prepare(
      "INSERT INTO events (run_id, seq, command_id, type, payload_json, hash) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertRun = this.db.prepare("INSERT INTO runs (run_id, manifest_json) VALUES (?, ?)");

    this.db.exec("BEGIN");
    try {
      if (freshRun) {
        insertRun.run(runId, JSON.stringify({ runFormatVersion: RUN_FORMAT_VERSION }));
      }
      for (const domainEvent of toAppend) {
        const recorded = recordEvent(domainEvent, seq, logicalTime, previousHash);
        insertEvent.run(
          runId,
          seq,
          domainEvent.commandId,
          domainEvent.type,
          canonicalJson(recorded),
          recorded.hash,
        );
        seq += 1;
        logicalTime += 1;
        previousHash = recorded.hash;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async loadEvents(runId: string, options?: { baseDir?: string }): Promise<RecordedEvent[]> {
    assertSafeResourceId("run", runId);
    const rows = this.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ payload_json: string }>;
    if (rows.length === 0) {
      const run = this.db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId);
      if (run === undefined) throw new RunNotFoundError(runId);
      return [];
    }
    const raw = rows.map((row) => JSON.parse(row.payload_json) as unknown);
    return verifyChain(raw, this.runFormatVersion(runId));
  }

  async loadRun(runId: string, options?: { baseDir?: string }): Promise<RunState> {
    const events = await this.loadEvents(runId, options);
    let state = createInitialRunState(runId);
    for (const event of events) state = reduce(state, event);
    return state;
  }

  async readHead(
    runId: string,
    options?: { baseDir?: string },
  ): Promise<{ seq: number; hash: string } | null> {
    assertSafeResourceId("run", runId);
    const row = this.db
      .prepare("SELECT seq, hash FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
      .get(runId) as { seq: number; hash: string } | undefined;
    return row === undefined ? null : { seq: row.seq, hash: row.hash };
  }

  /**
   * Read a run's committed rows as parsed `RecordedEvent`s WITHOUT throwing
   * `RunNotFoundError` for an empty/absent run and WITHOUT re-running
   * `verifyChain` — `appendEvents` uses this to read the existing head and
   * idempotency set cheaply.
   */
  private loadEventsSync(runId: string): RecordedEvent[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RecordedEvent);
  }

  /**
   * Resolve a run's format version from its manifest row, defaulting to
   * `RUN_FORMAT_VERSION` for a fresh run (no manifest row yet).
   */
  private runFormatVersion(runId: string): number {
    const row = this.db
      .prepare("SELECT manifest_json FROM runs WHERE run_id = ?")
      .get(runId) as { manifest_json: string } | undefined;
    if (row === undefined) return RUN_FORMAT_VERSION;
    return resolveRunFormatVersion(JSON.parse(row.manifest_json));
  }
}
