import { ZodError } from "zod";

import type { BriefValidationResult } from "../../../core/domain.js";

/**
 * FDE Gym — shared helpers for the PROBLEM_FRAMING subgraph (G3-02).
 *
 * These mirror the small deterministic helpers inlined in
 * `prepareFramingGate` WITHOUT importing the orchestrator (to avoid a cycle):
 * the guard-rejection error, the stable "no brief provided" code, the Zod issue
 * reducer, and the structure/coach result composer.
 */

/** Stable learner-visible code for a gate reached without a folded brief. */
export const FRAMING_BRIEF_NOT_PROVIDED = "FRAMING_BRIEF_NOT_PROVIDED" as const;

/**
 * A framing node rejection. Guard/agent nodes throw this (a stable `code` plus
 * minimal learner-safe `evidence` — ids/codes/paths only, never the rejected
 * payload) and the graph runtime maps the throw to the node's declared
 * `failurePolicy`.
 *
 * Domain-rejection guard OUTCOMES that are a durable learner-visible verdict
 * (structure/support fail) are deliberately NOT throws: they are carried as
 * `passed`/`code`/`evidence` in the node result so `brief.support.guard` can
 * author `brief.validated` (passed=false) — exactly as `prepareFramingGate`
 * returns a rejection instead of throwing.
 */
export class NodeGuardError extends Error {
  readonly code: string;
  readonly evidence?: unknown;
  constructor(code: string, message: string, evidence?: unknown) {
    super(message);
    this.name = "NodeGuardError";
    this.code = code;
    if (evidence !== undefined) this.evidence = evidence;
  }
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Reduce a Zod validation error to learner-safe evidence (codes + paths only). */
export function zodEvidence(error: ZodError): { codes: string[]; paths: string[][] } {
  const codes = [...new Set(error.issues.map((issue) => issue.code))];
  const paths = error.issues.map((issue) => issue.path.map(String));
  return { codes, paths };
}

/**
 * Compose the deterministic structure result with the Coach's semantic result.
 * Mirrors the orchestrator's private `composeBriefValidationResult`: `passed` is
 * the recomputed gate; `entailments` are the Coach's (semantic); the category /
 * claim unions are deduplicated; `feedback` is deterministic when the structure
 * gate failed and the Coach's (sanitized, public-only) feedback otherwise.
 */
export function composeBriefValidationResult(
  structure: BriefValidationResult,
  coach: BriefValidationResult | null,
  passed: boolean,
): BriefValidationResult {
  const missingCategories = dedupe([
    ...structure.missingCategories,
    ...(coach?.missingCategories ?? []),
  ]);
  const unsupportedClaimIds = dedupe([
    ...structure.unsupportedClaimIds,
    ...(coach?.unsupportedClaimIds ?? []),
  ]);
  const feedback = structure.passed ? (coach?.feedback ?? structure.feedback) : structure.feedback;
  return {
    passed,
    entailments: coach?.entailments ?? structure.entailments,
    missingCategories,
    unsupportedClaimIds,
    feedback,
  };
}
