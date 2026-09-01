import type { NodeExecution, NodeHandler } from "../node.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { AgentRuntime } from "../../../agents/agent-runtime.js";
import { validateProblemBrief, type BriefValidationInvocation } from "../../../agents/coach.js";
import type { BriefValidationResult } from "../../../core/domain.js";
import type { EvaluatorCapsule } from "../../../scenarios/schema.js";
import { BRIEF_DANGLING_EVIDENCE_REFERENCE } from "../../../evidence/brief-validator.js";
import { FRAMING_BRIEF_NOT_PROVIDED, NodeGuardError } from "./shared.js";

/**
 * `coach.brief.invoke` — the Coach entailment classification (agent).
 *
 * Delegates to `validateProblemBrief`, which builds the strict brief-validation
 * input through the context firewall (`coachTask: "brief-validation"`), invokes
 * the `AgentRuntime` under the `coach_evaluator` role, and sanitizes/validates
 * the entailment classification. A dangling evidence reference makes the
 * Coach's strict input schema reject the brief, so classification is skipped in
 * that already-failing case (mirrors `prepareFramingGate`).
 *
 * On failure it THROWS (the runtime's failure policy retries then routes); the
 * node produces NO events on success — the `BriefValidationInvocation` is carried
 * in the result for `brief.support.guard` to compose `brief.validated`.
 */
export interface CoachBriefInvokeInput {
  runtime: AgentRuntime;
  /** Must carry `coachTask: "brief-validation"` and the folded brief. */
  state: RunAggregate;
  capsule: EvaluatorCapsule;
  /** The structural gate's result (a dangling reference skips the Coach). */
  structure: BriefValidationResult;
  commandId: string;
  timeoutMs?: number;
  canaries?: readonly string[];
}

export interface CoachBriefInvokeResult extends NodeExecution {
  /** `null` when classification was skipped (dangling evidence reference). */
  coachResult: BriefValidationInvocation | null;
}

export async function runCoachBriefInvoke(
  input: CoachBriefInvokeInput,
): Promise<CoachBriefInvokeResult> {
  const { runtime, state, capsule, structure, commandId } = input;
  const brief = state.brief;
  if (brief === null) {
    throw new NodeGuardError(FRAMING_BRIEF_NOT_PROVIDED, "coach.brief.invoke requires a folded brief");
  }

  const timeoutMs = input.timeoutMs ?? 60_000;
  const canaries = input.canaries ?? [capsule.canary];

  let coachResult: BriefValidationInvocation | null = null;
  if (!structure.missingCategories.includes(BRIEF_DANGLING_EVIDENCE_REFERENCE)) {
    coachResult = await validateProblemBrief({
      runtime,
      state: { ...state, coachTask: "brief-validation", brief },
      capsule,
      invocationId: `${commandId}:coach`,
      timeoutMs,
      canaries,
    });
  }

  return { events: [], updatedState: state, coachResult };
}

export const coachBriefInvoke: NodeHandler<CoachBriefInvokeInput> = {
  definition: {
    id: "coach.brief.invoke",
    phase: "PROBLEM_FRAMING",
    kind: "agent",
    contextPolicy: { role: "coach_evaluator", capsule: "evaluator" },
    failurePolicy: { failureClass: "INVALID_MODEL_OUTPUT", retry: true, maxAttempts: 1 },
  },
  run: runCoachBriefInvoke,
};
