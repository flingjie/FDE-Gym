import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { collectProhibitedKeyPaths } from "../agents/contracts.js";
import { createEmptyProfile, updateLearnerProfile, type AttemptReview } from "../profile/learner-profile.js";
import { atomicWriteFile } from "../storage/atomic-file.js";
import { loadLearnerProfile, saveLearnerProfile } from "../storage/fs-store.js";
import { withRunLock } from "../storage/run-lock.js";
import { RunEventSchema, type RunEvent } from "./domain.js";
import { CommandIdConflictError } from "./errors.js";
import {
  appendEvents,
  assertSafeResourceId,
  canonicalJson,
  resolveBaseDir,
  type StoreOptions,
} from "./event-store.js";

/**
 * FDE Gym — write-ahead command journal and deterministic result replay.
 *
 * Every mutating CLI command runs through `executeCommandTransaction`. A
 * per-command journal (`<baseDir>/runs/<runId>/commands/<commandId>.json`) is
 * written atomically BEFORE any event or effect is applied, and records the
 * canonical request hash, the complete event batch, the learner-safe result
 * snapshot, and the idempotent effects. Recovery of a `prepared` journal can
 * finish a command (append its events, apply its effects, mark committed)
 * without re-invoking a model.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CommandEffect =
  | { type: "profile.apply-attempt"; effectId: string; runId: string; review: AttemptReview }
  | { type: "retry.ensure-child"; effectId: string; parentRunId: string; childRunId: string; events: RunEvent[] };

export interface PreparedCommand<T extends JsonValue> {
  journalVersion: 1;
  runId: string;
  commandId: string;
  requestHash: string;
  status: "prepared" | "committed";
  events: RunEvent[];
  result: T;
  effects: CommandEffect[];
}

export interface CommandPlan<T extends JsonValue> {
  events: RunEvent[];
  result: T;
  effects?: CommandEffect[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JOURNAL_VERSION = 1 as const;
const SHA256_HEX_LENGTH = 64;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function journalFile(baseDir: string, runId: string, commandId: string): string {
  return join(baseDir, "runs", runId, "commands", `${commandId}.json`);
}

/** Strict recursive `JsonValue` check: rejects `undefined`, non-finite numbers, and non-plain objects. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "boolean" || type === "string") return true;
  if (type === "number") return Number.isFinite(value);
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
    return false;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (type === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function assertJsonValue(value: unknown, label: string): void {
  if (!isJsonValue(value)) {
    throw new Error(`${label} is not a JSON value`);
  }
}

function assertNoProhibitedKeys(value: unknown, label: string): void {
  const paths = collectProhibitedKeyPaths(value);
  if (paths.length > 0) {
    throw new Error(`${label} carries prohibited keys: ${paths.join(", ")}`);
  }
}

/** Validate a command plan before it is journaled: JSON-safe, prohibited-key-free, schema-valid events. */
function validatePlan(events: RunEvent[], result: JsonValue, effects: CommandEffect[]): void {
  assertJsonValue(events, "command events");
  assertJsonValue(result, "command result");
  assertJsonValue(effects, "command effects");
  assertNoProhibitedKeys(events, "command events");
  assertNoProhibitedKeys(result, "command result");
  assertNoProhibitedKeys(effects, "command effects");
  z.array(RunEventSchema).parse(events);
}

/** Read a journal, failing closed on a missing (`null`) or malformed file. */
async function readJournal(path: string): Promise<PreparedCommand<JsonValue> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid command journal: not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("invalid command journal: not an object");
  }
  const journal = parsed as Record<string, unknown>;
  if (journal.journalVersion !== JOURNAL_VERSION) {
    throw new Error("invalid command journal: unsupported journalVersion");
  }
  if (typeof journal.runId !== "string" || typeof journal.commandId !== "string") {
    throw new Error("invalid command journal: missing runId/commandId");
  }
  if (typeof journal.requestHash !== "string" || journal.requestHash.length !== SHA256_HEX_LENGTH) {
    throw new Error("invalid command journal: malformed requestHash");
  }
  if (journal.status !== "prepared" && journal.status !== "committed") {
    throw new Error("invalid command journal: unknown status");
  }
  if (!Array.isArray(journal.events)) {
    throw new Error("invalid command journal: events not an array");
  }
  if (!Array.isArray(journal.effects)) {
    throw new Error("invalid command journal: effects not an array");
  }
  if (!("result" in journal)) {
    throw new Error("invalid command journal: missing result");
  }
  return journal as unknown as PreparedCommand<JsonValue>;
}

async function writeJournal(path: string, journal: PreparedCommand<JsonValue>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(journal) + "\n");
}

/**
 * Apply one journaled effect. `retry.ensure-child` is idempotent by the child
 * run's command-id dedup in `appendEvents`; `profile.apply-attempt` is applied
 * exactly-once semantics are reconciled with the profile store in Task 6.
 */
async function applyEffect(effect: CommandEffect, baseDir: string): Promise<void> {
  switch (effect.type) {
    case "retry.ensure-child":
      await appendEvents(effect.childRunId, effect.events, { baseDir });
      return;
    case "profile.apply-attempt": {
      const base = (await loadLearnerProfile({ baseDir })) ?? createEmptyProfile();
      const updated = updateLearnerProfile(base, effect.review);
      await saveLearnerProfile(updated, { baseDir });
      return;
    }
  }
}

async function applyEffects(effects: CommandEffect[], baseDir: string): Promise<void> {
  for (const effect of effects) {
    await applyEffect(effect, baseDir);
  }
}

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

/**
 * Run a mutating command as an atomic, recoverable transaction:
 *
 *   absent    -> prepare() -> atomic write `prepared`
 *   prepared  -> append missing event batch -> apply missing effects
 *   all durable -> atomic write `committed`
 *   committed + matching hash -> return stored result
 *   any state + different hash -> COMMAND_ID_CONFLICT
 */
export async function executeCommandTransaction<T extends JsonValue>(options: {
  runId: string;
  commandId: string;
  request: JsonValue;
  store?: StoreOptions;
  prepare: () => Promise<CommandPlan<T>>;
}): Promise<T> {
  const { runId, commandId, request } = options;
  // The top-level commandId becomes a journal filename component, so it must be
  // validated with the same resource-id shape as run ids. The `:`-suffixed ids
  // in DERIVED event commandId fields are event data, never filenames.
  assertSafeResourceId("run", runId);
  assertSafeResourceId("command", commandId);
  const baseDir = options.store?.baseDir ?? resolveBaseDir();
  const requestHash = sha256Hex(canonicalJson(request));
  const path = journalFile(baseDir, runId, commandId);

  return withRunLock(runId, options.store ?? {}, async (lock) => {
    const store: StoreOptions = { baseDir, lock };
    const existing = await readJournal(path);

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new CommandIdConflictError(runId, commandId);
      }
      if (existing.status === "committed") {
        return existing.result as T;
      }
      // Finish a prepared (interrupted) command: append is idempotent by
      // commandId; effects are applied once more (idempotent per effect).
      await appendEvents(runId, existing.events, store);
      await applyEffects(existing.effects, baseDir);
      await writeJournal(path, { ...existing, status: "committed" });
      return existing.result as T;
    }

    const plan = await options.prepare();
    const events = plan.events ?? [];
    const result = plan.result;
    const effects = plan.effects ?? [];
    validatePlan(events, result, effects);

    const prepared: PreparedCommand<JsonValue> = {
      journalVersion: JOURNAL_VERSION,
      runId,
      commandId,
      requestHash,
      status: "prepared",
      events,
      result,
      effects,
    };
    await writeJournal(path, prepared);
    await appendEvents(runId, events, store);
    await applyEffects(effects, baseDir);
    await writeJournal(path, { ...prepared, status: "committed" });
    return result as T;
  });
}
