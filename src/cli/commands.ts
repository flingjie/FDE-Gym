import { ZodError } from "zod";

import type { AgentRuntime } from "../agents/agent-runtime.js";
import type { Locale, RunPhase } from "../core/domain.js";
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
import {
  list,
  profile,
  replay,
  status,
  type ListArgs,
  type ListData,
  type ProfileArgs,
  type ProfileData,
  type ReplayArgs,
  type ReplayData,
  type StatusArgs,
  type StatusData,
} from "../application/use-cases/read.js";
import {
  retry,
  startRetry,
  type RetryArgs,
  type RetryData,
  type StartRetryArgs,
  type StartRetryData,
} from "../application/use-cases/retry.js";
import {
  abort,
  complete,
  type AbortArgs,
  type AbortData,
  type CompleteArgs,
  type CompleteData,
} from "../application/use-cases/lifecycle.js";

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

export async function replayCommand(ctx: CommandContext, args: ReplayArgs): Promise<CliResult<ReplayData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  const locale = args.locale ?? loaded.locale;
  return guard(locale, async () => {
    const r = await replay(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
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

export async function startRetryCommand(
  ctx: CommandContext,
  args: StartRetryArgs,
): Promise<CliResult<StartRetryData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await startRetry(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function completeCommand(
  ctx: CommandContext,
  args: CompleteArgs,
): Promise<CliResult<CompleteData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await complete(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function abortCommand(
  ctx: CommandContext,
  args: AbortArgs,
): Promise<CliResult<AbortData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await abort(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function statusCommand(ctx: CommandContext, args: StatusArgs): Promise<CliResult<StatusData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const r = await status(deps, args, loaded);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function profileCommand(
  ctx: CommandContext,
  args: ProfileArgs,
): Promise<CliResult<ProfileData>> {
  const deps = buildDeps(ctx);
  return guard(args.locale, async () => {
    const r = await profile(deps, args);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function listCommand(ctx: CommandContext, args: ListArgs): Promise<CliResult<ListData>> {
  const deps = buildDeps(ctx);
  return guard(args.locale, async () => {
    const r = await list(deps, args);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}
