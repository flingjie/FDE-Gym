import type { HintLevel, LocalizedText } from "../core/domain.js";
import type { HintLedgerEntry } from "../agents/contracts.js";
import type { HintLadder } from "../scenarios/schema.js";

/**
 * FDE Gym — deterministic hint escalation and selection.
 *
 * `requestHint` is PURE: no randomness, no wall-clock, no I/O. It enforces the
 * learner-safe escalation discipline for a single topic, then resolves the
 * granted level to the ladder's `LocalizedText` from the scenario's
 * `hintLadders` (the evaluator capsule). Hints are NOT evidence sources and
 * NEVER enter the Customer's context — this module consumes only
 * evaluator-side `HintLadder` data and the prior hint ledger, never a customer
 * capsule.
 *
 * Escalation rules (per topic):
 *   - Auto mode (`requestedLevel === null`): grant the NEXT level
 *     (`current + 1`), never skipping, never downgrading. First hint is always
 *     level 1. Grants stop at level 3.
 *   - Explicit mode (`requestedLevel` is a level): the learner may skip ahead
 *     (the explicit-request exception), but may NEVER downgrade or repeat a
 *     level at or below the highest already granted.
 *
 * Learner-safe level discipline (enforced by selection, so a lower-level grant
 * can never leak a higher level's text):
 *   - Level 1 = metacognitive dimension only.
 *   - Level 2 = missing evidence category only.
 *   - Level 3 = one actionable question, without its answer.
 */

export const HINT_UNKNOWN_TOPIC = "HINT_UNKNOWN_TOPIC" as const;
export const HINT_NO_DOWNGRADE = "HINT_NO_DOWNGRADE" as const;
export const HINT_EXHAUSTED = "HINT_EXHAUSTED" as const;

export class HintError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HintError";
    this.code = code;
  }
}

/** The granted level and its ladder text. Exactly two fields — no hidden content. */
export interface HintGrant {
  level: HintLevel;
  hint: LocalizedText;
}

/** Highest level already granted for a topic (0 when none). */
function maxGrantedLevel(grantedLevels: readonly HintLedgerEntry[], topic: string): number {
  let max = 0;
  for (const entry of grantedLevels) {
    if (entry.topic === topic && entry.level > max) max = entry.level;
  }
  return max;
}

/** Copy a LocalizedText so the caller can never mutate the ladder in place. */
function copyText(text: LocalizedText): LocalizedText {
  return { "zh-CN": text["zh-CN"], "en-US": text["en-US"] };
}

/**
 * Resolve a hint request to a granted level + ladder text.
 *
 * @param topic - the discovery topic (must match a `HintLadder.topic`).
 * @param requestedLevel - an explicit `1|2|3`, or `null` to auto-escalate.
 * @param hintLadders - the scenario's `hintLadders` (from the evaluator capsule).
 * @param grantedLevels - the prior hint ledger for escalation discipline.
 */
export function requestHint(
  topic: string,
  requestedLevel: HintLevel | null,
  hintLadders: readonly HintLadder[],
  grantedLevels: readonly HintLedgerEntry[] = [],
): HintGrant {
  const ladder = hintLadders.find((entry) => entry.topic === topic);
  if (!ladder) {
    throw new HintError(HINT_UNKNOWN_TOPIC, `no hint ladder for topic: ${topic}`);
  }

  const current = maxGrantedLevel(grantedLevels, topic);

  let level: HintLevel;
  if (requestedLevel === null) {
    // Auto mode: strictly one step at a time, never skip, never downgrade.
    const next = current + 1;
    if (next > 3) {
      throw new HintError(HINT_EXHAUSTED, `hint ladder exhausted for topic: ${topic}`);
    }
    level = next as HintLevel;
  } else {
    // Explicit mode: skip-ahead is allowed, downgrade/repeat is not.
    if (requestedLevel <= current) {
      throw new HintError(
        HINT_NO_DOWNGRADE,
        `cannot grant level ${requestedLevel} for topic ${topic} (already at level ${current})`,
      );
    }
    level = requestedLevel;
  }

  const hintByLevel: Record<HintLevel, LocalizedText> = {
    1: ladder.hints["1"],
    2: ladder.hints["2"],
    3: ladder.hints["3"],
  };

  return { level, hint: copyText(hintByLevel[level]) };
}
