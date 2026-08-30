import type { RunCommand, RunEvent, RunPhase } from "./domain.js";
import { InvalidPhaseCommandError, RunAlreadyExistsError } from "./errors.js";

/**
 * Phases in which a run is "active" (i.e. `abort` is legal). Terminal phases
 * (COMPLETED, ABORTED) and the pristine unstarted state are excluded.
 */
const ACTIVE_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  "SCENARIO",
  "DISCOVERY",
  "PROBLEM_FRAMING",
  "SOLUTION_DESIGN",
  "CHALLENGE",
  "PITCH",
  "REVIEW",
  "RETRY_READY",
]);

/**
 * Phase legality only — emits NO events and performs NO model I/O. Throws the
 * stable cross-phase error (or `RUN_ALREADY_EXISTS` for a re-`start`) when a
 * command is not legal in the current phase.
 *
 * Event authorship lives in the `prepare*` functions (and the thin event
 * helpers below for the simple `start`/`accept`/`frame` transitions); this
 * function is the single source of truth for what phase each command requires.
 */
export function assertCommandPhase(
  phase: RunPhase | null,
  commandType: RunCommand["type"],
): void {
  switch (commandType) {
    case "start": {
      // No runId reaches this pure phase assert; the store boundary throws the
      // real `RunAlreadyExistsError(runId)` on a persisted re-`start`.
      if (phase !== null) throw new RunAlreadyExistsError("");
      return;
    }
    case "accept":
      requirePhase(phase, "SCENARIO", commandType);
      return;
    case "ask":
      requirePhase(phase, "DISCOVERY", commandType);
      return;
    case "frame":
      requirePhase(phase, "DISCOVERY", commandType);
      return;
    case "hint": {
      if (phase !== "DISCOVERY" && phase !== "PROBLEM_FRAMING") {
        throw new InvalidPhaseCommandError(commandType, phase);
      }
      return;
    }
    case "submit-brief":
      requirePhase(phase, "PROBLEM_FRAMING", commandType);
      return;
    case "clarify":
      requirePhase(phase, "PROBLEM_FRAMING", commandType);
      return;
    case "submit-design":
      requirePhase(phase, "SOLUTION_DESIGN", commandType);
      return;
    case "respond-challenge":
      requirePhase(phase, "CHALLENGE", commandType);
      return;
    case "submit-pitch":
      requirePhase(phase, "PITCH", commandType);
      return;
    case "review":
      requirePhase(phase, "REVIEW", commandType);
      return;
    case "retry":
      requirePhase(phase, "REVIEW", commandType);
      return;
    case "start-retry":
      requirePhase(phase, "RETRY_READY", commandType);
      return;
    case "complete":
      requirePhase(phase, "REVIEW", commandType);
      return;
    case "abort": {
      if (phase === null || !ACTIVE_PHASES.has(phase)) {
        throw new InvalidPhaseCommandError(commandType, phase);
      }
      return;
    }
    default: {
      const exhaustive: never = commandType;
      throw new Error(`unhandled command type: ${(exhaustive as { type?: string }).type}`);
    }
  }
}

function requirePhase(actual: RunPhase | null, expected: RunPhase, commandType: string): void {
  if (actual !== expected) throw new InvalidPhaseCommandError(commandType, actual);
}

/**
 * The `start` command's event batch: `run.started` (carrying the optional
 * verified scenario-bundle digest) plus the anchor `phase.changed`
 * (SCENARIO -> SCENARIO). Byte-stable with the earlier event shape.
 */
export function buildRunStartedEvents(
  runId: string,
  command: Extract<RunCommand, { type: "start" }>,
): RunEvent[] {
  const started: RunEvent =
    command.scenarioBundleDigest !== undefined
      ? {
          type: "run.started",
          runId,
          commandId: command.commandId,
          scenarioId: command.scenarioId,
          locale: command.locale,
          scenarioBundleDigest: command.scenarioBundleDigest,
        }
      : {
          type: "run.started",
          runId,
          commandId: command.commandId,
          scenarioId: command.scenarioId,
          locale: command.locale,
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
