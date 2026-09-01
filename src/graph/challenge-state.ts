import { z } from "zod";
import type { RunEvent } from "../core/domain.js";

/**
 * FDE Gym — challenge aggregate (Phase 1, G1-03 seed).
 *
 * A pure, deterministic reducer over the injected-challenge lifecycle. It is the
 * single source of truth for "which challenges exist and which of them are
 * answered", and is intended to replace the caller-tracked
 * `mandatoryChallengeIds` list + `challengeResponses` append that
 * `prepareRespondToChallenge` uses today (`src/core/orchestrator.ts`).
 *
 * Rules encoded (verbatim from the plan):
 *   - A response must point to an already-injected challenge (no response to an
 *     unknown id).
 *   - No duplicate answers to the same challenge (unless a future `revise` action
 *     is added).
 *   - `all-answered` is derived ONLY from this aggregate — never a caller-tracked
 *     `mandatoryChallengeIds` list.
 *   - An empty challenge set uses an explicit edge to advance — never a fabricated
 *     response. (That edge lives in the orchestrator, not here.)
 *
 * Error policy: an invalid fold (`challenge.responded` for an unknown or
 * already-answered challenge id) THROWS a typed `ChallengeStateError` carrying a
 * stable machine-readable `code`. Throwing is deterministic and side-effect-free,
 * and it keeps the reducer's happy path a plain `collection -> event ->
 * collection` fold that composes with `Array.prototype.reduce`.
 *
 * This module is deterministic and side-effect-free: it imports no orchestrator,
 * performs no I/O, and never mutates its inputs. It is NOT wired into
 * `foldRunAggregate` or the orchestrator yet — that is Phase 1 (G1-03), later.
 */

export type InjectedChallengeStatus = "pending" | "answered";

export interface InjectedChallengeState {
  id: string;
  status: InjectedChallengeStatus;
  /** The `ChallengeResponse.id` that answered this challenge; absent while pending. */
  responseId?: string;
}

/** Zod form of `InjectedChallengeState`, for the aggregate schema. */
export const InjectedChallengeStateSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["pending", "answered"]),
    responseId: z.string().min(1).optional(),
  })
  .strict();

/** Immutable collection of injected-challenge entries, in injection order. */
export type InjectedChallengeCollection = readonly InjectedChallengeState[];

/** The pristine collection a fold starts from. */
export function emptyInjectedChallenges(): InjectedChallengeCollection {
  return [];
}

// ---------------------------------------------------------------------------
// Error surface
// ---------------------------------------------------------------------------

/** A `challenge.responded` event referenced a challenge that was never injected. */
export const CHALLENGE_RESPONSE_TO_UNKNOWN_ID = "CHALLENGE_RESPONSE_TO_UNKNOWN_ID" as const;
/** A `challenge.responded` event re-answered a challenge that already has a response. */
export const CHALLENGE_ALREADY_ANSWERED = "CHALLENGE_ALREADY_ANSWERED" as const;

export class ChallengeStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChallengeStateError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

/**
 * Pure event fold over the injected-challenge collection.
 *
 *   - `challenge.injected` appends a `pending` entry; idempotent on a duplicate id
 *     (returns the SAME collection reference — a true no-op).
 *   - `challenge.responded` marks the matching `pending` entry `answered` and
 *     records `responseId`. Throws `ChallengeStateError` on an unknown challenge id
 *     (`CHALLENGE_RESPONSE_TO_UNKNOWN_ID`) or an already-answered one
 *     (`CHALLENGE_ALREADY_ANSWERED`).
 *   - every other event is not part of this aggregate and leaves it unchanged.
 */
export function reduceInjectedChallenges(
  challenges: InjectedChallengeCollection,
  event: RunEvent,
): InjectedChallengeCollection {
  switch (event.type) {
    case "challenge.injected": {
      if (challenges.some((entry) => entry.id === event.challengeId)) {
        // Idempotent: a duplicate injection of the same id is a no-op.
        return challenges;
      }
      return [...challenges, { id: event.challengeId, status: "pending" }];
    }
    case "challenge.responded": {
      const index = challenges.findIndex((entry) => entry.id === event.response.challengeId);
      if (index === -1) {
        throw new ChallengeStateError(
          CHALLENGE_RESPONSE_TO_UNKNOWN_ID,
          `response targets an uninjected challenge: ${event.response.challengeId}`,
        );
      }
      const target = challenges[index];
      if (target.status === "answered") {
        throw new ChallengeStateError(
          CHALLENGE_ALREADY_ANSWERED,
          `challenge already answered: ${event.response.challengeId}`,
        );
      }
      return challenges.map((entry, i) =>
        i === index
          ? { id: entry.id, status: "answered", responseId: event.response.id }
          : entry,
      );
    }
    default:
      return challenges;
  }
}

// ---------------------------------------------------------------------------
// Derived predicate
// ---------------------------------------------------------------------------

/**
 * `true` when every injected challenge is `answered`. Vacuously `true` on an
 * empty set — the empty case is advanced by an explicit edge in the orchestrator,
 * never by this predicate inventing a response.
 */
export function allChallengesAnswered(challenges: InjectedChallengeCollection): boolean {
  return challenges.every((entry) => entry.status === "answered");
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Canonical serialization of the collection (fixed key order). This is the
 * byte-identity contract determinism tests assert against; `responseId` is
 * normalized to `null` when absent so key order never depends on construction.
 */
export function canonicalInjectedChallenges(challenges: InjectedChallengeCollection): string {
  return JSON.stringify(
    challenges.map((entry) => ({
      id: entry.id,
      status: entry.status,
      responseId: entry.responseId ?? null,
    })),
  );
}
