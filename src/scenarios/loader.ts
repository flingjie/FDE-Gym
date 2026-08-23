import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import {
  PublicScenarioSchema,
  CustomerCapsuleSchema,
  EvaluatorCapsuleSchema,
  ScenarioAuthoringSchema,
} from "./schema.js";
import type {
  PublicScenario,
  CustomerCapsule,
  EvaluatorCapsule,
  ScenarioEventCandidate,
} from "./schema.js";
import type { AgentRole } from "../core/domain.js";

/**
 * FDE Gym — scenario loader.
 *
 * Loads a role-specific scenario partition from the compiled JSON files under
 * `scenarios/compiled/<id>/`. Each role receives exactly its own partition and
 * never the authoring source or a cross-role partition.
 *
 * Role -> partition mapping (AgentRole is fixed by Task 2 in `core/domain.ts`):
 *   - `customer`         -> customer.json  (CustomerCapsule)
 *   - `evidence_tracker` -> evaluator.json (EvaluatorCapsule)
 *   - `coach_evaluator`  -> evaluator.json (EvaluatorCapsule)
 * The public (learner-visible) partition is not an agent role; it is loaded via
 * `loadPublicScenario`.
 */

const COMPILED_BASE_DIR = join(process.cwd(), "scenarios", "compiled");

function scenarioNotFoundError(id: string): Error {
  return new Error(`Scenario not found: ${id}`);
}

function unknownRoleError(role: unknown): Error {
  return new Error(
    `Unknown role: ${String(role)}. Valid roles are: customer, evidence_tracker, coach_evaluator`,
  );
}

/**
 * Loads the partition for the given agent role.
 *
 * @param id - Scenario id (e.g. "manufacturing-alert-triage").
 * @param role - Agent role requesting the partition.
 * @returns The role's capsule.
 * @throws Error for an unknown role or a missing scenario id.
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
  const scenarioDir = join(COMPILED_BASE_DIR, id);

  let filePath: string;
  switch (role) {
    case "customer":
      filePath = join(scenarioDir, "customer.json");
      break;
    case "evidence_tracker":
    case "coach_evaluator":
      filePath = join(scenarioDir, "evaluator.json");
      break;
    default:
      // Unreachable for a well-typed caller; kept for runtime defense.
      throw unknownRoleError(role);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw scenarioNotFoundError(id);
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (role === "customer") {
    return CustomerCapsuleSchema.parse(parsed);
  }
  return EvaluatorCapsuleSchema.parse(parsed);
}

/**
 * Loads the learner-visible public partition.
 *
 * @param id - Scenario id.
 * @returns PublicScenario.
 * @throws Error if the scenario id is not found.
 */
export function loadPublicScenario(id: string): PublicScenario {
  const filePath = join(COMPILED_BASE_DIR, id, "public.json");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw scenarioNotFoundError(id);
    }
    throw err;
  }
  return PublicScenarioSchema.parse(JSON.parse(raw));
}

/** Convenience: loads the customer capsule for an id. */
export function loadCustomerCapsule(id: string): CustomerCapsule {
  return loadScenarioForRole(id, "customer");
}

/** Convenience: loads the evaluator capsule for an id. */
export function loadEvaluatorCapsule(id: string): EvaluatorCapsule {
  return loadScenarioForRole(id, "evidence_tracker");
}

/**
 * Loads the scenario's authored event candidates (challenge/constraint changes)
 * from the source YAML. The compiled partitions intentionally omit these
 * (`events` are only in the authoring source); the CLI's challenge injection
 * needs them.
 */
export function loadScenarioEventCandidates(id: string): ScenarioEventCandidate[] {
  const sourcePath = join(process.cwd(), "scenarios", "source", `${id}.yaml`);
  let raw: string;
  try {
    raw = readFileSync(sourcePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw scenarioNotFoundError(id);
    }
    throw err;
  }
  const authoring = ScenarioAuthoringSchema.parse(parse(raw));
  return authoring.events;
}
