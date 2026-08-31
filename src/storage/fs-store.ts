import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBaseDir } from "../core/event-store.js";
import { upcastLearnerProfile } from "../core/versioning.js";
import { atomicWriteFile } from "./atomic-file.js";
import { withProfileLock } from "./run-lock.js";
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
  /** Overrides `$FDE_GYM_HOME` and the project-local `.fde-gym` default. */
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
 *
 * The whole fold (read → dedup check → update → write) runs under the profile
 * lock so concurrent folds across runs serialize instead of losing updates.
 */
export async function applyProfileAttemptEffect(
  effectId: string,
  runId: string,
  review: AttemptReview,
  options: ProfileStoreOptions = {},
): Promise<LearnerProfile> {
  const baseDir = options.baseDir ?? resolveBaseDir();
  return withProfileLock(baseDir, async () => {
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
  });
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

  // Load-time version gate + upcast live in the versioning layer (Task 8):
  // an unsupported/unversioned profile fails with UNSUPPORTED_SCHEMA_VERSION,
  // and older v1 profiles missing the applied-id/comparability fields are
  // filled with their neutral defaults before strict schema validation.
  return upcastLearnerProfile(parsed);
}
