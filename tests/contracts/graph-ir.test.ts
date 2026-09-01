import { describe, expect, it } from "vitest";

import { FDE_GRAPH } from "../../src/graph/fde-graph.js";
import { validateGraph } from "../../src/graph/validator.js";
import { toEdgeCatalog, toMermaid } from "../../src/graph/generators.js";
import { PHASE_TRANSITIONS } from "../../src/graph/phase-spec.js";
import { EVENT_PROTOCOLS } from "../../src/graph/event-protocols.js";
import type { GraphDefinition } from "../../src/graph/definition.js";
import type { GraphEdgeDefinition, GraphNodeDefinition } from "../../src/graph/types.js";

/**
 * Graph IR tests (Phase 2, G2-01/G2-03/G2-04): the FDE graph is structurally
 * valid, the static validator rejects broken graphs, and the graph's phase-change
 * effects are consistent with the phase-spec transition table.
 */

describe("FDE_GRAPH", () => {
  it("is structurally valid (no validator issues)", () => {
    expect(validateGraph(FDE_GRAPH)).toEqual([]);
  });

  it("covers every domain action (no ghost action)", () => {
    const triggers = new Set(FDE_GRAPH.edges.map((edge) => edge.trigger));
    for (const action of Object.keys(EVENT_PROTOCOLS)) {
      expect(triggers.has(action), `${action} has no edge`).toBe(true);
    }
  });

  it("has phase-change effects consistent with PHASE_TRANSITIONS", () => {
    const graphTransitions = new Set(
      FDE_GRAPH.edges
        .flatMap((edge) => edge.effects)
        .filter((effect) => effect.type === "phase-change")
        .map((effect) => effect.type === "phase-change" ? `${effect.from}→${effect.to}` : ""),
    );
    const specTransitions = new Set(PHASE_TRANSITIONS.map((t) => `${t.from}→${t.to}`));
    expect(graphTransitions).toEqual(specTransitions);
  });
});

describe("validateGraph", () => {
  const node = (id: string): GraphNodeDefinition => ({ id, phase: "DISCOVERY", kind: "deterministic" });
  const edge = (id: string, from: string, to: string): GraphEdgeDefinition => ({
    id, from, to, trigger: "ask", effects: [], protocol: EVENT_PROTOCOLS.ask,
  });
  const base = (): GraphDefinition => ({
    id: "g", version: "1", initialPhase: null,
    nodes: [node("a"), node("b")],
    edges: [edge("e1", "a", "b")],
  });

  it("rejects a duplicate node id", () => {
    const g = base();
    expect(validateGraph({ ...g, nodes: [node("a"), node("a")] }).map((i) => i.message)).toContain("duplicate node id");
  });

  it("rejects an edge referencing a missing node", () => {
    const g = base();
    expect(
      validateGraph({ ...g, edges: [edge("e1", "missing", "b")] }).map((i) => i.message),
    ).toContain("edge e1 references missing from-node missing");
  });

  it("rejects a missing action (ghost action)", () => {
    const g = base();
    // A graph with only one edge covers only `ask`; every other action is missing.
    expect(validateGraph(g).some((i) => i.message.startsWith("no edge for action"))).toBe(true);
  });

  it("rejects an invalid phase-change", () => {
    const g = base();
    const bad: GraphEdgeDefinition = {
      id: "e1", from: "a", to: "b", trigger: "ask",
      effects: [{ type: "phase-change", from: "NOPE" as never, to: "ALSO_NOPE" as never }],
      protocol: EVENT_PROTOCOLS.ask,
    };
    expect(validateGraph({ ...g, edges: [bad] }).some((i) => i.message.includes("invalid phase-change"))).toBe(true);
  });
});

describe("generators", () => {
  it("emits a Mermaid flowchart with one line per edge", () => {
    const mermaid = toMermaid(FDE_GRAPH);
    expect(mermaid.startsWith("flowchart LR")).toBe(true);
    expect(mermaid.split("\n").length).toBe(FDE_GRAPH.edges.length + 1);
  });

  it("emits an edge catalog with a header", () => {
    const catalog = toEdgeCatalog(FDE_GRAPH);
    expect(catalog.startsWith("| Edge |")).toBe(true);
    expect(catalog).toContain("start.unstarted.scenario");
  });
});
