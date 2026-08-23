import { describe, expect, it } from "vitest";

import { createRng } from "../../src/simulation/rng";
import {
  selectScenarioEvents,
  triggerFires,
  type EventTriggerContext,
} from "../../src/simulation/event-scheduler";
import type { ScenarioEventCandidate } from "../../src/scenarios/schema";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

function candidate(id: string, trigger: ScenarioEventCandidate["trigger"]): ScenarioEventCandidate {
  return { id, trigger, prompt: text(`提示 ${id}`, `Prompt ${id}`) };
}

function context(overrides: Partial<EventTriggerContext> = {}): EventTriggerContext {
  return {
    phase: "CHALLENGE",
    questionCount: 3,
    revealedEvidenceIds: ["ev-pain"],
    unresolvedContradictionIds: ["cc-001"],
    challengeResponseCount: 1,
    ...overrides,
  };
}

describe("triggerFires — the five deterministic trigger kinds", () => {
  it("on_stage_enter fires only when the current phase matches", () => {
    const trigger = { kind: "on_stage_enter", phase: "CHALLENGE" } as const;
    expect(triggerFires(trigger, context({ phase: "CHALLENGE" }))).toBe(true);
    expect(triggerFires(trigger, context({ phase: "SOLUTION_DESIGN" }))).toBe(false);
    expect(triggerFires(trigger, context({ phase: null }))).toBe(false);
  });

  it("after_question_count fires when the question count has been reached or exceeded", () => {
    const trigger = { kind: "after_question_count", count: 3 } as const;
    expect(triggerFires(trigger, context({ questionCount: 3 }))).toBe(true);
    expect(triggerFires(trigger, context({ questionCount: 5 }))).toBe(true);
    expect(triggerFires(trigger, context({ questionCount: 2 }))).toBe(false);
  });

  it("after_evidence_revealed fires only when the evidence id has been revealed", () => {
    const trigger = { kind: "after_evidence_revealed", evidenceId: "ev-pain" } as const;
    expect(triggerFires(trigger, context({ revealedEvidenceIds: ["ev-pain"] }))).toBe(true);
    expect(triggerFires(trigger, context({ revealedEvidenceIds: ["ev-trust"] }))).toBe(false);
    expect(triggerFires(trigger, context({ revealedEvidenceIds: [] }))).toBe(false);
  });

  it("if_contradiction_unresolved fires only when the contradiction remains unresolved", () => {
    const trigger = { kind: "if_contradiction_unresolved", contradictionId: "cc-001" } as const;
    expect(triggerFires(trigger, context({ unresolvedContradictionIds: ["cc-001"] }))).toBe(true);
    expect(triggerFires(trigger, context({ unresolvedContradictionIds: ["cc-002"] }))).toBe(false);
    expect(triggerFires(trigger, context({ unresolvedContradictionIds: [] }))).toBe(false);
  });

  it("after_challenge_response_count fires when the response count has been reached or exceeded", () => {
    const trigger = { kind: "after_challenge_response_count", count: 2 } as const;
    expect(triggerFires(trigger, context({ challengeResponseCount: 2 }))).toBe(true);
    expect(triggerFires(trigger, context({ challengeResponseCount: 4 }))).toBe(true);
    expect(triggerFires(trigger, context({ challengeResponseCount: 1 }))).toBe(false);
  });
});

describe("selectScenarioEvents — deterministic selection", () => {
  const candidates: ScenarioEventCandidate[] = [
    candidate("c-staging", { kind: "on_stage_enter", phase: "CHALLENGE" }),
    candidate("c-budget", { kind: "after_evidence_revealed", evidenceId: "ev-pain" }),
    candidate("c-trust", { kind: "after_evidence_revealed", evidenceId: "ev-trust" }),
    candidate("c-conflict", { kind: "if_contradiction_unresolved", contradictionId: "cc-001" }),
    candidate("c-qcount", { kind: "after_question_count", count: 5 }),
    candidate("c-resp", { kind: "after_challenge_response_count", count: 2 }),
  ];

  it("selects only candidates whose trigger fires, never the unfired ones", () => {
    const selected = selectScenarioEvents(candidates, context(), createRng(1));
    const ids = selected.map((c) => c.id).sort();

    // Fired: c-staging (phase), c-budget (ev-pain), c-conflict (cc-001).
    // Unfired: c-trust (ev-trust not revealed), c-qcount (3 < 5), c-resp (1 < 2).
    expect(ids).toEqual(["c-budget", "c-conflict", "c-staging"]);
  });

  it("returns an empty list when no trigger fires", () => {
    const none = selectScenarioEvents(
      [
        candidate("a", { kind: "after_evidence_revealed", evidenceId: "ev-absent" }),
        candidate("b", { kind: "after_question_count", count: 99 }),
      ],
      context(),
      createRng(2),
    );
    expect(none).toEqual([]);
  });

  it("produces identical ids and order for the same scenario + seed + context", () => {
    const first = selectScenarioEvents(candidates, context(), createRng(42)).map((c) => c.id);
    const second = selectScenarioEvents(candidates, context(), createRng(42)).map((c) => c.id);
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
  });

  it("is deterministic across two independent runs with the same seed", () => {
    const run = () => selectScenarioEvents(candidates, context(), createRng(1337)).map((c) => c.id);
    expect(run()).toEqual(run());
  });

  it("keeps the selected SET stable regardless of the seed (only the order is seeded)", () => {
    const bySeed = (seed: number) =>
      selectScenarioEvents(candidates, context(), createRng(seed)).map((c) => c.id);
    const seeds = [1, 2, 3, 999, 12345];
    const sets = seeds.map((seed) => bySeed(seed).slice().sort());
    for (const set of sets) {
      expect(set).toEqual(["c-budget", "c-conflict", "c-staging"]);
    }
  });
});
