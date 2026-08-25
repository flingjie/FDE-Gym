import {
  defaultCompiledRoot,
  loadScenarioBundle,
} from "./bundle.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
} from "./schema.js";
import type { AgentRole } from "../core/domain.js";

/**
 * FDE Gym — scenario loader.
 *
 * Thin, role-scoped wrappers over the single manifest-root `loadScenarioBundle`
 * (Task 7). Every role view — customer capsule, evaluator capsule, or the
 * learner-visible public partition — is loaded through the SAME verified bundle,
 * so a tampered/missing/stale artifact fails before any role view is returned.
 * The authoring source (`scenarios/source/*.yaml`) is build-time input only and
 * is never opened here.
 *
 * Role -> partition mapping (AgentRole is fixed by Task 2 in `core/domain.ts`):
 *   - `customer`         -> customer.json  (CustomerCapsule)
 *   - `evidence_tracker` -> evaluator.json (EvaluatorCapsule)
 *   - `coach_evaluator`  -> evaluator.json (EvaluatorCapsule)
 * The public (learner-visible) partition is not an agent role; it is loaded via
 * `loadPublicScenario`.
 */

function unknownRoleError(role: unknown): Error {
  return new Error(
    `Unknown role: ${String(role)}. Valid roles are: customer, evidence_tracker, coach_evaluator`,
  );
}

/**
 * Loads the partition for the given agent role through a fully verified bundle.
 *
 * @param id - Scenario id (e.g. "manufacturing-alert-triage").
 * @param role - Agent role requesting the partition.
 * @returns The role's capsule.
 * @throws Error for an unknown role or a missing/invalid scenario id.
 */
export function loadScenarioForRole(id: string, role: "customer"): CustomerCapsule;
export function loadScenarioForRole(
  id: string,
  role: "evidence_tracker" | "coach_evaluator",
): EvaluatorCapsule;
export function loadScenarioForRole(
  id: string,
  role: AgentRole,
): CustomerCapsule | EvaluatorCapsule {
  switch (role) {
    case "customer":
      return loadScenarioBundle(id, { compiledRoot: defaultCompiledRoot() }).customerCapsule;
    case "evidence_tracker":
    case "coach_evaluator":
      return loadScenarioBundle(id, { compiledRoot: defaultCompiledRoot() }).evaluatorCapsule;
    default:
      // Unreachable for a well-typed caller; kept for runtime defense.
      throw unknownRoleError(role);
  }
}

/**
 * Loads the learner-visible public partition through a fully verified bundle.
 *
 * @param id - Scenario id.
 * @returns PublicScenario.
 * @throws Error if the scenario id is not found.
 */
export function loadPublicScenario(id: string): PublicScenario {
  return loadScenarioBundle(id, { compiledRoot: defaultCompiledRoot() }).publicScenario;
}

/** Convenience: loads the customer capsule for an id. */
export function loadCustomerCapsule(id: string): CustomerCapsule {
  return loadScenarioForRole(id, "customer");
}

/** Convenience: loads the evaluator capsule for an id. */
export function loadEvaluatorCapsule(id: string): EvaluatorCapsule {
  return loadScenarioForRole(id, "evidence_tracker");
}
