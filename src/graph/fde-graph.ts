import type { RunPhase } from "../core/domain.js";
import type { GraphDefinition } from "./definition.js";
import type { GraphEffect, GraphEdgeDefinition, GraphNodeDefinition } from "./types.js";
import { EVENT_PROTOCOLS } from "./event-protocols.js";

/**
 * FDE Gym — the concrete Agent Graph (Phase 2, G2-03).
 *
 * Nodes are the runtime's work units (agent invocation / deterministic compute /
 * guard). Edges connect them and declare the triggering Action, an optional
 * Guard, the Effects (a phase change is an effect), and the Event Protocol.
 * This is the single source of truth for the graph shape; `phase-spec.ts`
 * projects the phase-legality table from these edges, and `validator.ts`
 * checks this definition's structural invariants.
 */

function pc(from: RunPhase, to: RunPhase): GraphEffect {
  return { type: "phase-change", from, to };
}

export const NODES: readonly GraphNodeDefinition[] = [
  { id: "run.start", phase: "SCENARIO", kind: "deterministic" },
  { id: "discovery.question.accept", phase: "DISCOVERY", kind: "guard" },
  { id: "customer.invoke", phase: "DISCOVERY", kind: "agent", contextPolicy: { role: "customer", capsule: "customer" } },
  { id: "evidence.invoke", phase: "DISCOVERY", kind: "agent", contextPolicy: { role: "evidence_tracker" } },
  { id: "evidence.patch.apply", phase: "DISCOVERY", kind: "deterministic" },
  { id: "brief.structure.guard", phase: "PROBLEM_FRAMING", kind: "guard" },
  { id: "coach.brief.invoke", phase: "PROBLEM_FRAMING", kind: "agent", contextPolicy: { role: "coach_evaluator", capsule: "evaluator" } },
  { id: "brief.support.guard", phase: "PROBLEM_FRAMING", kind: "guard" },
  { id: "solution.accept", phase: "SOLUTION_DESIGN", kind: "guard" },
  { id: "challenge.inject", phase: "CHALLENGE", kind: "deterministic" },
  { id: "challenge.response.guard", phase: "CHALLENGE", kind: "guard" },
  { id: "pitch.structure.guard", phase: "PITCH", kind: "guard" },
  { id: "coach.review.invoke", phase: "REVIEW", kind: "agent", contextPolicy: { role: "coach_evaluator", capsule: "evaluator" } },
  { id: "score.compute", phase: "REVIEW", kind: "deterministic" },
  { id: "profile.apply", phase: "REVIEW", kind: "deterministic" },
  { id: "run.retry-ready", phase: "RETRY_READY", kind: "deterministic" },
  { id: "run.completed", phase: "COMPLETED", kind: "deterministic" },
  { id: "run.aborted", phase: "ABORTED", kind: "deterministic" },
];

export const EDGES: readonly GraphEdgeDefinition[] = [
  // start (unstarted) — the byte-stable SCENARIO→SCENARIO anchor.
  { id: "start.unstarted.scenario", from: "run.start", to: "run.start", trigger: "start", effects: [pc("SCENARIO", "SCENARIO")], protocol: EVENT_PROTOCOLS.start },
  // accept (auto-issued inside start/retry).
  { id: "accept.scenario.discovery", from: "run.start", to: "discovery.question.accept", trigger: "accept", effects: [pc("SCENARIO", "DISCOVERY")], protocol: EVENT_PROTOCOLS.accept },

  // Discovery loop: ask (self-loop, no phase event), frame (advance).
  { id: "ask.discovery.discovery", from: "discovery.question.accept", to: "customer.invoke", trigger: "ask", effects: [], protocol: EVENT_PROTOCOLS.ask },
  { id: "frame.discovery.problem-framing", from: "discovery.question.accept", to: "brief.structure.guard", trigger: "frame", guard: "no-pending-evidence", effects: [pc("DISCOVERY", "PROBLEM_FRAMING")], protocol: EVENT_PROTOCOLS.frame },

  // hint (legal in two phases; no phase event).
  { id: "hint.discovery.discovery", from: "discovery.question.accept", to: "discovery.question.accept", trigger: "hint", effects: [], protocol: EVENT_PROTOCOLS.hint },
  { id: "hint.problem-framing.problem-framing", from: "brief.structure.guard", to: "brief.structure.guard", trigger: "hint", effects: [], protocol: EVENT_PROTOCOLS.hint },

  // Problem framing: submit-brief (pass advances), clarify (return to discovery).
  { id: "submit-brief.problem-framing.solution-design", from: "brief.support.guard", to: "solution.accept", trigger: "submit-brief", guard: "brief-support-sufficient", effects: [pc("PROBLEM_FRAMING", "SOLUTION_DESIGN")], protocol: EVENT_PROTOCOLS["submit-brief"] },
  { id: "clarify.problem-framing.discovery", from: "brief.structure.guard", to: "discovery.question.accept", trigger: "clarify", guard: "clarification-budget-available", effects: [pc("PROBLEM_FRAMING", "DISCOVERY")], protocol: EVENT_PROTOCOLS.clarify },

  // Solution → challenge.
  { id: "submit-design.solution-design.challenge", from: "solution.accept", to: "challenge.inject", trigger: "submit-design", guard: "proposal-structure-valid", effects: [pc("SOLUTION_DESIGN", "CHALLENGE")], protocol: EVENT_PROTOCOLS["submit-design"] },

  // Challenge: respond (stay until all-answered advances to pitch).
  { id: "respond-challenge.challenge.challenge", from: "challenge.response.guard", to: "challenge.response.guard", trigger: "respond-challenge", guard: "challenge-response-valid", effects: [], protocol: EVENT_PROTOCOLS["respond-challenge"] },
  { id: "respond-challenge.challenge.pitch", from: "challenge.response.guard", to: "pitch.structure.guard", trigger: "respond-challenge", guard: "all-challenges-answered", effects: [pc("CHALLENGE", "PITCH")], protocol: EVENT_PROTOCOLS["respond-challenge"] },

  // Pitch → review.
  { id: "submit-pitch.pitch.review", from: "pitch.structure.guard", to: "coach.review.invoke", trigger: "submit-pitch", guard: "pitch-structure-valid", effects: [pc("PITCH", "REVIEW")], protocol: EVENT_PROTOCOLS["submit-pitch"] },

  // Review (self-loop: review.completed + score.computed; no phase event).
  { id: "review.review.review", from: "coach.review.invoke", to: "coach.review.invoke", trigger: "review", effects: [], protocol: EVENT_PROTOCOLS.review },

  // Terminal: retry (two-step), complete, abort.
  { id: "retry.review.retry-ready", from: "coach.review.invoke", to: "run.retry-ready", trigger: "retry", effects: [pc("REVIEW", "RETRY_READY")], protocol: EVENT_PROTOCOLS.retry },
  { id: "start-retry.retry-ready.discovery", from: "run.retry-ready", to: "run.start", trigger: "start-retry", effects: [{ type: "spawn-run" }], protocol: EVENT_PROTOCOLS["start-retry"] },
  { id: "complete.review.completed", from: "coach.review.invoke", to: "run.completed", trigger: "complete", effects: [pc("REVIEW", "COMPLETED")], protocol: EVENT_PROTOCOLS.complete },

  // abort (from every active phase).
  ...(["SCENARIO", "DISCOVERY", "PROBLEM_FRAMING", "SOLUTION_DESIGN", "CHALLENGE", "PITCH", "REVIEW", "RETRY_READY"] as const).map((from) => ({
    id: `abort.${from}.aborted`,
    from: "run.start",
    to: "run.aborted",
    trigger: "abort" as const,
    effects: [pc(from, "ABORTED")],
    protocol: EVENT_PROTOCOLS.abort,
  })),
];

/** The graph version, recorded in `run.started` so a run replays under the graph it was started with. */
export const GRAPH_VERSION = "1" as const;

export const FDE_GRAPH: GraphDefinition = {
  id: "fde-gym",
  version: GRAPH_VERSION,
  initialPhase: null,
  nodes: NODES,
  edges: EDGES,
};
