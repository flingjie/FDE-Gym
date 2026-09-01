import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { RunEvent } from "../../../core/domain.js";
import type { CustomerTurn } from "../../../agents/customer.js";
import { validateCustomerOutput } from "../../../agents/output-validation.js";
import { buildRoleInput } from "../../../security/context-firewall.js";
import type { CustomerCapsule } from "../../../scenarios/schema.js";
import { NodeGuardError, foldReply } from "./shared.js";

/**
 * `customer.project` — sanitize/validate + project the customer reply
 * (deterministic).
 *
 * Re-runs the domain validation tail (`validateCustomerOutput`) against the
 * firewall-built customer input as defense-in-depth (throws
 * `AGENT_OUTPUT_DOMAIN_INVALID` on a fabricated stakeholder/disclosure unit),
 * then authors `customer.replied` and folds the turn into the aggregate
 * (transcript + disclosure ledger; clears `pendingQuestion`). Mirrors step 3 of
 * `prepareDiscoveryTurn`.
 *
 * Protocol: `EVENT_PROTOCOLS.ask` (required `customer.replied`).
 */
export interface CustomerProjectInput {
  /** The ask-gated aggregate; must still carry `pendingQuestion`. */
  state: RunAggregate;
  capsule: CustomerCapsule;
  /** The already-sanitized turn produced by `customer.invoke`. */
  turn: CustomerTurn;
  commandId: string;
}

export async function runCustomerProject(input: CustomerProjectInput): Promise<NodeExecution> {
  const { state, capsule, turn, commandId } = input;

  const built = buildRoleInput("customer", state, capsule);
  if (built.kind !== "customer") {
    throw new NodeGuardError("FIREWALL_CUSTOMER_INVALID", "customer project built the wrong role");
  }
  // Defense-in-depth: re-validate the sanitized turn's domain references.
  validateCustomerOutput(built.input, turn);

  const event: RunEvent = {
    type: "customer.replied",
    runId: state.runId,
    commandId,
    questionId: commandId,
    reply: turn.reply,
    stakeholderId: turn.stakeholderId,
    disclosedDisclosureUnitIds: turn.disclosedDisclosureUnitIds,
  };
  return { events: [event], updatedState: foldReply(state, turn, commandId) };
}

export const customerProject: NodeHandler<CustomerProjectInput> = {
  definition: {
    id: "customer.project",
    phase: "DISCOVERY",
    kind: "deterministic",
    failurePolicy: { failureClass: "DOMAIN_REJECTION", retry: false },
  },
  run: runCustomerProject,
};
