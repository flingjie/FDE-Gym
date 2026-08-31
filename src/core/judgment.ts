import { z } from "zod";

/**
 * FDE Gym — provenance for a single model judgment.
 *
 * Attached (optionally) to judgment-bearing events so "who judged, with which
 * model and prompt, and why a score changed when the model changed" is
 * answerable from the committed event log. Provenance-only: the judgment's
 * value lives in the event's own payload field (`assessment` / `result` /
 * `review`); this envelope never duplicates it and never carries raw output —
 * only its digest.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const JudgmentProvenanceSchema = z
  .object({
    /** Deterministic id, e.g. `<commandId>:<role>` — correlates to the invocation. */
    judgmentId: z.string().min(1),
    invocationId: z.string().min(1),
    modelId: z.string().min(1).nullable(),
    modelRevision: z.string().min(1).optional(),
    /** sha256 of the rendered role prompt. */
    promptDigest: z.string().regex(SHA256_HEX),
    /** The role output schema version that validated `value`. */
    schemaVersion: z.number().int().positive(),
    /** The verified scenario-bundle digest recorded at run start. */
    scenarioDigest: z.string().regex(SHA256_HEX),
    temperature: z.number().optional(),
    /** sha256 of the pre-validation raw output (raw text never persisted). */
    rawOutputDigest: z.string().regex(SHA256_HEX),
  })
  .strict();

export type JudgmentProvenance = z.infer<typeof JudgmentProvenanceSchema>;
