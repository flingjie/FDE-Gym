import type { RunEvent, RunPhase } from "./domain.js";
import { EventBatchInvalidError } from "./errors.js";
import { isLegalPhaseTransition } from "../graph/phase-spec.js";

/**
 * FDE Gym — event batch semantic validator (G1-01).
 *
 * Rejects a command's prepared event batch BEFORE it is journaled, so an illegal
 * batch can never reach the event log. Called from `executeCommandTransaction`
 * right after `prepare()` and before the prepared journal is written.
 *
 * Checks (the write-path counterpart to `validatePhaseContinuity` in G1-02):
 *   - every event carries the expected `runId` (no mixed-run batch);
 *   - every `phase.changed` is a legal transition (`PHASE_TRANSITIONS`) and the
 *     batch's own phase.changed events form a contiguous chain;
 *   - no event follows a terminal phase within the batch.
 *
 * Deliberately does NOT check command ownership: `repair-evidence` legitimately
 * re-runs the evidence extraction under the ORIGINAL `ask` command id (not the
 * repair command id), so a batch's events may be owned by a different command.
 *
 * Note: the run-lifecycle invariant (a run's stream opens with `run.started`)
 * and the full-stream phase continuity are STREAM-level concerns enforced by the
 * replay validator (G1-02) at `loadRun`, not here — the transaction journals any
 * command and cannot assume it is the run's first.
 */
export interface EventBatchInput {
  events: readonly RunEvent[];
  expectedRunId: string;
}

export function validateEventBatch({ events, expectedRunId }: EventBatchInput): void {
  let phase: RunPhase | null = null;
  let sawPhaseChanged = false;
  for (const event of events) {
    if (event.runId !== expectedRunId) {
      throw new EventBatchInvalidError(`event runId ${event.runId} does not match ${expectedRunId}`);
    }
    if (phase === "COMPLETED" || phase === "ABORTED") {
      throw new EventBatchInvalidError(`event after terminal phase ${phase}`);
    }
    if (event.type !== "phase.changed") continue;

    const { from, to } = event;
    if (sawPhaseChanged && from !== phase) {
      throw new EventBatchInvalidError(`phase continuity broken within batch: expected ${phase}, got ${from}`);
    }
    if (!isLegalPhaseTransition(from, to)) {
      throw new EventBatchInvalidError(`illegal phase transition ${from} → ${to}`);
    }
    phase = to;
    sawPhaseChanged = true;
  }
}
