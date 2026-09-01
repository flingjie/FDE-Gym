import type { EdgeSpan, NodeSpan } from "./types.js";

/**
 * FDE Gym — telemetry collector port (Phase 4).
 *
 * The runtime emits spans to a `TelemetryCollector`; the collector is the only
 * sink the graph runtime knows about. The in-memory collector below is for
 * tests and short-lived runs; a production sink (log/metrics exporter) can
 * implement the same two methods. Collectors are observation-only: they never
 * influence domain state or event authorship.
 */
export interface TelemetryCollector {
  recordNodeSpan(span: NodeSpan): void;
  recordEdgeSpan(span: EdgeSpan): void;
}

export class InMemoryCollector implements TelemetryCollector {
  readonly nodeSpans: NodeSpan[] = [];
  readonly edgeSpans: EdgeSpan[] = [];

  recordNodeSpan(span: NodeSpan): void {
    this.nodeSpans.push(span);
  }

  recordEdgeSpan(span: EdgeSpan): void {
    this.edgeSpans.push(span);
  }
}
