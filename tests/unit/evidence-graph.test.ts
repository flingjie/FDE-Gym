import { describe, expect, it } from "vitest";

import type {
  EvidenceEdge,
  EvidenceGraph,
  EvidenceGraphPatch,
  EvidenceNode,
  LocalizedText,
} from "../../src/core/domain";
import { EvidenceGraphSchema } from "../../src/core/domain";
import {
  EVIDENCE_ASSUMPTION_UNLABELED,
  EVIDENCE_CONTRADICTION_UNDERCONNECTED,
  EVIDENCE_CYCLE_DETECTED,
  EVIDENCE_DUPLICATE_ID,
  EVIDENCE_EDGE_MISSING_NODE,
  EVIDENCE_FACT_WITHOUT_SOURCE,
  EVIDENCE_NODE_NOT_FOUND,
  EVIDENCE_PATCH_VERSION_MISMATCH,
  applyEvidencePatch,
  createEmptyEvidenceGraph,
} from "../../src/evidence/graph";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function text(value: string): LocalizedText {
  return { "zh-CN": value, "en-US": value };
}

function node(id: string, over: Partial<EvidenceNode> = {}): EvidenceNode {
  return {
    id,
    kind: "fact",
    claim: text(`claim-${id}`),
    status: "active",
    sourceTranscriptIds: ["turn-1"],
    weight: 1,
    version: 0,
    ...over,
  };
}

function edge(id: string, from: string, to: string, relation: EvidenceEdge["relation"]): EvidenceEdge {
  return { id, from, to, relation, version: 0 };
}

function patch(over: Partial<EvidenceGraphPatch> = {}): EvidenceGraphPatch {
  return {
    patchId: "p1",
    expectedVersion: 0,
    addNodes: [],
    addEdges: [],
    invalidateNodeIds: [],
    ...over,
  };
}

/** Capture the stable `code` of a thrown invariant violation. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Invariant 1: a `fact` requires >= 1 public transcript source
// ---------------------------------------------------------------------------

describe("invariant: fact requires a public transcript source", () => {
  it("rejects a fact node with zero sourceTranscriptIds", () => {
    const p = patch({ addNodes: [node("ev-a", { sourceTranscriptIds: [] })] });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toBe(
      EVIDENCE_FACT_WITHOUT_SOURCE,
    );
    expect(messageOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toContain("ev-a");
  });

  it("accepts a fact node carrying at least one source", () => {
    const next = applyEvidencePatch(createEmptyEvidenceGraph(), patch({ addNodes: [node("ev-a")] }));
    expect(next.nodes.map((n) => n.id)).toEqual(["ev-a"]);
    expect(EvidenceGraphSchema.safeParse(next).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2: an `assumption` may have no source but MUST be labeled
// ---------------------------------------------------------------------------

describe("invariant: assumption may be sourceless but must be labeled", () => {
  it("accepts a sourceless assumption that is labeled in both locales", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({ addNodes: [node("ev-a", { kind: "assumption", sourceTranscriptIds: [] })] }),
    );
    expect(next.nodes[0].kind).toBe("assumption");
    expect(next.nodes[0].sourceTranscriptIds).toEqual([]);
  });

  it("rejects an assumption with an empty zh-CN label", () => {
    const unlabeled = {
      ...node("ev-a", { kind: "assumption", sourceTranscriptIds: [] }),
      claim: { "zh-CN": "", "en-US": "assumed" },
    } as unknown as EvidenceNode;
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), patch({ addNodes: [unlabeled] })))).toBe(
      EVIDENCE_ASSUMPTION_UNLABELED,
    );
  });

  it("rejects an assumption with an empty en-US label", () => {
    const unlabeled = {
      ...node("ev-a", { kind: "assumption", sourceTranscriptIds: [] }),
      claim: { "zh-CN": "假设", "en-US": "   " },
    } as unknown as EvidenceNode;
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), patch({ addNodes: [unlabeled] })))).toBe(
      EVIDENCE_ASSUMPTION_UNLABELED,
    );
  });

  it("rejects an unlabeled unknown node too (labels are required for every kind)", () => {
    const unlabeled = {
      ...node("ev-a", { kind: "unknown", sourceTranscriptIds: [] }),
      claim: { "zh-CN": "", "en-US": "" },
    } as unknown as EvidenceNode;
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), patch({ addNodes: [unlabeled] })))).toBe(
      EVIDENCE_ASSUMPTION_UNLABELED,
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant 3: a `contradiction` must connect >= 2 claims
// ---------------------------------------------------------------------------

describe("invariant: contradiction connects at least two claims", () => {
  const claimNodes = [node("ev-a"), node("ev-b")];

  it("rejects a contradiction node with only one contradicts edge", () => {
    const p = patch({
      addNodes: [...claimNodes, node("ev-x", { kind: "contradiction" })],
      addEdges: [edge("e1", "ev-x", "ev-a", "contradicts")],
    });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toBe(
      EVIDENCE_CONTRADICTION_UNDERCONNECTED,
    );
    expect(messageOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toContain("ev-x");
  });

  it("rejects a contradiction node with two contradicts edges to the SAME other node", () => {
    const p = patch({
      addNodes: [...claimNodes, node("ev-x", { kind: "contradiction" })],
      addEdges: [
        edge("e1", "ev-x", "ev-a", "contradicts"),
        edge("e2", "ev-a", "ev-x", "contradicts"),
      ],
    });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toBe(
      EVIDENCE_CONTRADICTION_UNDERCONNECTED,
    );
  });

  it("accepts a contradiction node linked to two distinct claims", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({
        addNodes: [...claimNodes, node("ev-x", { kind: "contradiction" })],
        addEdges: [
          edge("e1", "ev-x", "ev-a", "contradicts"),
          edge("e2", "ev-x", "ev-b", "contradicts"),
        ],
      }),
    );
    expect(next.nodes).toHaveLength(3);
    expect(next.edges).toHaveLength(2);
  });

  it("counts incoming contradicts edges toward the two-claim requirement", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({
        addNodes: [...claimNodes, node("ev-x", { kind: "contradiction" })],
        addEdges: [
          edge("e1", "ev-a", "ev-x", "contradicts"),
          edge("e2", "ev-b", "ev-x", "contradicts"),
        ],
      }),
    );
    expect(next.nodes).toHaveLength(3);
  });

  it("ignores non-contradicts edges when counting connected claims", () => {
    const p = patch({
      addNodes: [...claimNodes, node("ev-x", { kind: "contradiction" })],
      addEdges: [
        edge("e1", "ev-x", "ev-a", "contradicts"),
        edge("e2", "ev-x", "ev-b", "supports"),
      ],
    });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toBe(
      EVIDENCE_CONTRADICTION_UNDERCONNECTED,
    );
  });

  it("does not require connectivity from an invalidated contradiction node", () => {
    const seeded = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({
        addNodes: [...claimNodes, node("ev-x", { kind: "contradiction" })],
        addEdges: [
          edge("e1", "ev-x", "ev-a", "contradicts"),
          edge("e2", "ev-x", "ev-b", "contradicts"),
        ],
      }),
    );
    const next = applyEvidencePatch(
      seeded,
      patch({ patchId: "p2", expectedVersion: seeded.version, invalidateNodeIds: ["ev-x"] }),
    );
    expect(next.nodes.find((n) => n.id === "ev-x")?.status).toBe("invalidated");
  });
});

// ---------------------------------------------------------------------------
// Invariant 4: nodes are never deleted, only invalidated
// ---------------------------------------------------------------------------

describe("invariant: nodes are never deleted, only invalidated", () => {
  const seeded = applyEvidencePatch(
    createEmptyEvidenceGraph(),
    patch({ addNodes: [node("ev-a"), node("ev-b")] }),
  );

  it("flips status to invalidated while preserving the node and its claim", () => {
    const next = applyEvidencePatch(
      seeded,
      patch({ patchId: "p2", expectedVersion: seeded.version, invalidateNodeIds: ["ev-a"] }),
    );
    expect(next.nodes).toHaveLength(2);
    expect(next.nodes.map((n) => n.id)).toEqual(["ev-a", "ev-b"]);
    const invalidated = next.nodes.find((n) => n.id === "ev-a");
    expect(invalidated?.status).toBe("invalidated");
    expect(invalidated?.claim).toEqual(text("claim-ev-a"));
    expect(next.nodes.find((n) => n.id === "ev-b")?.status).toBe("active");
  });

  it("has no deletion channel in the patch shape", () => {
    const p = patch();
    expect(Object.keys(p).sort()).toEqual([
      "addEdges",
      "addNodes",
      "expectedVersion",
      "invalidateNodeIds",
      "patchId",
    ]);
  });

  it("rejects invalidating an unknown node id", () => {
    const p = patch({ patchId: "p3", expectedVersion: seeded.version, invalidateNodeIds: ["ev-ghost"] });
    expect(codeOf(() => applyEvidencePatch(seeded, p))).toBe(EVIDENCE_NODE_NOT_FOUND);
    expect(messageOf(() => applyEvidencePatch(seeded, p))).toContain("ev-ghost");
  });
});

// ---------------------------------------------------------------------------
// Invariant 5: expectedVersion must equal graph.version
// ---------------------------------------------------------------------------

describe("invariant: expectedVersion must equal graph version", () => {
  it("rejects a stale expectedVersion", () => {
    const seeded = applyEvidencePatch(createEmptyEvidenceGraph(), patch({ addNodes: [node("ev-a")] }));
    expect(seeded.version).toBe(1);
    const stale = patch({ patchId: "p2", expectedVersion: 0, addNodes: [node("ev-b")] });
    expect(codeOf(() => applyEvidencePatch(seeded, stale))).toBe(EVIDENCE_PATCH_VERSION_MISMATCH);
  });

  it("rejects an expectedVersion from the future", () => {
    const ahead = patch({ expectedVersion: 7, addNodes: [node("ev-a")] });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), ahead))).toBe(
      EVIDENCE_PATCH_VERSION_MISMATCH,
    );
  });

  it("bumps the graph version by one and stamps written nodes/edges", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({ addNodes: [node("ev-a"), node("ev-b")], addEdges: [edge("e1", "ev-a", "ev-b", "supports")] }),
    );
    expect(next.version).toBe(1);
    expect(next.nodes.every((n) => n.version === 1)).toBe(true);
    expect(next.edges.every((e) => e.version === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 6: reapplying the same patchId is idempotent
// ---------------------------------------------------------------------------

describe("invariant: reapplying a patchId is idempotent", () => {
  const p1 = patch({
    addNodes: [node("ev-a"), node("ev-b")],
    addEdges: [edge("e1", "ev-a", "ev-b", "supports")],
    invalidateNodeIds: [],
  });

  it("returns the graph unchanged on a second application", () => {
    const once = applyEvidencePatch(createEmptyEvidenceGraph(), p1);
    const twice = applyEvidencePatch(once, p1);
    expect(twice).toEqual(once);
    expect(twice.version).toBe(once.version);
    expect(twice.nodes).toHaveLength(2);
    expect(twice.edges).toHaveLength(1);
  });

  it("is idempotent even though the replayed expectedVersion is now stale", () => {
    const once = applyEvidencePatch(createEmptyEvidenceGraph(), p1);
    expect(p1.expectedVersion).not.toBe(once.version);
    expect(() => applyEvidencePatch(once, p1)).not.toThrow();
  });

  it("is idempotent for an invalidate-only patch", () => {
    const seeded = applyEvidencePatch(createEmptyEvidenceGraph(), patch({ addNodes: [node("ev-a")] }));
    const inv = patch({ patchId: "p2", expectedVersion: seeded.version, invalidateNodeIds: ["ev-a"] });
    const once = applyEvidencePatch(seeded, inv);
    const twice = applyEvidencePatch(once, inv);
    expect(twice).toEqual(once);
    expect(twice.version).toBe(once.version);
  });

  it("rejects a partially colliding patch instead of silently merging", () => {
    const seeded = applyEvidencePatch(createEmptyEvidenceGraph(), patch({ addNodes: [node("ev-a")] }));
    const collide = patch({
      patchId: "p2",
      expectedVersion: seeded.version,
      addNodes: [node("ev-a"), node("ev-b")],
    });
    expect(codeOf(() => applyEvidencePatch(seeded, collide))).toBe(EVIDENCE_DUPLICATE_ID);
    expect(messageOf(() => applyEvidencePatch(seeded, collide))).toContain("ev-a");
  });

  it("rejects a duplicate edge id", () => {
    const seeded = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({ addNodes: [node("ev-a"), node("ev-b")], addEdges: [edge("e1", "ev-a", "ev-b", "supports")] }),
    );
    const collide = patch({
      patchId: "p2",
      expectedVersion: seeded.version,
      addEdges: [edge("e1", "ev-b", "ev-a", "supports"), edge("e2", "ev-a", "ev-b", "supports")],
    });
    expect(codeOf(() => applyEvidencePatch(seeded, collide))).toBe(EVIDENCE_DUPLICATE_ID);
  });

  it("rejects duplicate ids inside a single patch", () => {
    const p = patch({ addNodes: [node("ev-a"), node("ev-a")] });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toBe(EVIDENCE_DUPLICATE_ID);
  });
});

// ---------------------------------------------------------------------------
// Edge referential integrity
// ---------------------------------------------------------------------------

describe("edge referential integrity", () => {
  it("rejects an edge referencing a node that does not exist", () => {
    const p = patch({
      addNodes: [node("ev-a")],
      addEdges: [edge("e1", "ev-a", "ev-ghost", "supports")],
    });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toBe(
      EVIDENCE_EDGE_MISSING_NODE,
    );
    expect(messageOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toContain("ev-ghost");
  });

  it("accepts an edge referencing a node added by the same patch", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({ addNodes: [node("ev-a"), node("ev-b")], addEdges: [edge("e1", "ev-a", "ev-b", "supports")] }),
    );
    expect(next.edges).toHaveLength(1);
  });

  it("accepts an edge referencing a pre-existing node", () => {
    const seeded = applyEvidencePatch(createEmptyEvidenceGraph(), patch({ addNodes: [node("ev-a")] }));
    const next = applyEvidencePatch(
      seeded,
      patch({
        patchId: "p2",
        expectedVersion: seeded.version,
        addNodes: [node("ev-b")],
        addEdges: [edge("e1", "ev-b", "ev-a", "derived_from")],
      }),
    );
    expect(next.edges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cycle rules: only derived_from / depends_on are acyclic
// ---------------------------------------------------------------------------

describe("cycle rules", () => {
  const three = [node("ev-a"), node("ev-b"), node("ev-c")];

  it("rejects a derived_from cycle", () => {
    const p = patch({
      addNodes: three,
      addEdges: [
        edge("e1", "ev-a", "ev-b", "derived_from"),
        edge("e2", "ev-b", "ev-c", "derived_from"),
        edge("e3", "ev-c", "ev-a", "derived_from"),
      ],
    });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toBe(EVIDENCE_CYCLE_DETECTED);
    expect(messageOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toContain("derived_from");
  });

  it("rejects a depends_on cycle", () => {
    const p = patch({
      addNodes: three,
      addEdges: [
        edge("e1", "ev-a", "ev-b", "depends_on"),
        edge("e2", "ev-b", "ev-a", "depends_on"),
      ],
    });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toBe(EVIDENCE_CYCLE_DETECTED);
  });

  it("rejects a derived_from self-loop", () => {
    const p = patch({ addNodes: [node("ev-a")], addEdges: [edge("e1", "ev-a", "ev-a", "derived_from")] });
    expect(codeOf(() => applyEvidencePatch(createEmptyEvidenceGraph(), p))).toBe(EVIDENCE_CYCLE_DETECTED);
  });

  it("rejects a cycle closed across two patches", () => {
    const seeded = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({ addNodes: three, addEdges: [edge("e1", "ev-a", "ev-b", "derived_from")] }),
    );
    const closing = patch({
      patchId: "p2",
      expectedVersion: seeded.version,
      addEdges: [edge("e2", "ev-b", "ev-a", "derived_from")],
    });
    expect(codeOf(() => applyEvidencePatch(seeded, closing))).toBe(EVIDENCE_CYCLE_DETECTED);
  });

  it("allows a derived_from DAG (diamond)", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({
        addNodes: [...three, node("ev-d")],
        addEdges: [
          edge("e1", "ev-a", "ev-b", "derived_from"),
          edge("e2", "ev-a", "ev-c", "derived_from"),
          edge("e3", "ev-b", "ev-d", "derived_from"),
          edge("e4", "ev-c", "ev-d", "derived_from"),
        ],
      }),
    );
    expect(next.edges).toHaveLength(4);
  });

  it("allows two-way contradicts edges between the same pair", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({
        addNodes: [node("ev-a"), node("ev-b")],
        addEdges: [
          edge("e1", "ev-a", "ev-b", "contradicts"),
          edge("e2", "ev-b", "ev-a", "contradicts"),
        ],
      }),
    );
    expect(next.edges).toHaveLength(2);
  });

  it("allows cycles on supports and resolves relations", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({
        addNodes: [node("ev-a"), node("ev-b")],
        addEdges: [
          edge("e1", "ev-a", "ev-b", "supports"),
          edge("e2", "ev-b", "ev-a", "supports"),
          edge("e3", "ev-a", "ev-b", "resolves"),
          edge("e4", "ev-b", "ev-a", "resolves"),
        ],
      }),
    );
    expect(next.edges).toHaveLength(4);
  });

  it("does not conflate derived_from with depends_on when detecting cycles", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({
        addNodes: [node("ev-a"), node("ev-b")],
        addEdges: [
          edge("e1", "ev-a", "ev-b", "derived_from"),
          edge("e2", "ev-b", "ev-a", "depends_on"),
        ],
      }),
    );
    expect(next.edges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("immutability", () => {
  it("never mutates the input graph or patch (deep-frozen inputs)", () => {
    const seeded = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({ addNodes: [node("ev-a"), node("ev-b")] }),
    );
    const frozenGraph = deepFreeze(structuredClone(seeded)) as EvidenceGraph;
    const frozenPatch = deepFreeze(
      patch({
        patchId: "p2",
        expectedVersion: frozenGraph.version,
        addNodes: [node("ev-c")],
        addEdges: [edge("e1", "ev-c", "ev-a", "derived_from")],
        invalidateNodeIds: ["ev-b"],
      }),
    );

    const next = applyEvidencePatch(frozenGraph, frozenPatch);

    expect(next).not.toBe(frozenGraph);
    expect(frozenGraph.nodes).toHaveLength(2);
    expect(frozenGraph.edges).toHaveLength(0);
    expect(frozenGraph.version).toBe(1);
    expect(frozenGraph.nodes.find((n) => n.id === "ev-b")?.status).toBe("active");
    expect(next.nodes).toHaveLength(3);
    expect(next.nodes.find((n) => n.id === "ev-b")?.status).toBe("invalidated");
    expect(next.nodes.some((n) => frozenGraph.nodes.includes(n) && n.id === "ev-b")).toBe(false);
  });

  it("does not alias patch nodes into the result", () => {
    const added = node("ev-a");
    const next = applyEvidencePatch(createEmptyEvidenceGraph(), patch({ addNodes: [added] }));
    expect(next.nodes[0]).not.toBe(added);
    expect(added.version).toBe(0);
  });

  it("produces a schema-valid graph", () => {
    const next = applyEvidencePatch(
      createEmptyEvidenceGraph(),
      patch({
        addNodes: [node("ev-a"), node("ev-b", { kind: "assumption", sourceTranscriptIds: [] })],
        addEdges: [edge("e1", "ev-b", "ev-a", "derived_from")],
      }),
    );
    expect(EvidenceGraphSchema.safeParse(next).success).toBe(true);
  });

  it("is deterministic: the same graph+patch yields byte-identical JSON", () => {
    const p = patch({
      addNodes: [node("ev-a"), node("ev-b")],
      addEdges: [edge("e1", "ev-a", "ev-b", "supports")],
    });
    const a = applyEvidencePatch(createEmptyEvidenceGraph(), p);
    const b = applyEvidencePatch(createEmptyEvidenceGraph(), p);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
