import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";

import type { AgentRuntime } from "../agents/agent-runtime.js";
import { resolveBaseDir } from "../core/event-store.js";
import type {
  ChallengeResponse,
  Locale,
  LocalizedText,
  PitchArtifact,
  ProblemBrief,
  RunPhase,
  SolutionProposal,
} from "../core/domain.js";
import { executeCommandTransaction } from "../core/command-transaction.js";
import {
  prepareChallengeInjection,
  prepareFramingGate,
  preparePitch,
  prepareRespondToChallenge,
  prepareRetry,
  prepareReview,
  prepareSolutionDesign,
} from "../core/orchestrator.js";
import { createRng } from "../simulation/rng.js";
import { projectReplay, type LearnerReplay } from "../replay/projector.js";
import { loadLearnerProfile } from "../storage/fs-store.js";
import { createEmptyProfile } from "../profile/learner-profile.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
  ScenarioEventCandidate,
} from "../scenarios/schema.js";
import type { ScoreBreakdown, FinalReviewResult } from "../core/domain.js";
import type { StageStates } from "../scoring/provenance.js";
import type { MeasuredCapability } from "../scoring/formulas.js";
import type { CliEnvelope, CliFailure, CliResult } from "./render.js";
import { localize } from "./render.js";
import { buildDeps } from "../application/deps.js";
import { loadRun, resolveScenario } from "../application/run-load.js";
import {
  ask,
  clarify,
  distinctInjectedChallengeIds,
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

export interface BriefData {
  passed: boolean;
  supportRatio: number;
  feedback: LocalizedText;
}

export interface DesignData {
  phase: RunPhase;
  injectedChallengeIds: string[];
  interruptions: Array<{ challengeId: string; reply: LocalizedText; stakeholderId: string }>;
}

export interface RespondData {
  challengesAddressed: boolean;
  phase: RunPhase;
}

export interface ReviewData {
  review: FinalReviewResult;
  /** The deterministic pass-gate `ScoreBreakdown` over ALL stages (byte-stable
   *  committed artifact). `final`/`raw` may fold deterministic fallbacks, so a
   *  proxy/unscorable stage can appear here — it is NOT a capability figure. */
  score: ScoreBreakdown;
  /** Per-stage three-state classification (measured/proxy/unscorable). */
  stageStates: StageStates;
  /** Display-time capability figure over discovery + measured stages only —
   *  this (not `score.final`) is the capability number. */
  measuredCapability: MeasuredCapability;
}

export interface ReplayData {
  replay: LearnerReplay;
}

export interface RetryData {
  runId: string;
  parentRunId: string;
  scenarioId: string;
  locale: Locale;
  phase: RunPhase;
  focusSummaries: LocalizedText[];
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

/** Deterministic FNV-1a seed from a run id (no randomness, no wall-clock). */
function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
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
  return guard("zh-CN", async () => {
    const r = await frame(deps, args);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function askCommand(ctx: CommandContext, args: AskArgs): Promise<CliResult<AskData>> {
  const deps = buildDeps(ctx);
  return guard("zh-CN", async () => {
    const r = await ask(deps, args);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function repairEvidenceCommand(
  ctx: CommandContext,
  args: RepairEvidenceArgs,
): Promise<CliResult<AskData>> {
  const deps = buildDeps(ctx);
  return guard("zh-CN", async () => {
    const r = await repairEvidence(deps, args);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function hintCommand(ctx: CommandContext, args: HintArgs): Promise<CliResult<HintData>> {
  const deps = buildDeps(ctx);
  return guard("zh-CN", async () => {
    const r = await requestHint(deps, args);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export async function clarifyCommand(
  ctx: CommandContext,
  args: ClarifyArgs,
): Promise<CliResult<{ phase: RunPhase }>> {
  const deps = buildDeps(ctx);
  return guard("zh-CN", async () => {
    const r = await clarify(deps, args);
    return ok(r.runId, r.phase, r.locale, r.data);
  });
}

export interface SubmitBriefArgs {
  runId: string;
  brief: ProblemBrief;
  commandId: string;
}

export async function submitBriefCommand(
  ctx: CommandContext,
  args: SubmitBriefArgs,
): Promise<CliResult<BriefData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "submit-brief", brief: args.brief },
      store: { baseDir: ctx.baseDir },
      canaries: [scenario.evaluator.canary],
      prepare: async () => {
        const result = await prepareFramingGate({
          runtime: ctx.runtime,
          capsule: scenario.evaluator,
          state: loaded.aggregate,
          brief: args.brief,
          commandId: args.commandId,
          scenarioBundleDigest: loaded.scenarioBundleDigest,
        });
        return {
          events: result.acceptedEvents,
          result: {
            passed: result.passed,
            supportRatio: result.supportRatio,
            feedback: result.result.feedback,
          },
        };
      },
    });
    const phase = data.passed ? "SOLUTION_DESIGN" : "PROBLEM_FRAMING";
    return ok(args.runId, phase, loaded.locale, data);
  });
}

export interface SubmitDesignArgs {
  runId: string;
  proposal: SolutionProposal;
  commandId: string;
  seed?: number;
}

export async function submitDesignCommand(
  ctx: CommandContext,
  args: SubmitDesignArgs,
): Promise<CliResult<DesignData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "submit-design", proposal: args.proposal, seed: args.seed ?? null },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const design = await prepareSolutionDesign({
          state: loaded.aggregate,
          proposal: args.proposal,
          commandId: args.commandId,
        });
        const injection = await prepareChallengeInjection({
          state: design.updatedState,
          capsule: scenario.customer,
          candidates: scenario.events,
          rng: createRng(args.seed ?? hashSeed(args.runId)),
          commandId: `${args.commandId}:inject`,
          alreadyInjectedChallengeIds: distinctInjectedChallengeIds(loaded.events),
        });
        return {
          events: [...design.acceptedEvents, ...injection.acceptedEvents],
          result: {
            phase: "CHALLENGE" as const,
            injectedChallengeIds: injection.injectedChallengeIds,
            interruptions: injection.interruptions,
          },
        };
      },
    });
    return ok(args.runId, "CHALLENGE", loaded.locale, data);
  });
}

export interface RespondChallengeArgs {
  runId: string;
  response: ChallengeResponse;
  commandId: string;
}

export async function respondChallengeCommand(
  ctx: CommandContext,
  args: RespondChallengeArgs,
): Promise<CliResult<RespondData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "respond-challenge", response: args.response },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const result = await prepareRespondToChallenge({
          state: loaded.aggregate,
          response: args.response,
          commandId: args.commandId,
          mandatoryChallengeIds: distinctInjectedChallengeIds(loaded.events),
        });
        return {
          events: result.acceptedEvents,
          result: {
            challengesAddressed: result.challengesAddressed,
            phase: result.updatedState.phase ?? "CHALLENGE",
          },
        };
      },
    });
    return ok(args.runId, data.phase, loaded.locale, data);
  });
}

export interface SubmitPitchArgs {
  runId: string;
  pitch: PitchArtifact;
  commandId: string;
}

export async function submitPitchCommand(
  ctx: CommandContext,
  args: SubmitPitchArgs,
): Promise<CliResult<{ phase: RunPhase }>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "submit-pitch", pitch: args.pitch },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const result = await preparePitch({
          state: loaded.aggregate,
          pitch: args.pitch,
          commandId: args.commandId,
        });
        return {
          events: result.acceptedEvents,
          result: { phase: result.updatedState.phase ?? "REVIEW" },
        };
      },
    });
    return ok(args.runId, data.phase, loaded.locale, data);
  });
}

export interface ReviewArgs {
  runId: string;
  commandId: string;
}

export async function reviewCommand(ctx: CommandContext, args: ReviewArgs): Promise<CliResult<ReviewData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
    const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "review" },
      store: { baseDir: ctx.baseDir },
      canaries: [scenario.evaluator.canary],
      prepare: async () => {
        const result = await prepareReview({
          runtime: ctx.runtime,
          capsule: scenario.evaluator,
          customerCapsule: scenario.customer,
          publicScenario: scenario.public,
          events: loaded.events,
          state: loaded.aggregate,
          commandId: args.commandId,
        });
        return {
          events: result.events,
          effects: [result.effect],
          result: {
            review: result.review,
            score: result.score,
            stageStates: result.stageStates,
            measuredCapability: result.measuredCapability,
          },
        };
      },
    });
    return ok(args.runId, loaded.phase, loaded.locale, data);
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

export interface RetryArgs {
  runId: string;
  newRunId: string;
  commandId: string;
  focusSummaries?: LocalizedText[];
  seed?: number;
}

export async function retryCommand(ctx: CommandContext, args: RetryArgs): Promise<CliResult<RetryData>> {
  const deps = buildDeps(ctx);
  const loaded = await loadRun(deps, args.runId);
  return guard(loaded.locale, async () => {
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
      store: { baseDir: ctx.baseDir },
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
    return ok(args.newRunId, data.phase, data.locale, data);
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
