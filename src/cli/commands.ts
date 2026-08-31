import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";

import type { AgentRuntime } from "../agents/agent-runtime.js";
import { resolveBaseDir } from "../core/event-store.js";
import type { Locale, RunPhase } from "../core/domain.js";
import { projectReplay, type LearnerReplay } from "../replay/projector.js";
import { loadLearnerProfile } from "../storage/fs-store.js";
import { createEmptyProfile } from "../profile/learner-profile.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
  ScenarioEventCandidate,
} from "../scenarios/schema.js";
import type { CliEnvelope, CliFailure, CliResult } from "./render.js";
import { localize } from "./render.js";
import { buildDeps } from "../application/deps.js";
import { loadRun } from "../application/run-load.js";
import {
  ask,
  clarify,
  frame,
  repairEvidence,
  requestHint,
  startRun,
  type AskArgs,
  type AskData,
  type ClarifyArgs,
  type FrameArgs,
  type HintArgs,
  type HintData,
  type RepairEvidenceArgs,
  type StartArgs,
  type StartData,
} from "../application/use-cases/discovery.js";
import {
  respondChallenge,
  review,
  submitBrief,
  submitDesign,
  submitPitch,
  type BriefData,
  type DesignData,
  type RespondChallengeArgs,
  type RespondData,
  type ReviewArgs,
  type ReviewData,
  type SubmitBriefArgs,
  type SubmitDesignArgs,
  type SubmitPitchArgs,
} from "../application/use-cases/framing-review.js";
import { retry, type RetryArgs, type RetryData } from "../application/use-cases/retry.js";

/**
 * FDE Gym — CLI command implementations (Task 11).
 *
 * Each command is a thin, async function delegating to the orchestrator,
 * scoring, profile, replay, and runtime layers. Every command returns the
 * strict learner-safe `CliResult` envelope; failures are reduced to a stable
 * code + LOCALIZED message and never serialize raw agent/model output.
 */

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface CommandContext {
  runtime: AgentRuntime;
  /** Store/profile root override (tests point this at a temp dir). */
  baseDir?: string;
  /** Compiled-scenario root override (defaults to `<cwd>/scenarios/compiled`). */
  compiledRoot?: string;
  /** Preloaded scenario partitions (tests inject these to bypass the loader). */
  scenario?: {
    public: PublicScenario;
    customer: CustomerCapsule;
    evaluator: EvaluatorCapsule;
    events: ScenarioEventCandidate[];
  };
}

// ---------------------------------------------------------------------------
// Result data shapes
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
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(runId: string, phase: RunPhase | null, locale: Locale, data: T): CliEnvelope<T> {
  return { ok: true, runId, phase: phase ?? "SCENARIO", locale, data };
}

function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  if (error instanceof ZodError) return "INVALID_ARTIFACT";
  if (error instanceof Error) {
    const message = error.message;
    if (message.startsWith("Scenario not found")) return "SCENARIO_NOT_FOUND";
    if (message.startsWith("Unknown role")) return "SCENARIO_NOT_FOUND";
    if (message.includes("learner profile")) return "INVALID_ARTIFACT";
  }
  return "INTERNAL_ERROR";
}

function toFailure(error: unknown, locale: Locale): CliFailure {
  const code = errorCodeOf(error);
  const localized = localize(code, locale);
  return { ok: false, code, message: localized.message, nextActions: localized.nextActions };
}

/** Wrap a command handler so failures always reduce to a learner-safe envelope. */
async function guard<T>(locale: Locale, fn: () => Promise<CliResult<T>>): Promise<CliResult<T>> {
  try {
    return await fn();
  } catch (error) {
    return toFailure(error, locale);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function startCommand(
  ctx: CommandContext,
  args: StartArgs,
): Promise<CliResult<StartData>> {
  const deps = buildDeps(ctx);
  return guard(args.locale, async () => {
    const r = await startRun(deps, args);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function frameCommand(
  ctx: CommandContext,
  args: FrameArgs,
): Promise<CliResult<{ phase: RunPhase }>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await frame(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function askCommand(ctx: CommandContext, args: AskArgs): Promise<CliResult<AskData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await ask(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function repairEvidenceCommand(
  ctx: CommandContext,
  args: RepairEvidenceArgs,
): Promise<CliResult<AskData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await repairEvidence(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function hintCommand(ctx: CommandContext, args: HintArgs): Promise<CliResult<HintData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await requestHint(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function clarifyCommand(
  ctx: CommandContext,
  args: ClarifyArgs,
): Promise<CliResult<{ phase: RunPhase }>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await clarify(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function submitBriefCommand(
  ctx: CommandContext,
  args: SubmitBriefArgs,
): Promise<CliResult<BriefData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await submitBrief(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function submitDesignCommand(
  ctx: CommandContext,
  args: SubmitDesignArgs,
): Promise<CliResult<DesignData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await submitDesign(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function respondChallengeCommand(
  ctx: CommandContext,
  args: RespondChallengeArgs,
): Promise<CliResult<RespondData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await respondChallenge(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function submitPitchCommand(
  ctx: CommandContext,
  args: SubmitPitchArgs,
): Promise<CliResult<{ phase: RunPhase }>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await submitPitch(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function reviewCommand(ctx: CommandContext, args: ReviewArgs): Promise<CliResult<ReviewData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await review(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export interface ReplayArgs {
  runId: string;
  locale?: Locale;
}

export async function replayCommand(ctx: CommandContext, args: ReplayArgs): Promise<CliResult<ReplayData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  const locale = args.locale ?? loaded.locale;
  return guard(locale, async () => {
    const replay = projectReplay(loaded.events, locale);
    return ok(args.runId, loaded.phase, locale, { replay });
  });
}

export async function retryCommand(ctx: CommandContext, args: RetryArgs): Promise<CliResult<RetryData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await retry(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export interface StatusArgs {
  runId: string;
}

export async function statusCommand(ctx: CommandContext, args: StatusArgs): Promise<CliResult<StatusData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const agg = loaded.aggregate;
    return ok(args.runId, loaded.phase, loaded.locale, {
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
    });
  });
}

export interface ProfileArgs {
  locale: Locale;
}

export async function profileCommand(
  ctx: CommandContext,
  args: ProfileArgs,
): Promise<CliResult<ProfileData>> {
  return guard(args.locale, async () => {
    const profile = (await loadLearnerProfile({ baseDir: ctx.baseDir })) ?? createEmptyProfile();
    return ok("", null, args.locale, { profile });
  });
}

export interface ListArgs {
  locale: Locale;
}

export async function listCommand(ctx: CommandContext, args: ListArgs): Promise<CliResult<ListData>> {
  const deps = buildDeps(ctx);
  return guard(args.locale, async () => {
    const runsDir = join(ctx.baseDir ?? resolveBaseDir(), "runs");
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
    return ok("", null, args.locale, { runs: summaries });
  });
}
