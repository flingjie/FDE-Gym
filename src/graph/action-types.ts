import type { RunCommand } from "../core/domain.js";

/**
 * FDE Gym — graph action vocabulary (Phase 0.5 contract).
 *
 * An **Action** is a command (learner-exposed or system-triggered) that may
 * traverse a phase edge. The vocabulary is derived from the `RunCommand`
 * discriminated union so it can never drift from the domain: renaming or adding
 * a command type updates the action set automatically.
 *
 * Note: `repair-evidence` is a wired CLI command but is intentionally NOT an
 * action here — it is a guard-gated re-entrant action with no phase edge (see
 * `docs/graph/wave0-integration.md`), not a phase transition.
 */

export type ActionId = RunCommand["type"];

/**
 * A deterministic, side-effect-free edge condition key. Phase 0.5 has no named
 * structural guards yet (phase legality is the only gate, expressed via an
 * edge's `from` phase); this widens into a stable union in Phase 2 (G2-02).
 */
export type GuardId = string;
