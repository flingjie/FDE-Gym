import { RUN_PHASES, type RunPhase } from "../core/domain.js";
import { EVENT_PROTOCOLS } from "./event-protocols.js";
import type { GraphDefinition } from "./definition.js";

/**
 * FDE Gym — static graph validator (Phase 2, G2-04).
 *
 * Checks a `GraphDefinition`'s structural invariants so CI can reject a broken
 * graph before it reaches the runtime:
 *   - node/edge id uniqueness;
 *   - edge reference integrity (from/to reference real nodes);
 *   - phase-change effect validity (from/to are real phases);
 *   - action coverage (every domain action has at least one edge — ghost action);
 *   - terminal out-edges (a node in a terminal phase has no outgoing edge).
 *
 * Pure and side-effect-free; returns the list of issues (empty = valid).
 */

export interface GraphValidationIssue {
  severity: "error" | "warning";
  message: string;
}

const ALL_ACTIONS = Object.keys(EVENT_PROTOCOLS);
const ALL_PHASES = new Set<RunPhase>(RUN_PHASES);

export function validateGraph(graph: GraphDefinition): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));

  if (nodeIds.size !== graph.nodes.length) {
    issues.push({ severity: "error", message: "duplicate node id" });
  }
  if (edgeIds.size !== graph.edges.length) {
    issues.push({ severity: "error", message: "duplicate edge id" });
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) {
      issues.push({ severity: "error", message: `edge ${edge.id} references missing from-node ${edge.from}` });
    }
    if (!nodeIds.has(edge.to)) {
      issues.push({ severity: "error", message: `edge ${edge.id} references missing to-node ${edge.to}` });
    }
    for (const effect of edge.effects) {
      if (effect.type === "phase-change") {
        if (!ALL_PHASES.has(effect.from) || !ALL_PHASES.has(effect.to)) {
          issues.push({ severity: "error", message: `edge ${edge.id} has an invalid phase-change ${effect.from} → ${effect.to}` });
        }
      }
    }
  }

  const coveredActions = new Set<string>(graph.edges.map((edge) => edge.trigger));
  for (const action of ALL_ACTIONS) {
    if (!coveredActions.has(action)) {
      issues.push({ severity: "error", message: `no edge for action ${action}` });
    }
  }

  for (const node of graph.nodes) {
    if (node.phase === "COMPLETED" || node.phase === "ABORTED") {
      if (graph.edges.some((edge) => edge.from === node.id)) {
        issues.push({ severity: "error", message: `terminal node ${node.id} has an outgoing edge` });
      }
    }
  }

  return issues;
}
