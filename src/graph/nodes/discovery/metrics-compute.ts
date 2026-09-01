import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { RunEvent } from "../../../core/domain.js";
import type { EvidenceTurnResult } from "../../../agents/evidence-tracker.js";
import { EVIDENCE_TRACKER_OUTPUT_SCHEMA_VERSION } from "../../../agents/contracts.js";
import { computeDiscoveryMetrics, type DiscoveryTurnMetrics } from "./shared.js";

/**
 * `discovery.metrics.compute` — deterministic per-question metrics (deterministic).
 *
 * Computes `DiscoveryTurnMetrics` (`questionAssessment` + 0..1 composite) from
 * the Evidence Tracker's assessment and authors `question.assessed` with the
 * per-invocation `judgment` provenance. Mirrors steps 5–6 of
 * `prepareDiscoveryTurn`.
 *
 * Protocol: `EVENT_PROTOCOLS.ask` (optional `question.assessed`).
 */
export interface MetricsComputeInput {
  /** The post-patch aggregate (its runId/context seed the event). */
  state: RunAggregate;
  evidence: EvidenceTurnResult;
  commandId: string;
  /** The verified scenario-bundle digest recorded at run start (provenance only). */
  scenarioBundleDigest?: string;
}

export interface MetricsComputeResult extends NodeExecution {
  metrics: DiscoveryTurnMetrics;
}

export async function runMetricsCompute(input: MetricsComputeInput): Promise<MetricsComputeResult> {
  const { state, evidence, commandId } = input;
  const metrics = computeDiscoveryMetrics(evidence.questionAssessment);

  const event: RunEvent = {
    type: "question.assessed",
    runId: state.runId,
    commandId: `${commandId}:evidence`,
    questionId: commandId,
    assessment: evidence.questionAssessment,
    judgment: {
      judgmentId: `${commandId}:evidence`,
      invocationId: evidence.invocationId,
      modelId: evidence.modelId,
      promptDigest: evidence.promptDigest,
      schemaVersion: EVIDENCE_TRACKER_OUTPUT_SCHEMA_VERSION,
      scenarioDigest: input.scenarioBundleDigest ?? "",
      rawOutputDigest: evidence.rawOutputDigest,
    },
  };
  return { events: [event], updatedState: state, metrics };
}

export const metricsCompute: NodeHandler<MetricsComputeInput> = {
  definition: {
    id: "discovery.metrics.compute",
    phase: "DISCOVERY",
    kind: "deterministic",
  },
  run: runMetricsCompute,
};
