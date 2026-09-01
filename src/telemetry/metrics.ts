import type { NodeSpan } from "./types.js";

/**
 * FDE Gym — telemetry metrics projection (Phase 4, G4-04).
 *
 * A pure aggregation over a run's node spans: the success/failure/pending
 * counts, duration percentiles, retry and invalid-output counts, token totals,
 * and the maximum (stuck) duration. Deterministic given the same spans — no
 * wall-clock or randomness — so the metric report is reproducible.
 */
export interface NodeMetrics {
  total: number;
  success: number;
  failure: number;
  pending: number;
  p50DurationMs: number;
  p95DurationMs: number;
  retryCount: number;
  invalidOutputCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  maxDurationMs: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

const INVALID_OUTPUT_CODES = new Set(["AGENT_OUTPUT_INVALID", "AGENT_OUTPUT_DOMAIN_INVALID", "JUDGMENT_INVALID"]);

export function aggregateNodeMetrics(spans: readonly NodeSpan[]): NodeMetrics {
  const durations = spans.map((span) => span.durationMs).sort((a, b) => a - b);
  return {
    total: spans.length,
    success: spans.filter((span) => span.outcome === "success").length,
    failure: spans.filter((span) => span.outcome === "failure").length,
    pending: spans.filter((span) => span.outcome === "pending").length,
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    retryCount: spans.filter((span) => span.attempt > 1).length,
    invalidOutputCount: spans.filter(
      (span) => span.failureClass === "INVALID_MODEL_OUTPUT" || (span.failureCode !== undefined && INVALID_OUTPUT_CODES.has(span.failureCode)),
    ).length,
    totalInputTokens: spans.reduce((sum, span) => sum + (span.tokenUsage?.input ?? 0), 0),
    totalOutputTokens: spans.reduce((sum, span) => sum + (span.tokenUsage?.output ?? 0), 0),
    maxDurationMs: durations.length > 0 ? durations[durations.length - 1] : 0,
  };
}
