import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { parse } from "yaml";
import { ScenarioAuthoringSchema, SCENARIO_SCHEMA_VERSION } from "./schema.js";
import type {
  ScenarioAuthoring,
  PublicScenario,
  CustomerCapsule,
  EvaluatorCapsule,
} from "./schema.js";

/**
 * FDE Gym — scenario compiler.
 *
 * Compiles a bilingual YAML source document into three structurally independent
 * role partitions (public, customer, evaluator), injects role canaries, and
 * writes the generated JSON files under scenarios/compiled/<scenario-id>/.
 *
 * Canary derivation: each role canary is a SHA-256 digest of `canarySeed` plus
 * a fixed role tag. This is deterministic (same seed -> same canaries) and is
 * derived only from the seed, never from any hidden content, so a canary cannot
 * be reverse-engineered from — nor does it leak — the scenario's hidden facts.
 */

const ROLE_IDS = {
  CUSTOMER: "customer",
  EVALUATOR: "evaluator",
} as const;

/**
 * Derives a deterministic, content-independent canary for a role.
 *
 * Uses SHA-256(seed + role tag) truncated to 32 hex chars. The input is the
 * caller-supplied seed and a fixed role tag only — no scenario content is mixed
 * in, so the canary carries no information about hidden facts.
 */
function deriveCanary(seed: string, role: string): string {
  return createHash("sha256").update(seed + role).digest("hex").substring(0, 32);
}

/** Compiled scenario package returned by `compileScenario`. */
export interface CompiledScenarioPack {
  id: string;
  schemaVersion: number;
  locale: string;
  canarySeed: string;
  publicScenario: PublicScenario;
  customerCapsule: CustomerCapsule;
  evaluatorCapsule: EvaluatorCapsule;
  manifest: ScenarioManifest;
}

/** Metadata manifest written to `manifest.json`. Never contains canary values. */
export interface ScenarioManifest {
  id: string;
  schemaVersion: number;
  locale: string;
  files: {
    public: string;
    customer: string;
    evaluator: string;
  };
}

/**
 * Compiles a scenario from a YAML source file into three role partitions.
 *
 * @param sourceYamlPath - Absolute or cwd-relative path to the YAML source file.
 * @param canarySeed - Seed string used to deterministically derive role canaries.
 * @returns CompiledScenarioPack with all partitions and the manifest.
 * @throws ZodError if the source YAML fails validation against `ScenarioAuthoringSchema`.
 */
export function compileScenario(
  sourceYamlPath: string,
  canarySeed: string,
): CompiledScenarioPack {
  const yamlContent = readFileSync(sourceYamlPath, "utf-8");
  const parsed = parse(yamlContent);

  const validated: ScenarioAuthoring = ScenarioAuthoringSchema.parse(parsed);

  const customerCanary = deriveCanary(canarySeed, ROLE_IDS.CUSTOMER);
  const evaluatorCanary = deriveCanary(canarySeed, ROLE_IDS.EVALUATOR);

  // Public partition: learner-visible content only. No hidden facts, no canary.
  const publicScenario: PublicScenario = {
    id: validated.id,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    locale: validated.locale,
    openingRequest: validated.public.openingRequest,
    visibleContext: validated.public.visibleContext,
    visibleConstraints: validated.public.visibleConstraints,
    deliverables: validated.public.deliverables,
    learnerRules: validated.public.learnerRules,
    questionBudget: validated.public.questionBudget,
  };

  // Customer partition: hidden facts + role canary.
  const customerCapsule: CustomerCapsule = {
    id: validated.id,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    stakeholders: validated.customer.stakeholders,
    disclosureUnits: validated.customer.disclosureUnits,
    responsePolicies: validated.customer.responsePolicies,
    privateConflicts: validated.customer.privateConflicts,
    canary: customerCanary,
  };

  // Evaluator partition: evaluation criteria + role canary.
  const evaluatorCapsule: EvaluatorCapsule = {
    id: validated.id,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    expectedEvidence: validated.evaluator.expectedEvidence,
    rubric: validated.evaluator.rubric,
    criticalContradictions: validated.evaluator.criticalContradictions,
    hintLadders: validated.evaluator.hintLadders,
    passGates: validated.evaluator.passGates,
    canary: evaluatorCanary,
  };

  // Manifest: metadata only. Must not carry canary values or hidden content.
  const manifest: ScenarioManifest = {
    id: validated.id,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    locale: validated.locale,
    files: {
      public: "public.json",
      customer: "customer.json",
      evaluator: "evaluator.json",
    },
  };

  const compiledDir = join(process.cwd(), "scenarios", "compiled", validated.id);
  mkdirSync(compiledDir, { recursive: true });

  writeFileSync(join(compiledDir, "public.json"), JSON.stringify(publicScenario, null, 2));
  writeFileSync(join(compiledDir, "customer.json"), JSON.stringify(customerCapsule, null, 2));
  writeFileSync(join(compiledDir, "evaluator.json"), JSON.stringify(evaluatorCapsule, null, 2));
  writeFileSync(join(compiledDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return {
    id: validated.id,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    locale: validated.locale,
    canarySeed,
    publicScenario,
    customerCapsule,
    evaluatorCapsule,
    manifest,
  };
}
