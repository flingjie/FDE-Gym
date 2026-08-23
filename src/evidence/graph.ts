import type {
  EvidenceEdge,
  EvidenceGraph,
  EvidenceGraphPatch,
  EvidenceNode,
  EvidenceRelation,
  LocalizedText,
} from "../core/domain.js";

/**
 * Evidence graph reducer.
 *
 * `applyEvidencePatch` is the ONLY way the evidence graph changes. It is pure
 * and deterministic: no wall-clock, no randomness, no mutation of its inputs.
 * Every call returns a brand-new graph (with brand-new node/edge objects), so a
 * caller may safely keep — or deep-freeze — the previous version.
 *
 * Invariants enforced here (each throws `EvidenceGraphError` with a stable
 * `code`; messages cite only node/edge ids and relation names, never evidence
 * claim text):
 *
 *  1. A `fact` node requires at least one public transcript source
 *     (`sourceTranscriptIds.length >= 1`).
 *  2. Every node must be LABELED — both locales of `claim` non-blank. An
 *     `assumption` (or `unknown`) MAY carry zero sources, but must be labeled.
 *  3. CONTRADICTION CONNECTIVITY RULE: a node with `kind === "contradiction"`
 *     that is `active` in the RESULTING graph must connect at least two
 *     DISTINCT other nodes through `contradicts` edges. Formally: collect the
 *     opposite endpoint of every edge where `relation === "contradicts"` and
 *     (`from === nodeId` || `to === nodeId`), drop the node itself, and require
 *     `size >= 2`. Direction is irrelevant (an incoming `contradicts` counts),
 *     and two edges to the SAME other node count once. Non-`contradicts`
 *     relations never count. Invalidated contradiction nodes are exempt.
 *  4. Nodes are never deleted. The patch shape has no removal channel; the only
 *     lifecycle transition is `invalidateNodeIds`, which flips a node's
 *     `status` to `invalidated` while preserving its id, kind, claim, and
 *     sources.
 *  5. `patch.expectedVersion` must equal `graph.version` (optimistic
 *     concurrency), unless the patch is a replay — see below.
 *  6. IDEMPOTENCY MECHANISM (no extra state on the graph, so the Task 2
 *     `EvidenceGraphSchema` stays intact): a patch is treated as ALREADY
 *     APPLIED — and the input graph is returned unchanged — when it is
 *     non-empty and *fully* absorbed, i.e. every `addNodes` id already exists,
 *     every `addEdges` id already exists, and every `invalidateNodeIds` target
 *     is already `invalidated`. This check runs BEFORE the version check, so a
 *     replayed patch whose `expectedVersion` is now stale is still a no-op. A
 *     PARTIAL overlap is not a replay: it is an id collision and is rejected
 *     with `EVIDENCE_DUPLICATE_ID`.
 *  7. New node and edge ids must be unique (against the existing graph and
 *     within the patch), and every new edge must reference a node that already
 *     exists or is added by the same patch.
 *  8. Cycles are rejected for `derived_from` and `depends_on` ONLY, and each of
 *     those relations is checked in ITS OWN subgraph (so `a derived_from b` +
 *     `b depends_on a` is legal). `supports`, `resolves`, and `contradicts` may
 *     cycle freely — in particular two-way `contradicts` edges are allowed.
 */

// ---------------------------------------------------------------------------
// Stable error codes
// ---------------------------------------------------------------------------

export const EVIDENCE_PATCH_VERSION_MISMATCH = "EVIDENCE_PATCH_VERSION_MISMATCH" as const;
export const EVIDENCE_FACT_WITHOUT_SOURCE = "EVIDENCE_FACT_WITHOUT_SOURCE" as const;
export const EVIDENCE_ASSUMPTION_UNLABELED = "EVIDENCE_ASSUMPTION_UNLABELED" as const;
export const EVIDENCE_CONTRADICTION_UNDERCONNECTED = "EVIDENCE_CONTRADICTION_UNDERCONNECTED" as const;
export const EVIDENCE_DUPLICATE_ID = "EVIDENCE_DUPLICATE_ID" as const;
export const EVIDENCE_EDGE_MISSING_NODE = "EVIDENCE_EDGE_MISSING_NODE" as const;
export const EVIDENCE_NODE_NOT_FOUND = "EVIDENCE_NODE_NOT_FOUND" as const;
export const EVIDENCE_CYCLE_DETECTED = "EVIDENCE_CYCLE_DETECTED" as const;
export const EVIDENCE_INVALID_RELATION = "EVIDENCE_INVALID_RELATION" as const;

export type EvidenceGraphErrorCode =
  | typeof EVIDENCE_PATCH_VERSION_MISMATCH
  | typeof EVIDENCE_FACT_WITHOUT_SOURCE
  | typeof EVIDENCE_ASSUMPTION_UNLABELED
  | typeof EVIDENCE_CONTRADICTION_UNDERCONNECTED
  | typeof EVIDENCE_DUPLICATE_ID
  | typeof EVIDENCE_EDGE_MISSING_NODE
  | typeof EVIDENCE_NODE_NOT_FOUND
  | typeof EVIDENCE_CYCLE_DETECTED
  | typeof EVIDENCE_INVALID_RELATION;

/** Invariant violation raised by the reducer. Carries a stable machine code. */
export class EvidenceGraphError extends Error {
  readonly code: EvidenceGraphErrorCode;
  readonly patchId: string;
  constructor(code: EvidenceGraphErrorCode, patchId: string, detail: string) {
    super(`${code} (patch ${patchId}): ${detail}`);
    this.name = "EvidenceGraphError";
    this.code = code;
    this.patchId = patchId;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The pristine graph a run starts from. */
export function createEmptyEvidenceGraph(): EvidenceGraph {
  return { version: 0, nodes: [], edges: [] };
}

/** Relations whose subgraphs must stay acyclic. Checked independently. */
export const ACYCLIC_RELATIONS: readonly EvidenceRelation[] = ["derived_from", "depends_on"];

const ALL_RELATIONS: readonly EvidenceRelation[] = [
  "supports",
  "contradicts",
  "derived_from",
  "resolves",
  "depends_on",
];

function isLabeled(claim: LocalizedText | undefined): boolean {
  if (claim === null || typeof claim !== "object") return false;
  return (
    typeof claim["zh-CN"] === "string" &&
    claim["zh-CN"].trim().length > 0 &&
    typeof claim["en-US"] === "string" &&
    claim["en-US"].trim().length > 0
  );
}

function cloneNode(node: EvidenceNode, version: number): EvidenceNode {
  return {
    id: node.id,
    kind: node.kind,
    claim: { "zh-CN": node.claim["zh-CN"], "en-US": node.claim["en-US"] },
    status: node.status,
    sourceTranscriptIds: [...node.sourceTranscriptIds],
    weight: node.weight,
    version,
  };
}

function cloneEdge(edge: EvidenceEdge, version: number): EvidenceEdge {
  return { id: edge.id, from: edge.from, to: edge.to, relation: edge.relation, version };
}

/** Opposite endpoints reachable from `nodeId` via `contradicts` edges (either direction). */
function contradictionPartners(nodeId: string, edges: readonly EvidenceEdge[]): Set<string> {
  const partners = new Set<string>();
  for (const edge of edges) {
    if (edge.relation !== "contradicts") continue;
    if (edge.from === nodeId && edge.to !== nodeId) partners.add(edge.to);
    else if (edge.to === nodeId && edge.from !== nodeId) partners.add(edge.from);
  }
  return partners;
}

/**
 * Depth-first cycle detection over the subgraph of a single relation.
 * Returns the id of a node on a cycle, or `null`. Iteration order follows the
 * edge array, so the reported node is deterministic.
 */
function findCycle(edges: readonly EvidenceEdge[], relation: EvidenceRelation): string | null {
  const adjacency = new Map<string, string[]>();
  const roots: string[] = [];
  for (const edge of edges) {
    if (edge.relation !== relation) continue;
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
      roots.push(edge.from);
    }
    adjacency.get(edge.from)!.push(edge.to);
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, []);
      roots.push(edge.to);
    }
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of roots) color.set(id, WHITE);

  for (const root of roots) {
    if (color.get(root) !== WHITE) continue;
    // Explicit stack; `enter=false` frames finalize a node (grey -> black).
    const stack: { id: string; enter: boolean }[] = [{ id: root, enter: true }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (!frame.enter) {
        color.set(frame.id, BLACK);
        continue;
      }
      if (color.get(frame.id) === BLACK) continue;
      color.set(frame.id, GREY);
      stack.push({ id: frame.id, enter: false });
      for (const next of adjacency.get(frame.id) ?? []) {
        if (color.get(next) === GREY) return next; // back edge (self-loops included)
        if (color.get(next) !== BLACK) stack.push({ id: next, enter: true });
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Apply an Evidence Tracker patch, returning a NEW graph. Throws
 * `EvidenceGraphError` when any invariant would be violated; on a replayed
 * patch it returns `graph` itself, unchanged.
 */
export function applyEvidencePatch(graph: EvidenceGraph, patch: EvidenceGraphPatch): EvidenceGraph {
  const { patchId } = patch;
  const fail = (code: EvidenceGraphErrorCode, detail: string): never => {
    throw new EvidenceGraphError(code, patchId, detail);
  };

  const existingNodeIds = new Set(graph.nodes.map((node) => node.id));
  const existingEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  const statusById = new Map(graph.nodes.map((node) => [node.id, node.status] as const));

  // --- Invariant 6: replay detection runs BEFORE the version check. ---------
  const touches = patch.addNodes.length + patch.addEdges.length + patch.invalidateNodeIds.length;
  const fullyAbsorbed =
    touches > 0 &&
    patch.addNodes.every((node) => existingNodeIds.has(node.id)) &&
    patch.addEdges.every((edge) => existingEdgeIds.has(edge.id)) &&
    patch.invalidateNodeIds.every((id) => statusById.get(id) === "invalidated");
  if (fullyAbsorbed) return graph;

  // --- Invariant 5: optimistic concurrency ---------------------------------
  if (patch.expectedVersion !== graph.version) {
    fail(
      EVIDENCE_PATCH_VERSION_MISMATCH,
      `expectedVersion ${patch.expectedVersion} != graph version ${graph.version}`,
    );
  }

  const nextVersion = graph.version + 1;

  // --- Invariant 7: id uniqueness (vs graph and within the patch) ----------
  const addedNodeIds = new Set<string>();
  for (const node of patch.addNodes) {
    if (existingNodeIds.has(node.id) || addedNodeIds.has(node.id)) {
      fail(EVIDENCE_DUPLICATE_ID, `node id already present: ${node.id}`);
    }
    addedNodeIds.add(node.id);
  }
  const addedEdgeIds = new Set<string>();
  for (const edge of patch.addEdges) {
    if (existingEdgeIds.has(edge.id) || addedEdgeIds.has(edge.id)) {
      fail(EVIDENCE_DUPLICATE_ID, `edge id already present: ${edge.id}`);
    }
    addedEdgeIds.add(edge.id);
  }

  // --- Invariants 1 & 2: per-node shape ------------------------------------
  for (const node of patch.addNodes) {
    if (!isLabeled(node.claim)) {
      fail(EVIDENCE_ASSUMPTION_UNLABELED, `node is not labeled in both locales: ${node.id}`);
    }
    if (node.kind === "fact" && node.sourceTranscriptIds.length === 0) {
      fail(EVIDENCE_FACT_WITHOUT_SOURCE, `fact node has no public transcript source: ${node.id}`);
    }
  }

  // --- Invariant 4: invalidation targets must exist ------------------------
  for (const id of patch.invalidateNodeIds) {
    if (!existingNodeIds.has(id) && !addedNodeIds.has(id)) {
      fail(EVIDENCE_NODE_NOT_FOUND, `cannot invalidate unknown node: ${id}`);
    }
  }

  // --- Invariant 7: edge endpoints must resolve ----------------------------
  for (const edge of patch.addEdges) {
    if (!ALL_RELATIONS.includes(edge.relation)) {
      fail(EVIDENCE_INVALID_RELATION, `unsupported relation on edge ${edge.id}: ${String(edge.relation)}`);
    }
    for (const endpoint of [edge.from, edge.to]) {
      if (!existingNodeIds.has(endpoint) && !addedNodeIds.has(endpoint)) {
        fail(EVIDENCE_EDGE_MISSING_NODE, `edge ${edge.id} references unknown node: ${endpoint}`);
      }
    }
  }

  // --- Build the candidate graph (immutably) ------------------------------
  const invalidate = new Set(patch.invalidateNodeIds);
  const nodes: EvidenceNode[] = graph.nodes.map((node) =>
    invalidate.has(node.id) && node.status !== "invalidated"
      ? { ...cloneNode(node, nextVersion), status: "invalidated" }
      : cloneNode(node, node.version),
  );
  for (const node of patch.addNodes) {
    const cloned = cloneNode(node, nextVersion);
    nodes.push(invalidate.has(node.id) ? { ...cloned, status: "invalidated" } : cloned);
  }
  const edges: EvidenceEdge[] = [
    ...graph.edges.map((edge) => cloneEdge(edge, edge.version)),
    ...patch.addEdges.map((edge) => cloneEdge(edge, nextVersion)),
  ];

  // --- Invariant 8: acyclic derived_from / depends_on subgraphs ------------
  for (const relation of ACYCLIC_RELATIONS) {
    const onCycle = findCycle(edges, relation);
    if (onCycle !== null) {
      fail(EVIDENCE_CYCLE_DETECTED, `${relation} cycle through node: ${onCycle}`);
    }
  }

  // --- Invariant 3: contradiction connectivity ----------------------------
  for (const node of nodes) {
    if (node.kind !== "contradiction" || node.status === "invalidated") continue;
    const partners = contradictionPartners(node.id, edges);
    if (partners.size < 2) {
      fail(
        EVIDENCE_CONTRADICTION_UNDERCONNECTED,
        `contradiction node connects ${partners.size} distinct claim(s) via contradicts edges, needs 2: ${node.id}`,
      );
    }
  }

  return { version: nextVersion, nodes, edges };
}
