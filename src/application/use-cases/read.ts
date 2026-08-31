import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Locale, RunPhase } from "../../core/domain.js";
import { resolveBaseDir } from "../../core/event-store.js";
import { projectReplay, type LearnerReplay } from "../../replay/projector.js";
import { createEmptyProfile } from "../../profile/learner-profile.js";
import type { ApplicationDeps } from "../deps.js";
import { loadRun, type LoadedRun } from "../run-load.js";
import type { CommandResult } from "./discovery.js";

/**
 * FDE Gym — read-only use cases (Phase 2a, Task 4).
 *
 * These four use cases never mutate the event store (no
 * `executeCommandTransaction`); they only load committed events and project a
 * learner-safe read model. Each takes the application dependencies plus its
 * command arguments (and, for `replay`/`status`, the already-loaded run so the
 * CLI can guard on the run's actual locale) and returns BOTH the learner-safe
 * data AND the envelope fields (`runId`/`phase`/`locale`) the CLI wraps in
 * `ok()`. `commands.ts` stays a thin caller.
 */

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface RunSummary {
  runId: string;
  scenarioId: string;
  phase: RunPhase;
  locale: Locale;
}

export interface StatusData {
  runId: string;
  scenarioId: string;
  phase: RunPhase;
  locale: Locale;
  transcriptCount: number;
  graphVersion: number;
  disclosedCount: number;
  hintCount: number;
  briefId: string | null;
  proposalId: string | null;
  pitchId: string | null;
  challengeResponseCount: number;
}

export interface ReplayData {
  replay: LearnerReplay;
}

export interface ProfileData {
  profile: ReturnType<typeof createEmptyProfile>;
}

export interface ListData {
  runs: RunSummary[];
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface ReplayArgs {
  runId: string;
  locale?: Locale;
}

export interface StatusArgs {
  runId: string;
}

export interface ProfileArgs {
  locale: Locale;
}

export interface ListArgs {
  locale: Locale;
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

export async function replay(
  _deps: ApplicationDeps,
  args: ReplayArgs,
  loaded: LoadedRun,
): Promise<CommandResult<ReplayData>> {
  const locale = args.locale ?? loaded.locale;
  const replay = projectReplay(loaded.events, locale);
  return { runId: args.runId, phase: loaded.phase, locale, data: { replay } };
}

export async function status(
  _deps: ApplicationDeps,
  args: StatusArgs,
  loaded: LoadedRun,
): Promise<CommandResult<StatusData>> {
  const agg = loaded.aggregate;
  return {
    runId: args.runId,
    phase: loaded.phase,
    locale: loaded.locale,
    data: {
      runId: args.runId,
      scenarioId: loaded.scenarioId,
      phase: loaded.phase ?? "SCENARIO",
      locale: loaded.locale,
      transcriptCount: agg.transcript.length,
      graphVersion: agg.graph.version,
      disclosedCount: agg.disclosedDisclosureUnitIds.length,
      hintCount: agg.grantedHints.length,
      briefId: agg.brief?.id ?? null,
      proposalId: agg.proposal?.id ?? null,
      pitchId: agg.pitch?.id ?? null,
      challengeResponseCount: agg.challengeResponses.length,
    },
  };
}

export async function profile(
  deps: ApplicationDeps,
  args: ProfileArgs,
): Promise<CommandResult<ProfileData>> {
  const profile =
    (await deps.profiles.loadLearnerProfile({ baseDir: deps.baseDir })) ?? createEmptyProfile();
  return { runId: "", phase: null, locale: args.locale, data: { profile } };
}

export async function list(
  deps: ApplicationDeps,
  args: ListArgs,
): Promise<CommandResult<ListData>> {
  const runsDir = join(deps.baseDir ?? resolveBaseDir(), "runs");
  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    entries = [];
  }
  const summaries: RunSummary[] = [];
  for (const runId of entries) {
    try {
      const loaded = await loadRun(deps, runId);
      summaries.push({
        runId,
        scenarioId: loaded.scenarioId,
        phase: loaded.phase ?? "SCENARIO",
        locale: loaded.locale,
      });
    } catch {
      // Skip unreadable run directories.
    }
  }
  summaries.sort((a, b) => a.runId.localeCompare(b.runId));
  return { runId: "", phase: null, locale: args.locale, data: { runs: summaries } };
}
