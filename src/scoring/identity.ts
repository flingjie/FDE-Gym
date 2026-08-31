import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../storage/canonical-json.js";
import { CAPABILITY_RUBRIC_VERSION } from "./rubric.js";
import { SCORE_SCHEMA_VERSION, FORMULA_VERSION } from "./provenance.js";

/** Manual version bumped when the runtime's observable behavior changes (timeout,
 *  structured-output approach, cancellation semantics). Provenance-only. */
export const RUNTIME_POLICY_VERSION = 1 as const;

/** The content-addressed identity that determines score comparability. */
export interface EvaluationIdentity {
  scenarioDigest: string;      // scenarioBundleSha256 ("" for provenance-legacy)
  promptSetDigest: string;     // sha256 over the three role prompt templates
  rubricVersion: number;       // CAPABILITY_RUBRIC_VERSION
  scoreSchemaVersion: number;  // SCORE_SCHEMA_VERSION
  formulaVersion: number;      // FORMULA_VERSION
  runtimePolicyVersion: number;// RUNTIME_POLICY_VERSION
  modelFamily: string | null;  // modelId
}

const PROMPT_FILES = ["coach-evaluator.md", "customer.md", "evidence-tracker.md"] as const;

function promptDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "resources", "prompts");
}

/** sha256 over the three prompt template files, in sorted filename order. */
export function promptSetDigest(): string {
  const hash = createHash("sha256");
  for (const file of [...PROMPT_FILES].sort()) {
    hash.update(file);
    hash.update("\u0000");
    hash.update(readFileSync(join(promptDir(), file), "utf8"));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

export interface ComputeIdentityInput {
  scenarioBundleSha256: string | null;
  modelId: string | null;
}

/** Build the full identity from what `buildScoreProvenance` already has. */
export function computeEvaluationIdentity(input: ComputeIdentityInput): EvaluationIdentity {
  return {
    scenarioDigest: input.scenarioBundleSha256 ?? "",
    promptSetDigest: promptSetDigest(),
    rubricVersion: CAPABILITY_RUBRIC_VERSION,
    scoreSchemaVersion: SCORE_SCHEMA_VERSION,
    formulaVersion: FORMULA_VERSION,
    runtimePolicyVersion: RUNTIME_POLICY_VERSION,
    modelFamily: input.modelId,
  };
}

/** The comparability key: sha256 over the canonical JSON of the full identity. */
export function computeEvaluationIdentityHash(identity: EvaluationIdentity): string {
  return createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex");
}
