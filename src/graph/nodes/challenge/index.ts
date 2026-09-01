import type { NodeHandler } from "../node.js";
import { challengeSelect } from "./select.js";
import { challengeInject } from "./inject.js";
import { responseAccept } from "./response-accept.js";
import { responseMembershipGuard } from "./membership-guard.js";
import { allAnsweredGuard } from "./all-answered-guard.js";
import { challengeWait } from "./wait.js";
import { pitchPrepare } from "./pitch-prepare.js";

/**
 * FDE Gym — CHALLENGE subgraph handlers (G3-03).
 *
 * The node flow (mirrors `prepareChallengeInjection` + `prepareRespondToChallenge`):
 *
 *   `challenge.select` → `challenge.inject` → `response.accept`
 *   → `response.membership.guard` → `all-answered.guard`
 *   → `challenge.wait` | `pitch.prepare`
 *
 * `challenge.select`/`challenge.inject` decompose the deterministic injection
 * wave (`prepareChallengeInjection`). The response pipeline decomposes
 * `prepareRespondToChallenge`: `response.accept` is the schema gate,
 * `response.membership.guard` validates the response targets an injected+pending
 * challenge and produces the fold, `all-answered.guard` is the BRANCH guard whose
 * verdict routes `challenge.wait` (stay, no phase event) vs `pitch.prepare`
 * (CHALLENGE → PITCH). `pitch.prepare` also serves the vacuous empty-set advance
 * (no fabricated response).
 *
 * Each handler is an independently testable reference implementation that
 * mirrors the orchestrator WITHOUT importing it (to avoid a cycle). The graph
 * runtime (a later integration) threads `updatedState` between nodes, carries
 * richer intermediate results (`selected`, `folded`) between sibling nodes, and
 * maps a guard's throw to its declared `failurePolicy`. Phase legality is the
 * EDGE's job (each edge declares its `from` phase), so the deterministic nodes
 * do not re-assert it here.
 */
export const handlers: readonly NodeHandler[] = [
  challengeSelect,
  challengeInject,
  responseAccept,
  responseMembershipGuard,
  allAnsweredGuard,
  challengeWait,
  pitchPrepare,
];

export * from "./shared.js";
export * from "./select.js";
export * from "./inject.js";
export * from "./response-accept.js";
export * from "./membership-guard.js";
export * from "./all-answered-guard.js";
export * from "./wait.js";
export * from "./pitch-prepare.js";
