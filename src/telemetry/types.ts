import type { RunPhase } from "../core/domain.js";
import type { ActionId, GuardId } from "../graph/action-types.js";
import type { EdgeId, NodeFailureClass, NodeId } from "../graph/types.js";

/**
 * FDE Gym — execution telemetry types (Phase 4).
 *
 * Telemetry is DELIBERATELY separate from the domain event log: a span is never
 * part of a committed event's hash payload, and losing telemetry never affects a
 * run's recovery. It records the execution-time facts (which node/edge ran, its
 * outcome, duration, model/token usage) needed to answer "what happened and why"
 * without re-deriving the deterministic domain state.
 */

export interface TokenUsage {
  input: number;
  output: number;
}

export type NodeOutcome = "success" | "failure" | "pending";

/** G4-01 — one node execution's execution-time record. */
export interface NodeSpan {
  graphVersion: string;
  runId: string;
  commandId: string;
  nodeId: NodeId;
  attempt: number;
  outcome: NodeOutcome;
  failureClass?: NodeFailureClass;
  failureCode?: string;
  durationMs: number;
  model?: string;
  promptDigest?: string;
  tokenUsage?: TokenUsage;
}

/** G4-02 — one edge traversal's record (guard evidence is ids/codes only, never payload). */
export interface EdgeSpan {
  graphVersion: string;
  runId: string;
  commandId: string;
  edgeId: EdgeId;
  action: ActionId;
  from: NodeId;
  to: NodeId;
  guardDecision?: { guardId: GuardId; passed: boolean; code?: string };
  phaseEffect?: { from: RunPhase; to: RunPhase };
}
