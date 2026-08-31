import type { ScenarioBundle, ScenarioLoadOptions } from "../scenarios/bundle.js";

export interface ScenarioRepositoryPort {
  loadScenarioBundle(id: string, options: ScenarioLoadOptions): ScenarioBundle;
}
