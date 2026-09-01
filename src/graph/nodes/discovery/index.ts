import type { NodeHandler } from "../node.js";
import { questionAccept } from "./question-accept.js";
import { customerInvoke } from "./customer-invoke.js";
import { customerProject } from "./customer-project.js";
import { evidenceInvoke } from "./evidence-invoke.js";
import { evidencePatchGuard } from "./evidence-patch-guard.js";
import { evidencePatchApply } from "./evidence-patch-apply.js";
import { metricsCompute } from "./metrics-compute.js";
import { evidencePending } from "./evidence-pending.js";

/**
 * FDE Gym — DISCOVERY subgraph handlers (G3-01).
 *
 * The happy-path node flow (mirrors `prepareDiscoveryTurn`):
 *
 *   `discovery.question.accept` → `customer.invoke` → `customer.project`
 *   → `evidence.invoke` → `evidence.patch.guard` → `evidence.patch.apply`
 *   → `discovery.metrics.compute`
 *
 * `evidence.pending` is the failure branch off `evidence.invoke`: when
 * extraction throws, the customer reply is retained and the turn is marked
 * pending instead of emitting `evidence.patched` / `question.assessed`.
 *
 * Each handler is an independently testable reference implementation that
 * mirrors the orchestrator WITHOUT importing it (to avoid a cycle). The graph
 * runtime (a later integration) threads `updatedState` between nodes and maps a
 * throw to the node's declared `failurePolicy`.
 */
export const handlers: readonly NodeHandler[] = [
  questionAccept,
  customerInvoke,
  customerProject,
  evidenceInvoke,
  evidencePatchGuard,
  evidencePatchApply,
  metricsCompute,
  evidencePending,
];

export * from "./shared.js";
export * from "./question-accept.js";
export * from "./customer-invoke.js";
export * from "./customer-project.js";
export * from "./evidence-invoke.js";
export * from "./evidence-patch-guard.js";
export * from "./evidence-patch-apply.js";
export * from "./metrics-compute.js";
export * from "./evidence-pending.js";
