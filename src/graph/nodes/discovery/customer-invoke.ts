import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { AgentRuntime } from "../../../agents/agent-runtime.js";
import { answerDiscoveryQuestion, type CustomerTurn } from "../../../agents/customer.js";
import type { CustomerCapsule } from "../../../scenarios/schema.js";

/**
 * `customer.invoke` — invoke the Customer role (agent).
 *
 * Delegates to `answerDiscoveryQuestion`, which builds the strict customer
 * input through the context firewall, invokes the `AgentRuntime` under the
 * `customer` role, sanitizes against the capsule canary, and domain-validates.
 * The node produces NO events; the sanitized `CustomerTurn` is carried in the
 * result for `customer.project` to author `customer.replied` and fold.
 *
 * Protocol: `EVENT_PROTOCOLS.ask` (the `customer.replied` event is authored by
 * `customer.project`).
 */
export interface CustomerInvokeInput {
  runtime: AgentRuntime;
  /** Must carry `pendingQuestion` (the firewall requires it). */
  state: RunAggregate;
  capsule: CustomerCapsule;
  commandId: string;
  timeoutMs?: number;
  canaries?: readonly string[];
}

export interface CustomerInvokeResult extends NodeExecution {
  /** The sanitized, schema- and domain-validated customer turn. */
  turn: CustomerTurn;
}

export async function runCustomerInvoke(input: CustomerInvokeInput): Promise<CustomerInvokeResult> {
  const { runtime, state, capsule, commandId } = input;
  const turn = await answerDiscoveryQuestion({
    runtime,
    state,
    capsule,
    invocationId: `${commandId}:customer`,
    timeoutMs: input.timeoutMs ?? 60_000,
    canaries: input.canaries ?? [capsule.canary],
  });
  return { events: [], updatedState: state, turn };
}

export const customerInvoke: NodeHandler<CustomerInvokeInput> = {
  definition: {
    id: "customer.invoke",
    phase: "DISCOVERY",
    kind: "agent",
    contextPolicy: { role: "customer", capsule: "customer" },
    failurePolicy: { failureClass: "TRANSIENT_RUNTIME", retry: true, maxAttempts: 3 },
  },
  run: runCustomerInvoke,
};
