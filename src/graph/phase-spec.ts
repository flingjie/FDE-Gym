import type { RunPhase } from "../core/domain.js";
import type { ActionId, GuardId } from "./action-types.js";
import type { EventProtocolSpec } from "./protocol-types.js";
import { EVENT_PROTOCOLS } from "./event-protocols.js";

/**
 * FDE Gym — phase transition spec (Phase 0.5, G05-01).
 *
 * The SINGLE source of truth for phase legality. Every action's legal `from`
 * phase(s) and its intended `to` phase are declared here; `assertCommandPhase`
 * (`src/core/state-machine.ts`) is derived from this table and keeps its facade
 * and stable error codes. No other module may maintain a second transition map.
 *
 * A `from` of `null` means the unstarted state (only the `start` action).
 */

export interface PhaseEdgeSpec {
  edgeId: string;
  action: ActionId;
  /** The phase this action is legal from; `null` = unstarted (only `start`). */
  from: RunPhase | null;
  /** The phase after a successful traverse (equals `from` for a stay). */
  to: RunPhase;
  guard?: GuardId;
  protocol: EventProtocolSpec;
}

/** Phases in which `abort` is legal (everything except the terminal phases and unstarted). */
const ABORTABLE_PHASES: readonly RunPhase[] = [
  "SCENARIO",
  "DISCOVERY",
  "PROBLEM_FRAMING",
  "SOLUTION_DESIGN",
  "CHALLENGE",
  "PITCH",
  "REVIEW",
  "RETRY_READY",
];

function abortEdge(from: RunPhase): PhaseEdgeSpec {
  return {
    edgeId: `abort.${from}.aborted`,
    action: "abort",
    from,
    to: "ABORTED",
    protocol: EVENT_PROTOCOLS.abort,
  };
}

/**
 * The full phase-legality table.
 *
 * - `start` → SCENARIO (unstarted only), then `accept` auto-advances
 *   SCENARIO → DISCOVERY (bundled by the `startRun` use case).
 * - `respond-challenge` stays CHALLENGE until every mandatory challenge is
 *   answered, then advances CHALLENGE → PITCH. When zero mandatory challenges
 *   are injected, this advance is vacuous (the all-answered guard is trivially
 *   satisfied), so PITCH is entered without a response.
 */
export const PHASE_EDGES: readonly PhaseEdgeSpec[] = [
  { edgeId: "start.unstarted.scenario", action: "start", from: null, to: "SCENARIO", protocol: EVENT_PROTOCOLS.start },
  { edgeId: "accept.scenario.discovery", action: "accept", from: "SCENARIO", to: "DISCOVERY", protocol: EVENT_PROTOCOLS.accept },
  { edgeId: "ask.discovery.discovery", action: "ask", from: "DISCOVERY", to: "DISCOVERY", protocol: EVENT_PROTOCOLS.ask },
  { edgeId: "frame.discovery.problem-framing", action: "frame", from: "DISCOVERY", to: "PROBLEM_FRAMING", protocol: EVENT_PROTOCOLS.frame },
  { edgeId: "hint.discovery.discovery", action: "hint", from: "DISCOVERY", to: "DISCOVERY", protocol: EVENT_PROTOCOLS.hint },
  { edgeId: "hint.problem-framing.problem-framing", action: "hint", from: "PROBLEM_FRAMING", to: "PROBLEM_FRAMING", protocol: EVENT_PROTOCOLS.hint },
  { edgeId: "submit-brief.problem-framing.solution-design", action: "submit-brief", from: "PROBLEM_FRAMING", to: "SOLUTION_DESIGN", protocol: EVENT_PROTOCOLS["submit-brief"] },
  { edgeId: "clarify.problem-framing.discovery", action: "clarify", from: "PROBLEM_FRAMING", to: "DISCOVERY", protocol: EVENT_PROTOCOLS.clarify },
  { edgeId: "submit-design.solution-design.challenge", action: "submit-design", from: "SOLUTION_DESIGN", to: "CHALLENGE", protocol: EVENT_PROTOCOLS["submit-design"] },
  { edgeId: "respond-challenge.challenge.challenge", action: "respond-challenge", from: "CHALLENGE", to: "CHALLENGE", protocol: EVENT_PROTOCOLS["respond-challenge"] },
  { edgeId: "submit-pitch.pitch.review", action: "submit-pitch", from: "PITCH", to: "REVIEW", protocol: EVENT_PROTOCOLS["submit-pitch"] },
  { edgeId: "review.review.review", action: "review", from: "REVIEW", to: "REVIEW", protocol: EVENT_PROTOCOLS.review },
  { edgeId: "retry.review.retry-ready", action: "retry", from: "REVIEW", to: "RETRY_READY", protocol: EVENT_PROTOCOLS.retry },
  // `start-retry` spawns the child run at DISCOVERY; the parent emits nothing.
  { edgeId: "start-retry.retry-ready.discovery", action: "start-retry", from: "RETRY_READY", to: "DISCOVERY", protocol: EVENT_PROTOCOLS["start-retry"] },
  { edgeId: "complete.review.completed", action: "complete", from: "REVIEW", to: "COMPLETED", protocol: EVENT_PROTOCOLS.complete },
  ...ABORTABLE_PHASES.map(abortEdge),
];

/** The legal `from` phases for an action (empty for an unknown action). */
export function legalFromPhases(action: ActionId): ReadonlySet<RunPhase | null> {
  const set = new Set<RunPhase | null>();
  for (const edge of PHASE_EDGES) {
    if (edge.action === action) set.add(edge.from);
  }
  return set;
}

/**
 * The legal `phase.changed` (from → to) transitions the runtime actually emits,
 * as the EFFECTS of the edges above. Distinct from `PHASE_EDGES` in two ways:
 *
 *   1. It includes the byte-stable `SCENARIO → SCENARIO` anchor that `start`
 *      emits (that anchor is not a command edge — no command is "legal from
 *      SCENARIO into SCENARIO").
 *   2. It EXCLUDES self-loop edges (`ask`, `hint`, `review`, `respond-challenge`
 *      stay) that produce no `phase.changed`, and the `start-retry` edge whose
 *      `to` is the CHILD run's phase (not a parent transition).
 *
 * The batch validator (G1-01) and strict replay (G1-02) check every
 * `phase.changed` against this table — the single source of truth for which
 * transitions are legal.
 */
export const PHASE_TRANSITIONS: readonly { from: RunPhase; to: RunPhase }[] = [
  { from: "SCENARIO", to: "SCENARIO" }, // start anchor (byte-stable artifact)
  { from: "SCENARIO", to: "DISCOVERY" }, // accept
  { from: "DISCOVERY", to: "PROBLEM_FRAMING" }, // frame
  { from: "PROBLEM_FRAMING", to: "SOLUTION_DESIGN" }, // submit-brief (pass)
  { from: "PROBLEM_FRAMING", to: "DISCOVERY" }, // clarify
  { from: "SOLUTION_DESIGN", to: "CHALLENGE" }, // submit-design
  { from: "CHALLENGE", to: "PITCH" }, // respond-challenge (all answered)
  { from: "PITCH", to: "REVIEW" }, // submit-pitch
  { from: "REVIEW", to: "RETRY_READY" }, // retry
  { from: "REVIEW", to: "COMPLETED" }, // complete
  { from: "SCENARIO", to: "ABORTED" },
  { from: "DISCOVERY", to: "ABORTED" },
  { from: "PROBLEM_FRAMING", to: "ABORTED" },
  { from: "SOLUTION_DESIGN", to: "ABORTED" },
  { from: "CHALLENGE", to: "ABORTED" },
  { from: "PITCH", to: "ABORTED" },
  { from: "REVIEW", to: "ABORTED" },
  { from: "RETRY_READY", to: "ABORTED" },
];

/** True when `from → to` is a legal `phase.changed` transition. */
export function isLegalPhaseTransition(from: RunPhase, to: RunPhase): boolean {
  return PHASE_TRANSITIONS.some((transition) => transition.from === from && transition.to === to);
}
