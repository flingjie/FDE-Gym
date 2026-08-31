import { createHash } from "node:crypto";
import { z } from "zod";

import { RunEventSchema, type RecordedEvent, type RunEvent } from "../core/domain.js";
import { EventChainInvalidError } from "../core/errors.js";
import { upcastRecordedEvent } from "../core/versioning.js";

/**
 * Shared hash-chain logic for append-only event stores. The file store
 * (`src/core/event-store.ts`) and the SQLite adapter both build on this so the
 * envelope, the canonical-JSON hash, and the chain-verification loop can never
 * drift between backends.
 */

export const SHA256_HEX_LENGTH = 64;
const FIRST_PREVIOUS_HASH = "";

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

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Layer the hash-chain envelope onto a domain event, hashing the canonical
 * (key-sorted) JSON of the non-hash fields.
 */
export function recordEvent(
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
 * Validate a hash chain over already-parsed raw records: record shape ->
 * envelope fields -> seq continuity -> previousHash -> hash -> explicit upcast
 * -> CURRENT `RecordedEventSchema`. Throws `EventChainInvalidError` on any
 * failure. Pure: no file I/O and no line numbering; callers own reading and
 * parsing (including tolerating a trailing incomplete line).
 */
export function verifyChain(
  rawRecords: readonly unknown[],
  runFormatVersion: number,
): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  for (const raw of rawRecords) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new EventChainInvalidError("invalid recorded event");
    }
    const rawRecord = raw as Record<string, unknown>;
    const envelope = envelopeFields(rawRecord);
    if (envelope === null) throw new EventChainInvalidError("invalid recorded event envelope");
    const expectedSeq = events.length + 1;
    const expectedPreviousHash =
      events.length === 0 ? FIRST_PREVIOUS_HASH : events[events.length - 1].hash;
    if (envelope.seq !== expectedSeq) {
      throw new EventChainInvalidError(`seq discontinuity: expected ${expectedSeq}, got ${envelope.seq}`);
    }
    if (envelope.previousHash !== expectedPreviousHash) {
      throw new EventChainInvalidError("previousHash mismatch");
    }
    if (hashRawRecord(rawRecord) !== envelope.hash) {
      throw new EventChainInvalidError("hash mismatch");
    }

    // Hash is verified; now select the upcaster and validate the CURRENT schema.
    const upcasted = upcastRecordedEvent(rawRecord, runFormatVersion);
    const validated = RecordedEventSchema.safeParse(upcasted);
    if (!validated.success) throw new EventChainInvalidError("invalid recorded event");
    events.push(validated.data);
  }
  return events;
}
