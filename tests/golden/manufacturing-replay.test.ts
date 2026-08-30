import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { projectReplay } from "../../src/replay/projector.js";
import { loadEvents } from "../../src/core/event-store.js";
import type { Locale, RecordedEvent, RunEvent } from "../../src/core/domain.js";

/**
 * Golden replay test (Task 11).
 *
 * Asserts `projectReplay` is BYTE-STABLE from a fixed public event stream:
 * identical bytes in BOTH locales across repeated runs; includes the required
 * public fields; and structurally excludes hidden content (disclosure unit ids,
 * canaries, chain-of-thought, internal ids).
 */

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const GOLDEN_FIXTURE_DIR = join(FIXTURE_DIR, "fixtures");
const V1_FIXTURE_DIR = join(FIXTURE_DIR, "..", "fixtures", "runs", "v1", "manufacturing");

const CANARY_SENTINEL = "CUSTOMER_CANARY_7f3a9c1e2b4d";

function loadGoldenEvents(): RunEvent[] {
  const raw = readFileSync(join(GOLDEN_FIXTURE_DIR, "customer-support-events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunEvent);
}

function loadGoldenSnapshot(locale: Locale): string {
  return readFileSync(join(GOLDEN_FIXTURE_DIR, `customer-support-replay.${locale}.json`), "utf8");
}

function loadV1Snapshot(locale: Locale): string {
  return readFileSync(join(V1_FIXTURE_DIR, `replay.${locale}.json`), "utf8");
}

function canonical(replay: ReturnType<typeof projectReplay>): string {
  return JSON.stringify(replay, null, 2) + "\n";
}

const REQUIRED_FIELDS = [
  "mode",
  "runId",
  "scenarioId",
  "locale",
  "phase",
  "stages",
  "transcript",
  "graphDiffs",
  "questionMetrics",
  "hints",
  "eventInjections",
  "artifacts",
  "score",
  "strengths",
  "weaknesses",
  "missedOpportunities",
  "decisionDivergencePoints",
  "nextFocus",
] as const;

const HIDDEN_MARKERS = [
  "du-001",
  "du-003",
  "disclosedDisclosureUnitIds",
  CANARY_SENTINEL,
  "chainOfThought",
  "reasoning",
  "systemPrompt",
  "rawCustomerOutput",
  '"commandId"',
];

describe("golden replay: customer-support-agent", () => {
  const events = loadGoldenEvents();

  it("is byte-identical to the zh-CN snapshot across repeated runs", () => {
    const a = projectReplay(events, "zh-CN");
    const b = projectReplay(events, "zh-CN");
    expect(canonical(a)).toBe(loadGoldenSnapshot("zh-CN"));
    expect(canonical(b)).toBe(canonical(a));
  });

  it("is byte-identical to the en-US snapshot across repeated runs", () => {
    const a = projectReplay(events, "en-US");
    const b = projectReplay(events, "en-US");
    expect(canonical(a)).toBe(loadGoldenSnapshot("en-US"));
    expect(canonical(b)).toBe(canonical(a));
  });

  it("resolves localized text per locale", () => {
    const zh = projectReplay(events, "zh-CN");
    const en = projectReplay(events, "en-US");
    expect(zh.transcript[0].customerReply).toBe(
      "代理先查 CRM 再查订单 API；每月约18万张工单，约55%可走工具闭环。",
    );
    expect(en.transcript[0].customerReply).toBe(
      "The agent looks up CRM first, then the order API; about 180,000 tickets a month, about 55% can close in a tool loop.",
    );
  });

  it("includes the full required public field set", () => {
    const replay = projectReplay(events, "zh-CN");
    for (const field of REQUIRED_FIELDS) {
      expect(replay, `missing ${field}`).toHaveProperty(field);
    }
    expect(replay.mode).toBe("recorded");
    expect(replay.transcript).toHaveLength(2);
    expect(replay.graphDiffs).toHaveLength(2);
    expect(replay.questionMetrics).toHaveLength(2);
    expect(replay.hints).toHaveLength(1);
    expect(replay.eventInjections).toHaveLength(1);
    expect(replay.strengths).toHaveLength(1);
    expect(replay.weaknesses).toHaveLength(1);
    expect(replay.missedOpportunities).toHaveLength(1);
    expect(replay.decisionDivergencePoints).toHaveLength(1);
    expect(replay.nextFocus).toHaveLength(2);
    expect(replay.score).not.toBeNull();
  });

  it("excludes hidden content by construction", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const serialized = canonical(projectReplay(events, locale));
      for (const marker of HIDDEN_MARKERS) {
        expect(serialized).not.toContain(marker);
      }
    }
  });
});

describe("golden replay: frozen v1 manufacturing run", () => {
  function stripEnvelope(recorded: RecordedEvent): RunEvent {
    const { seq: _seq, logicalTime: _lt, previousHash: _ph, hash: _hash, ...event } = recorded;
    return event as RunEvent;
  }

  it("reproduces the existing learner replay bytes through the current reader", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "fde-golden-v1-"));
    try {
      const runDir = join(baseDir, "runs", "manufacturing");
      mkdirSync(runDir, { recursive: true });
      copyFileSync(join(V1_FIXTURE_DIR, "events.jsonl"), join(runDir, "events.jsonl"));
      copyFileSync(join(V1_FIXTURE_DIR, "manifest.json"), join(runDir, "manifest.json"));

      const recorded = await loadEvents("manufacturing", { baseDir });
      const replayEvents = recorded.map(stripEnvelope);
      expect(replayEvents).toHaveLength(24);

      for (const locale of ["zh-CN", "en-US"] as const) {
        expect(canonical(projectReplay(replayEvents, locale))).toBe(loadV1Snapshot(locale));
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
