import type { TranscriptTurn } from "../../../core/domain.js";
import type { RunAggregate } from "../../../core/aggregate.js";
import type { CustomerTurn } from "../../../agents/customer.js";
import type { QuestionAssessment } from "../../../agents/contracts.js";

/**
 * FDE Gym — shared helpers for the DISCOVERY subgraph (G3-01).
 *
 * These mirror the small deterministic helpers inlined in
 * `prepareDiscoveryTurn` WITHOUT importing the orchestrator (to avoid a cycle).
 * They are the only bits of the orchestrator's discovery pipeline that are not
 * already a distinct module: the fold, the metrics formula, the failure
 * normalizer, and the pending-evidence marker shape.
 */

/** Stable learner-visible failure code for a failed evidence extraction. */
export const EVIDENCE_EXTRACTION_FAILED = "EVIDENCE_EXTRACTION_FAILED" as const;

/** Deterministic per-question metrics (mirrors `orchestrator.DiscoveryTurnMetrics`). */
export interface DiscoveryTurnMetrics {
  questionAssessment: QuestionAssessment;
  /** Deterministic 0..1 aggregate: mean of atomicity, neutrality, relevance, and (1 - redundancy). */
  composite: number;
}

/** The learner-visible pending-evidence marker (mirrors `orchestrator.PendingEvidence`). */
export interface PendingEvidence {
  turnId: string;
  /** Stable failure code (never payload or canary text). */
  code: string;
  /** Structural message (never payload or canary text). */
  message: string;
}

/**
 * A guard node's rejection. Guard NODES (unlike the pure predicates in
 * `guards.ts`) gate execution by throwing; the graph runtime maps the throw to
 * the node's declared `failurePolicy`.
 */
export class NodeGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NodeGuardError";
    this.code = code;
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Deterministic 0..1 per-question aggregate (mirrors `computeDiscoveryMetrics`). */
export function computeDiscoveryMetrics(assessment: QuestionAssessment): DiscoveryTurnMetrics {
  const composite = clamp01(
    (assessment.atomicity + assessment.neutrality + assessment.relevance + (1 - assessment.redundancy)) / 4,
  );
  return { questionAssessment: assessment, composite };
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Fold a validated customer turn into the aggregate: append the transcript turn,
 * merge the disclosure ledger, and clear `pendingQuestion` (mirrors the
 * orchestrator's `foldReply`).
 */
export function foldReply(agg: RunAggregate, turn: CustomerTurn, commandId: string): RunAggregate {
  const newTurn: TranscriptTurn = {
    turnId: `${commandId}:turn`,
    seq: agg.transcript.length,
    question: agg.pendingQuestion?.question ?? "",
    customerReply: turn.reply,
    stakeholderId: turn.stakeholderId,
  };
  return {
    ...agg,
    transcript: [...agg.transcript, newTurn],
    disclosedDisclosureUnitIds: dedupe([
      ...agg.disclosedDisclosureUnitIds,
      ...turn.disclosedDisclosureUnitIds,
    ]),
    pendingQuestion: null,
  };
}

/** Reduce an unknown error to a stable, payload-free code + message. */
export function normalizeFailure(error: unknown): { code: string; message: string } {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    if (typeof code === "string" && code.length > 0) {
      return { code, message: typeof message === "string" ? message : code };
    }
  }
  return { code: EVIDENCE_EXTRACTION_FAILED, message: "evidence extraction failed" };
}
