import type { AgentRuntime } from "../agents/agent-runtime.js";
import {
  appendEvents, loadEvents, loadRun, readHead,
} from "../core/event-store.js";
import { loadScenarioBundle } from "../scenarios/bundle.js";
import {
  applyProfileAttemptEffect, loadLearnerProfile, saveLearnerProfile,
} from "../storage/fs-store.js";
import type { EventStorePort } from "../ports/event-store.js";
import type { ScenarioRepositoryPort } from "../ports/scenario-repository.js";
import type { ProfileRepositoryPort } from "../ports/profile-repository.js";
import type { CustomerCapsule, EvaluatorCapsule, PublicScenario, ScenarioEventCandidate } from "../scenarios/schema.js";

export interface PreloadedScenario {
  public: PublicScenario;
  customer: CustomerCapsule;
  evaluator: EvaluatorCapsule;
  events: ScenarioEventCandidate[];
}

/** Everything an application use case needs to coordinate domain + ports. */
export interface ApplicationDeps {
  runtime: AgentRuntime;
  store: EventStorePort;
  scenarios: ScenarioRepositoryPort;
  profiles: ProfileRepositoryPort;
  baseDir?: string;
  compiledRoot?: string;
  scenario?: PreloadedScenario;
}

export interface BuildDepsInput {
  runtime: AgentRuntime;
  baseDir?: string;
  compiledRoot?: string;
  scenario?: PreloadedScenario;
}

/** Wire the concrete modules into the ports. The concrete modules satisfy the
 *  ports structurally — no adapter change. */
export function buildDeps(input: BuildDepsInput): ApplicationDeps {
  return {
    runtime: input.runtime,
    store: { loadRun, loadEvents, appendEvents, readHead },
    scenarios: { loadScenarioBundle },
    profiles: { loadLearnerProfile, saveLearnerProfile, applyProfileAttemptEffect },
    baseDir: input.baseDir,
    compiledRoot: input.compiledRoot,
    scenario: input.scenario,
  };
}
