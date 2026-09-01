import { describe, expect, it } from "vitest";

import { createRng } from "../../../src/simulation/rng.js";
import type { RunAggregate } from "../../../src/core/aggregate.js";
import type { ChallengeResponse, LocalizedText, RunPhase } from "../../../src/core/domain.js";
import type { CustomerCapsule, ScenarioEventCandidate } from "../../../src/scenarios/schema.js";
import {
  CHALLENGE_ALREADY_ANSWERED,
  CHALLENGE_RESPONSE_TO_UNKNOWN_ID,
} from "../../../src/graph/challenge-state.js";
import {
  CHALLENGE_RESPONSE_INVALID,
  CHALLENGES_UNANSWERED,
} from "../../../src/graph/guards.js";
import {
  handlers,
  runAllAnsweredGuard,
  runChallengeInject,
  runChallengeSelect,
  runChallengeWait,
  runPitchPrepare,
  runResponseAccept,
  runResponseMembershipGuard,
} from "../../../src/graph/nodes/challenge/index.js";

/**
 * CHALLENGE subgraph tests (G3-03): the deterministic injection wave and the
 * response gate pipeline, decomposed from `prepareChallengeInjection` +
 * `prepareRespondToChallenge` WITHOUT importing the orchestrator. No real model.
 */

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function text(value: string): LocalizedText {
  return { "zh-CN": value, "en-US": value };
}

function makeState(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scenario-1",
    locale: "en-US",
    phase: "CHALLENGE",
    transcript: [],
    graph: { version: 0, nodes: [], edges: [] },
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: null,
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    injectedChallenges: [],
    pendingEvidence: null,
    clarificationBudgetUsed: 0,
    ...overrides,
  };
}

function makeCapsule(): CustomerCapsule {
  return {
    id: "customer-1",
    schemaVersion: 1,
    stakeholders: [
      {
        id: "stake-1",
        role: text("role"),
        persona: text("persona"),
        concerns: [text("concern")],
        blindSpots: [text("blind")],
      },
    ],
    disclosureUnits: [],
    responsePolicies: [],
    privateConflicts: [],
    canary: "CANARY-SEED",
  };
}

function candidate(id: string, phase: RunPhase = "CHALLENGE"): ScenarioEventCandidate {
  return { id, trigger: { kind: "on_stage_enter", phase }, prompt: text(`prompt-${id}`) };
}

function respond(id: string, challengeId: string): ChallengeResponse {
  return {
    id,
    challengeId,
    impact: text(`impact-${id}`),
    decision: "keep",
    rationale: text(`rationale-${id}`),
    newRiskOrValidation: text(`action-${id}`),
  };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

describe("challenge handlers registry", () => {
  it("declares one handler per challenge node with the expected ids and kinds", () => {
    const byId = new Map(handlers.map((h) => [h.definition.id, h.definition]));
    expect(byId.size).toBe(7);
    expect([...byId.keys()].sort()).toEqual([
      "all-answered.guard",
      "challenge.inject",
      "challenge.select",
      "challenge.wait",
      "pitch.prepare",
      "response.accept",
      "response.membership.guard",
    ]);
    expect(byId.get("challenge.select")).toMatchObject({ phase: "CHALLENGE", kind: "deterministic" });
    expect(byId.get("challenge.inject")).toMatchObject({ phase: "CHALLENGE", kind: "deterministic" });
    expect(byId.get("response.accept")).toMatchObject({ phase: "CHALLENGE", kind: "guard" });
    expect(byId.get("response.membership.guard")).toMatchObject({ phase: "CHALLENGE", kind: "guard" });
    expect(byId.get("all-answered.guard")).toMatchObject({ phase: "CHALLENGE", kind: "guard" });
    expect(byId.get("challenge.wait")).toMatchObject({ phase: "CHALLENGE", kind: "deterministic" });
    expect(byId.get("pitch.prepare")).toMatchObject({ phase: "CHALLENGE", kind: "deterministic" });
  });
});

// ---------------------------------------------------------------------------
// deterministic injection wave
// ---------------------------------------------------------------------------

describe("challenge.select + challenge.inject", () => {
  it("selects the deterministic wave and injects every candidate as pending", async () => {
    const capsule = makeCapsule();
    const candidates = [candidate("c3"), candidate("c1"), candidate("c2")];
    const preState = makeState();

    const selected = await runChallengeSelect({
      state: preState,
      capsule,
      candidates,
      rng: createRng(42),
    });
    expect(selected.events).toEqual([]);
    expect(selected.updatedState).toBe(preState);
    // The SET is sort-stabilized by id (independent of the seed); ORDER is seeded.
    expect(selected.selected.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(selected.context).toMatchObject({ phase: "CHALLENGE", questionCount: 0, challengeResponseCount: 0 });

    const injected = await runChallengeInject({
      state: makeState(),
      capsule,
      selected: selected.selected,
      commandId: "cmd-inject",
    });
    expect(injected.injectedChallengeIds.sort()).toEqual(["c1", "c2", "c3"]);
    expect(injected.interruptions).toHaveLength(3);
    // Each `challenge.injected` precedes its `customer.replied`, in selected order.
    for (const c of selected.selected) {
      const inj = injected.events.findIndex(
        (e) => e.type === "challenge.injected" && e.challengeId === c.id,
      );
      const rep = injected.events.findIndex(
        (e) => e.type === "customer.replied" && e.questionId === c.id,
      );
      expect(inj).toBeGreaterThanOrEqual(0);
      expect(rep).toBeGreaterThan(inj);
    }
    expect(injected.updatedState.injectedChallenges).toEqual(
      selected.selected.map((c) => ({ id: c.id, status: "pending" })),
    );
  });

  it("skips candidates already injected in an earlier wave", async () => {
    const state = makeState({ injectedChallenges: [{ id: "c1", status: "pending" }] });
    const injected = await runChallengeInject({
      state,
      capsule: makeCapsule(),
      selected: [candidate("c1"), candidate("c2")],
      commandId: "cmd-inject",
    });
    expect(injected.injectedChallengeIds).toEqual(["c2"]);
    expect(injected.events.map((e) => e.type)).toEqual(["challenge.injected", "customer.replied"]);
    expect(injected.updatedState.injectedChallenges).toEqual([
      { id: "c1", status: "pending" },
      { id: "c2", status: "pending" },
    ]);
  });

  it("is deterministic: same seed → same order; different seed → same set", async () => {
    const capsule = makeCapsule();
    const candidates = [candidate("a"), candidate("b"), candidate("c")];
    const a = await runChallengeSelect({ state: makeState(), capsule, candidates, rng: createRng(7) });
    const b = await runChallengeSelect({ state: makeState(), capsule, candidates, rng: createRng(7) });
    const c = await runChallengeSelect({ state: makeState(), capsule, candidates, rng: createRng(8) });
    expect(a.selected.map((x) => x.id)).toEqual(b.selected.map((x) => x.id));
    expect(a.selected.map((x) => x.id).sort()).toEqual(c.selected.map((x) => x.id).sort());
  });
});

// ---------------------------------------------------------------------------
// response gate pipeline (happy path)
// ---------------------------------------------------------------------------

describe("response pipeline", () => {
  it("injects two challenges, answers both, and advances to PITCH only on the last answer", async () => {
    const capsule = makeCapsule();
    const selected = await runChallengeSelect({
      state: makeState(),
      capsule,
      candidates: [candidate("c1"), candidate("c2")],
      rng: createRng(42),
    });
    const injected = await runChallengeInject({
      state: makeState(),
      capsule,
      selected: selected.selected,
      commandId: "cmd-inject",
    });
    const injectedState = injected.updatedState;

    // Answer the first challenge: stays in CHALLENGE, no phase.changed.
    const r1 = respond("r1", "c1");
    await expect(runResponseAccept({ state: injectedState, response: r1 })).resolves.toEqual({
      events: [],
      updatedState: injectedState,
    });

    const membership1 = await runResponseMembershipGuard({
      state: injectedState,
      response: r1,
      commandId: "cmd-r1",
    });
    expect(membership1.folded).toEqual(
      injectedState.injectedChallenges!.map((e) =>
        e.id === "c1" ? { id: "c1", status: "answered", responseId: "r1" } : e,
      ),
    );

    const all1 = await runAllAnsweredGuard({ state: injectedState, challenges: membership1.folded });
    expect(all1.ok).toBe(false);
    expect(all1.code).toBe(CHALLENGES_UNANSWERED);
    expect(all1.evidence).toEqual({ pendingChallengeIds: ["c2"] });

    const waited = await runChallengeWait({
      state: injectedState,
      response: r1,
      commandId: "cmd-r1",
      folded: membership1.folded,
    });
    expect(waited.events.map((e) => e.type)).toEqual(["challenge.responded"]);
    expect(waited.updatedState.phase).toBe("CHALLENGE");
    expect(waited.updatedState.challengeResponses).toEqual([r1]);
    expect(waited.updatedState.injectedChallenges).toEqual(membership1.folded);

    // Answer the second (final) challenge: advances to PITCH.
    const r2 = respond("r2", "c2");
    const membership2 = await runResponseMembershipGuard({
      state: waited.updatedState,
      response: r2,
      commandId: "cmd-r2",
    });
    expect(membership2.folded).toEqual(
      waited.updatedState.injectedChallenges!.map((e) =>
        e.id === "c2" ? { id: "c2", status: "answered", responseId: "r2" } : e,
      ),
    );

    const all2 = await runAllAnsweredGuard({ state: waited.updatedState, challenges: membership2.folded });
    expect(all2.ok).toBe(true);

    const prepared = await runPitchPrepare({
      state: waited.updatedState,
      commandId: "cmd-r2",
      folded: membership2.folded,
      response: r2,
    });
    expect(prepared.events.map((e) => e.type)).toEqual(["challenge.responded", "phase.changed"]);
    expect(prepared.events[1]).toMatchObject({ type: "phase.changed", from: "CHALLENGE", to: "PITCH" });
    expect(prepared.updatedState.phase).toBe("PITCH");
    expect(prepared.updatedState.challengeResponses).toEqual([r1, r2]);
    expect(prepared.updatedState.injectedChallenges).toEqual(membership2.folded);
  });
});

// ---------------------------------------------------------------------------
// rejection
// ---------------------------------------------------------------------------

describe("rejection", () => {
  it("rejects a response to an unknown challenge id", async () => {
    const state = makeState({ injectedChallenges: [{ id: "c1", status: "pending" }] });
    await expect(
      runResponseMembershipGuard({ state, response: respond("r1", "unknown"), commandId: "cmd-r1" }),
    ).rejects.toMatchObject({ code: CHALLENGE_RESPONSE_TO_UNKNOWN_ID });
  });

  it("rejects a duplicate response to an already-answered challenge", async () => {
    const state = makeState({ injectedChallenges: [{ id: "c1", status: "answered", responseId: "r0" }] });
    await expect(
      runResponseMembershipGuard({ state, response: respond("r1", "c1"), commandId: "cmd-r1" }),
    ).rejects.toMatchObject({ code: CHALLENGE_ALREADY_ANSWERED });
  });

  it("response.accept rejects a structurally invalid response", async () => {
    const state = makeState();
    const bad = {
      id: "r1",
      challengeId: "c1",
      impact: text("impact"),
      decision: "keep",
      rationale: text("rationale"),
      // missing newRiskOrValidation
    } as unknown as ChallengeResponse;
    await expect(runResponseAccept({ state, response: bad })).rejects.toMatchObject({
      code: CHALLENGE_RESPONSE_INVALID,
    });
  });
});

// ---------------------------------------------------------------------------
// empty set (vacuous all-answered)
// ---------------------------------------------------------------------------

describe("empty set", () => {
  it("zero candidates → vacuous all-answered → PITCH without a fabricated response", async () => {
    const capsule = makeCapsule();
    const state = makeState();

    const selected = await runChallengeSelect({ state, capsule, candidates: [], rng: createRng(1) });
    expect(selected.selected).toEqual([]);

    const injected = await runChallengeInject({ state, capsule, selected: [], commandId: "cmd-inject" });
    expect(injected.events).toEqual([]);
    expect(injected.injectedChallengeIds).toEqual([]);
    expect(injected.updatedState.injectedChallenges).toEqual([]);

    const all = await runAllAnsweredGuard({ state, challenges: [] });
    expect(all.ok).toBe(true);

    const prepared = await runPitchPrepare({ state, commandId: "cmd-pitch", folded: [] });
    expect(prepared.events.map((e) => e.type)).toEqual(["phase.changed"]);
    expect(prepared.events.some((e) => e.type === "challenge.responded")).toBe(false);
    expect(prepared.updatedState.phase).toBe("PITCH");
    expect(prepared.updatedState.challengeResponses).toEqual([]);
  });
});
