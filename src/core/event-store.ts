import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { RunEventSchema, type RecordedEvent, type RunEvent } from "./domain.js";
import { EventChainInvalidError, RunNotFoundError } from "./errors.js";
import { createInitialRunState, reduce, type RunState } from "./reducer.js";

/**
 * Append-only, hash-chained JSONL event store under `${FDE_GYM_HOME}/runs/<run-id>/events.jsonl`.
 * The domain event payload is written verbatim; the envelope (`seq`,
 * `logicalTime`, `previousHash`, `hash`) is layered on top here so `decide()`
 * and `reduce()` stay pure of wall-clock and hashing.
 */

const FIRST_PREVIOUS_HASH = "";
const SHA256_HEX_LENGTH = 64;

export interface StoreOptions {
  /** Overrides `$FDE_GYM_HOME`/`~/.fde-gym` — used by tests to point at a temp dir. */
  baseDir?: string;
}

/** Resolve the store root: `$FDE_GYM_HOME` when set (non-empty), else `~/.fde-gym`. */
export function resolveBaseDir(): string {
  return process.env.FDE_GYM_HOME || join(homedir(), ".fde-gym");
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

/**
 * Append domain events to a run, assigning the envelope and chaining hashes.
 * Idempotent by `commandId`: an event whose `commandId` is already recorded is
 * skipped, so replaying a command never duplicates effects.
 */
export async function appendEvents(
  runId: string,
  events: RunEvent[],
  options: StoreOptions = {},
): Promise<void> {
  if (events.length === 0) return;
  const baseDir = options.baseDir ?? resolveBaseDir();
  const existing = await readRecordedEvents(baseDir, runId);

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

  await mkdir(join(baseDir, "runs", runId), { recursive: true });
  await appendFile(eventsFile(baseDir, runId), lines.join(""), "utf8");
}

/**
 * Load a run by replaying its committed events. Rejects a missing run with
 * `RUN_NOT_FOUND` and a tampered/corrupted chain with `EVENT_CHAIN_INVALID`;
 * tolerates only a final incomplete line from an interrupted write.
 */
export async function loadRun(runId: string, options: StoreOptions = {}): Promise<RunState> {
  const baseDir = options.baseDir ?? resolveBaseDir();
  const file = eventsFile(baseDir, runId);

  let exists = true;
  try {
    await access(file);
  } catch {
    exists = false;
  }
  if (!exists) throw new RunNotFoundError(runId);

  const events = await readRecordedEvents(baseDir, runId);
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
  const baseDir = options.baseDir ?? resolveBaseDir();
  const file = eventsFile(baseDir, runId);

  let exists = true;
  try {
    await access(file);
  } catch {
    exists = false;
  }
  if (!exists) throw new RunNotFoundError(runId);

  return readRecordedEvents(baseDir, runId);
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

function hashRecordedEvent(recorded: RecordedEvent): string {
  const { hash: _hash, ...withoutHash } = recorded;
  return sha256Hex(canonicalJson(withoutHash));
}

/** Read + validate the chain. Returns [] for a run with no file yet. */
async function readRecordedEvents(baseDir: string, runId: string): Promise<RecordedEvent[]> {
  const file = eventsFile(baseDir, runId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const events: RecordedEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      // Only a trailing line cut off mid-write is tolerated.
      if (i === lines.length - 1) break;
      throw new EventChainInvalidError(`unparseable committed event at line ${i + 1}`);
    }

    const validation = RecordedEventSchema.safeParse(parsed);
    if (!validation.success) {
      throw new EventChainInvalidError(`invalid recorded event at line ${i + 1}`);
    }
    const recorded = validation.data as RecordedEvent;

    const expectedSeq = events.length + 1;
    const expectedPreviousHash =
      events.length === 0 ? FIRST_PREVIOUS_HASH : events[events.length - 1].hash;

    if (recorded.seq !== expectedSeq) {
      throw new EventChainInvalidError(
        `seq discontinuity at line ${i + 1}: expected ${expectedSeq}, got ${recorded.seq}`,
      );
    }
    if (recorded.previousHash !== expectedPreviousHash) {
      throw new EventChainInvalidError(`previousHash mismatch at line ${i + 1}`);
    }
    if (hashRecordedEvent(recorded) !== recorded.hash) {
      throw new EventChainInvalidError(`hash mismatch at line ${i + 1}`);
    }
    events.push(recorded);
  }
  return events;
}
