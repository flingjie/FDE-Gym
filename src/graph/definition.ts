import type { RunPhase } from "../core/domain.js";
import type { GraphEdgeDefinition, GraphNodeDefinition } from "./types.js";

/**
 * FDE Gym — Graph Definition (Phase 2, G2-01).
 *
 * A named, versioned collection of nodes and edges. `fde-graph.ts` is the single
 * concrete instance. The static validator (`validator.ts`) checks a definition's
 * structural invariants, and `phase-spec.ts` projects the phase-legality table
 * out of it.
 */

export interface GraphDefinition {
  id: string;
  version: string;
  /** The phase a run begins in before the `start` action (the unstarted state). */
  initialPhase: RunPhase | null;
  nodes: readonly GraphNodeDefinition[];
  edges: readonly GraphEdgeDefinition[];
}
