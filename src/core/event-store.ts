import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { resolveBaseDir } from "../base-dir.js";
import { RunEventSchema, SAFE_RESOURCE_ID, type RecordedEvent, type RunEvent } from "./domain.js";
import {
  RUN_FORMAT_VERSION,
  resolveRunFormatVersion,
  upcastRecordedEvent,
} from "./versioning.js";
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

/**
 * Append-only, hash-chained JSONL event store under
 * `${FDE_GYM_HOME}/runs/<run-id>/events.jsonl` (default `${FDE_GYM_HOME}` is the
 * project-local `.fde-gym` directory).
 * The domain event payload is written verbatim; the envelope (`seq`,
 * `logicalTime`, `previousHash`, `hash`) is layered on top here so the
 * `prepare*` event authors and `reduce()` stay pure of wall-clock and hashing.
 */

const FIRST_PREVIOUS_HASH = "";
const SHA256_HEX_LENGTH = 64;

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

/** Envelope schema; the domain payload schema is intersected in below. */
export const EventEnvelopeSchema = z
  .object({
    seq: z.number().int().positive(),
    logicalTime: z.number().int().positive(),
    previousHash: z.string(),
    hash: z.string().length(SHA256_HEX_LENGTH),
  })
  .strict();

/** The full recorded-event schema (domain payload + envelope). */
export const RecordedEventSchema = RunEventSchema.and(EventEnvelopeSchema);

/**
 * Canonical JSON: object keys sorted recursively, then `JSON.stringify`. This
 * is the byte-stability contract for hashing — independent of how an object
 * was constructed or parsed.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
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

function recordEvent(
  domainEvent: RunEvent,
  seq: number,
  logicalTime: number,
  previousHash: string,
): RecordedEvent {
  const withoutHash = { ...domainEvent, seq, logicalTime, previousHash };
  const hash = sha256Hex(canonicalJson(withoutHash));
  return { ...withoutHash, hash };
}

/** Recompute the hash over a raw record's non-hash fields (canonical key order). */
function hashRawRecord(raw: Record<string, unknown>): string {
  const { hash: _hash, ...withoutHash } = raw;
  return sha256Hex(canonicalJson(withoutHash));
}

/** Validate the envelope fields of a raw record, returning them typed (or null). */
function envelopeFields(raw: Record<string, unknown>): {
  seq: number;
  logicalTime: number;
  previousHash: string;
  hash: string;
} | null {
  const { seq, logicalTime, previousHash, hash } = raw;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) return null;
  if (typeof logicalTime !== "number" || !Number.isInteger(logicalTime) || logicalTime <= 0) {
    return null;
  }
  if (typeof previousHash !== "string") return null;
  if (typeof hash !== "string" || hash.length !== SHA256_HEX_LENGTH) return null;
  return { seq, logicalTime, previousHash, hash };
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
  const events: RecordedEvent[] = [];
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

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new EventChainInvalidError(`invalid recorded event at line ${i + 1}`);
    }
    const rawRecord = parsed as Record<string, unknown>;
    const envelope = envelopeFields(rawRecord);
    if (envelope === null) {
      throw new EventChainInvalidError(`invalid recorded event at line ${i + 1}`);
    }

    const expectedSeq = events.length + 1;
    const expectedPreviousHash =
      events.length === 0 ? FIRST_PREVIOUS_HASH : events[events.length - 1].hash;

    if (envelope.seq !== expectedSeq) {
      throw new EventChainInvalidError(
        `seq discontinuity at line ${i + 1}: expected ${expectedSeq}, got ${envelope.seq}`,
      );
    }
    if (envelope.previousHash !== expectedPreviousHash) {
      throw new EventChainInvalidError(`previousHash mismatch at line ${i + 1}`);
    }
    if (hashRawRecord(rawRecord) !== envelope.hash) {
      throw new EventChainInvalidError(`hash mismatch at line ${i + 1}`);
    }

    // Hash is verified; now select the upcaster and validate the CURRENT schema.
    const upcasted = upcastRecordedEvent(rawRecord, runFormatVersion);
    const validation = RecordedEventSchema.safeParse(upcasted);
    if (!validation.success) {
      throw new EventChainInvalidError(`invalid recorded event at line ${i + 1}`);
    }
    events.push(validation.data);
    committedCount = i + 1;
  }

  const committedPrefix =
    committedCount === 0 ? "" : lines.slice(0, committedCount).join("\n") + "\n";
  return { events, committedPrefix };
}
