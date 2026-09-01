import type { GraphDefinition } from "./definition.js";

/**
 * FDE Gym — graph generators (Phase 2, G5-01 seed).
 *
 * Render a `GraphDefinition` into human-readable artifacts. `toMermaid` emits a
 * Mermaid `flowchart` the docs can embed directly; a later phase will generate
 * the node/edge catalogs and coverage report from the same source.
 */

/** A Mermaid-safe node id (dots/dashes → underscores). */
function mermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** A Mermaid flowchart (LR) of the graph's edges, labelled `trigger / guard`. */
export function toMermaid(graph: GraphDefinition): string {
  const lines = ["flowchart LR"];
  const phaseOf = new Map(graph.nodes.map((node) => [node.id, node.phase]));
  const labelOf = (id: string) => {
    const phase = phaseOf.get(id);
    return phase ? `${id} (${phase})` : id;
  };
  for (const edge of graph.edges) {
    const from = mermaidId(edge.from);
    const to = mermaidId(edge.to);
    const label = edge.guard ? `${edge.trigger} / ${edge.guard}` : edge.trigger;
    lines.push(`  ${from}["${labelOf(edge.from)}"] -->|${label}| ${to}["${labelOf(edge.to)}"]`);
  }
  return lines.join("\n");
}

/** A simple edge catalog: one line per edge. */
export function toEdgeCatalog(graph: GraphDefinition): string {
  const lines = ["| Edge | Trigger | Guard | Phase change |", "|---|---|---|---|"];
  for (const edge of graph.edges) {
    const change = edge.effects
      .filter((effect) => effect.type === "phase-change")
      .map((effect) => effect.type === "phase-change" ? `${effect.from} → ${effect.to}` : "")
      .filter(Boolean)
      .join(", ");
    lines.push(`| ${edge.id} | ${edge.trigger} | ${edge.guard ?? ""} | ${change || "—"} |`);
  }
  return lines.join("\n");
}
