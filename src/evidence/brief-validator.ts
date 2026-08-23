import {
  CONTRADICTION_DISPOSITIONS,
  type BriefValidationResult,
  type ClaimEntailment,
  type ClaimWeight,
  type Entailment,
  type EvidenceGraph,
  type EvidenceNode,
  type LocalizedText,
  type ProblemBrief,
  type ProblemBriefClaim,
} from "../core/domain.js";

/**
 * Problem Brief gate — the DETERMINISTIC half.
 *
 * `validateBriefStructure` is a pure structural validator: no model call, no
 * wall-clock, no randomness. It sees only the learner's public brief and the
 * public evidence graph, so its feedback can cite nothing but learner claim ids,
 * contradiction ids, and evidence node ids — never hidden evidence text. That
 * discipline is deliberate and must be preserved by anything added here.
 *
 * `calculateSupportRatio` is the weighted aggregation of the Coach's
 * schema-validated entailment classifications (Task 8).
 *
 * The FULL gate (`supportRatio >= 0.75` AND `validateBriefStructure().passed`)
 * is composed by the orchestrator in Task 8. This module intentionally does not
 * compose it.
 */

// ---------------------------------------------------------------------------
// Stable `missingCategories` keys
// ---------------------------------------------------------------------------

/** Fewer than one success measure. */
export const BRIEF_MISSING_SUCCESS_MEASURE = "successMeasures" as const;
/** Fewer than one remaining unknown. */
export const BRIEF_MISSING_UNKNOWN = "unknowns" as const;
/** A contradiction lacks a valid disposition, or an active contradiction node is unaddressed. */
export const BRIEF_UNDISPOSED_CONTRADICTION = "contradictionDisposition" as const;
/** An `evidenceIds` entry does not resolve to a node in the evidence graph. */
export const BRIEF_DANGLING_EVIDENCE_REFERENCE = "evidenceReference" as const;
/** A `critical` claim is grounded only in assumption/unknown/invalidated nodes. */
export const BRIEF_UNGROUNDED_CRITICAL_CLAIM = "criticalClaimGrounding" as const;

/** Stable emission order for `missingCategories`. */
export const BRIEF_CATEGORY_ORDER = [
  BRIEF_MISSING_SUCCESS_MEASURE,
  BRIEF_MISSING_UNKNOWN,
  BRIEF_UNDISPOSED_CONTRADICTION,
  BRIEF_DANGLING_EVIDENCE_REFERENCE,
  BRIEF_UNGROUNDED_CRITICAL_CLAIM,
] as const;

// ---------------------------------------------------------------------------
// Weights and entailment scores
// ---------------------------------------------------------------------------

/** `critical=3`, `major=2`, `minor=1`. */
export const CLAIM_WEIGHT_SCORES: Readonly<Record<ClaimWeight, number>> = {
  critical: 3,
  major: 2,
  minor: 1,
};

/** `supported=1`, `partial=0.5`, `unsupported=0`. */
export const ENTAILMENT_SCORES: Readonly<Record<Entailment, number>> = {
  supported: 1,
  partial: 0.5,
  unsupported: 0,
};

/** The gate threshold composed by Task 8: `supportRatio >= 0.75`. */
export const SUPPORT_RATIO_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// validateBriefStructure
// ---------------------------------------------------------------------------

/** A node grounds a claim as a hard fact only when it is a `fact` and not invalidated. */
function isGroundingFact(node: EvidenceNode | undefined): boolean {
  return node !== undefined && node.kind === "fact" && node.status !== "invalidated";
}

/**
 * Deterministic structural gate for a Problem Brief.
 *
 * Checks, in order:
 *  (a) at least one success measure;
 *  (b) at least one remaining unknown;
 *  (c) every brief contradiction carries a disposition drawn from
 *      `resolved | accepted_risk | needs_follow_up`, AND every `active`
 *      `contradiction` node in the graph is addressed by at least one brief
 *      contradiction's `evidenceIds` (so a critical contradiction cannot be
 *      left silently undisposed);
 *  (d) every `evidenceIds` entry on a claim or contradiction resolves to a node
 *      in the graph (an `invalidated` node still resolves — it exists);
 *  (e) no `critical` claim whose evidence resolves ONLY to
 *      assumption/unknown/contradiction or invalidated nodes: a critical claim
 *      must cite at least one active `fact`.
 *
 * `entailments` is always `[]` here; semantic classification is the Coach's job
 * (Task 8). `feedback` is bilingual and cites ids only.
 */
export function validateBriefStructure(brief: ProblemBrief, graph: EvidenceGraph): BriefValidationResult {
  const nodeById = new Map<string, EvidenceNode>(graph.nodes.map((node) => [node.id, node] as const));
  const categories = new Set<string>();
  const unsupportedClaimIds: string[] = [];
  const zh: string[] = [];
  const en: string[] = [];

  // (a) success measures ----------------------------------------------------
  if (brief.successMeasures.length < 1) {
    categories.add(BRIEF_MISSING_SUCCESS_MEASURE);
    zh.push("缺少成功度量：至少需要 1 条。");
    en.push("Missing success measure: at least 1 is required.");
  }

  // (b) remaining unknowns --------------------------------------------------
  if (brief.unknowns.length < 1) {
    categories.add(BRIEF_MISSING_UNKNOWN);
    zh.push("缺少未知项：至少需要保留 1 条。");
    en.push("Missing remaining unknown: at least 1 must be kept open.");
  }

  // (c) contradiction dispositions -----------------------------------------
  const disposed: string[] = [];
  for (const contradiction of brief.contradictions) {
    const valid = (CONTRADICTION_DISPOSITIONS as readonly string[]).includes(contradiction.disposition);
    if (!valid) {
      categories.add(BRIEF_UNDISPOSED_CONTRADICTION);
      zh.push(`矛盾 ${contradiction.id} 缺少有效处置结论（resolved / accepted_risk / needs_follow_up）。`);
      en.push(
        `Contradiction ${contradiction.id} has no valid disposition (resolved / accepted_risk / needs_follow_up).`,
      );
    } else {
      disposed.push(...contradiction.evidenceIds);
    }
  }
  const disposedEvidenceIds = new Set(disposed);
  for (const node of graph.nodes) {
    if (node.kind !== "contradiction" || node.status !== "active") continue;
    if (disposedEvidenceIds.has(node.id)) continue;
    categories.add(BRIEF_UNDISPOSED_CONTRADICTION);
    zh.push(`矛盾证据 ${node.id} 未在问题定义中处置。`);
    en.push(`Contradiction evidence ${node.id} is not disposed of in the brief.`);
  }

  // (d) evidence references resolve ----------------------------------------
  for (const claim of brief.claims) {
    const dangling = [...new Set(claim.evidenceIds)].filter((id) => !nodeById.has(id));
    if (dangling.length === 0) continue;
    categories.add(BRIEF_DANGLING_EVIDENCE_REFERENCE);
    if (!unsupportedClaimIds.includes(claim.id)) unsupportedClaimIds.push(claim.id);
    zh.push(`论断 ${claim.id} 引用了不存在的证据：${dangling.join(", ")}。`);
    en.push(`Claim ${claim.id} cites evidence that does not exist: ${dangling.join(", ")}.`);
  }
  for (const contradiction of brief.contradictions) {
    const dangling = [...new Set(contradiction.evidenceIds)].filter((id) => !nodeById.has(id));
    if (dangling.length === 0) continue;
    categories.add(BRIEF_DANGLING_EVIDENCE_REFERENCE);
    zh.push(`矛盾 ${contradiction.id} 引用了不存在的证据：${dangling.join(", ")}。`);
    en.push(`Contradiction ${contradiction.id} cites evidence that does not exist: ${dangling.join(", ")}.`);
  }

  // (e) critical claims must cite an active fact ----------------------------
  for (const claim of brief.claims) {
    if (claim.weight !== "critical") continue;
    const grounded = claim.evidenceIds.some((id) => isGroundingFact(nodeById.get(id)));
    if (grounded) continue;
    categories.add(BRIEF_UNGROUNDED_CRITICAL_CLAIM);
    if (!unsupportedClaimIds.includes(claim.id)) unsupportedClaimIds.push(claim.id);
    zh.push(`关键论断 ${claim.id} 缺少有效事实证据支撑（仅有假设/未知/已失效证据）。`);
    en.push(
      `Critical claim ${claim.id} is not grounded in any active fact evidence (only assumption/unknown/invalidated).`,
    );
  }

  const missingCategories = BRIEF_CATEGORY_ORDER.filter((category) => categories.has(category));
  const passed = missingCategories.length === 0;
  const feedback: LocalizedText = passed
    ? { "zh-CN": "结构校验通过。", "en-US": "Structural checks passed." }
    : { "zh-CN": zh.join(" "), "en-US": en.join(" ") };

  return {
    passed,
    entailments: [],
    missingCategories: [...missingCategories],
    unsupportedClaimIds,
    feedback,
  };
}

// ---------------------------------------------------------------------------
// calculateSupportRatio
// ---------------------------------------------------------------------------

/**
 * Weighted support ratio:
 *
 *   SupportRatio = Σ(claimWeight × entailmentScore) / Σ(claimWeight)
 *
 * with `critical=3, major=2, minor=1` and `supported=1, partial=0.5,
 * unsupported=0`. Returns 0 when there are no claims. A claim with no
 * entailment entry scores 0 (unsupported); when a claim id appears more than
 * once in `entailments`, the FIRST entry wins (deterministic). Entailments for
 * unknown claim ids are ignored. The result is clamped to `[0, 1]`.
 */
export function calculateSupportRatio(
  claims: readonly ProblemBriefClaim[],
  entailments: readonly ClaimEntailment[],
): number {
  if (claims.length === 0) return 0;

  const byClaimId = new Map<string, Entailment>();
  for (const entry of entailments) {
    if (!byClaimId.has(entry.claimId)) byClaimId.set(entry.claimId, entry.entailment);
  }

  let numerator = 0;
  let denominator = 0;
  for (const claim of claims) {
    const weight = CLAIM_WEIGHT_SCORES[claim.weight] ?? 0;
    const entailment = byClaimId.get(claim.id);
    const score = entailment === undefined ? 0 : ENTAILMENT_SCORES[entailment] ?? 0;
    numerator += weight * score;
    denominator += weight;
  }
  if (denominator === 0) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}
