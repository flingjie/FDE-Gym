import { OrchestratorError } from "../core/orchestrator.js";
import { AGENT_OUTPUT_DOMAIN_INVALID } from "../core/errors.js";
import type {
  BriefValidationInput,
  BriefValidationOutput,
  CustomerInput,
  CustomerOutput,
  EvidenceTrackerInput,
  EvidenceTrackerOutput,
  FinalReviewInput,
  FinalReviewOutput,
} from "./contracts.js";

export { AGENT_OUTPUT_DOMAIN_INVALID };

/**
 * FDE Gym — input-dependent output domain validation (Task 2).
 *
 * After the sanitizer strips prohibited keys, scans for canaries, and validates
 * the payload against the role's strict OUTPUT schema, the surviving structural
 * references must still resolve against the INPUT the role was actually given.
 * A stakeholder, disclosure unit, claim, transcript source, or rubric criterion
 * the role never saw is a fabrication: rejected here with a single stable,
 * payload-free code (`AGENT_OUTPUT_DOMAIN_INVALID`).
 *
 * These are pure functions: no wall-clock, no randomness, no model call. Error
 * messages name contract fields (e.g. `stakeholderId`) but never echo model
 * text, canary values, or raw ids supplied only by the model.
 */

function domainError(detail: string): never {
  throw new OrchestratorError(AGENT_OUTPUT_DOMAIN_INVALID, detail);
}

// ---------------------------------------------------------------------------
// Customer Simulator
// ---------------------------------------------------------------------------

export function validateCustomerOutput(
  input: CustomerInput,
  output: CustomerOutput,
): CustomerOutput {
  const stakeholderIds = new Set(input.stakeholders.map((stakeholder) => stakeholder.id));
  if (!stakeholderIds.has(output.stakeholderId)) {
    domainError("stakeholderId is not a scenario stakeholder");
  }

  const disclosureUnitById = new Map(input.disclosureUnits.map((unit) => [unit.id, unit] as const));
  const alreadyDisclosed = new Set(input.disclosedDisclosureUnitIds);
  const newlyDisclosed = new Set(output.disclosedDisclosureUnitIds);
  for (const unitId of output.disclosedDisclosureUnitIds) {
    const unit = disclosureUnitById.get(unitId);
    if (unit === undefined) {
      domainError("disclosedDisclosureUnitIds references a disclosure unit absent from the scenario");
    }
    for (const prerequisite of unit.prerequisites) {
      if (!alreadyDisclosed.has(prerequisite) && !newlyDisclosed.has(prerequisite)) {
        domainError(
          "disclosedDisclosureUnitIds discloses a unit whose prerequisite is not yet disclosed",
        );
      }
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Evidence Tracker
// ---------------------------------------------------------------------------

export function validateEvidenceTrackerOutput(
  input: EvidenceTrackerInput,
  output: EvidenceTrackerOutput,
): EvidenceTrackerOutput {
  const currentTurnId = input.turn.turnId;
  for (const node of output.patch.addNodes) {
    if (node.kind !== "fact") continue;
    if (node.sourceTranscriptIds.length !== 1 || node.sourceTranscriptIds[0] !== currentTurnId) {
      domainError("fact node sourceTranscriptIds must reference exactly the current turn");
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Coach — problem brief validation
// ---------------------------------------------------------------------------

export function validateBriefValidationOutput(
  input: BriefValidationInput,
  output: BriefValidationOutput,
): BriefValidationOutput {
  const claimIds = new Set(input.brief.claims.map((claim) => claim.id));
  for (const entailment of output.entailments) {
    if (!claimIds.has(entailment.claimId)) {
      domainError("entailment claimId is absent from the brief");
    }
  }
  for (const claimId of output.unsupportedClaimIds) {
    if (!claimIds.has(claimId)) {
      domainError("unsupportedClaimIds references a claim id absent from the brief");
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Coach — final review
// ---------------------------------------------------------------------------

const RUBRIC_STAGES = ["framing", "solution", "challenge", "pitch", "process"] as const;

export function validateFinalReviewOutput(
  input: FinalReviewInput,
  output: FinalReviewOutput,
): FinalReviewOutput {
  const scores = output.criterionScores;
  if (scores === undefined) return output;

  for (const stage of RUBRIC_STAGES) {
    const stageScores = scores[stage];
    if (stageScores === undefined || Object.keys(stageScores).length === 0) continue;

    const rubricIds = new Set<string>();
    for (const criterion of input.rubric[stage]) {
      if (rubricIds.has(criterion.id)) {
        domainError(`rubric[${stage}] contains a duplicate criterion id`);
      }
      rubricIds.add(criterion.id);
    }

    for (const key of Object.keys(stageScores)) {
      if (!rubricIds.has(key)) {
        domainError(`criterionScores[${stage}] references an unknown criterion id`);
      }
    }
    for (const id of rubricIds) {
      if (!(id in stageScores)) {
        domainError(`criterionScores[${stage}] is missing a criterion id from the fixed rubric`);
      }
    }
  }
  return output;
}
