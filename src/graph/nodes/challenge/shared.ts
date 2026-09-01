import type { ChallengeResponse, LocalizedText, RunEvent } from "../../../core/domain.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { CustomerCapsule } from "../../../scenarios/schema.js";
import type { EventTriggerContext } from "../../../simulation/event-scheduler.js";

/**
 * FDE Gym — shared helpers for the CHALLENGE subgraph (G3-03).
 *
 * These mirror the small deterministic helpers inlined in
 * `prepareChallengeInjection` / `prepareRespondToChallenge` WITHOUT importing the
 * orchestrator (to avoid a cycle): the learner-visible interruption shape, the
 * trigger-context snapshot, and the `challenge.responded` event builder. The
 * `NodeGuardError` class has the same shape as the DISCOVERY subgraph's, so each
 * subgraph stays self-contained.
 */

/** The learner-visible interruption (mirrors `orchestrator.ChallengeInterruption`). */
export type ChallengeInterruption = {
  challengeId: string;
  /** The learner-visible interruption text — exactly the scenario's `prompt`. */
  reply: LocalizedText;
  stakeholderId: string;
};

/**
 * A guard node's rejection. Guard NODES (unlike the pure predicates in
 * `guards.ts`) gate execution by throwing; the graph runtime maps the throw to
 * the node's declared `failurePolicy`.
 */
export class NodeGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NodeGuardError";
    this.code = code;
  }
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Build the scheduler's trigger-context snapshot from the public aggregate +
 * the customer capsule (mirrors the orchestrator's `buildTriggerContext`). All
 * ids are PUBLIC identifiers only:
 *   - `revealedEvidenceIds`    = the `evidenceId` of every disclosed disclosure unit;
 *   - `unresolvedContradictionIds` = ids of `active` `contradiction`-kind graph nodes;
 *   - `questionCount`          = number of public transcript turns;
 *   - `challengeResponseCount` = responses already recorded.
 */
export function buildTriggerContext(state: RunAggregate, capsule: CustomerCapsule): EventTriggerContext {
  const disclosed = new Set(state.disclosedDisclosureUnitIds);
  const revealedEvidenceIds = dedupe(
    capsule.disclosureUnits
      .filter((unit) => disclosed.has(unit.id))
      .map((unit) => unit.evidenceId),
  );
  const unresolvedContradictionIds = state.graph.nodes
    .filter((node) => node.kind === "contradiction" && node.status === "active")
    .map((node) => node.id);
  return {
    phase: state.phase,
    questionCount: state.transcript.length,
    revealedEvidenceIds,
    unresolvedContradictionIds,
    challengeResponseCount: state.challengeResponses.length,
  };
}

/**
 * Build the `challenge.responded` event for a response (mirrors the
 * orchestrator's `respondEvent`). Deterministic: no validation here — the
 * membership guard validates via `reduceInjectedChallenges` before this event is
 * committed by `challenge.wait` / `pitch.prepare`.
 */
export function buildRespondEvent(
  state: RunAggregate,
  commandId: string,
  response: ChallengeResponse,
): RunEvent {
  return { type: "challenge.responded", runId: state.runId, commandId, response };
}
