import type { HintLevel, LocalizedText, RunCommand, RunEvent, RunPhase } from "./domain.js";
import { InvalidPhaseCommandError, RunAlreadyExistsError } from "./errors.js";
import type { RunState } from "./reducer.js";

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
 * Pure decision function. Given the current aggregate and a command, return the
 * domain events the command produces — or throw a stable error for a
 * cross-phase illegal command (which emits NO event).
 *
 * Task 4 collapses every cross-phase command to its `phase.changed` success
 * path; the multi-step gating (brief.validated, challenge.injected, etc.) is
 * layered on top by Tasks 5/8/9.
 */
export function decide(state: RunState, command: RunCommand): RunEvent[] {
  const { runId } = state;
  const phase = state.phase;

  switch (command.type) {
    case "start": {
      if (phase !== null) throw new RunAlreadyExistsError(runId);
      return [
        {
          type: "run.started",
          runId,
          commandId: command.commandId,
          scenarioId: command.scenarioId,
          locale: command.locale,
        },
        phaseChanged(runId, command.commandId, "SCENARIO", "SCENARIO"),
      ];
    }
    case "accept": {
      requirePhase(phase, "SCENARIO", command.type);
      return [phaseChanged(runId, command.commandId, "SCENARIO", "DISCOVERY")];
    }
    case "ask": {
      requirePhase(phase, "DISCOVERY", command.type);
      return [
        {
          type: "question.asked",
          runId,
          commandId: command.commandId,
          questionId: command.commandId,
          question: command.question,
        },
      ];
    }
    case "frame": {
      requirePhase(phase, "DISCOVERY", command.type);
      return [phaseChanged(runId, command.commandId, "DISCOVERY", "PROBLEM_FRAMING")];
    }
    case "hint": {
      if (phase !== "DISCOVERY" && phase !== "PROBLEM_FRAMING") {
        throw new InvalidPhaseCommandError(command.type, phase);
      }
      return [
        {
          type: "hint.granted",
          runId,
          commandId: command.commandId,
          topic: command.topic,
          level: command.level,
          hint: hintPlaceholder(command.topic, command.level),
        },
      ];
    }
    case "submit-brief": {
      requirePhase(phase, "PROBLEM_FRAMING", command.type);
      return [phaseChanged(runId, command.commandId, "PROBLEM_FRAMING", "SOLUTION_DESIGN")];
    }
    case "clarify": {
      requirePhase(phase, "PROBLEM_FRAMING", command.type);
      return [phaseChanged(runId, command.commandId, "PROBLEM_FRAMING", "DISCOVERY")];
    }
    case "submit-design": {
      requirePhase(phase, "SOLUTION_DESIGN", command.type);
      return [phaseChanged(runId, command.commandId, "SOLUTION_DESIGN", "CHALLENGE")];
    }
    case "respond-challenge": {
      requirePhase(phase, "CHALLENGE", command.type);
      return [phaseChanged(runId, command.commandId, "CHALLENGE", "PITCH")];
    }
    case "submit-pitch": {
      requirePhase(phase, "PITCH", command.type);
      return [phaseChanged(runId, command.commandId, "PITCH", "REVIEW")];
    }
    case "review": {
      requirePhase(phase, "REVIEW", command.type);
      return []; // Task 9 adds review.completed once the Coach result is available.
    }
    case "retry": {
      requirePhase(phase, "REVIEW", command.type);
      return [phaseChanged(runId, command.commandId, "REVIEW", "RETRY_READY")];
    }
    case "start-retry": {
      requirePhase(phase, "RETRY_READY", command.type);
      return [phaseChanged(runId, command.commandId, "RETRY_READY", "DISCOVERY")];
    }
    case "complete": {
      requirePhase(phase, "REVIEW", command.type);
      return [
        phaseChanged(runId, command.commandId, "REVIEW", "COMPLETED"),
        { type: "run.completed", runId, commandId: command.commandId },
      ];
    }
    case "abort": {
      if (phase === null || !ACTIVE_PHASES.has(phase)) {
        throw new InvalidPhaseCommandError(command.type, phase);
      }
      const aborted: RunEvent =
        command.reason !== undefined
          ? { type: "run.aborted", runId, commandId: command.commandId, reason: command.reason }
          : { type: "run.aborted", runId, commandId: command.commandId };
      return [phaseChanged(runId, command.commandId, phase, "ABORTED"), aborted];
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`unhandled command type: ${(exhaustive as { type?: string }).type}`);
    }
  }
}

function requirePhase(actual: RunPhase | null, expected: RunPhase, commandType: string): void {
  if (actual !== expected) throw new InvalidPhaseCommandError(commandType, actual);
}

function phaseChanged(runId: string, commandId: string, from: RunPhase, to: RunPhase): RunEvent {
  return { type: "phase.changed", runId, commandId, from, to };
}

/**
 * Task 4 placeholder for the real hint text. The hint ladder lives in the
 * scenario (Task 8 resolves topic+level -> LocalizedText); `decide` is pure and
 * the `hint` command carries only topic+level, so we emit a deterministic
 * placeholder that Task 8 replaces with the ladder's actual copy.
 */
function hintPlaceholder(topic: string, level: HintLevel): LocalizedText {
  return {
    "zh-CN": `提示（${topic}，级别 ${level}）`,
    "en-US": `Hint (${topic}, level ${level})`,
  };
}
