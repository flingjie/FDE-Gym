import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UNSUPPORTED_SCHEMA_VERSION } from "../../src/core/errors";
import { createEmptyProfile } from "../../src/profile/learner-profile";
import { loadLearnerProfile, saveLearnerProfile } from "../../src/storage/fs-store";

/**
 * Task 14 — learner-profile schema freeze.
 *
 * The profile is load-time-gated: a persisted profile carries `schemaVersion: 1`
 * and any other (or missing) version is rejected with `UNSUPPORTED_SCHEMA_VERSION`
 * rather than partially parsed.
 */

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "fde-gym-profile-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function profileFile(): string {
  return join(baseDir, "profile.json");
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

describe("learner profile store (schema freeze)", () => {
  it("persists and reloads a profile with schemaVersion 1", async () => {
    await saveLearnerProfile(createEmptyProfile(), { baseDir });
    const loaded = await loadLearnerProfile({ baseDir });
    expect(loaded).not.toBeNull();
    expect(loaded!.schemaVersion).toBe(1);
    expect(loaded!.attempts).toBe(0);
  });

  it("rejects a profile with an unsupported schemaVersion", async () => {
    const profile = { ...createEmptyProfile(), schemaVersion: 2 };
    writeFileSync(profileFile(), JSON.stringify(profile), "utf8");
    expect(await codeOf(loadLearnerProfile({ baseDir }))).toBe(UNSUPPORTED_SCHEMA_VERSION);
  });

  it("rejects an unversioned profile with UNSUPPORTED_SCHEMA_VERSION", async () => {
    const { schemaVersion: _version, ...unversioned } = createEmptyProfile();
    writeFileSync(profileFile(), JSON.stringify(unversioned), "utf8");
    expect(await codeOf(loadLearnerProfile({ baseDir }))).toBe(UNSUPPORTED_SCHEMA_VERSION);
  });
});
