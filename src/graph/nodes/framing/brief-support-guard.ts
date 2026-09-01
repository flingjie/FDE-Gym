import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { BriefValidationInvocation } from "../../../agents/coach.js";
import { BRIEF_VALIDATION_OUTPUT_SCHEMA_VERSION } from "../../../agents/contracts.js";
import type { BriefValidationResult, RunEvent } from "../../../core/domain.js";
import { calculateSupportRatio } from "../../../evidence/brief-validator.js";
import { BRIEF_STRUCTURE_INVALID, GUARD_IDS, briefSupportSufficient } from "../../guards.js";
import {
  FRAMING_BRIEF_NOT_PROVIDED,
  NodeGuardError,
  composeBriefValidationResult,
} from "./shared.js";

/**
 * `brief.support.guard` — the final gate: support ratio ≥ 0.75 (guard).
 *
 * Composes the structural result with the Coach's semantic result, recomputes
 * the weighted support ratio (`brief-support-sufficient`, `GUARD_IDS.BRIEF_
 * SUPPORT_SUFFICIENT`), and authors the durable verdict: `brief.validated`
 * ALWAYS, plus `phase.changed` (PROBLEM_FRAMING → SOLUTION_DESIGN) only on pass.
 * A rejection is returned as `passed=false` (never thrown) — it stays in
 * PROBLEM_FRAMING with no `phase.changed`, exactly as `prepareFramingGate`
 * does.
 *
 * Protocol: `EVENT_PROTOCOLS["submit-brief"]` (`brief.validated` here; the
 * optional `phase.changed` accompanies it on pass).
 */
export interface BriefSupportGuardInput {
  state: RunAggregate;
  structure: BriefValidationResult;
  coachResult: BriefValidationInvocation | null;
  commandId: string;
  /** The verified scenario-bundle digest (judgment provenance only). */
  scenarioBundleDigest?: string;
}

export interface BriefSupportGuardResult extends NodeExecution {
  passed: boolean;
  supportRatio: number;
  /** The composed validation result persisted in `brief.validated`. */
  result: BriefValidationResult;
  /** The `guards.ts` id this node evaluates. */
  guardId: string;
  /** Stable failure code when the gate rejects (structure or support). */
  code?: string;
  evidence?: unknown;
}

export async function runBriefSupportGuard(
  input: BriefSupportGuardInput,
): Promise<BriefSupportGuardResult> {
  const { state, structure, coachResult, commandId } = input;
  const runId = state.runId;
  const brief = state.brief;
  if (brief === null) {
    throw new NodeGuardError(FRAMING_BRIEF_NOT_PROVIDED, "brief.support.guard requires a folded brief");
  }

  const entailments = coachResult?.result.entailments ?? structure.entailments;
  const support = briefSupportSufficient(brief.claims, entailments);
  const supportRatio = calculateSupportRatio(brief.claims, entailments);
  const passed = structure.passed && support.ok;

  const result = composeBriefValidationResult(structure, coachResult?.result ?? null, passed);

  const validatedEvent: RunEvent =
    coachResult !== null
      ? {
          type: "brief.validated",
          runId,
          commandId,
          briefId: brief.id,
          result,
          judgment: {
            judgmentId: `${commandId}:coach`,
            invocationId: coachResult.invocationId,
            modelId: coachResult.modelId,
            promptDigest: coachResult.promptDigest,
            schemaVersion: BRIEF_VALIDATION_OUTPUT_SCHEMA_VERSION,
            scenarioDigest: input.scenarioBundleDigest ?? "",
            rawOutputDigest: coachResult.rawOutputDigest,
          },
        }
      : { type: "brief.validated", runId, commandId, briefId: brief.id, result };

  const events: RunEvent[] = [validatedEvent];
  let phase = state.phase;
  if (passed) {
    events.push({
      type: "phase.changed",
      runId,
      commandId,
      from: "PROBLEM_FRAMING",
      to: "SOLUTION_DESIGN",
    });
    phase = "SOLUTION_DESIGN";
  }

  const code = !structure.passed ? BRIEF_STRUCTURE_INVALID : support.ok ? undefined : support.code;
  const evidence = !structure.passed
    ? { missingCategories: structure.missingCategories, unsupportedClaimIds: structure.unsupportedClaimIds }
    : support.ok
      ? undefined
      : support.evidence;

  return {
    events,
    updatedState: { ...state, brief, phase },
    passed,
    supportRatio,
    result,
    guardId: GUARD_IDS.BRIEF_SUPPORT_SUFFICIENT,
    code,
    evidence,
  };
}

export const briefSupportGuard: NodeHandler<BriefSupportGuardInput> = {
  definition: { id: "brief.support.guard", phase: "PROBLEM_FRAMING", kind: "guard" },
  run: runBriefSupportGuard,
};
