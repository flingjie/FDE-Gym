import { describe, expect, it } from "vitest";

import { RUN_PHASES, type RunPhase } from "../../src/core/domain.js";
import { assertCommandPhase } from "../../src/core/state-machine.js";
import { PHASE_EDGES, legalFromPhases, type PhaseEdgeSpec } from "../../src/graph/phase-spec.js";
import { EVENT_PROTOCOLS } from "../../src/graph/event-protocols.js";
import type { ActionId } from "../../src/graph/action-types.js";

/**
 * Phase transition spec contract tests (G05-01).
 *
 * Prove three things:
 *   1. `assertCommandPhase` is a faithful derivation of the Spec — it reproduces
 *      the original hard-coded legality table exactly, so there is no second map.
 *   2. The Spec covers every command in the domain union (no ghost action).
 *   3. The Spec is internally consistent (unique edge ids, complete abort edges).
 */

// The ground-truth legality table the Spec must reproduce (the pre-migration
// `assertCommandPhase` switch, transcribed as an oracle).
const LEGALITY: Record<ActionId, readonly (RunPhase | null)[]> = {
  start: [null],
  accept: ["SCENARIO"],
  ask: ["DISCOVERY"],
  frame: ["DISCOVERY"],
  hint: ["DISCOVERY", "PROBLEM_FRAMING"],
  "submit-brief": ["PROBLEM_FRAMING"],
  clarify: ["PROBLEM_FRAMING"],
  "submit-design": ["SOLUTION_DESIGN"],
  "respond-challenge": ["CHALLENGE"],
  "submit-pitch": ["PITCH"],
  review: ["REVIEW"],
  retry: ["REVIEW"],
  "start-retry": ["RETRY_READY"],
  complete: ["REVIEW"],
  abort: [
    "SCENARIO",
    "DISCOVERY",
    "PROBLEM_FRAMING",
    "SOLUTION_DESIGN",
    "CHALLENGE",
    "PITCH",
    "REVIEW",
    "RETRY_READY",
  ],
};

const ALL_ACTIONS = Object.keys(EVENT_PROTOCOLS) as ActionId[];
const ALL_PHASES: readonly (RunPhase | null)[] = [...RUN_PHASES, null];

describe("phase transition spec", () => {
  it("covers every command in the domain union (no ghost action)", () => {
    for (const action of ALL_ACTIONS) {
      expect(legalFromPhases(action).size, `${action} has no edges`).toBeGreaterThan(0);
    }
    // And the registry is exhaustive by construction: `EVENT_PROTOCOLS` is a
    // `Record<ActionId, _>`, so a missing action would be a compile error.
  });

  it("has unique edge ids", () => {
    const ids = PHASE_EDGES.map((edge) => edge.edgeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares an abort edge for every abortable phase", () => {
    const abortFroms = PHASE_EDGES.filter((edge) => edge.action === "abort").map((edge) => edge.from);
    expect(new Set(abortFroms)).toEqual(new Set(LEGALITY.abort));
  });

  it("derives legalFromPhases from the spec", () => {
    expect(legalFromPhases("start")).toEqual(new Set([null]));
    expect(legalFromPhases("hint")).toEqual(new Set(["DISCOVERY", "PROBLEM_FRAMING"]));
    expect(legalFromPhases("complete")).toEqual(new Set(["REVIEW"]));
    expect(legalFromPhases("abort").size).toBe(8);
  });
});

describe("assertCommandPhase derivation", () => {
  it("reproduces the original legality table for every action × phase", () => {
    for (const action of ALL_ACTIONS) {
      for (const phase of ALL_PHASES) {
        const expectedLegal = LEGALITY[action].includes(phase);
        if (expectedLegal) {
          expect(() => assertCommandPhase(phase, action), `${action} should be legal in ${phase}`).not.toThrow();
        } else {
          expect(() => assertCommandPhase(phase, action), `${action} should be illegal in ${phase}`).toThrow();
        }
      }
    }
  });

  it("throws the stable error codes", () => {
    expect(() => assertCommandPhase("DISCOVERY", "complete")).toThrowError(/INVALID_PHASE_COMMAND|not valid/);
    expect(() => assertCommandPhase("DISCOVERY", "start")).toThrowError(/already|RUN_ALREADY_EXISTS/);
  });

  it("accepts the `start` edge from the unstarted state only", () => {
    expect(() => assertCommandPhase(null, "start")).not.toThrow();
    expect(() => assertCommandPhase("SCENARIO", "start")).toThrow();
  });
});

describe("edge protocol references", () => {
  it("every edge references a defined protocol with a non-empty shape", () => {
    for (const edge of PHASE_EDGES) {
      expect(edge.protocol, edge.edgeId).toBeDefined();
      expect(typeof edge.protocol.ordered, edge.edgeId).toBe("boolean");
      expect(Array.isArray(edge.protocol.required), edge.edgeId).toBe(true);
    }
  });

  it("the registry maps every action to the protocol each edge cites", () => {
    for (const edge of PHASE_EDGES as PhaseEdgeSpec[]) {
      expect(EVENT_PROTOCOLS[edge.action], edge.edgeId).toBe(edge.protocol);
    }
  });
});
