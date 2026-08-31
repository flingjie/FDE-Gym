import type {
  ChallengeResponse,
  FinalReviewResult,
  LocalizedText,
  PitchArtifact,
  ProblemBrief,
  RunPhase,
  ScoreBreakdown,
  SolutionProposal,
} from "../../core/domain.js";
import type { StageStates } from "../../scoring/provenance.js";
import type { MeasuredCapability } from "../../scoring/formulas.js";
import type { ApplicationDeps } from "../deps.js";
import { resolveScenario, type LoadedRun } from "../run-load.js";
import { executeCommandTransaction } from "../../core/command-transaction.js";
import {
  prepareChallengeInjection,
  prepareFramingGate,
  preparePitch,
  prepareRespondToChallenge,
  prepareReview,
  prepareSolutionDesign,
} from "../../core/orchestrator.js";
import { createRng } from "../../simulation/rng.js";
import { distinctInjectedChallengeIds, type CommandResult } from "./discovery.js";

/**
 * FDE Gym — framing/review mutating use cases (Phase 2a, Task 3).
 *
 * Each mutating use case takes the application dependencies, its command
 * arguments, and the already-loaded run (`LoadedRun`), resolves the scenario,
 * runs the `prepare*` step(s) and the write-ahead `executeCommandTransaction`,
 * and returns BOTH the learner-safe data AND the envelope fields (`runId`/
 * `phase`/`locale`) the CLI needs to wrap the result in `ok()`. `commands.ts`
 * stays a thin caller: build deps, load the run (so it can guard on the run's
 * actual locale), call the use case, wrap in `ok`.
 */

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface SubmitBriefArgs {
  runId: string;
  brief: ProblemBrief;
  commandId: string;
}

export interface SubmitDesignArgs {
  runId: string;
  proposal: SolutionProposal;
  commandId: string;
  seed?: number;
}

export interface RespondChallengeArgs {
  runId: string;
  response: ChallengeResponse;
  commandId: string;
}

export interface SubmitPitchArgs {
  runId: string;
  pitch: PitchArtifact;
  commandId: string;
}

export interface ReviewArgs {
  runId: string;
  commandId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic FNV-1a seed from a run id (no randomness, no wall-clock). */
function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

export async function submitBrief(
  deps: ApplicationDeps,
  args: SubmitBriefArgs,
  loaded: LoadedRun,
): Promise<CommandResult<BriefData>> {
  const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "submit-brief", brief: args.brief },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    canaries: [scenario.evaluator.canary],
    prepare: async () => {
      const result = await prepareFramingGate({
        runtime: deps.runtime,
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
  return { runId: args.runId, phase, locale: loaded.locale, data };
}

export async function submitDesign(
  deps: ApplicationDeps,
  args: SubmitDesignArgs,
  loaded: LoadedRun,
): Promise<CommandResult<DesignData>> {
  const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "submit-design", proposal: args.proposal, seed: args.seed ?? null },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
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
  return { runId: args.runId, phase: "CHALLENGE", locale: loaded.locale, data };
}

export async function respondChallenge(
  deps: ApplicationDeps,
  args: RespondChallengeArgs,
  loaded: LoadedRun,
): Promise<CommandResult<RespondData>> {
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "respond-challenge", response: args.response },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
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
  return { runId: args.runId, phase: data.phase, locale: loaded.locale, data };
}

export async function submitPitch(
  deps: ApplicationDeps,
  args: SubmitPitchArgs,
  loaded: LoadedRun,
): Promise<CommandResult<{ phase: RunPhase }>> {
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "submit-pitch", pitch: args.pitch },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
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
  return { runId: args.runId, phase: data.phase, locale: loaded.locale, data };
}

export async function review(
  deps: ApplicationDeps,
  args: ReviewArgs,
  loaded: LoadedRun,
): Promise<CommandResult<ReviewData>> {
  const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "review" },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    canaries: [scenario.evaluator.canary],
    prepare: async () => {
      const result = await prepareReview({
        runtime: deps.runtime,
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
  return { runId: args.runId, phase: loaded.phase, locale: loaded.locale, data };
}
