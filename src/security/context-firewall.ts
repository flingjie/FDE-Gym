import { z } from "zod";
import type { AgentRole } from "../core/domain.js";
import { RunAggregateSchema, type RunAggregate } from "../core/aggregate.js";
import {
  BriefValidationInputSchema,
  CustomerInputSchema,
  EvidenceTrackerInputSchema,
  FinalReviewInputSchema,
  type BriefValidationInput,
  type CustomerInput,
  type EvidenceTrackerInput,
  type FinalReviewInput,
} from "../agents/contracts.js";
import type { CustomerCapsule, EvaluatorCapsule } from "../scenarios/schema.js";
import { RUBRIC } from "../scoring/rubric.js";

/**
 * FDE Gym — role-scoped context firewall.
 *
 * `buildRoleInput(role, state, capsule)` is the security boundary between the
 * internal run aggregate (which may legitimately hold hidden evaluator/customer
 * facts) and the strict role INPUT schemas. It CONSTRUCTS each role input
 * field-by-field from an explicit per-role allowlist — it never spreads the
 * aggregate or the capsule, so a field not on a role's allowlist cannot enter
 * that role's input even by accident. The role schemas' `.strict()` reject
 * extras as defense-in-depth, and any aggregate field this firewall does not
 * recognize causes it to FAIL CLOSED rather than be silently ignored.
 */

// ---------------------------------------------------------------------------
// Error surface (stable codes; never carry payload content)
// ---------------------------------------------------------------------------

export const FIREWALL_UNRECOGNIZED_FIELD = "FIREWALL_UNRECOGNIZED_FIELD" as const;
export const FIREWALL_CAPSULE_FORBIDDEN = "FIREWALL_CAPSULE_FORBIDDEN" as const;
export const FIREWALL_INVALID_STATE = "FIREWALL_INVALID_STATE" as const;

export class ContextFirewallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ContextFirewallError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Capsule discrimination (lightweight, structural — no full re-validation)
// ---------------------------------------------------------------------------

function isEvaluatorCapsule(capsule: unknown): boolean {
  if (typeof capsule !== "object" || capsule === null) return false;
  const record = capsule as Record<string, unknown>;
  return "rubric" in record || "expectedEvidence" in record;
}

function isCustomerCapsule(capsule: unknown): boolean {
  if (typeof capsule !== "object" || capsule === null) return false;
  const record = capsule as Record<string, unknown>;
  return "stakeholders" in record || "disclosureUnits" in record;
}

// ---------------------------------------------------------------------------
// The role input union
// ---------------------------------------------------------------------------

export type RoleInput =
  | { kind: "customer"; input: CustomerInput }
  | { kind: "evidence_tracker"; input: EvidenceTrackerInput }
  | { kind: "brief-validation"; input: BriefValidationInput }
  | { kind: "final-review"; input: FinalReviewInput };

/**
 * The role's strict INPUT schema, used by the role runtime to fail closed on
 * a caller who hands a role an input (e.g. an evaluator capsule) it must never
 * see. The coach accepts exactly one of its two input shapes.
 */
export function roleInputSchema(role: AgentRole): z.ZodType<unknown> {
  switch (role) {
    case "customer":
      return CustomerInputSchema;
    case "evidence_tracker":
      return EvidenceTrackerInputSchema;
    case "coach_evaluator":
      return z.union([
        BriefValidationInputSchema,
        FinalReviewInputSchema,
      ]);
  }
}

// ---------------------------------------------------------------------------
// buildRoleInput
// ---------------------------------------------------------------------------

export function buildRoleInput(
  role: "customer",
  state: RunAggregate,
  capsule: CustomerCapsule,
): RoleInput;
export function buildRoleInput(
  role: "evidence_tracker",
  state: RunAggregate,
  // The evidence tracker takes only transcript + graph; it is structurally
  // incapable of receiving a capsule. A caller that hands one in fails closed.
  capsule?: never,
): RoleInput;
export function buildRoleInput(
  role: "coach_evaluator",
  state: RunAggregate,
  capsule: EvaluatorCapsule,
): RoleInput;
export function buildRoleInput(
  role: AgentRole,
  state: RunAggregate,
  capsule?: CustomerCapsule | EvaluatorCapsule,
): RoleInput {
  const parsed = RunAggregateSchema.safeParse(state);
  if (!parsed.success) {
    // Any field this firewall does not recognize fails closed — never ignored.
    throw new ContextFirewallError(
      FIREWALL_UNRECOGNIZED_FIELD,
      "run aggregate contains an unrecognized field",
    );
  }
  const agg = parsed.data;

  switch (role) {
    case "customer": {
      if (!isCustomerCapsule(capsule) || isEvaluatorCapsule(capsule)) {
        throw new ContextFirewallError(
          FIREWALL_CAPSULE_FORBIDDEN,
          "customer role requires the customer capsule (never the evaluator capsule)",
        );
      }
      if (!agg.pendingQuestion) {
        throw new ContextFirewallError(
          FIREWALL_INVALID_STATE,
          "customer role requires a pending question",
        );
      }
      const customerCapsule = capsule as CustomerCapsule;
      const input: CustomerInput = {
        locale: agg.locale,
        question: agg.pendingQuestion.question,
        stakeholderId: agg.pendingQuestion.stakeholderId,
        stakeholders: customerCapsule.stakeholders,
        disclosureUnits: customerCapsule.disclosureUnits,
        disclosedDisclosureUnitIds: agg.disclosedDisclosureUnitIds,
        responsePolicies: customerCapsule.responsePolicies,
      };
      return { kind: "customer", input: CustomerInputSchema.parse(input) };
    }

    case "evidence_tracker": {
      // The evidence tracker must NEVER receive the customer capsule, the
      // evaluator capsule, ground truth, or rubric. Passing any capsule is
      // rejected outright (fail closed).
      if (capsule !== undefined) {
        throw new ContextFirewallError(
          FIREWALL_CAPSULE_FORBIDDEN,
          "evidence tracker must not receive a capsule",
        );
      }
      const turn = agg.transcript[agg.transcript.length - 1];
      if (!turn) {
        throw new ContextFirewallError(
          FIREWALL_INVALID_STATE,
          "evidence tracker requires at least one transcript turn",
        );
      }
      // Built ONLY from public transcript + public graph. No capsule is read.
      const input: EvidenceTrackerInput = { locale: agg.locale, turn, graph: agg.graph };
      return { kind: "evidence_tracker", input: EvidenceTrackerInputSchema.parse(input) };
    }

    case "coach_evaluator": {
      if (!isEvaluatorCapsule(capsule)) {
        throw new ContextFirewallError(
          FIREWALL_CAPSULE_FORBIDDEN,
          "coach role requires the evaluator capsule (never the customer capsule)",
        );
      }
      switch (agg.coachTask) {
        case "brief-validation": {
          if (!agg.brief) {
            throw new ContextFirewallError(
              FIREWALL_INVALID_STATE,
              "coach brief-validation task requires a brief",
            );
          }
          const input: BriefValidationInput = {
            locale: agg.locale,
            brief: agg.brief,
            graph: agg.graph,
            transcript: agg.transcript,
          };
          return { kind: "brief-validation", input: BriefValidationInputSchema.parse(input) };
        }
        case "final-review": {
          if (!agg.brief || !agg.proposal || !agg.pitch) {
            throw new ContextFirewallError(
              FIREWALL_INVALID_STATE,
              "coach final-review task requires brief, proposal, and pitch",
            );
          }
          const input: FinalReviewInput = {
            locale: agg.locale,
            brief: agg.brief,
            proposal: agg.proposal,
            pitch: agg.pitch,
            challengeResponses: agg.challengeResponses,
            graph: agg.graph,
            transcript: agg.transcript,
            hintLedger: agg.grantedHints,
            // The FIXED capability rubric (learner-safe), never the scenario's
            // hidden `evaluator.rubric`. Copied to plain arrays (RUBRIC is
            // `readonly`).
            rubric: {
              framing: [...RUBRIC.framing],
              solution: [...RUBRIC.solution],
              challenge: [...RUBRIC.challenge],
              pitch: [...RUBRIC.pitch],
              process: [...RUBRIC.process],
            },
          };
          return { kind: "final-review", input: FinalReviewInputSchema.parse(input) };
        }
      }
    }
  }
}
