# Phase 2d — SQLite Event Store (first unit: event storage + adapter)

**Date:** 2026-08-31
**Status:** Approved for implementation planning
**Scope:** FDEGym Phase 2 "降耦合" — SQLite event store, first coherent unit

## Context

The file event store (`src/core/event-store.ts`) is append-only JSONL but rewrites the whole
file on each append (O(n) write). This sub-project adds a SQLite-backed adapter implementing
the `EventStorePort` (from Phase 2a), selectable at runtime, while the file store remains the
default. This is the first unit: **event storage only** — the command journal and run lock
stay file-based for now.

## Decisions (locked)

- **Driver:** `node:sqlite` (`DatabaseSync`, built-in) — zero new npm deps. The
  ExperimentalWarning on Node 22–24 is accepted (single-machine product).
- **Strategy:** coexist — SQLite is an OPTIONAL adapter behind `FDE_GYM_STORE=sqlite`; the
  file store stays the default and keeps full backward compatibility.

## Goal

- Extract the shared hash-chain logic so the file store and the SQLite adapter cannot drift.
- `SqliteEventStore` implements `EventStorePort`'s four methods (`loadRun`, `loadEvents`,
  `appendEvents`, `readHead`) with byte-identical chain semantics.
- The commit path routes event append/read through the SELECTED store.

## Non-negotiable constraints

- **Byte-equivalent to the file store.** Same `canonicalJson` key-sort, same hash chain
  (`seq` continuity, `previousHash` chaining, `hash = sha256(canonicalJson({...event, seq,
  logicalTime, previousHash}))`), same command-id idempotency, same errors
  (`EVENT_CHAIN_INVALID`, `RUN_NOT_FOUND`, `RUN_ALREADY_EXISTS`, `INVALID_RESOURCE_ID`).
- Golden replay byte-stability is untouched (replay reads `RecordedEvent[]`, storage-agnostic).
- The file store and its on-disk format are NOT changed; existing runs keep working.
- Source imports `.js`; test imports extensionless; no new npm deps.

## 1. Shared chain logic (`src/storage/event-chain.ts`)

Extract from `event-store.ts` (unchanged behavior): `canonicalJson`, `sha256Hex`,
`recordEvent(domainEvent, seq, logicalTime, previousHash)`, and a pure
`verifyChain(rawRecords: readonly Record<string, unknown>[]): RecordedEvent[]` that checks
seq continuity + `previousHash` chaining + hash, throwing `EventChainInvalidError`. The
upcast step (`upcastRecordedEvent`) stays where it is; the chain verify runs on the ORIGINAL
bytes first (same order as today). `event-store.ts` re-imports these from `event-chain.js`.

## 2. `SqliteEventStore` (`src/storage/sqlite-event-store.ts`)

```ts
export interface SqliteEventStoreOptions { dbPath: string; }
export class SqliteEventStore {
  constructor(options: SqliteEventStoreOptions);
  loadRun(runId, options?): Promise<RunState>;
  loadEvents(runId, options?): Promise<RecordedEvent[]>;
  appendEvents(runId, events, options?): Promise<void>;
  readHead(runId, options?): Promise<{ seq: number; hash: string } | null>;
}
```

Schema (created on first use, `PRAGMA journal_mode = WAL`):

```sql
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,   -- full RecordedEvent canonical JSON (with envelope + hash)
  hash TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL
);
```

- `appendEvents`: inside one transaction, read the run's existing events (ordered by seq),
  dedup by `command_id`, reject a second `run.started` with `RunAlreadyExistsError`, compute
  `seq`/`logicalTime`/`previousHash`/`hash` via `recordEvent`, `INSERT` the rows. Idempotent
  per `command_id` (same grouping rule as the file store).
- `loadEvents`: `SELECT ... ORDER BY seq`, parse each `payload_json`, run `verifyChain`.
- `loadRun`: `loadEvents` + `reduce` (reuse `createInitialRunState` + `reduce`).
- `readHead`: last row's `{ seq, hash }` or `null`.

## 3. Commit-path routing (`src/core/command-transaction.ts`)

`executeCommandTransaction` currently imports `appendEvents`/`readHead` directly. Refactor it
to receive the event store's `appendEvents` + `readHead` (or an `EventStorePort`-shaped
object) so the SELECTED store is used. The command journal (`readJournal`/`writeJournal`) and
`withRunLock` stay file-based and unchanged.

## 4. Selection + wiring

- Env var `FDE_GYM_STORE` (`"sqlite"` | unset). `"sqlite"` → `SqliteEventStore` at
  `<baseDir>/store.sqlite`; unset → the file store (default).
- `buildDeps` (and the transaction call sites) use the selected store's four functions.

## 5. Contract test

Refactor the existing event-store contract tests so their scenarios run against BOTH the file
store and `SqliteEventStore` (a `describe.each` over two store factories). Assert the same
behavior: append/load round-trip, hash-chain tamper → `EVENT_CHAIN_INVALID`, command-id
idempotency, `readHead` null→non-null, `RUN_ALREADY_EXISTS`, `RUN_NOT_FOUND`.

## Out of scope (later units)

- Command journal + run lock SQLite-ization (needs a journal port).
- Snapshots (every-N-events materialized aggregate).
- `profile_events`, `judgments`, `scenario_versions` tables.
- Migration of existing file-based runs into SQLite.

## Success criteria

- `npm run release:gate` green; golden replay byte-stable.
- The same contract-test scenarios pass against both stores (byte-equivalent chain).
- `FDE_GYM_STORE=sqlite` routes a run's events to `store.sqlite`; unset uses the file store.
- Zero new npm dependencies.
