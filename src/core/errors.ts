import type { RunPhase } from "./domain.js";

/**
 * Stable error codes for the deterministic control plane. Errors expose only a
 * machine-readable `code` plus structural (non-sensitive) context — never
 * scenario, customer, evaluator, or brief content.
 */

export const INVALID_PHASE_COMMAND = "INVALID_PHASE_COMMAND" as const;
export const EVENT_CHAIN_INVALID = "EVENT_CHAIN_INVALID" as const;
export const RUN_NOT_FOUND = "RUN_NOT_FOUND" as const;
export const RUN_ALREADY_EXISTS = "RUN_ALREADY_EXISTS" as const;
/** Reserved for the Task 12 schema-v1 freeze; not emitted by Task 4. */
export const UNSUPPORTED_SCHEMA_VERSION = "UNSUPPORTED_SCHEMA_VERSION" as const;

export type FdeErrorCode =
  | typeof INVALID_PHASE_COMMAND
  | typeof EVENT_CHAIN_INVALID
  | typeof RUN_NOT_FOUND
  | typeof RUN_ALREADY_EXISTS
  | typeof UNSUPPORTED_SCHEMA_VERSION;

/** Base class for all FDE Gym errors. The `code` field is the stable contract. */
export class FdeError extends Error {
  readonly code: FdeErrorCode;
  constructor(code: FdeErrorCode, message: string) {
    super(message);
    this.name = "FdeError";
    this.code = code;
  }
}

/** A command was issued in a phase where it is not allowed. */
export class InvalidPhaseCommandError extends FdeError {
  readonly commandType: string;
  readonly phase: RunPhase | null;
  constructor(commandType: string, phase: RunPhase | null) {
    super(INVALID_PHASE_COMMAND, `${commandType} is not valid in phase ${phase ?? "UNSTARTED"}`);
    this.name = "InvalidPhaseCommandError";
    this.commandType = commandType;
    this.phase = phase;
  }
}

/** A recorded event failed hash-chain verification on load. */
export class EventChainInvalidError extends FdeError {
  constructor(message: string) {
    super(EVENT_CHAIN_INVALID, message);
    this.name = "EventChainInvalidError";
  }
}

/** The requested run has no committed events. */
export class RunNotFoundError extends FdeError {
  readonly runId: string;
  constructor(runId: string) {
    super(RUN_NOT_FOUND, `run not found: ${runId}`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

/** `start` was issued for a run that has already been started. */
export class RunAlreadyExistsError extends FdeError {
  readonly runId: string;
  constructor(runId: string) {
    super(RUN_ALREADY_EXISTS, `run already started: ${runId}`);
    this.name = "RunAlreadyExistsError";
    this.runId = runId;
  }
}
