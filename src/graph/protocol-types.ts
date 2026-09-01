import type { RunEvent } from "../core/domain.js";

/**
 * FDE Gym — event protocol contract (Phase 0.5).
 *
 * An **Event Protocol** declares the ordered domain events an edge must
 * produce. It is the contract a later batch validator (Phase 1, G1-01) checks
 * every committed event batch against:
 *
 *   - `required` — event types that must be present, in order.
 *   - `optional`  — event types that may appear (e.g. conditional success/failure).
 *   - `forbidden` — event types that must never appear on this edge.
 *   - `ordered`   — whether the `required` order is significant.
 */

export interface EventProtocolSpec {
  required: RunEvent["type"][];
  optional?: RunEvent["type"][];
  forbidden?: RunEvent["type"][];
  ordered: boolean;
}
