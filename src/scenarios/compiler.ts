import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { basename, dirname, join } from "path";
import { parse } from "yaml";
import {
  ScenarioAuthoringSchema,
  SCENARIO_MANIFEST_VERSION,
  SCENARIO_SCHEMA_VERSION,
  type ScenarioArtifactDescriptor,
  type ScenarioAuthoring,
  type ScenarioEventCandidate,
  type PublicScenario,
  type CustomerCapsule,
  type EvaluatorCapsule,
  type VerifiedScenarioManifest,
} from "./schema.js";
import { computeBundleDigest } from "./bundle.js";

/**
 * FDE Gym — scenario compiler.
 *
 * Compiles a bilingual YAML source document into a sealed, integrity-manifested
 * bundle under `scenarios/compiled/<scenario-id>/`: four role-independent
 * artifacts (`public.json`, `customer.json`, `evaluator.json`, `events.json`)
 * plus a `manifest.json` that carries each artifact's SHA-256 + byte length and
 * a root digest. The manifest is written last and the whole directory is
 * published atomically (build-in-staging → verify → rename), so a reader never
 * observes a partially-written bundle and a failed build leaves the previous
 * bundle untouched.
 *
 * The manifest never contains canary values or the canary seed; canaries are
 * injected only into the customer/evaluator capsules.
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
  manifestVersion: number;
  locale: string;
  canarySeed: string;
  publicScenario: PublicScenario;
  customerCapsule: CustomerCapsule;
  evaluatorCapsule: EvaluatorCapsule;
  eventCandidates: ScenarioEventCandidate[];
  /** The manifest's artifact descriptors (sha256 + bytes per artifact). */
  artifacts: ScenarioArtifactDescriptor[];
  /** Root digest over the canonical descriptors — the bundle's stable identity. */
  digest: string;
  manifest: VerifiedScenarioManifest;
}

function sha256Hex(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function descriptorFor(path: string, content: string): ScenarioArtifactDescriptor {
  const buf = Buffer.from(content, "utf8");
  return {
    path,
    sha256: sha256Hex(buf),
    bytes: buf.length,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
  };
}

/** Write a file to the staging dir and fsync its bytes. */
function writeAndSync(path: string, content: string): void {
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Atomically replace `target` with `staging`, preserving `target` on failure. */
function swapDirectory(staging: string, target: string): void {
  const parent = dirname(target);
  const backup = join(parent, `.${basename(target)}.${randomUUID()}.backup`);
  let hadTarget = false;
  try {
    renameSync(target, backup);
    hadTarget = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // No previous bundle to preserve.
  }
  try {
    renameSync(staging, target);
  } catch (error) {
    if (hadTarget) {
      try {
        renameSync(backup, target);
      } catch {
        // Best-effort restore; the original error is re-thrown below.
      }
    }
    throw error;
  }
  fsyncDir(parent);
  if (hadTarget) rmSync(backup, { recursive: true, force: true });
}

/**
 * Publish a compiled bundle atomically: write artifacts into a sibling staging
 * directory, reread and verify every descriptor, write the manifest LAST, sync,
 * then rename the staging directory into place. On any failure the staging
 * directory is removed and the previous bundle is left untouched.
 */
function publishBundle(
  targetDir: string,
  files: Array<{ name: string; content: string }>,
  manifestContent: string,
  artifacts: ScenarioArtifactDescriptor[],
): void {
  const parent = dirname(targetDir);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.${basename(targetDir)}.${randomUUID()}.staging`);
  mkdirSync(staging, { recursive: true });

  try {
    // 1. Build: write the artifact files.
    for (const file of files) {
      writeAndSync(join(staging, file.name), file.content);
    }

    // 2. Reread and verify every descriptor against the bytes actually on disk.
    for (const file of files) {
      const descriptor = artifacts.find((artifact) => artifact.path === file.name);
      if (!descriptor) throw new Error(`missing descriptor for ${file.name}`);
      const buf = readFileSync(join(staging, file.name));
      if (buf.length !== descriptor.bytes) {
        throw new Error(`byte length mismatch for ${file.name}`);
      }
      if (sha256Hex(buf) !== descriptor.sha256) {
        throw new Error(`hash mismatch for ${file.name}`);
      }
    }

    // 3. Write the manifest LAST (the seal).
    writeAndSync(join(staging, "manifest.json"), manifestContent);

    // 4. Sync the staging directory, then atomically move it into place.
    fsyncDir(staging);
    swapDirectory(staging, targetDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Compiles a scenario from a YAML source file into a sealed bundle.
 *
 * @param sourceYamlPath - Absolute or cwd-relative path to the YAML source file.
 * @param canarySeed - Seed string used to deterministically derive role canaries.
 * @param compiledRoot - Output root (defaults to `<cwd>/scenarios/compiled`).
 * @returns CompiledScenarioPack with all partitions, events, descriptors, and the manifest.
 * @throws ZodError if the source YAML fails validation against `ScenarioAuthoringSchema`.
 */
export function compileScenario(
  sourceYamlPath: string,
  canarySeed: string,
  compiledRoot: string = join(process.cwd(), "scenarios", "compiled"),
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

  const eventCandidates: ScenarioEventCandidate[] = validated.events;

  // Serialize each artifact exactly once (deterministic key order, pretty-printed).
  const publicJson = JSON.stringify(publicScenario, null, 2);
  const customerJson = JSON.stringify(customerCapsule, null, 2);
  const evaluatorJson = JSON.stringify(evaluatorCapsule, null, 2);
  const eventsJson = JSON.stringify(eventCandidates, null, 2);

  // Descriptors (sha256 + bytes) over those exact serialized bytes.
  const artifacts: ScenarioArtifactDescriptor[] = [
    descriptorFor("public.json", publicJson),
    descriptorFor("customer.json", customerJson),
    descriptorFor("evaluator.json", evaluatorJson),
    descriptorFor("events.json", eventsJson),
  ];

  // Root digest from the canonical manifest descriptors.
  const digest = computeBundleDigest(artifacts);

  // Manifest: metadata + descriptors + digest only. Never canaries or the seed.
  const manifest: VerifiedScenarioManifest = {
    manifestVersion: SCENARIO_MANIFEST_VERSION,
    id: validated.id,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    locale: validated.locale,
    digest,
    artifacts,
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  publishBundle(
    join(compiledRoot, validated.id),
    [
      { name: "public.json", content: publicJson },
      { name: "customer.json", content: customerJson },
      { name: "evaluator.json", content: evaluatorJson },
      { name: "events.json", content: eventsJson },
    ],
    manifestJson,
    artifacts,
  );

  return {
    id: validated.id,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    manifestVersion: SCENARIO_MANIFEST_VERSION,
    locale: validated.locale,
    canarySeed,
    publicScenario,
    customerCapsule,
    evaluatorCapsule,
    eventCandidates,
    artifacts,
    digest,
    manifest,
  };
}
