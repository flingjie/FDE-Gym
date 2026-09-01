import type { RunCommand, RunEvent, RunPhase } from "./domain.js";
import { InvalidPhaseCommandError, RunAlreadyExistsError } from "./errors.js";
import { PHASE_EDGES } from "../graph/phase-spec.js";
import { GRAPH_VERSION } from "../graph/fde-graph.js";

/**
 * Phase legality only — emits NO events and performs NO model I/O. Throws the
 * stable cross-phase error (or `RUN_ALREADY_EXISTS` for a re-`start`) when a
 * command is not legal in the current phase.
 *
 * Legality is DERIVED from the phase transition spec (`src/graph/phase-spec.ts`),
 * the single source of truth. This function keeps the stable facade and error
 * codes while delegating the legality table to the Spec — no second transition
 * map is maintained here.
 */
export function assertCommandPhase(
  phase: RunPhase | null,
  commandType: RunCommand["type"],
): void {
  for (const edge of PHASE_EDGES) {
    if (edge.action === commandType && edge.from === phase) return;
  }
  if (commandType === "start") {
    // `start` is the only action whose edge has `from === null`; a non-null
    // phase is a re-`start`, which throws the dedicated (not phase) error.
    throw new RunAlreadyExistsError("");
  }
  throw new InvalidPhaseCommandError(commandType, phase);
}

/**
 * The `start` command's event batch: `run.started` (carrying the graph version
 * the run was started under, plus the optional verified scenario-bundle digest)
 * and the anchor `phase.changed` (SCENARIO -> SCENARIO). Byte-stable with the
 * earlier event shape.
 */
export function buildRunStartedEvents(
  runId: string,
  command: Extract<RunCommand, { type: "start" }>,
): RunEvent[] {
  const started: RunEvent = {
    type: "run.started",
    runId,
    commandId: command.commandId,
    scenarioId: command.scenarioId,
    locale: command.locale,
    graphVersion: GRAPH_VERSION,
    ...(command.scenarioBundleDigest !== undefined
      ? { scenarioBundleDigest: command.scenarioBundleDigest }
      : {}),
  };
  return [started, buildPhaseChangedEvent(runId, command.commandId, "SCENARIO", "SCENARIO")];
}

/** A single `phase.changed` event (the thin transition helper for `accept`/`frame`). */
export function buildPhaseChangedEvent(
  runId: string,
  commandId: string,
  from: RunPhase,
  to: RunPhase,
): RunEvent {
  return { type: "phase.changed", runId, commandId, from, to };
}
