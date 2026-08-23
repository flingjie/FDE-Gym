import { describe, expect, it } from "vitest";

import {
  HINT_EXHAUSTED,
  HINT_NO_DOWNGRADE,
  HINT_UNKNOWN_TOPIC,
  HintError,
  requestHint,
} from "../../src/simulation/hints";
import type { HintLadder } from "../../src/scenarios/schema";
import type { HintLedgerEntry } from "../../src/agents/contracts";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

function ladder(topic: string): HintLadder {
  return {
    id: `hl-${topic}`,
    topic,
    hints: {
      "1": text(`L1 ${topic}: metacognitive reflection`, `L1 ${topic}: metacognitive reflection`),
      "2": text(`L2 ${topic}: missing category hint`, `L2 ${topic}: missing category hint`),
      "3": text(`L3 ${topic}: one actionable question?`, `L3 ${topic}: one actionable question?`),
    },
  };
}

const LADDERS = [ladder("workflow"), ladder("pain")];

const grant = (topic: string, level: 1 | 2 | 3): HintLedgerEntry => ({ topic, level });

function expectHintError(code: string, fn: () => unknown): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HintError);
  expect((caught as HintError).code).toBe(code);
}

describe("requestHint — deterministic escalation", () => {
  it("progresses each topic 1 -> 2 -> 3 in auto mode", () => {
    const g1 = requestHint("workflow", null, LADDERS);
    expect(g1.level).toBe(1);
    const g2 = requestHint("workflow", null, LADDERS, [grant("workflow", 1)]);
    expect(g2.level).toBe(2);
    const g3 = requestHint("workflow", null, LADDERS, [grant("workflow", 1), grant("workflow", 2)]);
    expect(g3.level).toBe(3);
  });

  it("never skips in auto mode (first hint is always level 1)", () => {
    const first = requestHint("workflow", null, LADDERS);
    expect(first.level).toBe(1);
    expect(first.level).not.toBe(2);
    expect(first.level).not.toBe(3);
  });

  it("never downgrades an explicit request at or below the granted level", () => {
    expectHintError(HINT_NO_DOWNGRADE, () =>
      requestHint("workflow", 1, LADDERS, [grant("workflow", 2)]),
    );
    // A repeat of the current level is also not a new grant.
    expectHintError(HINT_NO_DOWNGRADE, () =>
      requestHint("workflow", 2, LADDERS, [grant("workflow", 2)]),
    );
  });

  it("allows an explicit request to skip ahead (the explicit-request exception)", () => {
    const skipped = requestHint("workflow", 3, LADDERS);
    expect(skipped.level).toBe(3);
  });

  it("throws HINT_EXHAUSTED when auto-escalating past level 3", () => {
    expectHintError(HINT_EXHAUSTED, () =>
      requestHint("workflow", null, LADDERS, [grant("workflow", 3)]),
    );
  });

  it("throws HINT_UNKNOWN_TOPIC for a topic with no ladder", () => {
    expectHintError(HINT_UNKNOWN_TOPIC, () => requestHint("unknown", null, LADDERS));
  });
});

describe("requestHint — learner-safe level discipline", () => {
  it("returns exactly the granted level's text and never a higher level's", () => {
    const g1 = requestHint("workflow", 1, LADDERS);
    expect(g1.hint["en-US"]).toContain("L1");
    expect(g1.hint["en-US"]).not.toContain("L2");
    expect(g1.hint["en-US"]).not.toContain("L3");

    const g2 = requestHint("workflow", 2, LADDERS, [grant("workflow", 1)]);
    expect(g2.hint["en-US"]).toContain("L2");
    expect(g2.hint["en-US"]).not.toContain("L1");
    expect(g2.hint["en-US"]).not.toContain("L3");
  });

  it("selects L1 metacognitive, L2 category-only, L3 a question without its answer", () => {
    const safeLadders: HintLadder[] = [
      {
        id: "hl-safe",
        topic: "safe",
        hints: {
          "1": text(
            "想一想流程的起点：谁在处理告警？",
            "Think about the start of the process: who handles the alerts?",
          ),
          "2": text("关注数据量这个类别。", "Focus on the data-volume category."),
          "3": text(
            "真正需要关注的告警占多大比例，为什么？",
            "What share of alerts actually need attention, and why?",
          ),
        },
      },
    ];

    const l1 = requestHint("safe", 1, safeLadders);
    const l2 = requestHint("safe", 2, safeLadders, [grant("safe", 1)]);
    const l3 = requestHint("safe", 3, safeLadders, [grant("safe", 1), grant("safe", 2)]);

    // Level 1 is metacognitive: no specific numbers/facts.
    expect(l1.hint["zh-CN"]).not.toMatch(/\d/);
    expect(l1.hint["en-US"]).not.toMatch(/\d/);
    // Level 2 names only the missing category.
    expect(l2.hint["en-US"]).toMatch(/category/i);
    // Level 3 is a question, not an answer.
    expect(l3.hint["en-US"]).toMatch(/\?/);
    expect(l3.hint["en-US"]).not.toContain("answer");
  });
});

describe("requestHint — hints are not evidence and never enter Customer context", () => {
  it("returns only { level, hint } with no customer-capsule or evidence fields", () => {
    const g = requestHint("workflow", 1, LADDERS);
    expect(Object.keys(g).sort()).toEqual(["hint", "level"]);

    const serialized = JSON.stringify(g);
    for (const banned of ["stakeholder", "disclosureUnit", "canary", "reply", "evidenceIds"]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it("is deterministic for identical inputs (no randomness, no wall-clock)", () => {
    const a = requestHint("workflow", 2, LADDERS, [grant("workflow", 1)]);
    const b = requestHint("workflow", 2, LADDERS, [grant("workflow", 1)]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate the ladder or the ledger", () => {
    const beforeLadders = JSON.stringify(LADDERS);
    const ledger = [grant("workflow", 1)];
    const beforeLedger = JSON.stringify(ledger);
    requestHint("workflow", 2, LADDERS, ledger);
    expect(JSON.stringify(LADDERS)).toBe(beforeLadders);
    expect(JSON.stringify(ledger)).toBe(beforeLedger);
  });
});
