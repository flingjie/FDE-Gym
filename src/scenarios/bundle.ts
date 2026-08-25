import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { assertSafeResourceId, canonicalJson } from "../core/event-store.js";
import {
  ScenarioBundleInvalidError,
  UnsupportedSchemaVersionError,
} from "../core/errors.js";
import {
  CustomerCapsuleSchema,
  EvaluatorCapsuleSchema,
  PublicScenarioSchema,
  ScenarioEventsFileSchema,
  ScenarioManifestSchema,
  SCENARIO_SCHEMA_VERSION,
  type CustomerCapsule,
  type EvaluatorCapsule,
  type PublicScenario,
  type ScenarioArtifactDescriptor,
  type ScenarioEventCandidate,
  type VerifiedScenarioManifest,
} from "./schema.js";

/**
 * FDE Gym — scenario bundle loader (Task 7).
 *
 * A compiled scenario is an integrity-sealed directory under `compiledRoot/<id>/`
 * containing exactly four artifacts (`public.json`, `customer.json`,
 * `evaluator.json`, `events.json`) plus a `manifest.json` that carries each
 * artifact's SHA-256 + byte length and a root `digest` over those canonical
 * descriptors. `loadScenarioBundle` is the ONE manifest-root loader: it verifies
 * the manifest version, descriptor path containment, every artifact's hash and
 * byte length, and the id/schema cross-check BEFORE parsing, then returns a
 * single immutable `ScenarioBundle`. Role partitions never read the authoring
 * YAML — `scenarios/source/*.yaml` is build-time input only.
 */

export const SCENARIO_MANIFEST_VERSION = 2 as const;

/** The four artifacts a compiled bundle must contain, in canonical write order. */
const ARTIFACT_PATHS = ["public.json", "customer.json", "evaluator.json", "events.json"] as const;
const ARTIFACT_PATH_SET: ReadonlySet<string> = new Set<string>(ARTIFACT_PATHS);

/** The compiled-bundle root when none is supplied (repo-local `scenarios/compiled`). */
export function defaultCompiledRoot(): string {
  return join(process.cwd(), "scenarios", "compiled");
}

/** An immutable, fully-verified scenario bundle (the runtime's only scenario source). */
export interface ScenarioBundle {
  manifest: VerifiedScenarioManifest;
  publicScenario: PublicScenario;
  customerCapsule: CustomerCapsule;
  evaluatorCapsule: EvaluatorCapsule;
  eventCandidates: readonly ScenarioEventCandidate[];
  bundleDigest: string;
}

export interface ScenarioLoadOptions {
  compiledRoot: string;
}

function sha256Hex(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The root digest of a manifest's descriptors — the bundle's stable identity.
 * Computed from the canonical (key-sorted) serialization of the descriptor array.
 */
export function computeBundleDigest(
  descriptors: readonly ScenarioArtifactDescriptor[],
): string {
  return createHash("sha256").update(canonicalJson(descriptors), "utf8").digest("hex");
}

function scenarioNotFoundError(id: string): Error {
  return new Error(`Scenario not found: ${id}`);
}

function isPathTraversal(path: string): boolean {
  return (
    path.length === 0 ||
    path !== basename(path) ||
    path === "." ||
    path === ".." ||
    path.includes("/") ||
    path.includes("\\") ||
    path.startsWith(".")
  );
}

/**
 * Load and fully verify one compiled scenario bundle.
 *
 * Algorithm (fail-closed at every step):
 *   safe scenario ID validation
 *   -> manifest parse/version check
 *   -> descriptor path containment + exact artifact-set check
 *   -> read all four artifacts
 *   -> hash/byte verification
 *   -> id/schema cross-check
 *   -> strict Zod parse
 *   -> return one immutable bundle
 */
export function loadScenarioBundle(id: string, options: ScenarioLoadOptions): ScenarioBundle {
  assertSafeResourceId("scenario", id);

  const root = resolve(options.compiledRoot);
  const dir = join(root, id);

  // Manifest parse + version check.
  const manifestPath = join(dir, "manifest.json");
  let manifestRaw: Buffer;
  try {
    manifestRaw = readFileSync(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw scenarioNotFoundError(id);
    throw error;
  }
  let manifestParsed: unknown;
  try {
    manifestParsed = JSON.parse(manifestRaw.toString("utf8"));
  } catch {
    throw new ScenarioBundleInvalidError(id, "manifest is not valid JSON");
  }
  const manifest = ScenarioManifestSchema.parse(manifestParsed);

  // Root digest must match the canonical descriptors.
  const recomputedDigest = computeBundleDigest(manifest.artifacts);
  if (manifest.digest !== recomputedDigest) {
    throw new ScenarioBundleInvalidError(id, "manifest digest mismatch");
  }

  // Exact artifact set: no missing, extra, or duplicate descriptors.
  const byPath = new Map<string, ScenarioArtifactDescriptor>();
  for (const descriptor of manifest.artifacts) {
    if (byPath.has(descriptor.path)) {
      throw new ScenarioBundleInvalidError(id, `duplicate artifact descriptor: ${descriptor.path}`);
    }
    byPath.set(descriptor.path, descriptor);
  }
  if (byPath.size !== ARTIFACT_PATHS.length) {
    throw new ScenarioBundleInvalidError(id, "artifact descriptor count does not match the bundle contract");
  }
  for (const path of ARTIFACT_PATHS) {
    if (!byPath.has(path)) {
      throw new ScenarioBundleInvalidError(id, `missing artifact descriptor: ${path}`);
    }
  }
  for (const descriptor of manifest.artifacts) {
    if (!ARTIFACT_PATH_SET.has(descriptor.path)) {
      throw new ScenarioBundleInvalidError(id, `unexpected artifact descriptor: ${descriptor.path}`);
    }
    if (isPathTraversal(descriptor.path)) {
      throw new ScenarioBundleInvalidError(id, `artifact path escapes the bundle: ${descriptor.path}`);
    }
  }

  // Read all four artifacts, verifying exact bytes + hash against the descriptor.
  function readVerified(path: string): Buffer {
    let buf: Buffer;
    try {
      buf = readFileSync(join(dir, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ScenarioBundleInvalidError(id, `missing artifact file: ${path}`);
      }
      throw error;
    }
    const descriptor = byPath.get(path)!;
    if (buf.length !== descriptor.bytes) {
      throw new ScenarioBundleInvalidError(id, `byte length mismatch for ${path}`);
    }
    if (sha256Hex(buf) !== descriptor.sha256) {
      throw new ScenarioBundleInvalidError(id, `hash mismatch for ${path}`);
    }
    return buf;
  }

  const publicRaw = readVerified("public.json");
  const customerRaw = readVerified("customer.json");
  const evaluatorRaw = readVerified("evaluator.json");
  const eventsRaw = readVerified("events.json");

  // Id/schema cross-check BEFORE strict parse, so a version drift fails with the
  // stable UNSUPPORTED_SCHEMA_VERSION code rather than a generic Zod error.
  function readPartitionJson(raw: Buffer, label: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new ScenarioBundleInvalidError(id, `${label} partition is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ScenarioBundleInvalidError(id, `${label} partition is not an object`);
    }
    return parsed as Record<string, unknown>;
  }

  const publicRecord = readPartitionJson(publicRaw, "public");
  const customerRecord = readPartitionJson(customerRaw, "customer");
  const evaluatorRecord = readPartitionJson(evaluatorRaw, "evaluator");

  for (const [label, record] of [
    ["public", publicRecord],
    ["customer", customerRecord],
    ["evaluator", evaluatorRecord],
  ] as const) {
    if (record.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(
        `${label} partition for scenario ${id}`,
        record.schemaVersion,
      );
    }
    if (record.id !== id) {
      throw new ScenarioBundleInvalidError(id, `${label} partition id mismatch`);
    }
  }

  // Strict Zod parse of every artifact.
  const publicScenario = PublicScenarioSchema.parse(publicRecord);
  const customerCapsule = CustomerCapsuleSchema.parse(customerRecord);
  const evaluatorCapsule = EvaluatorCapsuleSchema.parse(evaluatorRecord);

  let eventsParsed: unknown;
  try {
    eventsParsed = JSON.parse(eventsRaw.toString("utf8"));
  } catch {
    throw new ScenarioBundleInvalidError(id, "events artifact is not valid JSON");
  }
  const eventCandidates = ScenarioEventsFileSchema.parse(eventsParsed);

  return {
    manifest,
    publicScenario,
    customerCapsule,
    evaluatorCapsule,
    eventCandidates,
    bundleDigest: manifest.digest,
  };
}
