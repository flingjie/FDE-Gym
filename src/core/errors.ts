import { FDE_SCHEMA_VERSION, type RunPhase } from "./domain.js";

/**
 * Stable error codes for the deterministic control plane. Errors expose only a
 * machine-readable `code` plus structural (non-sensitive) context — never
 * scenario, customer, evaluator, or brief content.
 */

export const INVALID_PHASE_COMMAND = "INVALID_PHASE_COMMAND" as const;
export const EVENT_CHAIN_INVALID = "EVENT_CHAIN_INVALID" as const;
export const RUN_NOT_FOUND = "RUN_NOT_FOUND" as const;
export const RUN_ALREADY_EXISTS = "RUN_ALREADY_EXISTS" as const;
/** A command id was re-issued with a different canonical request than the journal recorded. */
export const COMMAND_ID_CONFLICT = "COMMAND_ID_CONFLICT" as const;
/** A command journal's content contains a hidden canary value; rejected without persisting it. */
export const JOURNAL_CANARY_LEAK = "JOURNAL_CANARY_LEAK" as const;
/** A run/scenario/command id is unsafe to use as a filename component. */
export const INVALID_RESOURCE_ID = "INVALID_RESOURCE_ID" as const;
/** Another process (live owner) holds the run's exclusive writer lock. */
export const RUN_LOCKED = "RUN_LOCKED" as const;
/** Reserved for the Task 12 schema-v1 freeze; not emitted by Task 4. */
export const UNSUPPORTED_SCHEMA_VERSION = "UNSUPPORTED_SCHEMA_VERSION" as const;
/** A role output passed Zod/sanitizer but references an entity absent from its input. */
export const AGENT_OUTPUT_DOMAIN_INVALID = "AGENT_OUTPUT_DOMAIN_INVALID" as const;
/** A compiled scenario bundle failed integrity verification (hash/byte/digest/id/descriptor). */
export const SCENARIO_BUNDLE_INVALID = "SCENARIO_BUNDLE_INVALID" as const;
/** The current scenario bundle's digest differs from the one a run was started against. */
export const SCENARIO_BUNDLE_MISMATCH = "SCENARIO_BUNDLE_MISMATCH" as const;
/** A command's prepared plan is stale: the run's event-log head moved between prepare and commit. */
export const RUN_VERSION_CONFLICT = "RUN_VERSION_CONFLICT" as const;
/** A command's event batch violates the graph semantics (illegal transition, mixed ids, …) — rejected before journal. */
export const EVENT_BATCH_INVALID = "EVENT_BATCH_INVALID" as const;
/** A committed event log violates the graph semantics (broken phase continuity, illegal transition, terminal-after) — fail closed. */
export const REPLAY_INVALID = "REPLAY_INVALID" as const;

// Standalone stable codes thrown by `OrchestratorError` (a plain-string error,
// not an `FdeError` subclass). Kept here so the orchestrator and the graph guard
// registry share one definition rather than duplicating the literal.
/** Evidence extraction is pending; `frame` is blocked until it is repaired. */
export const FRAME_BLOCKED = "FRAME_BLOCKED" as const;
/** The clarification budget is exhausted. */
export const CLARIFICATION_BUDGET_EXCEEDED = "CLARIFICATION_BUDGET_EXCEEDED" as const;

export type FdeErrorCode =
  | typeof INVALID_PHASE_COMMAND
  | typeof EVENT_CHAIN_INVALID
  | typeof RUN_NOT_FOUND
  | typeof RUN_ALREADY_EXISTS
  | typeof COMMAND_ID_CONFLICT
  | typeof JOURNAL_CANARY_LEAK
  | typeof INVALID_RESOURCE_ID
  | typeof RUN_LOCKED
  | typeof UNSUPPORTED_SCHEMA_VERSION
  | typeof AGENT_OUTPUT_DOMAIN_INVALID
  | typeof SCENARIO_BUNDLE_INVALID
  | typeof SCENARIO_BUNDLE_MISMATCH
  | typeof RUN_VERSION_CONFLICT
  | typeof EVENT_BATCH_INVALID
  | typeof REPLAY_INVALID;

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

/** A command id was re-issued with a different canonical request than its journal recorded. */
export class CommandIdConflictError extends FdeError {
  readonly runId: string;
  readonly commandId: string;
  constructor(runId: string, commandId: string) {
    super(COMMAND_ID_CONFLICT, `command id conflict: ${runId}/${commandId}`);
    this.name = "CommandIdConflictError";
    this.runId = runId;
    this.commandId = commandId;
  }
}

/** Journal content contains a hidden canary value; the message never echoes the value. */
export class JournalCanaryLeakError extends FdeError {
  constructor() {
    super(JOURNAL_CANARY_LEAK, "journal content contains a canary value");
    this.name = "JournalCanaryLeakError";
  }
}

/** A resource id is unsafe to use as a filename component (traversal, separators, empty). */
export class InvalidResourceIdError extends FdeError {
  readonly kind: string;
  readonly id: string;
  constructor(kind: string, id: string) {
    super(INVALID_RESOURCE_ID, `invalid ${kind} id: ${id}`);
    this.name = "InvalidResourceIdError";
    this.kind = kind;
    this.id = id;
  }
}

/** Another process holds the run's exclusive writer lock. */
export class RunLockedError extends FdeError {
  readonly runId: string;
  constructor(runId: string) {
    super(RUN_LOCKED, `run is locked: ${runId}`);
    this.name = "RunLockedError";
    this.runId = runId;
  }
}

/** A persisted resource carries a schema version this build does not support. */
export class UnsupportedSchemaVersionError extends FdeError {
  readonly resource: string;
  readonly schemaVersion: unknown;
  constructor(resource: string, schemaVersion: unknown) {
    super(
      UNSUPPORTED_SCHEMA_VERSION,
      `${resource} carries schemaVersion ${String(schemaVersion)}; only schemaVersion ${FDE_SCHEMA_VERSION} is supported and no automatic migration is available — recompile the scenario source with a v${FDE_SCHEMA_VERSION} build, or regenerate the profile/run with a current build.`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.resource = resource;
    this.schemaVersion = schemaVersion;
  }
}

/** A compiled scenario bundle failed integrity verification. The message is structural only — never artifact content. */
export class ScenarioBundleInvalidError extends FdeError {
  readonly scenarioId: string;
  readonly reason: string;
  constructor(scenarioId: string, reason: string) {
    super(SCENARIO_BUNDLE_INVALID, `scenario bundle ${scenarioId} is invalid: ${reason}`);
    this.name = "ScenarioBundleInvalidError";
    this.scenarioId = scenarioId;
    this.reason = reason;
  }
}

/** The current scenario bundle does not match the digest a run was started against. */
export class ScenarioBundleMismatchError extends FdeError {
  readonly scenarioId: string;
  constructor(scenarioId: string) {
    super(
      SCENARIO_BUNDLE_MISMATCH,
      `scenario bundle for ${scenarioId} no longer matches the digest recorded at run start`,
    );
    this.name = "ScenarioBundleMismatchError";
    this.scenarioId = scenarioId;
  }
}

/** A command's prepared plan is stale: the run's event-log head moved between prepare and commit. */
export class RunVersionConflictError extends FdeError {
  readonly runId: string;
  constructor(runId: string) {
    super(RUN_VERSION_CONFLICT, `run version conflict: ${runId}`);
    this.name = "RunVersionConflictError";
    this.runId = runId;
  }
}

/** A command's event batch violates the graph semantics — rejected before journal. */
export class EventBatchInvalidError extends FdeError {
  constructor(message: string) {
    super(EVENT_BATCH_INVALID, message);
    this.name = "EventBatchInvalidError";
  }
}

/** A committed event log violates the graph semantics — replay fails closed. */
export class ReplayInvalidError extends FdeError {
  constructor(message: string) {
    super(REPLAY_INVALID, message);
    this.name = "ReplayInvalidError";
  }
}
