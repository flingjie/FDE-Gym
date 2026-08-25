import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";

import type { AgentRuntime } from "../agents/agent-runtime.js";
import type { CodexCapabilityReport } from "../integrations/codex/capability-probe.js";
import {
  probeCodexCapabilities,
} from "../integrations/codex/capability-probe.js";
import { resolveBaseDir } from "../core/event-store.js";
import { loadEvents } from "../core/event-store.js";
import type { RecordedEvent } from "../core/domain.js";
import type {
  ChallengeResponse,
  Locale,
  LocalizedText,
  PitchArtifact,
  ProblemBrief,
  RunEvent,
  RunPhase,
  SolutionProposal,
} from "../core/domain.js";
import { decide } from "../core/state-machine.js";
import { createInitialRunState } from "../core/reducer.js";
import { executeCommandTransaction } from "../core/command-transaction.js";
import {
  assertFrameAllowed,
  prepareChallengeInjection,
  prepareClarification,
  prepareDiscoveryTurn,
  prepareFramingGate,
  preparePitch,
  prepareRepairPendingEvidence,
  prepareRespondToChallenge,
  prepareRetry,
  prepareReview,
  prepareSolutionDesign,
} from "../core/orchestrator.js";
import { requestHint } from "../simulation/hints.js";
import { createRng } from "../simulation/rng.js";
import { foldRunAggregate, projectReplay, type LearnerReplay } from "../replay/projector.js";
import { loadLearnerProfile } from "../storage/fs-store.js";
import { createEmptyProfile } from "../profile/learner-profile.js";
import {
  loadCustomerCapsule,
  loadEvaluatorCapsule,
  loadPublicScenario,
  loadScenarioEventCandidates,
} from "../scenarios/loader.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
  ScenarioEventCandidate,
} from "../scenarios/schema.js";
import type { ScoreBreakdown, FinalReviewResult } from "../core/domain.js";
import { InvalidPhaseCommandError } from "../core/errors.js";
import type { CliEnvelope, CliFailure, CliResult } from "./render.js";
import { localize } from "./render.js";

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

export interface AskData {
  turnId: string;
  question: string;
  customerReply: LocalizedText;
  stakeholderId: string;
  composite: number | null;
  pendingEvidence: { code: string } | null;
}

export interface HintData {
  topic: string;
  level: 1 | 2 | 3;
  hint: LocalizedText;
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
  score: ScoreBreakdown;
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

export interface StartData {
  scenario: PublicScenario;
  phase: RunPhase;
}

export interface DoctorData {
  report: CodexCapabilityReport;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripEnvelope(recorded: RecordedEvent): RunEvent {
  const { seq: _seq, logicalTime: _lt, previousHash: _ph, hash: _hash, ...event } = recorded;
  return event as RunEvent;
}

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

interface LoadedRun {
  events: RunEvent[];
  scenarioId: string;
  locale: Locale;
  phase: RunPhase | null;
  aggregate: ReturnType<typeof foldRunAggregate>;
}

async function loadRunState(ctx: CommandContext, runId: string): Promise<LoadedRun> {
  const recorded = await loadEvents(runId, { baseDir: ctx.baseDir });
  const events = recorded.map(stripEnvelope);
  const started = events.find((event) => event.type === "run.started");
  const scenarioId = started && started.type === "run.started" ? started.scenarioId : "";
  const locale = started && started.type === "run.started" ? started.locale : "zh-CN";
  const aggregate = foldRunAggregate(events, scenarioId, locale);
  return { events, scenarioId, locale, phase: aggregate.phase, aggregate };
}

function resolveScenario(ctx: CommandContext, scenarioId: string) {
  if (ctx.scenario) return ctx.scenario;
  return {
    public: loadPublicScenario(scenarioId),
    customer: loadCustomerCapsule(scenarioId),
    evaluator: loadEvaluatorCapsule(scenarioId),
    events: loadScenarioEventCandidates(scenarioId),
  };
}

function distinctInjectedChallengeIds(events: readonly RunEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type === "challenge.injected") seen.add(event.challengeId);
  }
  return [...seen];
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

export interface StartArgs {
  runId: string;
  scenarioId: string;
  locale: Locale;
  commandId: string;
}

export async function startCommand(
  ctx: CommandContext,
  args: StartArgs,
): Promise<CliResult<StartData>> {
  return guard(args.locale, async () => {
    const { public: publicScenario } = resolveScenario(ctx, args.scenarioId);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "start", scenarioId: args.scenarioId, locale: args.locale },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const initial = createInitialRunState(args.runId);
        const startEvents = decide(initial, {
          type: "start",
          commandId: args.commandId,
          scenarioId: args.scenarioId,
          locale: args.locale,
        });
        const acceptEvents = decide(
          { runId: args.runId, phase: "SCENARIO", seq: startEvents.length },
          { type: "accept", commandId: `${args.commandId}:accept` },
        );
        return {
          events: [...startEvents, ...acceptEvents],
          result: { scenario: publicScenario, phase: "DISCOVERY" as const },
        };
      },
    });
    return ok(args.runId, "DISCOVERY", args.locale, data);
  });
}

export interface FrameArgs {
  runId: string;
  commandId: string;
}

export async function frameCommand(ctx: CommandContext, args: FrameArgs): Promise<CliResult<{ phase: RunPhase }>> {
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    assertFrameAllowed(loaded.aggregate.pendingEvidence);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "frame" },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const events = decide(
          { runId: args.runId, phase: loaded.phase, seq: 0 },
          { type: "frame", commandId: args.commandId },
        );
        return { events, result: { phase: "PROBLEM_FRAMING" as const } };
      },
    });
    return ok(args.runId, "PROBLEM_FRAMING", loaded.locale, data);
  });
}

export interface AskArgs {
  runId: string;
  question: string;
  stakeholderId: string;
  commandId: string;
}

export async function askCommand(ctx: CommandContext, args: AskArgs): Promise<CliResult<AskData>> {
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    const scenario = resolveScenario(ctx, loaded.scenarioId);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "ask", question: args.question, stakeholderId: args.stakeholderId },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const result = await prepareDiscoveryTurn({
          runtime: ctx.runtime,
          capsule: scenario.customer,
          state: loaded.aggregate,
          question: args.question,
          stakeholderId: args.stakeholderId,
          commandId: args.commandId,
        });
        const turn = result.updatedState.transcript[result.updatedState.transcript.length - 1];
        return {
          events: result.acceptedEvents,
          result: {
            turnId: turn?.turnId ?? `${args.commandId}:turn`,
            question: args.question,
            customerReply: turn?.customerReply ?? { "zh-CN": "", "en-US": "" },
            stakeholderId: turn?.stakeholderId ?? args.stakeholderId,
            composite: result.metrics?.composite ?? null,
            pendingEvidence: result.pendingEvidence ? { code: result.pendingEvidence.code } : null,
          },
        };
      },
    });
    return ok(args.runId, loaded.phase, loaded.locale, data);
  });
}

export interface RepairEvidenceArgs {
  runId: string;
  commandId: string;
}

export async function repairEvidenceCommand(
  ctx: CommandContext,
  args: RepairEvidenceArgs,
): Promise<CliResult<AskData>> {
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    const pending = loaded.aggregate.pendingEvidence;
    if (!pending) {
      throw { code: "NOTHING_TO_REPAIR" };
    }
    const turnId = pending.turnId;
    const askCommandId = turnId.endsWith(":turn") ? turnId.slice(0, -":turn".length) : turnId;

    const scenario = resolveScenario(ctx, loaded.scenarioId);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "repair-evidence" },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const result = await prepareRepairPendingEvidence({
          runtime: ctx.runtime,
          state: loaded.aggregate,
          commandId: askCommandId,
          canaries: [scenario.customer.canary],
        });

        const turn = result.updatedState.transcript[result.updatedState.transcript.length - 1];
        return {
          events: result.acceptedEvents,
          result: {
            turnId: turn?.turnId ?? turnId,
            question: turn?.question ?? "",
            customerReply: turn?.customerReply ?? { "zh-CN": "", "en-US": "" },
            stakeholderId: turn?.stakeholderId ?? "",
            composite: result.metrics?.composite ?? null,
            pendingEvidence: null,
          },
        };
      },
    });
    return ok(args.runId, loaded.phase, loaded.locale, data);
  });
}

export interface HintArgs {
  runId: string;
  topic: string;
  level?: 1 | 2 | 3;
  commandId: string;
}

export async function hintCommand(ctx: CommandContext, args: HintArgs): Promise<CliResult<HintData>> {
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    if (loaded.phase !== "DISCOVERY" && loaded.phase !== "PROBLEM_FRAMING") {
      throw new InvalidPhaseCommandError("hint", loaded.phase);
    }
    const scenario = resolveScenario(ctx, loaded.scenarioId);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "hint", topic: args.topic, level: args.level ?? null },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const grant = requestHint(
          args.topic,
          args.level ?? null,
          scenario.evaluator.hintLadders,
          loaded.aggregate.grantedHints,
        );
        const event: RunEvent = {
          type: "hint.granted",
          runId: args.runId,
          commandId: args.commandId,
          topic: args.topic,
          level: grant.level,
          hint: grant.hint,
        };
        return {
          events: [event],
          result: { topic: args.topic, level: grant.level, hint: grant.hint },
        };
      },
    });
    return ok(args.runId, loaded.phase, loaded.locale, data);
  });
}

export interface ClarifyArgs {
  runId: string;
  commandId: string;
}

export async function clarifyCommand(
  ctx: CommandContext,
  args: ClarifyArgs,
): Promise<CliResult<{ phase: RunPhase }>> {
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "clarify" },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const result = await prepareClarification({
          state: loaded.aggregate,
          commandId: args.commandId,
          clarificationBudgetUsed: loaded.aggregate.clarificationBudgetUsed,
        });
        return {
          events: result.acceptedEvents,
          result: { phase: result.updatedState.phase ?? "DISCOVERY" },
        };
      },
    });
    return ok(args.runId, data.phase, loaded.locale, data);
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
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    const scenario = resolveScenario(ctx, loaded.scenarioId);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "submit-brief", brief: args.brief },
      store: { baseDir: ctx.baseDir },
      prepare: async () => {
        const result = await prepareFramingGate({
          runtime: ctx.runtime,
          capsule: scenario.evaluator,
          state: loaded.aggregate,
          brief: args.brief,
          commandId: args.commandId,
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
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    const scenario = resolveScenario(ctx, loaded.scenarioId);
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
  const loaded = await loadRunState(ctx, args.runId);
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
  const loaded = await loadRunState(ctx, args.runId);
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
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    const scenario = resolveScenario(ctx, loaded.scenarioId);
    const data = await executeCommandTransaction({
      runId: args.runId,
      commandId: args.commandId,
      request: { type: "review" },
      store: { baseDir: ctx.baseDir },
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
          result: { review: result.review, score: result.score },
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
  const loaded = await loadRunState(ctx, args.runId);
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
  const loaded = await loadRunState(ctx, args.runId);
  return guard(loaded.locale, async () => {
    let focusSummaries = args.focusSummaries;
    if (!focusSummaries) {
      const review = [...loaded.events].reverse().find((event) => event.type === "review.completed");
      focusSummaries = review && review.type === "review.completed" ? review.review.nextFocus : undefined;
    }
    if (!focusSummaries) {
      throw { code: "INVALID_RETRY_FOCUS" };
    }
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
  const loaded = await loadRunState(ctx, args.runId);
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
        const loaded = await loadRunState(ctx, runId);
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

export interface DoctorArgs {
  locale: Locale;
  executable?: string;
}

export async function doctorCommand(ctx: CommandContext, args: DoctorArgs): Promise<CliResult<DoctorData>> {
  return guard(args.locale, async () => {
    const report = await probeCodexCapabilities({ executable: args.executable ?? defaultCodexExecutable() });
    return ok("", null, args.locale, { report });
  });
}

function defaultCodexExecutable(): string {
  return process.env.CODEX_BIN || join(process.env.HOME ?? "", ".local", "bin", "codex");
}
