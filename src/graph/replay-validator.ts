import type { RunEvent, RunPhase } from "../core/domain.js";
import { ReplayInvalidError } from "../core/errors.js";
import { isLegalPhaseTransition } from "./phase-spec.js";

/**
 * FDE Gym — strict replay validation (G1-02).
 *
 * A pure, side-effect-free check that a committed event stream is a legal phase
 * path. Called before folding (see `foldRunAggregate` in `src/replay/projector.ts`)
 * so an illegal log fails closed instead of being silently folded:
 *
 *   - phase continuity: each `phase.changed.from` must equal the running phase,
 *     starting from the unstarted state. The byte-stable `SCENARIO → SCENARIO`
 *     start anchor is the one permitted exception.
 *   - illegal transition: each `from → to` must be in `PHASE_TRANSITIONS`.
 *   - terminal-after: no event may follow once the run reaches COMPLETED/ABORTED.
 *
 * Deterministic: no wall-clock, no randomness, no model.
 */
export function validatePhaseContinuity(events: readonly RunEvent[]): void {
  let phase: RunPhase | null = null;
  for (const event of events) {
    if (phase === "COMPLETED" || phase === "ABORTED") {
      throw new ReplayInvalidError(`event after terminal phase ${phase}`);
    }
    if (event.type !== "phase.changed") continue;
    const { from, to } = event;

    // The start anchor: the first phase.changed from the unstarted state is the
    // byte-stable SCENARIO → SCENARIO self-loop (`buildRunStartedEvents`).
    if (phase === null && from === "SCENARIO" && to === "SCENARIO") {
      phase = "SCENARIO";
      continue;
    }

    if (from !== phase) {
      throw new ReplayInvalidError(
        `phase continuity broken: expected ${phase ?? "UNSTARTED"}, got ${from}`,
      );
    }
    if (!isLegalPhaseTransition(from, to)) {
      throw new ReplayInvalidError(`illegal phase transition ${from} → ${to}`);
    }
    phase = to;
  }
}
