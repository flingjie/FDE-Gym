import { foldRunAggregate } from "../replay/projector.js";
import { loadScenarioBundle, defaultCompiledRoot } from "../scenarios/bundle.js";
import { ScenarioBundleMismatchError } from "../core/errors.js";
import type { RecordedEvent, Locale, RunEvent, RunPhase } from "../core/domain.js";
import type { ScenarioEventCandidate } from "../scenarios/schema.js";
import type { ApplicationDeps, PreloadedScenario } from "./deps.js";

export function stripEnvelope(recorded: RecordedEvent): RunEvent {
  const { seq: _seq, logicalTime: _lt, previousHash: _ph, hash: _hash, ...event } = recorded;
  return event as RunEvent;
}

export interface LoadedRun {
  events: RunEvent[];
  scenarioId: string;
  locale: Locale;
  phase: RunPhase | null;
  aggregate: ReturnType<typeof foldRunAggregate>;
  scenarioBundleDigest: string | undefined;
}

export async function loadRun(deps: ApplicationDeps, runId: string): Promise<LoadedRun> {
  const recorded = await deps.store.loadEvents(runId, { baseDir: deps.baseDir });
  const events = recorded.map(stripEnvelope);
  const started = events.find((event) => event.type === "run.started");
  const scenarioId = started && started.type === "run.started" ? started.scenarioId : "";
  const locale = started && started.type === "run.started" ? started.locale : "zh-CN";
  const scenarioBundleDigest =
    started && started.type === "run.started" ? started.scenarioBundleDigest : undefined;
  const aggregate = foldRunAggregate(events, scenarioId, locale);
  return { events, scenarioId, locale, phase: aggregate.phase, aggregate, scenarioBundleDigest };
}

export interface RunScenario extends PreloadedScenario {
  bundleDigest: string | undefined;
}

export function resolveScenario(
  deps: ApplicationDeps,
  scenarioId: string,
  expectedBundleDigest?: string,
): RunScenario {
  if (deps.scenario) {
    return { ...deps.scenario, bundleDigest: undefined };
  }
  const bundle = deps.scenarios.loadScenarioBundle(scenarioId, {
    compiledRoot: deps.compiledRoot ?? defaultCompiledRoot(),
  });
  if (expectedBundleDigest !== undefined && bundle.bundleDigest !== expectedBundleDigest) {
    throw new ScenarioBundleMismatchError(scenarioId);
  }
  return {
    public: bundle.publicScenario,
    customer: bundle.customerCapsule,
    evaluator: bundle.evaluatorCapsule,
    events: [...bundle.eventCandidates],
    bundleDigest: bundle.bundleDigest,
  };
}
