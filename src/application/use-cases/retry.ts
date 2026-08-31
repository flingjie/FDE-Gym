import type { Locale, LocalizedText, RunPhase } from "../../core/domain.js";
import type { ApplicationDeps } from "../deps.js";
import { resolveScenario, type LoadedRun } from "../run-load.js";
import { executeCommandTransaction } from "../../core/command-transaction.js";
import { prepareRetry } from "../../core/orchestrator.js";
import type { CommandResult } from "./discovery.js";

/**
 * FDE Gym — retry mutating use case (Phase 2a, Task 3).
 *
 * The retry use case takes the application dependencies, its command arguments,
 * and the already-loaded parent run (`LoadedRun`), derives the focus summaries,
 * resolves the scenario, and runs the write-ahead `executeCommandTransaction`
 * with `prepareRetry` (parent `retry.started` events) plus the
 * `retry.ensure-child` effect that persists the fresh child run's events. It
 * returns BOTH the learner-safe data AND the envelope fields (`runId`/`phase`/
 * `locale`) the CLI needs to wrap the result in `ok()`.
 */

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface RetryData {
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
  newRunId: string;
  commandId: string;
  focusSummaries?: LocalizedText[];
  seed?: number;
}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export async function retry(
  deps: ApplicationDeps,
  args: RetryArgs,
  loaded: LoadedRun,
): Promise<CommandResult<RetryData>> {
  let focusSummaries = args.focusSummaries;
  if (!focusSummaries) {
    const review = [...loaded.events].reverse().find((event) => event.type === "review.completed");
    focusSummaries = review && review.type === "review.completed" ? review.review.nextFocus : undefined;
  }
  if (!focusSummaries) {
    throw { code: "INVALID_RETRY_FOCUS" };
  }
  const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "retry", newRunId: args.newRunId, seed: args.seed ?? null, focusSummaries },
    store: { baseDir: deps.baseDir },
    prepare: async () => {
      const result = await prepareRetry(loaded.aggregate, {
        newRunId: args.newRunId,
        commandId: args.commandId,
        seed: args.seed,
        focusSummaries,
        ...(scenario.bundleDigest !== undefined ? { scenarioBundleDigest: scenario.bundleDigest } : {}),
      });
      return {
        events: result.parentEvents,
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
          phase: result.state.phase ?? "DISCOVERY",
          focusSummaries: result.focusSummaries,
        },
      };
    },
  });
  return { runId: args.newRunId, phase: data.phase, locale: data.locale, data };
}
