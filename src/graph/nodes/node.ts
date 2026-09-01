import type { AgentRuntime } from "../../agents/agent-runtime.js";
import type { RunAggregate } from "../../core/aggregate.js";
import type { RunEvent } from "../../core/domain.js";
import type { GraphNodeDefinition } from "../types.js";

/**
 * FDE Gym — node handler contract (Phase 3).
 *
 * A node handler declares its `GraphNodeDefinition` (id/phase/kind/context/
 * failure policy) and implements the node's work as a single async step that
 * returns the events to commit plus the updated aggregate. Agent nodes receive
 * the `AgentRuntime` (and any capsules they need) in their node-specific input;
 * the handler does NOT perform durable I/O — the transaction commits its events.
 *
 * Subgraph modules (`src/graph/nodes/<subgraph>/`) implement one `NodeHandler`
 * per node and export a `handlers: readonly NodeHandler[]` list. The graph
 * runtime (a later integration) dispatches these; for now they are independently
 * testable reference implementations that mirror the existing `prepare*`
 * functions in `src/core/orchestrator.ts` WITHOUT importing them (to avoid a
 * cycle).
 */

export interface NodeExecution {
  events: RunEvent[];
  updatedState: RunAggregate;
}

export interface NodeRuntime {
  runtime: AgentRuntime;
}

export interface NodeHandler<I = unknown> {
  definition: GraphNodeDefinition;
  run(input: I): Promise<NodeExecution>;
}
