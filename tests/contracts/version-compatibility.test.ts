import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  ScoreComputedEventSchema,
  type RecordedEvent,
  type RunEvent,
} from "../../src/core/domain.js";
import { EVENT_CHAIN_INVALID, UNSUPPORTED_SCHEMA_VERSION } from "../../src/core/errors.js";
import { loadEvents } from "../../src/core/event-store.js";
import {
  CurrentRunManifestSchema,
  EVENT_ENVELOPE_VERSION,
  RUN_FORMAT_VERSION,
  upcastLearnerProfile,
  upcastRecordedEvent,
  upcastRunManifest,
} from "../../src/core/versioning.js";
import { projectReplay, projectScoreProvenance } from "../../src/replay/projector.js";
import {
  LEGACY_COMPARABILITY_KEY,
  SCORE_SCHEMA_VERSION,
  ScoreProvenanceSchema,
  computeComparabilityKey,
  legacyScoreProvenance,
} from "../../src/scoring/provenance.js";

/**
 * Task 8 — version compatibility and score provenance contracts.
 *
 * The frozen v1 manufacturing run (schemaVersion: 1 manifest + enveloped,
 * hash-chained events) must upcast through the current reader and replay
 * BYTE-IDENTICALLY to the pre-upcast golden snapshots. Unknown run/event
 * revisions fail closed with `UNSUPPORTED_SCHEMA_VERSION`; hash verification
 * happens on the ORIGINAL bytes BEFORE any upcast; new `score.computed`
 * events require provenance; comparability keys distinguish rubric / model /
 * output-schema / formula / calibration changes; legacy scores are
 * non-comparable by default.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "fixtures", "runs", "v1", "manufacturing");

function stripEnvelope(recorded: RecordedEvent): RunEvent {
  const { seq: _seq, logicalTime: _lt, previousHash: _ph, hash: _hash, ...event } = recorded;
  return event as RunEvent;
}

function readFixtureEvents(): RecordedEvent[] {
  const raw = readFileSync(join(FIXTURE_DIR, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

function goldenReplay(locale: "zh-CN" | "en-US"): string {
  return readFileSync(join(FIXTURE_DIR, `replay.${locale}.json`), "utf8");
}

/** Copy the frozen v1 fixture into a real store layout and return the store root. */
function makeV1Store(): string {
  const baseDir = mkdtempSync(join(tmpdir(), "fde-v1-store-"));
  const runDir = join(baseDir, "runs", "manufacturing");
  mkdirSync(runDir, { recursive: true });
  copyFileSync(join(FIXTURE_DIR, "events.jsonl"), join(runDir, "events.jsonl"));
  copyFileSync(join(FIXTURE_DIR, "manifest.json"), join(runDir, "manifest.json"));
  return baseDir;
}

const stores: string[] = [];
function track(baseDir: string): string {
  stores.push(baseDir);
  return baseDir;
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      rmSync(store, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("versioning constants", () => {
  it("exposes the independent format versions", () => {
    expect(RUN_FORMAT_VERSION).toBe(2);
    expect(EVENT_ENVELOPE_VERSION).toBe(1);
    expect(SCORE_SCHEMA_VERSION).toBe(1);
  });
});

describe("upcastRunManifest", () => {
  it("maps a frozen v1 manifest (schemaVersion 1) to the current run format", () => {
    const manifest = upcastRunManifest({ schemaVersion: 1 });
    expect(manifest).toEqual({ runFormatVersion: 2 });
    expect(CurrentRunManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("accepts a current run manifest (runFormatVersion 2) unchanged", () => {
    expect(upcastRunManifest({ runFormatVersion: 2 })).toEqual({ runFormatVersion: 2 });
  });

  it("fails closed on an unknown run format with UNSUPPORTED_SCHEMA_VERSION", () => {
    expect(() => upcastRunManifest({ runFormatVersion: 3 })).toThrowError(
      expect.objectContaining({ code: UNSUPPORTED_SCHEMA_VERSION }),
    );
    expect(() => upcastRunManifest({ schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ code: UNSUPPORTED_SCHEMA_VERSION }),
    );
    expect(() => upcastRunManifest("nonsense")).toThrowError(
      expect.objectContaining({ code: UNSUPPORTED_SCHEMA_VERSION }),
    );
  });
});

describe("upcastRecordedEvent", () => {
  it("fails closed on an unknown event revision with UNSUPPORTED_SCHEMA_VERSION", () => {
    expect(() => upcastRecordedEvent({}, 99)).toThrowError(
      expect.objectContaining({ code: UNSUPPORTED_SCHEMA_VERSION }),
    );
  });

  it("leaves a current-format recorded event unchanged", () => {
    const event = readFixtureEvents()[0];
    expect(upcastRecordedEvent(event, 2)).toEqual(event);
  });
});

describe("v1 fixture upcast + replay", () => {
  it("upcasts a frozen v1 run and replays byte-identically to the golden snapshots", async () => {
    const baseDir = track(makeV1Store());
    const recorded = await loadEvents("manufacturing", { baseDir });

    expect(recorded).toHaveLength(24);

    const scoreComputed = recorded.find((event) => event.type === "score.computed");
    expect(scoreComputed).toBeDefined();
    expect(scoreComputed!.type).toBe("score.computed");
    const scoreEvent = scoreComputed! as Extract<RecordedEvent, { type: "score.computed" }>;
    expect(ScoreProvenanceSchema.safeParse(scoreEvent.provenance).success).toBe(true);

    for (const locale of ["zh-CN", "en-US"] as const) {
      const replay = projectReplay(recorded.map(stripEnvelope), locale);
      expect(JSON.stringify(replay, null, 2) + "\n").toBe(goldenReplay(locale));
    }
  });

  it("marks the legacy v1 score non-comparable by default", async () => {
    const baseDir = track(makeV1Store());
    const recorded = await loadEvents("manufacturing", { baseDir });
    const scoreEvent = recorded.find((event) => event.type === "score.computed");
    expect(scoreEvent).toBeDefined();
    const provenance = (scoreEvent as Extract<RecordedEvent, { type: "score.computed" }>).provenance;
    expect(provenance.comparabilityKey).toBe(LEGACY_COMPARABILITY_KEY);
    expect(provenance.evaluatorInvocationId).toBeNull();
    expect(provenance.modelId).toBeNull();
    for (const stage of Object.values(provenance.stages)) {
      expect(stage.source).toBe("deterministic-fallback");
    }
  });

  it("projects only the learner-safe provenance subset for the replay", async () => {
    const baseDir = track(makeV1Store());
    const recorded = await loadEvents("manufacturing", { baseDir });
    const provenance = projectScoreProvenance(recorded.map(stripEnvelope));

    expect(provenance).not.toBeNull();
    expect(provenance!.comparabilityKey).toBe(LEGACY_COMPARABILITY_KEY);
    expect(provenance).not.toHaveProperty("evaluatorInvocationId");
    expect(provenance).not.toHaveProperty("scenarioBundleSha256");
    expect(provenance!.stages.framing.source).toBe("deterministic-fallback");
  });

  it("verifies the hash chain BEFORE upcasting and never mutates the fixture", async () => {
    const originalEvents = readFileSync(join(FIXTURE_DIR, "events.jsonl"), "utf8");
    const originalManifest = readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8");

    const baseDir = track(makeV1Store());
    await loadEvents("manufacturing", { baseDir });

    // The reader is read-only: the committed v1 fixture files are unchanged.
    expect(readFileSync(join(FIXTURE_DIR, "events.jsonl"), "utf8")).toBe(originalEvents);
    expect(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")).toBe(originalManifest);

    // A tampered payload must fail hash verification (EVENT_CHAIN_INVALID), not
    // upcast past the corruption.
    const tamperedDir = track(makeV1Store());
    const tamperedPath = join(tamperedDir, "runs", "manufacturing", "events.jsonl");
    const tampered = readFileSync(tamperedPath, "utf8").replace(
      "manufacturing-alert-triage",
      "manufacturing-alert-triage2",
    );
    writeFileSync(tamperedPath, tampered, "utf8");

    await expect(loadEvents("manufacturing", { baseDir: tamperedDir })).rejects.toMatchObject({
      code: EVENT_CHAIN_INVALID,
    });
  });
});

describe("score.computed provenance requirement", () => {
  const score = (readFixtureEvents().find((e) => e.type === "score.computed") as Extract<
    RecordedEvent,
    { type: "score.computed" }
  >).score;

  it("rejects a new score.computed event that lacks provenance", () => {
    const parsed = ScoreComputedEventSchema.safeParse({
      type: "score.computed",
      runId: "run-1",
      commandId: "cmd-1",
      score,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a score.computed event carrying provenance", () => {
    const parsed = ScoreComputedEventSchema.safeParse({
      type: "score.computed",
      runId: "run-1",
      commandId: "cmd-1",
      score,
      provenance: legacyScoreProvenance(),
    });
    expect(parsed.success).toBe(true);
  });
});

describe("comparability keys", () => {
  const base = {
    scoreSchemaVersion: 1,
    formulaVersion: 1,
    capabilityRubricId: "fde-capability",
    capabilityRubricVersion: 1,
    capabilityRubricSha256: "a".repeat(64),
    outputSchemaVersion: 1,
    modelId: "model-family-a",
  };

  it("is deterministic", () => {
    expect(computeComparabilityKey(base)).toBe(computeComparabilityKey(base));
  });

  it("differs when the capability rubric changes", () => {
    expect(computeComparabilityKey(base)).not.toBe(
      computeComparabilityKey({ ...base, capabilityRubricSha256: "b".repeat(64) }),
    );
  });

  it("differs when the model family changes", () => {
    expect(computeComparabilityKey(base)).not.toBe(
      computeComparabilityKey({ ...base, modelId: "model-family-b" }),
    );
  });

  it("differs when the output schema version changes", () => {
    expect(computeComparabilityKey(base)).not.toBe(
      computeComparabilityKey({ ...base, outputSchemaVersion: 2 }),
    );
  });

  it("differs when the formula version changes", () => {
    expect(computeComparabilityKey(base)).not.toBe(
      computeComparabilityKey({ ...base, formulaVersion: 2 }),
    );
  });

  it("differs when the calibration (rubric) version changes", () => {
    expect(computeComparabilityKey(base)).not.toBe(
      computeComparabilityKey({ ...base, capabilityRubricVersion: 2 }),
    );
  });
});

describe("upcastLearnerProfile", () => {
  it("upcasts a v1 profile missing the new bookkeeping fields", () => {
    const v1Profile = {
      schemaVersion: 1,
      competencies: {
        discovery: 50,
        problemFraming: 50,
        evidenceReasoning: 50,
        solutionDesign: 50,
        adaptability: 50,
        pitching: 50,
      },
      attempts: 0,
      hintReliance: 0,
      repeatedQuestionRate: 0,
      unsupportedClaimRate: 0,
      contradictionHandling: 0,
      strongestCompetency: null,
      weakestCompetency: null,
      retryFocuses: [],
    };
    const profile = upcastLearnerProfile(v1Profile);
    expect(profile.appliedEffectIds).toEqual([]);
    expect(profile.appliedRunIds).toEqual([]);
    expect(profile.comparabilityKey).toBeNull();
    expect(profile.discontinuities).toBe(0);
    expect(profile.attempts).toBe(0);
  });

  it("fails closed on an unsupported profile version", () => {
    expect(() =>
      upcastLearnerProfile({
        schemaVersion: 2,
        competencies: {
          discovery: 50,
          problemFraming: 50,
          evidenceReasoning: 50,
          solutionDesign: 50,
          adaptability: 50,
          pitching: 50,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: UNSUPPORTED_SCHEMA_VERSION }));
  });
});
