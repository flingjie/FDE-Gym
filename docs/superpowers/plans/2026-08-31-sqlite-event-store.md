# SQLite Event Store (Phase 2d, first unit) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `node:sqlite`-backed `SqliteEventStore` implementing `EventStorePort`, selectable via `FDE_GYM_STORE=sqlite`, with byte-equivalent hash-chain semantics to the file store. Extract the shared chain logic so the two stores cannot drift.

**Architecture:** Extract `event-chain.ts` (canonicalJson / sha256Hex / recordEvent / verifyChain); `SqliteEventStore` (events + runs tables, WAL, command-id idempotency, chain verify); route `executeCommandTransaction`'s event append/readHead through the SELECTED store; wire selection via env var; run the event-store contract tests against both stores.

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod, `node:sqlite` (built-in). No new npm deps.

**Spec:** `docs/superpowers/specs/2026-08-31-sqlite-event-store-design.md`

## Global Constraints

- **Byte-equivalent to the file store.** Same hash chain, same command-id idempotency, same errors (`EVENT_CHAIN_INVALID`, `RUN_NOT_FOUND`, `RUN_ALREADY_EXISTS`, `INVALID_RESOURCE_ID`). Golden replay byte-stability untouched.
- The file store and its on-disk format are NOT changed; existing runs keep working.
- Source imports `.js`; test imports extensionless; no new npm deps.
- `node:sqlite` emits an ExperimentalWarning — do NOT suppress it; it is accepted.

---

### Task 1: Extract shared chain logic (`src/storage/event-chain.ts`)

**Files:**
- Create: `src/storage/event-chain.ts`
- Modify: `src/core/event-store.ts` (re-import from `event-chain.js`)

- [ ] **Step 1: Create `event-chain.ts`.** Move `canonicalJson`/`sortKeysDeep`, `sha256Hex`, `recordEvent`, `envelopeFields`, `hashRawRecord`, and add a pure `verifyChain`. `verifyChain` takes the parsed raw records and the run format version, and returns validated `RecordedEvent[]`:

```ts
import { z } from "zod";
import { createHash } from "node:crypto";
import { RecordedEventSchema, type RecordedEvent } from "../core/domain.js";
import { upcastRecordedEvent } from "../core/versioning.js";
import { EventChainInvalidError } from "../core/errors.js";

export const SHA256_HEX_LENGTH = 64;
const FIRST_PREVIOUS_HASH = "";

export function canonicalJson(value: unknown): string { /* moved verbatim */ }
export function sha256Hex(input: string): string { return createHash("sha256").update(input, "utf8").digest("hex"); }
export function recordEvent(domainEvent, seq, logicalTime, previousHash): RecordedEvent { /* moved verbatim */ }

/** Validate envelope fields + hash chain + upcast + current schema, in that order. */
export function verifyChain(rawRecords: readonly unknown[], runFormatVersion: number): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  for (const raw of rawRecords) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new EventChainInvalidError("invalid recorded event");
    }
    const rawRecord = raw as Record<string, unknown>;
    const envelope = envelopeFields(rawRecord);
    if (envelope === null) throw new EventChainInvalidError("invalid recorded event envelope");
    const expectedSeq = events.length + 1;
    const expectedPrev = events.length === 0 ? FIRST_PREVIOUS_HASH : events[events.length - 1].hash;
    if (envelope.seq !== expectedSeq) throw new EventChainInvalidError(`seq discontinuity: expected ${expectedSeq}, got ${envelope.seq}`);
    if (envelope.previousHash !== expectedPrev) throw new EventChainInvalidError("previousHash mismatch");
    if (hashRawRecord(rawRecord) !== envelope.hash) throw new EventChainInvalidError("hash mismatch");
    const upcasted = upcastRecordedEvent(rawRecord, runFormatVersion);
    const validated = RecordedEventSchema.safeParse(upcasted);
    if (!validated.success) throw new EventChainInvalidError("invalid recorded event");
    events.push(validated.data);
  }
  return events;
}
```

(Move `envelopeFields`/`hashRawRecord`/`sortKeysDeep` verbatim from `event-store.ts`; keep them module-private in `event-chain.ts`, exporting only `canonicalJson`, `sha256Hex`, `recordEvent`, `verifyChain`, `SHA256_HEX_LENGTH`.)

- [ ] **Step 2: Refactor `event-store.ts`.** Delete the moved helpers and `readEventsAndPrefix`'s inline chain loop; re-implement `readEventsAndPrefix` as: read file → split lines → parse each non-empty line (tolerating a trailing incomplete line) → `verifyChain(parsedRecords, runFormatVersion)` → `committedPrefix` = the valid lines' bytes. Import `canonicalJson`/`recordEvent`/`verifyChain`/`sha256Hex` from `../storage/event-chain.js`. Re-export `canonicalJson` (command-transaction imports it).

- [ ] **Step 3: Verify + commit.** `npm run typecheck && npm test` — green, byte-identical (pure move).

```bash
git add -A && git commit -m "refactor: extract shared event-chain logic from the file store"
```

---

### Task 2: `SqliteEventStore`

**Files:**
- Create: `src/storage/sqlite-event-store.ts`
- Create: `tests/unit/sqlite-event-store.test.ts` (or fold into the contract test in Task 5)

**Interfaces:**
- Consumes: `verifyChain`, `recordEvent`, `sha256Hex`, `canonicalJson` (Task 1); `reduce`, `createInitialRunState` (from `core/reducer.js`); `RunEventSchema`/`RecordedEvent`/`RunEvent`/`RunState` (from `core/domain.js`); `EventChainInvalidError`, `RunAlreadyExistsError`, `RunNotFoundError`, `InvalidResourceIdError` (from `core/errors.js`); `assertSafeResourceId` (from `core/event-store.js`).

- [ ] **Step 1: Implement the store.** `src/storage/sqlite-event-store.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import type { RecordedEvent, RunEvent, RunState } from "../core/domain.js";
import { createInitialRunState, reduce } from "../core/reducer.js";
import { RunAlreadyExistsError, RunNotFoundError } from "../core/errors.js";
import { assertSafeResourceId } from "../core/event-store.js";
import { canonicalJson, recordEvent, verifyChain } from "./event-chain.js";

export interface SqliteEventStoreOptions { dbPath: string; }

export class SqliteEventStore {
  private readonly db: DatabaseSync;
  constructor(options: SqliteEventStoreOptions) {
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

  async appendEvents(runId: string, events: RunEvent[], options?: { baseDir?: string; lock?: unknown }): Promise<void> {
    assertSafeResourceId("run", runId);
    if (events.length === 0) return;
    const existing = this.loadEventsSync(runId);
    const alreadyStarted = existing.some((e) => e.type === "run.started");
    const seen = new Set(existing.map((e) => e.commandId));
    const toAppend: RunEvent[] = [];
    let i = 0;
    while (i < events.length) {
      const commandId = events[i].commandId;
      const group: RunEvent[] = [];
      while (i < events.length && events[i].commandId === commandId) { group.push(events[i]); i++; }
      if (seen.has(commandId)) continue;
      seen.add(commandId); toAppend.push(...group);
    }
    if (toAppend.length === 0) return;
    if (alreadyStarted && toAppend.some((e) => e.type === "run.started")) throw new RunAlreadyExistsError(runId);
    let seq = existing.length + 1;
    let logicalTime = existing.length === 0 ? 1 : existing[existing.length - 1].logicalTime + 1;
    let previousHash = existing.length === 0 ? "" : existing[existing.length - 1].hash;
    const insert = this.db.prepare(
      "INSERT INTO events (run_id, seq, command_id, type, payload_json, hash) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const domainEvent of toAppend) {
        const recorded = recordEvent(domainEvent, seq, logicalTime, previousHash);
        insert.run(runId, seq, domainEvent.commandId, domainEvent.type, canonicalJson(recorded), recorded.hash);
        seq += 1; logicalTime += 1; previousHash = recorded.hash;
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  async loadEvents(runId: string, options?: { baseDir?: string }): Promise<RecordedEvent[]> {
    assertSafeResourceId("run", runId);
    const rows = this.db.prepare("SELECT payload_json FROM events WHERE run_id = ? ORDER BY seq").all(runId);
    if (rows.length === 0) {
      const run = this.db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId);
      if (run === undefined) throw new RunNotFoundError(runId);
      return [];
    }
    const raw = rows.map((r) => JSON.parse((r as { payload_json: string }).payload_json));
    return verifyChain(raw, this.runFormatVersion(runId));
  }

  async loadRun(runId: string, options?: { baseDir?: string }): Promise<RunState> {
    const events = await this.loadEvents(runId, options);
    let state = createInitialRunState(runId);
    for (const event of events) state = reduce(state, event);
    return state;
  }

  async readHead(runId: string, options?: { baseDir?: string }): Promise<{ seq: number; hash: string } | null> {
    assertSafeResourceId("run", runId);
    const row = this.db.prepare("SELECT seq, hash FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1").get(runId);
    return row === undefined ? null : { seq: (row as { seq: number }).seq, hash: (row as { hash: string }).hash };
  }

  // private helpers: loadEventsSync (raw rows, no RunNotFound throw), runFormatVersion (from runs.manifest_json)
}
```

(Note: `payload_json` stores the full `RecordedEvent` canonical JSON; `loadEvents` re-runs `verifyChain` over those. `appendEvents` is `async` to satisfy the port but internally synchronous — the port is async so wrap in `Promise`/`async` as shown. The `runs` table stores the run manifest (the same `{ runFormatVersion }` JSON the file store writes) so `runFormatVersion(runId)` can resolve the upcaster version; a fresh run writes `runFormatVersion: RUN_FORMAT_VERSION`.)

- [ ] **Step 2: Verify + commit.** `npm run typecheck && npm test` (the new class is not yet wired, so existing tests unaffected; add a minimal smoke test if desired).

```bash
git add -A && git commit -m "feat: add SqliteEventStore implementing EventStorePort"
```

---

### Task 3: Route the transaction through the selected store

**Files:**
- Modify: `src/core/command-transaction.ts`
- Modify: `src/application/use-cases/*.ts` (pass the store's `appendEvents`/`readHead`)

- [ ] **Step 1: Add a `TransactionEventStore` dependency.** In `command-transaction.ts`, define:

```ts
export interface TransactionEventStore {
  appendEvents(runId: string, events: RunEvent[], options: { baseDir?: string; lock?: unknown }): Promise<void>;
  readHead(runId: string, options: { baseDir?: string; lock?: unknown }): Promise<{ seq: number; hash: string } | null>;
}
```

Add `events?: TransactionEventStore` to `executeCommandTransaction`'s options; default it to the file store's `{ appendEvents, readHead }` (the current imports). Replace the four `appendEvents(...)` call sites and the two `readHead(...)` call sites with `events.appendEvents(...)`/`events.readHead(...)` (threading `events` into `applyEffect`/`applyEffects`).

- [ ] **Step 2: Pass the store from the use cases.** In the use cases (the `executeCommandTransaction({...})` call sites in `src/application/use-cases/`), pass `events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead }` (or a helper that bundles it). The `EventStorePort`'s `appendEvents`/`readHead` accept `{ baseDir? }`; make `TransactionEventStore`'s options compatible (a function accepting `{ baseDir? }` is assignable to one accepting `{ baseDir?; lock? }` — if TS complains, widen the `EventStorePort` signatures to `StoreOptions`).

- [ ] **Step 3: Verify + commit.** `npm run typecheck && npm test` — green (defaults to the file store, byte-identical).

```bash
git add -A && git commit -m "refactor: route transaction event append/read through the selected store"
```

---

### Task 4: Selection + wiring (`FDE_GYM_STORE=sqlite`)

**Files:**
- Modify: `src/application/deps.ts` (or a new `src/application/resolve-store.ts`)

- [ ] **Step 1: Resolve the store.** Add a `resolveEventStore(baseDir)` that returns either the file-store functions or a `SqliteEventStore` instance based on `process.env.FDE_GYM_STORE === "sqlite"` (dbPath = `<baseDir>/store.sqlite`). Default (unset) → the file store.

- [ ] **Step 2: Wire into `buildDeps`.** `buildDeps` builds `store` from `resolveEventStore(baseDir)` so `deps.store` (and therefore the use cases and transaction) route to SQLite when selected. (The transaction's default `events` still defaults to the file store, so ensure the use cases' `events` pass-through — Task 3 — is what actually selects SQLite.)

- [ ] **Step 3: Verify + commit.** `npm run typecheck && npm test` (unset → file store, green).

```bash
git add -A && git commit -m "feat: select SQLite event store via FDE_GYM_STORE=sqlite"
```

---

### Task 5: Contract test (dual-store) + full gate

**Files:**
- Modify: the existing event-store contract test (locate via `rg -n "appendEvents|loadEvents|EVENT_CHAIN_INVALID" tests/`)
- Create (if needed): `tests/contracts/event-store-contract.test.ts`

- [ ] **Step 1: Parameterize the contract test.** Refactor the event-store contract scenarios into `describe.each([["file", fileFactory], ["sqlite", sqliteFactory]])` where each factory returns `{ store, baseDir, cleanup }` (the SQLite factory creates a temp `store.sqlite`). Assert the same behaviors against both: append/load round-trip, hash-chain tamper → `EVENT_CHAIN_INVALID`, command-id idempotency, `readHead` null→non-null, `RUN_ALREADY_EXISTS`, `RUN_NOT_FOUND`.

- [ ] **Step 2: Full gate.** `npm run release:gate` — green, golden replay byte-stable.

- [ ] **Step 3: Commit.**

```bash
git add -A && git commit -m "test: run event-store contract against both file and SQLite stores"
```

---

## Execution order

1 → 2 → 3 → 4 → 5 (serial; each depends on the previous).

## Verification checklist

- [ ] `npm run release:gate` green; golden replay byte-stable.
- [ ] Same contract-test scenarios pass against both stores (byte-equivalent chain).
- [ ] `FDE_GYM_STORE=sqlite` routes a run's events to `store.sqlite`; unset uses the file store.
- [ ] Zero new npm dependencies (only `node:sqlite`).
- [ ] The file store's on-disk format is unchanged.
