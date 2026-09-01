import type { z } from "zod";

import type { AgentRole, RunPhase } from "../core/domain.js";
import type { ActionId, GuardId } from "./action-types.js";
import type { EventProtocolSpec } from "./protocol-types.js";

/**
 * FDE Gym — Graph IR types (Phase 2, G2-01).
 *
 * The explicit type model that separates the six core concepts (see
 * `docs/graph/wave0-integration.md`): a **Node** is a unit of work the runtime
 * executes; an **Edge** connects two nodes and is traversed by an **Action**
 * (`trigger`), gated by a **Guard**, producing **Effects** (a phase change is an
 * effect) and an ordered **Event Protocol**.
 */

export type NodeId = string;
export type EdgeId = string;

export type NodeKind = "human" | "agent" | "deterministic" | "guard";

/**
 * A node's context firewall contract: which role/capsule (if any) an agent node
 * may receive. The firewall (`buildRoleInput`) is the runtime enforcer; this is
 * the declarative record.
 */
export interface ContextPolicy {
  role?: AgentRole;
  capsule?: "customer" | "evaluator";
}

export type NodeFailureClass =
  | "TRANSIENT_RUNTIME"
  | "INVALID_MODEL_OUTPUT"
  | "SECURITY_VIOLATION"
  | "DOMAIN_REJECTION"
  | "CONCURRENCY_CONFLICT";

/** How a node's failure is handled (see G3-05). */
export interface FailurePolicy {
  failureClass: NodeFailureClass;
  retry: boolean;
  maxAttempts?: number;
}

export interface GraphNodeDefinition {
  id: NodeId;
  phase: RunPhase;
  kind: NodeKind;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  contextPolicy?: ContextPolicy;
  failurePolicy?: FailurePolicy;
}

/**
 * An edge's effect. `phase-change` is the common case (the run moves phase);
 * `spawn-run` is reserved for `start-retry`, which creates a child run rather
 * than transitioning the parent.
 */
export type GraphEffect =
  | { type: "phase-change"; from: RunPhase; to: RunPhase }
  | { type: "spawn-run" };

export interface GraphEdgeDefinition {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  trigger: ActionId;
  guard?: GuardId;
  effects: GraphEffect[];
  protocol: EventProtocolSpec;
}
