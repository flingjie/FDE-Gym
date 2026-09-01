import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { RunEvent } from "../../../core/domain.js";
import type { CustomerCapsule, ScenarioEventCandidate } from "../../../scenarios/schema.js";
import { reduceInjectedChallenges } from "../../challenge-state.js";
import type { ChallengeInterruption } from "./shared.js";

/**
 * `challenge.inject` — inject the selected challenge wave (deterministic).
 *
 * Drops candidates already injected in an earlier wave, then for each selected
 * candidate emits `challenge.injected` (the authoritative record carrying the
 * scenario's `prompt`) BEFORE the learner-visible `customer.replied` interruption
 * (whose `reply` is verbatim the scenario's `prompt`, attributed to the capsule's
 * first stakeholder), and folds each into `injectedChallenges`. The run stays in
 * CHALLENGE (no `phase.changed` here). Mirrors the injection half of
 * `prepareChallengeInjection`.
 *
 * Protocol: `EVENT_PROTOCOLS["submit-design"]` (optional `challenge.injected` +
 * `customer.replied`).
 */
export interface ChallengeInjectionInput {
  /** Aggregate; `phase` must be CHALLENGE. */
  state: RunAggregate;
  capsule: CustomerCapsule;
  /** The wave selected by `challenge.select`. */
  selected: readonly ScenarioEventCandidate[];
  commandId: string;
}

export interface ChallengeInjectionResult extends NodeExecution {
  /** The ids actually injected this wave (already-injected candidates excluded). */
  injectedChallengeIds: string[];
  /** One learner-visible interruption per injected challenge, in injection order. */
  interruptions: ChallengeInterruption[];
}

export async function runChallengeInject(
  input: ChallengeInjectionInput,
): Promise<ChallengeInjectionResult> {
  const { state, capsule, selected, commandId } = input;
  const runId = state.runId;

  const alreadyInjected = new Set((state.injectedChallenges ?? []).map((entry) => entry.id));
  const toInject = selected.filter((candidate) => !alreadyInjected.has(candidate.id));
  const stakeholderId = capsule.stakeholders[0]?.id ?? "customer";

  const events: RunEvent[] = [];
  const interruptions: ChallengeInterruption[] = [];
  for (const candidate of toInject) {
    // 1. The authoritative injected record — persisted first.
    events.push({
      type: "challenge.injected",
      runId,
      commandId,
      challengeId: candidate.id,
      prompt: candidate.prompt,
    });
    // 2. The learner-visible customer interruption (text is the scenario's prompt).
    events.push({
      type: "customer.replied",
      runId,
      commandId,
      questionId: candidate.id,
      reply: candidate.prompt,
      stakeholderId,
      disclosedDisclosureUnitIds: [],
    });
    interruptions.push({ challengeId: candidate.id, reply: candidate.prompt, stakeholderId });
  }

  // Fold the newly-injected challenges into the aggregate so `updatedState`
  // (and a resumed fold) sees them as pending.
  let injectedChallenges = state.injectedChallenges ?? [];
  for (const candidate of toInject) {
    injectedChallenges = reduceInjectedChallenges(injectedChallenges, {
      type: "challenge.injected",
      runId,
      commandId,
      challengeId: candidate.id,
      prompt: candidate.prompt,
    });
  }

  return {
    events,
    updatedState: { ...state, injectedChallenges },
    injectedChallengeIds: toInject.map((candidate) => candidate.id),
    interruptions,
  };
}

export const challengeInject: NodeHandler<ChallengeInjectionInput> = {
  definition: {
    id: "challenge.inject",
    phase: "CHALLENGE",
    kind: "deterministic",
  },
  run: runChallengeInject,
};
