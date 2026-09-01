import type { Locale, LocalizedText, RunEvent, RunPhase } from "../../core/domain.js";
import type { PublicScenario } from "../../scenarios/schema.js";
import type { ApplicationDeps } from "../deps.js";
import { resolveScenario, stripEnvelope, type LoadedRun } from "../run-load.js";
import { executeCommandTransaction } from "../../core/command-transaction.js";
import { foldRunAggregate } from "../../replay/projector.js";
import {
  assertFrameAllowed,
  prepareClarification,
  prepareDiscoveryTurn,
  prepareRepairPendingEvidence,
} from "../../core/orchestrator.js";
import {
  assertCommandPhase,
  buildPhaseChangedEvent,
  buildRunStartedEvents,
} from "../../core/state-machine.js";
import { InvalidPhaseCommandError } from "../../core/errors.js";
import { requestHint as grantHint } from "../../simulation/hints.js";

/**
 * FDE Gym — discovery/framing mutating use cases (Phase 2a, Task 2).
 *
 * Each mutating use case takes the application dependencies, its command
 * arguments, and the already-loaded run (`LoadedRun`), resolves the scenario,
 * runs the `prepare*` step and the write-ahead `executeCommandTransaction`, and
 * returns BOTH the learner-safe data AND the envelope fields (`runId`/`phase`/
 * `locale`) the CLI needs to wrap the result in `ok()`. `commands.ts` stays a
 * thin caller: build deps, load the run (so it can guard on the run's actual
 * locale), call the use case, wrap in `ok`.
 */

/** The envelope + data a use case returns so the CLI command can stay thin. */
export interface CommandResult<D> {
  runId: string;
  phase: RunPhase | null;
  locale: Locale;
  data: D;
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface StartData {
  scenario: PublicScenario;
  phase: RunPhase;
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

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface StartArgs {
  runId: string;
  scenarioId: string;
  locale: Locale;
  commandId: string;
}

export interface FrameArgs {
  runId: string;
  commandId: string;
}

export interface AskArgs {
  runId: string;
  question: string;
  stakeholderId: string;
  commandId: string;
}

export interface RepairEvidenceArgs {
  runId: string;
  commandId: string;
}

export interface HintArgs {
  runId: string;
  topic: string;
  level?: 1 | 2 | 3;
  commandId: string;
}

export interface ClarifyArgs {
  runId: string;
  commandId: string;
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

export async function startRun(deps: ApplicationDeps, args: StartArgs): Promise<CommandResult<StartData>> {
  const resolved = resolveScenario(deps, args.scenarioId);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: {
      type: "start",
      scenarioId: args.scenarioId,
      locale: args.locale,
      ...(resolved.bundleDigest !== undefined ? { scenarioBundleDigest: resolved.bundleDigest } : {}),
    },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    prepare: async () => {
      const startEvents = buildRunStartedEvents(args.runId, {
        type: "start",
        commandId: args.commandId,
        scenarioId: args.scenarioId,
        locale: args.locale,
        ...(resolved.bundleDigest !== undefined ? { scenarioBundleDigest: resolved.bundleDigest } : {}),
      });
      const acceptEvents = [
        buildPhaseChangedEvent(args.runId, `${args.commandId}:accept`, "SCENARIO", "DISCOVERY"),
      ];
      return {
        events: [...startEvents, ...acceptEvents],
        result: { scenario: resolved.public, phase: "DISCOVERY" as const },
      };
    },
  });
  return { runId: args.runId, phase: "DISCOVERY", locale: args.locale, data };
}

export async function frame(
  deps: ApplicationDeps,
  args: FrameArgs,
  loaded: LoadedRun,
): Promise<CommandResult<{ phase: RunPhase }>> {
  assertFrameAllowed(loaded.aggregate.pendingEvidence);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "frame" },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    prepare: async () => {
      assertCommandPhase(loaded.phase, "frame");
      const events = [
        buildPhaseChangedEvent(args.runId, args.commandId, "DISCOVERY", "PROBLEM_FRAMING"),
      ];
      return { events, result: { phase: "PROBLEM_FRAMING" as const } };
    },
  });
  return { runId: args.runId, phase: "PROBLEM_FRAMING", locale: loaded.locale, data };
}

export async function ask(
  deps: ApplicationDeps,
  args: AskArgs,
  loaded: LoadedRun,
): Promise<CommandResult<AskData>> {
  const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "ask", question: args.question, stakeholderId: args.stakeholderId },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    canaries: [scenario.customer.canary],
    prepare: async () => {
      const result = await prepareDiscoveryTurn({
        runtime: deps.runtime,
        capsule: scenario.customer,
        state: loaded.aggregate,
        question: args.question,
        stakeholderId: args.stakeholderId,
        commandId: args.commandId,
        scenarioBundleDigest: loaded.scenarioBundleDigest,
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
  return { runId: args.runId, phase: loaded.phase, locale: loaded.locale, data };
}

export async function repairEvidence(
  deps: ApplicationDeps,
  args: RepairEvidenceArgs,
  loaded: LoadedRun,
): Promise<CommandResult<AskData>> {
  const pending = loaded.aggregate.pendingEvidence;
  if (!pending) {
    throw { code: "NOTHING_TO_REPAIR" };
  }
  const turnId = pending.turnId;
  const askCommandId = turnId.endsWith(":turn") ? turnId.slice(0, -":turn".length) : turnId;

  const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "repair-evidence" },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    canaries: [scenario.customer.canary],
    prepare: async () => {
      const result = await prepareRepairPendingEvidence({
        runtime: deps.runtime,
        state: loaded.aggregate,
        commandId: askCommandId,
        canaries: [scenario.customer.canary],
        scenarioBundleDigest: loaded.scenarioBundleDigest,
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
  return { runId: args.runId, phase: loaded.phase, locale: loaded.locale, data };
}

export async function requestHint(
  deps: ApplicationDeps,
  args: HintArgs,
  loaded: LoadedRun,
): Promise<CommandResult<HintData>> {
  const scenario = resolveScenario(deps, loaded.scenarioId, loaded.scenarioBundleDigest);
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "hint", topic: args.topic, level: args.level ?? null },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
    canaries: [scenario.evaluator.canary],
    prepare: async () => {
      const recorded = await deps.store.loadEvents(args.runId, { baseDir: deps.baseDir });
      const events = recorded.map(stripEnvelope);
      const aggregate = foldRunAggregate(events, loaded.scenarioId, loaded.locale);
      if (aggregate.phase !== "DISCOVERY" && aggregate.phase !== "PROBLEM_FRAMING") {
        throw new InvalidPhaseCommandError("hint", aggregate.phase);
      }
      const grant = grantHint(
        args.topic,
        args.level ?? null,
        scenario.evaluator.hintLadders,
        aggregate.grantedHints,
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
  const recordedAfter = await deps.store.loadEvents(args.runId, { baseDir: deps.baseDir });
  const phase = foldRunAggregate(
    recordedAfter.map(stripEnvelope),
    loaded.scenarioId,
    loaded.locale,
  ).phase;
  return { runId: args.runId, phase, locale: loaded.locale, data };
}

export async function clarify(
  deps: ApplicationDeps,
  args: ClarifyArgs,
  loaded: LoadedRun,
): Promise<CommandResult<{ phase: RunPhase }>> {
  const data = await executeCommandTransaction({
    runId: args.runId,
    commandId: args.commandId,
    request: { type: "clarify" },
    store: { baseDir: deps.baseDir },
    events: { appendEvents: deps.store.appendEvents, readHead: deps.store.readHead },
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
  return { runId: args.runId, phase: data.phase, locale: loaded.locale, data };
}
