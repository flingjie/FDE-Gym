import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBaseDir } from "../core/event-store.js";
import { FDE_SCHEMA_VERSION } from "../core/domain.js";
import { UnsupportedSchemaVersionError } from "../core/errors.js";
import {
  LearnerProfileSchema,
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
  await writeFile(profileFile(baseDir), JSON.stringify(validated, null, 2) + "\n", "utf8");
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

  const result = LearnerProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid learner profile: ${result.error.message}`);
  }
  return result.data;
}
