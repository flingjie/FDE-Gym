import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UNSUPPORTED_SCHEMA_VERSION } from "../../src/core/errors";
import {
  createEmptyProfile,
  type AttemptReview,
} from "../../src/profile/learner-profile";
import {
  applyProfileAttemptEffect,
  loadLearnerProfile,
  saveLearnerProfile,
} from "../../src/storage/fs-store";

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

function review(): AttemptReview {
  return {
    competencies: {
      discovery: 60,
      problemFraming: 55,
      evidenceReasoning: 50,
      solutionDesign: 50,
      adaptability: 50,
      pitching: 50,
    },
    hintReliance: 0,
    repeatedQuestionRate: 0,
    unsupportedClaimRate: 0,
    contradictionHandling: 0,
    retryFocuses: [],
    comparabilityKey: "key-1",
  };
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

  it("leaves the previous profile valid when a write fails before the atomic rename", async () => {
    await saveLearnerProfile(createEmptyProfile(), { baseDir });
    const before = readFileSync(profileFile(), "utf8");

    // Read-only dir: the sibling temp file cannot be created, so the write
    // fails before the rename and the existing profile must survive intact.
    chmodSync(baseDir, 0o555);
    try {
      await expect(
        saveLearnerProfile({ ...createEmptyProfile(), attempts: 1 }, { baseDir }),
      ).rejects.toThrow();
    } finally {
      chmodSync(baseDir, 0o755);
    }

    expect(readFileSync(profileFile(), "utf8")).toBe(before);
    const loaded = await loadLearnerProfile({ baseDir });
    expect(loaded!.attempts).toBe(0);
  });
});

describe("applyProfileAttemptEffect (exactly-once profile projection)", () => {
  it("applies a review once and records the effect and run ids", async () => {
    const updated = await applyProfileAttemptEffect("e1", "r1", review(), { baseDir });

    expect(updated.attempts).toBe(1);
    expect(updated.appliedEffectIds).toEqual(["e1"]);
    expect(updated.appliedRunIds).toEqual(["r1"]);

    const persisted = await loadLearnerProfile({ baseDir });
    expect(persisted!.attempts).toBe(1);
    expect(persisted!.appliedEffectIds).toEqual(["e1"]);
    expect(persisted!.appliedRunIds).toEqual(["r1"]);
  });

  it("is idempotent for the same effect id", async () => {
    await applyProfileAttemptEffect("e1", "r1", review(), { baseDir });
    const again = await applyProfileAttemptEffect("e1", "r1", review(), { baseDir });

    expect(again.attempts).toBe(1);
    expect(again.appliedEffectIds).toEqual(["e1"]);
    expect(again.appliedRunIds).toEqual(["r1"]);
  });

  it("upcasts an old v1 profile missing the applied-id arrays to empty arrays", async () => {
    const old = { ...createEmptyProfile() } as Record<string, unknown>;
    delete old.appliedEffectIds;
    delete old.appliedRunIds;
    writeFileSync(profileFile(), JSON.stringify(old), "utf8");

    const loaded = await loadLearnerProfile({ baseDir });
    expect(loaded!.appliedEffectIds).toEqual([]);
    expect(loaded!.appliedRunIds).toEqual([]);
    expect(loaded!.attempts).toBe(0);
  });
});
