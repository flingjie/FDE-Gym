import type { RunEvent, RunPhase } from "./domain.js";

/**
 * The plain run aggregate rebuilt by folding events. Kept minimal: the current
 * `phase`, the `runId` anchor, and the number of applied events (`seq`).
 * `phase` is `null` until the first `phase.changed` lands.
 */
export interface RunState {
  runId: string;
  phase: RunPhase | null;
  seq: number;
}

/** The pristine state a run starts from (orchestrator supplies the fresh runId). */
export function createInitialRunState(runId: string): RunState {
  return { runId, phase: null, seq: 0 };
}

/**
 * Pure event fold. No wall-clock, no randomness. Deterministic: the same event
 * sequence always produces the same state. Only `run.started` and
 * `phase.changed` mutate fields; every other event is a domain fact that
 * advances `seq` (its payload is consumed by later tasks).
 */
export function reduce(state: RunState, event: RunEvent): RunState {
  let runId = state.runId;
  let phase = state.phase;
  if (event.type === "run.started") runId = event.runId;
  if (event.type === "phase.changed") phase = event.to;
  return { runId, phase, seq: state.seq + 1 };
}

/**
 * Canonical serialization of a run state (fixed key order). This is the
 * byte-identity contract the determinism tests assert against.
 */
export function canonicalRunState(state: RunState): string {
  return JSON.stringify({ runId: state.runId, phase: state.phase, seq: state.seq });
}
