import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBaseDir } from "../core/event-store.js";
import { FDE_SCHEMA_VERSION } from "../core/domain.js";
import { UnsupportedSchemaVersionError } from "../core/errors.js";
import { atomicWriteFile } from "./atomic-file.js";
import {
  LearnerProfileSchema,
  createEmptyProfile,
  updateLearnerProfile,
  type AttemptReview,
  type LearnerProfile,
} from "../profile/learner-profile.js";

/**
 * FDE Gym — durable learner-profile storage under the store root.
 *
 * The profile lives at `<root>/profile.json` (single learner per local
 * machine). Reads validate against `LearnerProfileSchema` and fail closed on
 * corruption; a missing file returns `null` (no profile yet).
 */

export interface ProfileStoreOptions {
  /** Overrides `$FDE_GYM_HOME`/`~/.fde-gym` — used by tests. */
  baseDir?: string;
}

function profileFile(baseDir: string): string {
  return join(baseDir, "profile.json");
}

/** Validate and write the profile. Fails (throws) on an invalid profile rather than persisting garbage. */
export async function saveLearnerProfile(
  profile: LearnerProfile,
  options: ProfileStoreOptions = {},
): Promise<void> {
  const baseDir = options.baseDir ?? resolveBaseDir();
  const validated = LearnerProfileSchema.parse(profile);
  await mkdir(baseDir, { recursive: true });
  await atomicWriteFile(profileFile(baseDir), JSON.stringify(validated, null, 2) + "\n");
}

/**
 * Fold one review into the durable learner profile exactly once.
 *
 * The `effectId` is the idempotency key: a profile whose `appliedEffectIds`
 * already contains it is returned unchanged (a crash between the EMA update and
 * the commit marker can therefore be safely replayed). Otherwise the EMA update
 * runs, the effect/run ids are appended, and the complete profile is written
 * atomically.
 */
export async function applyProfileAttemptEffect(
  effectId: string,
  runId: string,
  review: AttemptReview,
  options: ProfileStoreOptions = {},
): Promise<LearnerProfile> {
  const base = (await loadLearnerProfile(options)) ?? createEmptyProfile();
  if (base.appliedEffectIds.includes(effectId)) return base;

  const updated = updateLearnerProfile(base, review);
  const complete: LearnerProfile = {
    ...updated,
    appliedEffectIds: [...updated.appliedEffectIds, effectId],
    appliedRunIds: [...updated.appliedRunIds, runId],
  };
  await saveLearnerProfile(complete, options);
  return complete;
}

/** Load and validate the profile; `null` when none has been saved yet. */
export async function loadLearnerProfile(
  options: ProfileStoreOptions = {},
): Promise<LearnerProfile | null> {
  const baseDir = options.baseDir ?? resolveBaseDir();
  let raw: string;
  try {
    raw = await readFile(profileFile(baseDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid learner profile: not valid JSON");
  }

  // Load-time schema-version gate (Task 14 freeze): reject a profile whose
  // schemaVersion is not the current version BEFORE structural validation, so an
  // unsupported (or unversioned) profile fails with UNSUPPORTED_SCHEMA_VERSION
  // and a migration instruction instead of a generic parse error.
  const version =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).schemaVersion
      : undefined;
  if (version !== FDE_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError("learner profile", version);
  }

  // Defensive upcast for pre-Task-6 v1 profiles that predate the applied-id
  // bookkeeping fields. The formal versioning layer (Task 8) owns this upcast;
  // until then, load defensively so an old profile still parses without
  // weakening `LearnerProfileSchema` (which requires the arrays).
  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.appliedEffectIds)) record.appliedEffectIds = [];
    if (!Array.isArray(record.appliedRunIds)) record.appliedRunIds = [];
  }

  const result = LearnerProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid learner profile: ${result.error.message}`);
  }
  return result.data;
}
