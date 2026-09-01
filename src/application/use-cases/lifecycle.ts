import type { RunPhase } from "../../core/domain.js";
import type { ApplicationDeps } from "../deps.js";
import type { LoadedRun } from "../run-load.js";
import { executeCommandTransaction } from "../../core/command-transaction.js";
import { prepareAbort, prepareComplete } from "../../core/orchestrator.js";
import type { CommandResult } from "./discovery.js";

/**
 * FDE Gym — terminal lifecycle mutating use cases.
 *
 * `complete` finalizes a REVIEW-phase run (REVIEW → COMPLETED, emitting
 * `run.completed`); `abort` terminates a run from any active phase (→ ABORTED,
 * emitting `run.aborted` with an optional reason). Both are pure transitions —
 * no model call, no I/O beyond the write-ahead command transaction.
 */

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface CompleteData {
  phase: RunPhase;
}

export interface AbortData {
  phase: RunPhase;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface CompleteArgs {
  runId: string;
  commandId: string;
}

export interface AbortArgs {
  runId: string;
  commandId: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

export async function complete(
  deps: ApplicationDeps,
  args: CompleteArgs,
  loaded: LoadedRun,
): Promise<CommandResult<CompleteData>> {
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "complete" },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    prepare: async () => {
      const result = prepareComplete(loaded.aggregate, args.commandId);
      return { events: result.events, result: { phase: "COMPLETED" as const } };
    },
  });
  return { runId: args.runId, phase: data.phase, locale: loaded.locale, data };
}

export async function abort(
  deps: ApplicationDeps,
  args: AbortArgs,
  loaded: LoadedRun,
): Promise<CommandResult<AbortData>> {
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "abort", ...(args.reason !== undefined ? { reason: args.reason } : {}) },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    prepare: async () => {
      const result = prepareAbort(loaded.aggregate, args.commandId, args.reason);
      return {
        events: result.events,
        result: {
          phase: "ABORTED" as const,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        },
      };
    },
  });
  return { runId: args.runId, phase: data.phase, locale: loaded.locale, data };
}
