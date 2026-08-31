import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBaseDir } from "../base-dir.js";
import { SAFE_RESOURCE_ID, type RecordedEvent, type RunEvent } from "./domain.js";
import { RUN_FORMAT_VERSION, resolveRunFormatVersion } from "./versioning.js";
import {
  EventChainInvalidError,
  InvalidResourceIdError,
  RunAlreadyExistsError,
  RunNotFoundError,
  UnsupportedSchemaVersionError,
} from "./errors.js";
import { createInitialRunState, reduce, type RunState } from "./reducer.js";
import { atomicWriteFile } from "../storage/atomic-file.js";
import { withRunLock, type RunLock } from "../storage/run-lock.js";
import {
  canonicalJson,
  EventEnvelopeSchema,
  RecordedEventSchema,
  recordEvent,
  verifyChain,
} from "../storage/event-chain.js";

// Re-exported for `command-transaction.ts` and the scenario/fixture helpers,
// which import `canonicalJson` from the store, and for any caller depending on
// the envelope/recorded-event schemas living on the store module.
export { canonicalJson, EventEnvelopeSchema, RecordedEventSchema };

/**
 * Append-only, hash-chained JSONL event store under
 * `${FDE_GYM_HOME}/runs/<run-id>/events.jsonl` (default `${FDE_GYM_HOME}` is the
 * project-local `.fde-gym` directory).
 * The domain event payload is written verbatim; the envelope (`seq`,
 * `logicalTime`, `previousHash`, `hash`) is layered on top here so the
 * `prepare*` event authors and `reduce()` stay pure of wall-clock and hashing.
 */

const FIRST_PREVIOUS_HASH = "";

export interface StoreOptions {
  /** Overrides `$FDE_GYM_HOME` and the project-local `.fde-gym` default. */
  baseDir?: string;
  /** A run lock already held by the caller; reused instead of re-acquiring. */
  lock?: RunLock;
}

export { resolveBaseDir };

/**
 * Reject any resource id that is unsafe as a filename component BEFORE it can
 * reach a path join. `kind` labels the failing entity in the error. Run ids and
 * command ids become filenames (events.jsonl / the command journal); scenario
 * ids are validated at the same boundary for later bundle/run lookups.
 */
export function assertSafeResourceId(kind: "run" | "scenario" | "command", id: string): void {
  if (!SAFE_RESOURCE_ID.test(id)) {
    throw new InvalidResourceIdError(kind, id);
  }
}

function eventsFile(baseDir: string, runId: string): string {
  return join(baseDir, "runs", runId, "events.jsonl");
}

function manifestFile(baseDir: string, runId: string): string {
  return join(baseDir, "runs", runId, "manifest.json");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and resolve the run manifest's run format version. A missing or
 * unparseable manifest, or a run format this build does not support, fails
 * closed with `UNSUPPORTED_SCHEMA_VERSION` and a migration instruction rather
 * than partially parsing the run. Frozen v1 manifests (`schemaVersion: 1`)
 * resolve to run format 1 so the event upcaster selects the v1 path.
 */
async function readRunManifest(baseDir: string, runId: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(manifestFile(baseDir, runId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UnsupportedSchemaVersionError(`run ${runId}`, "unversioned (no manifest)");
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UnsupportedSchemaVersionError(`run ${runId}`, "unparseable manifest");
  }
  return resolveRunFormatVersion(parsed);
}

/**
 * Append domain events to a run, assigning the envelope and chaining hashes.
 * Idempotent by `commandId`: an event whose `commandId` is already recorded is
 * skipped, so replaying a command never duplicates effects.
 *
 * The append runs under the run's exclusive cross-process lock and replaces the
 * events file atomically (see `atomicWriteFile`), so two writers can never both
 * compute a batch from the same committed head.
 */
export async function appendEvents(
  runId: string,
  events: RunEvent[],
  options: StoreOptions = {},
): Promise<void> {
  if (events.length === 0) return;
  assertSafeResourceId("run", runId);
  const baseDir = options.baseDir ?? resolveBaseDir();
  await withRunLock(runId, { ...options, baseDir }, () => appendEventsLocked(runId, events, baseDir));
}

async function appendEventsLocked(runId: string, events: RunEvent[], baseDir: string): Promise<void> {
  const { events: existing, committedPrefix } = await readEventsAndPrefix(baseDir, runId);
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

  let seq = existing.length + 1;
  let logicalTime = existing.length === 0 ? 1 : existing[existing.length - 1].logicalTime + 1;
  let previousHash =
    existing.length === 0 ? FIRST_PREVIOUS_HASH : existing[existing.length - 1].hash;

  const lines: string[] = [];
  for (const domainEvent of toAppend) {
    const recorded = recordEvent(domainEvent, seq, logicalTime, previousHash);
    lines.push(canonicalJson(recorded) + "\n");
    seq += 1;
    logicalTime += 1;
    previousHash = recorded.hash;
  }

  const runDir = join(baseDir, "runs", runId);
  await mkdir(runDir, { recursive: true });

  // The run manifest is immutable after creation: created exclusively for a new
  // run, validated (never rewritten) for an existing one.
  if (await fileExists(manifestFile(baseDir, runId))) {
    await readRunManifest(baseDir, runId);
  } else {
    await atomicWriteFile(
      manifestFile(baseDir, runId),
      JSON.stringify({ runFormatVersion: RUN_FORMAT_VERSION }) + "\n",
    );
  }

  // Replace the events file atomically with the valid committed prefix (any
  // incomplete trailing fragment physically discarded) plus the new batch.
  await atomicWriteFile(eventsFile(baseDir, runId), committedPrefix + lines.join(""));
}

/**
 * Load a run by replaying its committed events. Rejects a missing run with
 * `RUN_NOT_FOUND` and a tampered/corrupted chain with `EVENT_CHAIN_INVALID`;
 * tolerates only a final incomplete line from an interrupted write.
 */
export async function loadRun(runId: string, options: StoreOptions = {}): Promise<RunState> {
  assertSafeResourceId("run", runId);
  const baseDir = options.baseDir ?? resolveBaseDir();
  const file = eventsFile(baseDir, runId);

  if (!(await fileExists(file))) throw new RunNotFoundError(runId);

  const { events } = await readEventsAndPrefix(baseDir, runId);
  let state = createInitialRunState(runId);
  for (const event of events) state = reduce(state, event);
  return state;
}

/**
 * Load a run's committed, hash-chain-validated events. Throws `RUN_NOT_FOUND`
 * for a missing run and `EVENT_CHAIN_INVALID` for a tampered chain. Used by the
 * replay projector and the CLI resume path to fold the full `RunAggregate`.
 */
export async function loadEvents(runId: string, options: StoreOptions = {}): Promise<RecordedEvent[]> {
  assertSafeResourceId("run", runId);
  const baseDir = options.baseDir ?? resolveBaseDir();
  const file = eventsFile(baseDir, runId);

  if (!(await fileExists(file))) throw new RunNotFoundError(runId);

  const { events } = await readEventsAndPrefix(baseDir, runId);
  return events;
}

/** The committed log head — `{ seq, hash }` of the last recorded event, or `null` for an empty/absent run. */
export async function readHead(
  runId: string,
  options: StoreOptions = {},
): Promise<{ seq: number; hash: string } | null> {
  assertSafeResourceId("run", runId);
  const baseDir = options.baseDir ?? resolveBaseDir();
  const file = eventsFile(baseDir, runId);
  if (!(await fileExists(file))) return null;
  const { events } = await readEventsAndPrefix(baseDir, runId);
  if (events.length === 0) return null;
  const last = events[events.length - 1];
  return { seq: last.seq, hash: last.hash };
}

/**
 * Read + validate the chain, returning the committed events together with the
 * exact on-disk bytes of their committed prefix (valid lines up to the last
 * good one). Returns `{ events: [], committedPrefix: "" }` for a run with no
 * file yet. An incomplete TRAILING line (an interrupted write) is tolerated and
 * excluded from the prefix; any corruption in the middle rejects with
 * `EVENT_CHAIN_INVALID`.
 *
 * Processing order (Task 8): parse raw record -> validate the ORIGINAL
 * envelope/hash -> select the explicit upcaster by run format -> validate the
 * CURRENT `RecordedEventSchema` -> emit. Hash verification therefore always
 * runs on the original bytes, before any upcast can rewrite a payload.
 */
async function readEventsAndPrefix(
  baseDir: string,
  runId: string,
): Promise<{ events: RecordedEvent[]; committedPrefix: string }> {
  const file = eventsFile(baseDir, runId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], committedPrefix: "" };
    }
    throw error;
  }

  const runFormatVersion = await readRunManifest(baseDir, runId);

  const lines = raw.split("\n");
  const rawRecords: unknown[] = [];
  let committedCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      // The final artifact of a trailing newline; an empty line in the middle
      // is corruption.
      if (i === lines.length - 1) break;
      throw new EventChainInvalidError(`empty committed event at line ${i + 1}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Only a trailing line cut off mid-write is tolerated.
      if (i === lines.length - 1) break;
      throw new EventChainInvalidError(`unparseable committed event at line ${i + 1}`);
    }

    rawRecords.push(parsed);
    committedCount = i + 1;
  }

  const events = verifyChain(rawRecords, runFormatVersion);

  const committedPrefix =
    committedCount === 0 ? "" : lines.slice(0, committedCount).join("\n") + "\n";
  return { events, committedPrefix };
}
