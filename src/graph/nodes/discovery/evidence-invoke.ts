import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { AgentRuntime } from "../../../agents/agent-runtime.js";
import {
  extractEvidence,
  type EvidenceTurnResult,
} from "../../../agents/evidence-tracker.js";

/**
 * `evidence.invoke` — invoke the Evidence Tracker role (agent).
 *
 * Delegates to `extractEvidence`, which builds the tracker input through the
 * context firewall (transcript + graph ONLY, no capsule), invokes the
 * `AgentRuntime` under the `evidence_tracker` role, and sanitizes/validates the
 * patch + question assessment. On failure it THROWS (the runtime's failure
 * policy retries then routes to `evidence.pending`); the node produces NO events
 * on success — the `EvidenceTurnResult` is carried in the result.
 *
 * Protocol: `EVENT_PROTOCOLS.ask` (`evidence.patched`/`question.assessed` are
 * authored downstream by `evidence.patch.apply` / `discovery.metrics.compute`).
 */
export interface EvidenceInvokeInput {
  runtime: AgentRuntime;
  /** Must carry the just-folded transcript turn (the extraction target). */
  state: RunAggregate;
  commandId: string;
  timeoutMs?: number;
  canaries?: readonly string[];
}

export interface EvidenceInvokeResult extends NodeExecution {
  evidence: EvidenceTurnResult;
}

export async function runEvidenceInvoke(input: EvidenceInvokeInput): Promise<EvidenceInvokeResult> {
  const { runtime, state, commandId } = input;
  const evidence = await extractEvidence({
    runtime,
    state,
    invocationId: `${commandId}:evidence`,
    timeoutMs: input.timeoutMs ?? 60_000,
    canaries: input.canaries ?? [],
  });
  return { events: [], updatedState: state, evidence };
}

export const evidenceInvoke: NodeHandler<EvidenceInvokeInput> = {
  definition: {
    id: "evidence.invoke",
    phase: "DISCOVERY",
    kind: "agent",
    contextPolicy: { role: "evidence_tracker" },
    failurePolicy: { failureClass: "TRANSIENT_RUNTIME", retry: true, maxAttempts: 3 },
  },
  run: runEvidenceInvoke,
};
