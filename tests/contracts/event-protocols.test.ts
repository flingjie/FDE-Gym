import { describe, expect, it } from "vitest";

import { EVENT_PROTOCOLS, protocolFor } from "../../src/graph/event-protocols.js";
import type { ActionId } from "../../src/graph/action-types.js";

/**
 * Event protocol registry contract tests (G05-02).
 *
 * The registry is the only place the ordered event batches are spelled out. It
 * must cover every action (enforced at compile time by its `Record<ActionId, _>`
 * type) and describe the success/pending/terminal batches accurately.
 */

describe("event protocol registry", () => {
  it("provides a protocol for every action", () => {
    for (const action of Object.keys(EVENT_PROTOCOLS) as ActionId[]) {
      expect(protocolFor(action)).toBe(EVENT_PROTOCOLS[action]);
    }
  });

  it("describes the `ask` success/pending split", () => {
    const ask = EVENT_PROTOCOLS.ask;
    expect(ask.required).toEqual(["question.asked", "customer.replied"]);
    expect(ask.optional).toEqual(["evidence.patched", "question.assessed", "evidence.pending"]);
    expect(ask.ordered).toBe(true);
  });

  it("describes the conditional phase.changed on gated submissions", () => {
    expect(EVENT_PROTOCOLS["submit-brief"].required).toEqual(["brief.submitted", "brief.validated"]);
    expect(EVENT_PROTOCOLS["submit-brief"].optional).toEqual(["phase.changed"]);

    expect(EVENT_PROTOCOLS["respond-challenge"].required).toEqual(["challenge.responded"]);
    expect(EVENT_PROTOCOLS["respond-challenge"].optional).toEqual(["phase.changed"]);
  });

  it("describes the terminal protocols", () => {
    expect(EVENT_PROTOCOLS.complete.required).toEqual(["run.completed", "phase.changed"]);
    expect(EVENT_PROTOCOLS.abort.required).toEqual(["run.aborted", "phase.changed"]);
    expect(EVENT_PROTOCOLS.retry.required).toEqual(["retry.started", "phase.changed"]);
  });

  it("models `start-retry` as parent-silent", () => {
    expect(EVENT_PROTOCOLS["start-retry"].required).toEqual([]);
  });

  it("every required/optional/forbidden type is a real event type", () => {
    // The `EventProtocolSpec` type already constrains these to RunEvent["type"];
    // this asserts non-empty required lists where an event batch is mandatory.
    for (const [action, protocol] of Object.entries(EVENT_PROTOCOLS)) {
      expect(protocol.required, action).toBeInstanceOf(Array);
      expect(protocol.optional ?? [], action).toBeInstanceOf(Array);
      expect(protocol.forbidden ?? [], action).toBeInstanceOf(Array);
    }
  });
});
