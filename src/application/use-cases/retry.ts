import type { Locale, LocalizedText, RunPhase } from "../../core/domain.js";
import type { ApplicationDeps } from "../deps.js";
import { resolveScenario, type LoadedRun } from "../run-load.js";
import { executeCommandTransaction } from "../../core/command-transaction.js";
import { prepareRetry, prepareStartRetry } from "../../core/orchestrator.js";
import type { CommandResult } from "./discovery.js";

/**
 * FDE Gym — two-step retry mutating use cases (Task 10, restructured).
 *
 * The retry flow is a two-step state transition matching `docs/architecture.md`:
 *
 *   1. `retry`        — marks the REVIEW-phase parent ready to retry: moves it
 *                        to `RETRY_READY` and durably records the focus summaries
 *                        (`retry.started`) on the parent.
 *   2. `start-retry`  — reads the focus summaries from the parent's committed
 *                        `retry.started`, then spawns a fresh child run at
 *                        DISCOVERY via the `retry.ensure-child` effect.
 *
 * Both use cases run the write-ahead `executeCommandTransaction` and return BOTH
 * the learner-safe data AND the envelope fields (`runId`/`phase`/`locale`) the
 * CLI needs to wrap the result in `ok()`.
 */

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface RetryData {
  runId: string;
  scenarioId: string;
  locale: Locale;
  phase: RunPhase;
  focusSummaries: LocalizedText[];
}

export interface StartRetryData {
  runId: string;
  parentRunId: string;
  scenarioId: string;
  locale: Locale;
  phase: RunPhase;
  focusSummaries: LocalizedText[];
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface RetryArgs {
  runId: string;
  commandId: string;
  focusSummaries?: LocalizedText[];
}

export interface StartRetryArgs {
  runId: string;
  newRunId: string;
  commandId: string;
  seed?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFocusSummaries(
  loaded: LoadedRun,
  provided?: LocalizedText[],
): LocalizedText[] {
  if (provided) return provided;
  const review = [...loaded.events].reverse().find((event) => event.type === "review.completed");
  return review && review.type === "review.completed" ? review.review.nextFocus : [];
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

/** Step 1: mark a REVIEW-phase run ready to retry (REVIEW → RETRY_READY). */
export async function retry(
  deps: ApplicationDeps,
  args: RetryArgs,
  loaded: LoadedRun,
): Promise<CommandResult<RetryData>> {
  const focusSummaries = resolveFocusSummaries(loaded, args.focusSummaries);
  if (focusSummaries.length === 0) {
    throw { code: "INVALID_RETRY_FOCUS" };
  }
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "retry", focusSummaries },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    prepare: async () => {
      const result = prepareRetry(loaded.aggregate, {
        commandId: args.commandId,
        focusSummaries,
      });
      return {
        events: result.parentEvents,
        result: {
          runId: result.parentRunId,
          scenarioId: result.scenarioId,
          locale: result.locale,
          phase: "RETRY_READY" as const,
          focusSummaries: result.focusSummaries,
        },
      };
    },
  });
  return { runId: args.runId, phase: data.phase, locale: data.locale, data };
}

/** Step 2: spawn the fresh child run (RETRY_READY → child DISCOVERY). */
export async function startRetry(
  deps: ApplicationDeps,
  args: StartRetryArgs,
  loaded: LoadedRun,
): Promise<CommandResult<StartRetryData>> {
  const ready = [...loaded.events].reverse().find((event) => event.type === "retry.started");
  const focusSummaries = ready && ready.type === "retry.started" ? ready.focusSummaries : undefined;
  if (!focusSummaries || focusSummaries.length === 0) {
    throw { code: "INVALID_RETRY_FOCUS" };
  }
  const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "start-retry", newRunId: args.newRunId, seed: args.seed ?? null },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    prepare: async () => {
      const result = prepareStartRetry(loaded.aggregate, {
        newRunId: args.newRunId,
        commandId: args.commandId,
        seed: args.seed,
        focusSummaries,
        ...(scenario.bundleDigest !== undefined ? { scenarioBundleDigest: scenario.bundleDigest } : {}),
      });
      return {
        events: [],
        effects: [
          {
            type: "retry.ensure-child",
            effectId: `${result.parentRunId}:${args.commandId}:child`,
            parentRunId: result.parentRunId,
            childRunId: result.runId,
            events: result.newRunEvents,
          },
        ],
        result: {
          runId: result.runId,
          parentRunId: result.parentRunId,
          scenarioId: result.scenarioId,
          locale: result.locale,
          phase: "DISCOVERY" as const,
          focusSummaries: result.focusSummaries,
        },
      };
    },
  });
  return { runId: args.newRunId, phase: data.phase, locale: data.locale, data };
}
