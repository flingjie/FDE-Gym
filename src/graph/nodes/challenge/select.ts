import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { CustomerCapsule, ScenarioEventCandidate } from "../../../scenarios/schema.js";
import { selectScenarioEvents } from "../../../simulation/event-scheduler.js";
import type { EventTriggerContext } from "../../../simulation/event-scheduler.js";
import type { Rng } from "../../../simulation/rng.js";
import { buildTriggerContext } from "./shared.js";

/**
 * `challenge.select` — select the deterministic challenge wave (deterministic).
 *
 * Builds the trigger-context snapshot and runs `selectScenarioEvents` with the
 * run's seeded `Rng`: the SELECTED SET is fully determined by scenario +
 * context (sort-stabilized by id), and only the ORDER is seeded. The node
 * produces NO events — the selected candidates are carried in the result for
 * `challenge.inject` to author `challenge.injected` + interruptions. Mirrors the
 * selection half of `prepareChallengeInjection`.
 */
export interface ChallengeSelectInput {
  /** Aggregate; `phase` must be CHALLENGE. */
  state: RunAggregate;
  capsule: CustomerCapsule;
  /** The scenario's authored event candidates (challenge/constraint changes). */
  candidates: readonly ScenarioEventCandidate[];
  rng: Rng;
}

export interface ChallengeSelectResult extends NodeExecution {
  /** The trigger-context snapshot the selection was computed against. */
  context: EventTriggerContext;
  /** The fired candidates, sorted by id then deterministically shuffled by `rng`. */
  selected: ScenarioEventCandidate[];
}

export async function runChallengeSelect(input: ChallengeSelectInput): Promise<ChallengeSelectResult> {
  const { state, capsule, candidates, rng } = input;
  const context = buildTriggerContext(state, capsule);
  const selected = selectScenarioEvents(candidates, context, rng);
  return { events: [], updatedState: state, context, selected };
}

export const challengeSelect: NodeHandler<ChallengeSelectInput> = {
  definition: {
    id: "challenge.select",
    phase: "CHALLENGE",
    kind: "deterministic",
  },
  run: runChallengeSelect,
};
