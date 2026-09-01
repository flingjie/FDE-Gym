import type { ActionId } from "./action-types.js";
import type { EventProtocolSpec } from "./protocol-types.js";

/**
 * FDE Gym — event protocol registry (Phase 0.5).
 *
 * One `EventProtocolSpec` per action, declared in a single place. `phase-spec.ts`
 * references these by name, and the Phase 1 batch validator (G1-01) will check
 * every committed event batch against the protocol for its action. Protocols are
 * the ONLY place the ordered event batches are spelled out — no second map.
 */

/** `start`: run.started + the SCENARIO→SCENARIO anchor. (Auto-accept follows on `accept`.) */
export const START_PROTOCOL: EventProtocolSpec = {
  required: ["run.started", "phase.changed"],
  ordered: true,
};

/** `accept`: the SCENARIO→DISCOVERY hop, auto-issued inside `start`/`retry`. */
export const ACCEPT_PROTOCOL: EventProtocolSpec = {
  required: ["phase.changed"],
  ordered: true,
};

/**
 * `ask`: question + reply, then either the evidence patch (success) or the
 * durable pending marker (evidence-tracker failure).
 */
export const ASK_PROTOCOL: EventProtocolSpec = {
  required: ["question.asked", "customer.replied"],
  optional: ["evidence.patched", "question.assessed", "evidence.pending"],
  ordered: true,
};

export const FRAME_PROTOCOL: EventProtocolSpec = {
  required: ["phase.changed"],
  ordered: true,
};

export const HINT_PROTOCOL: EventProtocolSpec = {
  required: ["hint.granted"],
  ordered: true,
};

/** `submit-brief`: the phase.changed only appears when the gate passes. */
export const SUBMIT_BRIEF_PROTOCOL: EventProtocolSpec = {
  required: ["brief.submitted", "brief.validated"],
  optional: ["phase.changed"],
  ordered: true,
};

export const CLARIFY_PROTOCOL: EventProtocolSpec = {
  required: ["phase.changed"],
  ordered: true,
};

/**
 * `submit-design`: the design + the SOLUTION_DESIGN→CHALLENGE hop, followed by
 * the deterministic challenge wave (challenge.injected + interruption turns)
 * bundled into the same transaction.
 */
export const SUBMIT_DESIGN_PROTOCOL: EventProtocolSpec = {
  required: ["design.submitted", "phase.changed"],
  optional: ["challenge.injected", "customer.replied"],
  ordered: true,
};

/** `respond-challenge`: the phase.changed only appears when every mandatory challenge is answered. */
export const RESPOND_CHALLENGE_PROTOCOL: EventProtocolSpec = {
  required: ["challenge.responded"],
  optional: ["phase.changed"],
  ordered: true,
};

export const SUBMIT_PITCH_PROTOCOL: EventProtocolSpec = {
  required: ["pitch.submitted", "phase.changed"],
  ordered: true,
};

export const REVIEW_PROTOCOL: EventProtocolSpec = {
  required: ["review.completed", "score.computed"],
  ordered: true,
};

/** `retry` (step 1): retry.started + the REVIEW→RETRY_READY hop on the parent. */
export const RETRY_PROTOCOL: EventProtocolSpec = {
  required: ["retry.started", "phase.changed"],
  ordered: true,
};

/**
 * `start-retry` (step 2): emits NO parent events — the parent rests at
 * RETRY_READY while the child run's own log receives `run.started`,
 * `retry.focus`, and the SCENARIO→DISCOVERY accept.
 */
export const START_RETRY_PROTOCOL: EventProtocolSpec = {
  required: [],
  ordered: true,
};

export const COMPLETE_PROTOCOL: EventProtocolSpec = {
  required: ["run.completed", "phase.changed"],
  ordered: true,
};

export const ABORT_PROTOCOL: EventProtocolSpec = {
  required: ["run.aborted", "phase.changed"],
  ordered: true,
};

/** The queryable registry: one protocol per action, in a stable order. */
export const EVENT_PROTOCOLS: Readonly<Record<ActionId, EventProtocolSpec>> = {
  start: START_PROTOCOL,
  accept: ACCEPT_PROTOCOL,
  ask: ASK_PROTOCOL,
  frame: FRAME_PROTOCOL,
  hint: HINT_PROTOCOL,
  "submit-brief": SUBMIT_BRIEF_PROTOCOL,
  clarify: CLARIFY_PROTOCOL,
  "submit-design": SUBMIT_DESIGN_PROTOCOL,
  "respond-challenge": RESPOND_CHALLENGE_PROTOCOL,
  "submit-pitch": SUBMIT_PITCH_PROTOCOL,
  review: REVIEW_PROTOCOL,
  retry: RETRY_PROTOCOL,
  "start-retry": START_RETRY_PROTOCOL,
  complete: COMPLETE_PROTOCOL,
  abort: ABORT_PROTOCOL,
};

export function protocolFor(action: ActionId): EventProtocolSpec {
  return EVENT_PROTOCOLS[action];
}
