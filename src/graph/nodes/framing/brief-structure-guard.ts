import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { BriefValidationResult } from "../../../core/domain.js";
import { validateBriefStructure } from "../../../evidence/brief-validator.js";
import { GUARD_IDS } from "../../guards.js";
import { FRAMING_BRIEF_NOT_PROVIDED, NodeGuardError } from "./shared.js";

/**
 * `brief.structure.guard` — the deterministic structural gate (guard).
 *
 * Runs `validateBriefStructure` (the `brief-structure-valid` guard,
 * `GUARD_IDS.BRIEF_STRUCTURE_VALID`; the schema parse already ran at
 * `brief.accept`). The result is CARRIED (not thrown) so the Coach can still
 * classify a non-dangling structure failure and `brief.support.guard` can
 * compose the durable `brief.validated` verdict — the framing gate's rejection
 * is a learner-visible record, not an execution failure.
 *
 * Protocol: `EVENT_PROTOCOLS["submit-brief"]` (no events authored here).
 */
export interface BriefStructureGuardInput {
  /** Aggregate whose `brief` was folded by `brief.accept`. */
  state: RunAggregate;
}

export interface BriefStructureGuardResult extends NodeExecution {
  /** The pure structural gate's result (`passed` = structure valid). */
  structure: BriefValidationResult;
  /** `structure.passed` — carried for the support guard to compose. */
  passed: boolean;
  /** The `guards.ts` id this node evaluates. */
  guardId: string;
}

export async function runBriefStructureGuard(
  input: BriefStructureGuardInput,
): Promise<BriefStructureGuardResult> {
  const { state } = input;
  const brief = state.brief;
  if (brief === null) {
    throw new NodeGuardError(FRAMING_BRIEF_NOT_PROVIDED, "brief.structure.guard requires a folded brief");
  }

  const structure = validateBriefStructure(brief, state.graph);
  return {
    events: [],
    updatedState: state,
    structure,
    passed: structure.passed,
    guardId: GUARD_IDS.BRIEF_STRUCTURE_VALID,
  };
}

export const briefStructureGuard: NodeHandler<BriefStructureGuardInput> = {
  definition: { id: "brief.structure.guard", phase: "PROBLEM_FRAMING", kind: "guard" },
  run: runBriefStructureGuard,
};
