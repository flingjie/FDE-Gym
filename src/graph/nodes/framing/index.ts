import type { NodeHandler } from "../node.js";
import { briefAccept } from "./brief-accept.js";
import { briefStructureGuard } from "./brief-structure-guard.js";
import { coachBriefInvoke } from "./coach-brief-invoke.js";
import { briefSupportGuard } from "./brief-support-guard.js";
import { framingRevise } from "./framing-revise.js";
import { discoveryClarify } from "./discovery-clarify.js";

/**
 * FDE Gym — PROBLEM_FRAMING subgraph handlers (G3-02).
 *
 * The node flow (mirrors `prepareFramingGate` + `prepareClarification`):
 *
 *   `brief.accept` → `brief.structure.guard` → `coach.brief.invoke`
 *   → `brief.support.guard` → (`solution.design` on pass | `framing.revise`
 *     on reject)
 *
 * and the clarify back-edge `discovery.clarify` (PROBLEM_FRAMING → DISCOVERY,
 * bounded by the clarification budget). The two failure edges are distinct
 * nodes so the runtime cannot conflate "重新整理" (`framing.revise`) with
 * "返回探索" (`discovery.clarify`).
 *
 * Each handler is an independently testable reference implementation that
 * mirrors the orchestrator WITHOUT importing it (to avoid a cycle). The graph
 * runtime (a later integration) threads `updatedState` and each node's extra
 * result fields between nodes, and maps a throw to the node's declared
 * `failurePolicy`.
 */
export const handlers: readonly NodeHandler[] = [
  briefAccept,
  briefStructureGuard,
  coachBriefInvoke,
  briefSupportGuard,
  framingRevise,
  discoveryClarify,
];

export * from "./shared.js";
export * from "./brief-accept.js";
export * from "./brief-structure-guard.js";
export * from "./coach-brief-invoke.js";
export * from "./brief-support-guard.js";
export * from "./framing-revise.js";
export * from "./discovery-clarify.js";
