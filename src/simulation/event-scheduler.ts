import type { RunPhase } from "../core/domain.js";
import type { EventTrigger, ScenarioEventCandidate } from "../scenarios/schema.js";
import type { Rng } from "./rng.js";

/**
 * FDE Gym — deterministic scenario-event scheduler.
 *
 * `selectScenarioEvents` chooses which `ScenarioEventCandidate`s fire given a
 * snapshot of the run, using the run's seeded `Rng`. It is PURE: no wall-clock,
 * no I/O, no `Math.random`, and it does not mutate its inputs or the `rng`'s
 * seed (it only advances the rng's sequence).
 *
 * The trigger context is a caller-supplied snapshot of exactly the five
 * dimensions the trigger kinds can observe:
 *   - `phase`                 → `on_stage_enter`
 *   - `questionCount`         → `after_question_count`
 *   - `revealedEvidenceIds`   → `after_evidence_revealed`
 *   - `unresolvedContradictionIds` → `if_contradiction_unresolved`
 *   - `challengeResponseCount` → `after_challenge_response_count`
 *
 * Count-based triggers fire once their count has been REACHED OR EXCEEDED
 * (`>=`), matching the "after N …" semantics; membership triggers fire on
 * exact id membership.
 */

export interface EventTriggerContext {
  phase: RunPhase | null;
  questionCount: number;
  revealedEvidenceIds: readonly string[];
  unresolvedContradictionIds: readonly string[];
  challengeResponseCount: number;
}

/** Whether a single trigger fires against the given context snapshot. */
export function triggerFires(trigger: EventTrigger, context: EventTriggerContext): boolean {
  switch (trigger.kind) {
    case "on_stage_enter":
      return context.phase === trigger.phase;
    case "after_question_count":
      return context.questionCount >= trigger.count;
    case "after_evidence_revealed":
      return context.revealedEvidenceIds.includes(trigger.evidenceId);
    case "if_contradiction_unresolved":
      return context.unresolvedContradictionIds.includes(trigger.contradictionId);
    case "after_challenge_response_count":
      return context.challengeResponseCount >= trigger.count;
  }
}

/**
 * SELECTION RULE (documented; the determinism contract):
 *
 *   1. FILTER — keep only candidates whose trigger fires given the context.
 *      A candidate whose trigger does not fire is NEVER selected.
 *
 *   2. STABILIZE — sort the fired candidates by `id` (lexicographic, `a < b`).
 *      This makes the SELECTED SET fully determined by scenario + context,
 *      independent of the seed.
 *
 *   3. SHUFFLE — deterministically reorder that stable list with a Fisher–Yates
 *      pass driven by the seeded `rng` (only `nextInt` is consumed).
 *
 * Therefore: same scenario + seed + trigger context → identical ids in
 * identical order (the ORDER is seeded; the SET is not). Model wording of the
 * candidate prompts is explicitly OUT OF SCOPE of this guarantee.
 */
export function selectScenarioEvents(
  candidates: readonly ScenarioEventCandidate[],
  context: EventTriggerContext,
  rng: Rng,
): ScenarioEventCandidate[] {
  const fired = candidates.filter((candidate) => triggerFires(candidate.trigger, context));

  const sorted = [...fired].sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const result = [...sorted];
  for (let i = result.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}
