import { z } from "zod";
import {
  FDE_SCHEMA_VERSION,
  LocalizedTextSchema,
  LocaleSchema,
  RunPhaseSchema,
} from "../core/domain.js";

/**
 * FDE Gym — scenario authoring schema and the three compiled role partitions.
 *
 * The three partitions are STRUCTURALLY independent: `PublicScenarioSchema`
 * never declares `customer` or `evaluator`, and every partition is `.strict()`
 * so an input carrying another partition's keys is rejected outright. The
 * authoring schema (`ScenarioAuthoringSchema`) is the single source document
 * Task 3 compiles into `manifest.json`, `public.json`, `customer.json`, and
 * `evaluator.json`.
 */

/** Frozen MVP schema version (finalized in Task 14; defined here so every partition carries it). */
export const SCENARIO_SCHEMA_VERSION = FDE_SCHEMA_VERSION;

/**
 * Frozen scenario-manifest FORMAT version (Task 7). Independent of the content
 * schema version above: `SCENARIO_SCHEMA_VERSION` versions the role partitions,
 * `SCENARIO_MANIFEST_VERSION` versions the integrity manifest that seals them.
 */
export const SCENARIO_MANIFEST_VERSION = 2 as const;

// ---------------------------------------------------------------------------
// Scenario bundle integrity manifest (Task 7)
// ---------------------------------------------------------------------------

/** A single sealed artifact (partition or events file) described by the manifest. */
export const ScenarioArtifactDescriptorSchema = z
  .object({
    /** Bundle-relative filename, e.g. `public.json`. Must never be an absolute or traversing path. */
    path: z.string().min(1),
    /** SHA-256 of the artifact's exact on-disk bytes, lowercase hex. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Exact byte length of the artifact. */
    bytes: z.number().int().nonnegative(),
    /** Content schema version the artifact was compiled against. */
    schemaVersion: z.literal(SCENARIO_SCHEMA_VERSION),
  })
  .strict();
export type ScenarioArtifactDescriptor = z.infer<typeof ScenarioArtifactDescriptorSchema>;

/** The sealed manifest written last in a compiled bundle. Never contains canaries or the seed. */
export const ScenarioManifestSchema = z
  .object({
    manifestVersion: z.literal(SCENARIO_MANIFEST_VERSION),
    id: z.string().min(1),
    schemaVersion: z.literal(SCENARIO_SCHEMA_VERSION),
    locale: LocaleSchema,
    /** Root digest of the canonical artifact descriptors — the bundle's stable identity. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    artifacts: z.array(ScenarioArtifactDescriptorSchema),
  })
  .strict();
export type VerifiedScenarioManifest = z.infer<typeof ScenarioManifestSchema>;

// ---------------------------------------------------------------------------
// Shared content blocks
// ---------------------------------------------------------------------------

export const StakeholderSchema = z
  .object({
    id: z.string().min(1),
    role: LocalizedTextSchema,
    persona: LocalizedTextSchema,
    concerns: z.array(LocalizedTextSchema),
    /** Information this stakeholder is blind to; the customer may say "I don't know". */
    blindSpots: z.array(LocalizedTextSchema),
  })
  .strict();
export type Stakeholder = z.infer<typeof StakeholderSchema>;

export const DisclosureUnitSchema = z
  .object({
    id: z.string().min(1),
    /** Discovery category this unit belongs to (workflow, pain, root cause, etc.). */
    topic: z.string().min(1),
    /** The hidden fact the customer may reveal. */
    text: LocalizedTextSchema,
    /** Disclosure unit ids that must already be disclosed before this one may be revealed. */
    prerequisites: z.array(z.string().min(1)),
    /** Cross-reference to the evaluator's expected evidence this unit satisfies. */
    evidenceId: z.string().min(1),
  })
  .strict();
export type DisclosureUnit = z.infer<typeof DisclosureUnitSchema>;

export const ResponsePolicySchema = z
  .object({
    id: z.string().min(1),
    when: LocalizedTextSchema,
    behavior: LocalizedTextSchema,
  })
  .strict();
export type ResponsePolicy = z.infer<typeof ResponsePolicySchema>;

export const PrivateConflictSchema = z
  .object({
    id: z.string().min(1),
    stakeholderIds: z.array(z.string().min(1)),
    description: LocalizedTextSchema,
  })
  .strict();
export type PrivateConflict = z.infer<typeof PrivateConflictSchema>;

export const ExpectedEvidenceSchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    /** Hidden: what the evidence tracker/evaluator looks for. Never learner-visible. */
    description: LocalizedTextSchema,
    /** Information-gain weight; strictly positive. */
    weight: z.number().positive(),
    /** Disclosure units that reveal this evidence. */
    disclosureUnitIds: z.array(z.string().min(1)),
  })
  .strict();
export type ExpectedEvidence = z.infer<typeof ExpectedEvidenceSchema>;

export const RUBRIC_STAGE_IDS = ["framing", "solution", "challenge", "pitch", "process"] as const;
export type RubricStageId = (typeof RUBRIC_STAGE_IDS)[number];

export const RubricCriterionSchema = z
  .object({
    id: z.string().min(1),
    label: LocalizedTextSchema,
    /** Percentage points, 0..100, within its stage. */
    weight: z.number().min(0).max(100),
    description: LocalizedTextSchema,
  })
  .strict();
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const RubricStageSchema = z
  .object({
    id: z.enum(RUBRIC_STAGE_IDS),
    label: LocalizedTextSchema,
    criteria: z.array(RubricCriterionSchema),
  })
  .strict();
export type RubricStage = z.infer<typeof RubricStageSchema>;

export const RubricSchema = z
  .object({
    stages: z.array(RubricStageSchema),
  })
  .strict();
export type Rubric = z.infer<typeof RubricSchema>;

export const CriticalContradictionSchema = z
  .object({
    id: z.string().min(1),
    statement: LocalizedTextSchema,
    expectedEvidenceIds: z.array(z.string().min(1)),
  })
  .strict();
export type CriticalContradiction = z.infer<typeof CriticalContradictionSchema>;

/** A complete Level 1/2/3 hint ladder for one discovery topic. All three levels are required. */
export const HintLadderSchema = z
  .object({
    id: z.string().min(1),
    topic: z.string().min(1),
    hints: z
      .object({
        "1": LocalizedTextSchema,
        "2": LocalizedTextSchema,
        "3": LocalizedTextSchema,
      })
      .strict(),
  })
  .strict();
export type HintLadder = z.infer<typeof HintLadderSchema>;

export const PassGateSchema = z
  .object({
    id: z.string().min(1),
    description: LocalizedTextSchema,
  })
  .strict();
export type PassGate = z.infer<typeof PassGateSchema>;

// ---------------------------------------------------------------------------
// Deterministic scenario events
// ---------------------------------------------------------------------------

export const EventTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("on_stage_enter"), phase: RunPhaseSchema }).strict(),
  z
    .object({ kind: z.literal("after_question_count"), count: z.number().int().positive() })
    .strict(),
  z
    .object({ kind: z.literal("after_evidence_revealed"), evidenceId: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("if_contradiction_unresolved"),
      contradictionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("after_challenge_response_count"),
      count: z.number().int().positive(),
    })
    .strict(),
]);
export type EventTrigger = z.infer<typeof EventTriggerSchema>;

export const ScenarioEventCandidateSchema = z
  .object({
    id: z.string().min(1),
    trigger: EventTriggerSchema,
    /** The challenge/constraint-change text injected when the trigger fires. */
    prompt: LocalizedTextSchema,
  })
  .strict();
export type ScenarioEventCandidate = z.infer<typeof ScenarioEventCandidateSchema>;

/** The `events.json` artifact: the scenario's authored event candidates, verbatim from the source. */
export const ScenarioEventsFileSchema = z.array(ScenarioEventCandidateSchema);

// ---------------------------------------------------------------------------
// Compiled role partitions
// ---------------------------------------------------------------------------

export const PublicScenarioSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(SCENARIO_SCHEMA_VERSION),
    locale: LocaleSchema,
    openingRequest: LocalizedTextSchema,
    visibleContext: LocalizedTextSchema,
    visibleConstraints: z.array(LocalizedTextSchema),
    deliverables: z.array(LocalizedTextSchema),
    learnerRules: z.array(LocalizedTextSchema),
    questionBudget: z.number().int().positive(),
  })
  .strict();
export type PublicScenario = z.infer<typeof PublicScenarioSchema>;

export const CustomerCapsuleSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(SCENARIO_SCHEMA_VERSION),
    stakeholders: z.array(StakeholderSchema).min(1),
    disclosureUnits: z.array(DisclosureUnitSchema),
    responsePolicies: z.array(ResponsePolicySchema),
    privateConflicts: z.array(PrivateConflictSchema),
    /** Role canary injected by the compiler; used by leak-guard checks. */
    canary: z.string().min(1),
  })
  .strict();
export type CustomerCapsule = z.infer<typeof CustomerCapsuleSchema>;

export const EvaluatorCapsuleSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(SCENARIO_SCHEMA_VERSION),
    expectedEvidence: z.array(ExpectedEvidenceSchema),
    rubric: RubricSchema,
    criticalContradictions: z.array(CriticalContradictionSchema),
    hintLadders: z.array(HintLadderSchema),
    passGates: z.array(PassGateSchema),
    /** Role canary injected by the compiler; used by leak-guard checks. */
    canary: z.string().min(1),
  })
  .strict();
export type EvaluatorCapsule = z.infer<typeof EvaluatorCapsuleSchema>;

// ---------------------------------------------------------------------------
// Authoring source document
// ---------------------------------------------------------------------------

export const ScenarioAuthoringSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(SCENARIO_SCHEMA_VERSION),
    locale: LocaleSchema,
    public: z
      .object({
        openingRequest: LocalizedTextSchema,
        visibleContext: LocalizedTextSchema,
        visibleConstraints: z.array(LocalizedTextSchema),
        deliverables: z.array(LocalizedTextSchema),
        learnerRules: z.array(LocalizedTextSchema),
        questionBudget: z.number().int().positive(),
      })
      .strict(),
    customer: z
      .object({
        stakeholders: z.array(StakeholderSchema).min(1),
        disclosureUnits: z.array(DisclosureUnitSchema),
        responsePolicies: z.array(ResponsePolicySchema),
        privateConflicts: z.array(PrivateConflictSchema),
      })
      .strict(),
    evaluator: z
      .object({
        expectedEvidence: z.array(ExpectedEvidenceSchema),
        rubric: RubricSchema,
        criticalContradictions: z.array(CriticalContradictionSchema),
        hintLadders: z.array(HintLadderSchema),
        passGates: z.array(PassGateSchema),
      })
      .strict(),
    events: z.array(ScenarioEventCandidateSchema),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const stakeholderIds = new Set<string>();
    doc.customer.stakeholders.forEach((stakeholder, i) => {
      if (stakeholderIds.has(stakeholder.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate stakeholder id: ${stakeholder.id}`,
          path: ["customer", "stakeholders", i, "id"],
        });
      }
      stakeholderIds.add(stakeholder.id);
    });

    const disclosureUnitIds = new Set<string>();
    doc.customer.disclosureUnits.forEach((unit, i) => {
      if (disclosureUnitIds.has(unit.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate disclosure unit id: ${unit.id}`,
          path: ["customer", "disclosureUnits", i, "id"],
        });
      }
      disclosureUnitIds.add(unit.id);
    });

    doc.customer.disclosureUnits.forEach((unit, i) => {
      unit.prerequisites.forEach((prereq, j) => {
        if (!disclosureUnitIds.has(prereq)) {
          ctx.addIssue({
            code: "custom",
            message: `disclosure unit references missing prerequisite: ${prereq}`,
            path: ["customer", "disclosureUnits", i, "prerequisites", j],
          });
        }
      });
    });

    const evidenceIds = new Set<string>();
    doc.evaluator.expectedEvidence.forEach((evidence, i) => {
      if (evidenceIds.has(evidence.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate expected evidence id: ${evidence.id}`,
          path: ["evaluator", "expectedEvidence", i, "id"],
        });
      }
      evidenceIds.add(evidence.id);
    });

    doc.customer.disclosureUnits.forEach((unit, i) => {
      if (!evidenceIds.has(unit.evidenceId)) {
        ctx.addIssue({
          code: "custom",
          message: `disclosure unit references missing expected evidence: ${unit.evidenceId}`,
          path: ["customer", "disclosureUnits", i, "evidenceId"],
        });
      }
    });

    const contradictionIds = new Set<string>();
    doc.evaluator.criticalContradictions.forEach((contradiction, i) => {
      if (contradictionIds.has(contradiction.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate critical contradiction id: ${contradiction.id}`,
          path: ["evaluator", "criticalContradictions", i, "id"],
        });
      }
      contradictionIds.add(contradiction.id);
    });

    const hintLadderIds = new Set<string>();
    doc.evaluator.hintLadders.forEach((ladder, i) => {
      if (hintLadderIds.has(ladder.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate hint ladder id: ${ladder.id}`,
          path: ["evaluator", "hintLadders", i, "id"],
        });
      }
      hintLadderIds.add(ladder.id);
    });

    const eventIds = new Set<string>();
    doc.events.forEach((event, i) => {
      if (eventIds.has(event.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate scenario event id: ${event.id}`,
          path: ["events", i, "id"],
        });
      }
      eventIds.add(event.id);

      const trigger = event.trigger;
      if (trigger.kind === "after_evidence_revealed" && !evidenceIds.has(trigger.evidenceId)) {
        ctx.addIssue({
          code: "custom",
          message: `event trigger references missing expected evidence: ${trigger.evidenceId}`,
          path: ["events", i, "trigger", "evidenceId"],
        });
      }
      if (
        trigger.kind === "if_contradiction_unresolved" &&
        !contradictionIds.has(trigger.contradictionId)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `event trigger references missing critical contradiction: ${trigger.contradictionId}`,
          path: ["events", i, "trigger", "contradictionId"],
        });
      }
    });
  });
export type ScenarioAuthoring = z.infer<typeof ScenarioAuthoringSchema>;
