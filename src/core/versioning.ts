import { z } from "zod";

import { FDE_SCHEMA_VERSION, type RecordedEvent } from "./domain.js";
import { UnsupportedSchemaVersionError } from "./errors.js";
import {
  LearnerProfileSchema,
  type LearnerProfile,
} from "../profile/learner-profile.js";
import { legacyScoreProvenance } from "../scoring/provenance.js";

export {
  SCORE_SCHEMA_VERSION,
  FORMULA_VERSION,
  OUTPUT_SCHEMA_VERSION,
  LEGACY_COMPARABILITY_KEY,
} from "../scoring/provenance.js";
export { CAPABILITY_RUBRIC_ID, CAPABILITY_RUBRIC_VERSION } from "../scoring/rubric.js";

/**
 * FDE Gym — explicit format-version layer (Task 8).
 *
 * The single frozen `FDE_SCHEMA_VERSION` is split into independent versions:
 * `RUN_FORMAT_VERSION` (run manifest + recorded-event shape), `EVENT_ENVELOPE_VERSION`
 * (the hash-chain envelope), the scenario manifest/partition versions (see
 * `src/scenarios/schema.ts`), and the score/formula/rubric versions (see
 * `src/scoring/provenance.ts` and `src/scoring/rubric.ts`).
 *
 * Readers accept ONLY explicitly listed versions and fail closed on unknown
 * revisions — never a `<=` range comparison. Frozen v1 fixtures are supported
 * through pure upcasters below; the v1 run format (`schemaVersion: 1` on the
 * manifest) upcasts to the current run format.
 */

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

/** The current run-manifest + recorded-event format. v1 (schemaVersion 1) upcasts. */
export const RUN_FORMAT_VERSION = 2 as const;
/** The hash-chain envelope version layered on every recorded event. */
export const EVENT_ENVELOPE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Current run manifest
// ---------------------------------------------------------------------------

export interface CurrentRunManifest {
  runFormatVersion: typeof RUN_FORMAT_VERSION;
}

export const CurrentRunManifestSchema = z
  .object({ runFormatVersion: z.literal(RUN_FORMAT_VERSION) })
  .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve a raw run manifest's declared run format version: `2` for a current
 * manifest (`runFormatVersion: 2`), `1` for a frozen v1 manifest
 * (`schemaVersion: 1`), and anything else fails closed. The store uses this to
 * select the event upcaster by the ORIGINAL on-disk format.
 */
export function resolveRunFormatVersion(raw: unknown): number {
  if (!isRecord(raw)) {
    throw new UnsupportedSchemaVersionError("run manifest", undefined);
  }
  if (raw.runFormatVersion === RUN_FORMAT_VERSION) return RUN_FORMAT_VERSION;
  if (raw.runFormatVersion !== undefined) {
    throw new UnsupportedSchemaVersionError("run manifest", raw.runFormatVersion);
  }
  if (raw.schemaVersion === 1) return 1;
  throw new UnsupportedSchemaVersionError(
    "run manifest",
    raw.runFormatVersion ?? raw.schemaVersion,
  );
}

/**
 * Upcast a raw run manifest to the current run format. The frozen v1 manifest
 * (`{ schemaVersion: 1 }`) maps to `{ runFormatVersion: 2 }`; the current
 * manifest passes through; anything else fails closed.
 */
export function upcastRunManifest(raw: unknown): CurrentRunManifest {
  resolveRunFormatVersion(raw);
  return { runFormatVersion: RUN_FORMAT_VERSION };
}

/**
 * Upcast a raw recorded event to the current `RecordedEvent` shape, selecting
 * the upcaster by run format and event type. v1 and current events share the
 * envelope and domain payload except that a v1 `score.computed` lacks
 * provenance — it is assigned the non-comparable legacy provenance. The
 * original envelope/hash must already be verified BEFORE this runs (see
 * `src/core/event-store.ts`).
 */
export function upcastRecordedEvent(raw: unknown, runFormatVersion: number): RecordedEvent {
  if (runFormatVersion !== 1 && runFormatVersion !== RUN_FORMAT_VERSION) {
    throw new UnsupportedSchemaVersionError("run event", runFormatVersion);
  }
  if (
    runFormatVersion === 1 &&
    isRecord(raw) &&
    raw.type === "score.computed" &&
    !("provenance" in raw)
  ) {
    return { ...raw, provenance: legacyScoreProvenance() } as RecordedEvent;
  }
  return raw as RecordedEvent;
}

/**
 * Upcast a persisted learner profile to the current shape. The profile's
 * `schemaVersion` is still the frozen content version (1); older v1 profiles
 * predating the applied-id bookkeeping and comparability fields are filled
 * with their neutral defaults. Any other version fails closed.
 */
export function upcastLearnerProfile(raw: unknown): LearnerProfile {
  if (!isRecord(raw)) {
    throw new UnsupportedSchemaVersionError("learner profile", undefined);
  }
  if (raw.schemaVersion !== FDE_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError("learner profile", raw.schemaVersion);
  }
  const record: Record<string, unknown> = { ...raw };
  if (!Array.isArray(record.appliedEffectIds)) record.appliedEffectIds = [];
  if (!Array.isArray(record.appliedRunIds)) record.appliedRunIds = [];
  if (record.comparabilityKey === undefined) record.comparabilityKey = null;
  if (typeof record.discontinuities !== "number") record.discontinuities = 0;
  const result = LearnerProfileSchema.safeParse(record);
  if (!result.success) {
    throw new Error(`invalid learner profile: ${result.error.message}`);
  }
  return result.data;
}
