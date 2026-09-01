import { describe, expect, it } from "vitest";

import { RunEventSchema } from "../../src/core/domain.js";
import {
  CONTROL_FIXTURES,
  ILLEGAL_FIXTURES,
  REFERENCE_FIXTURES,
  duplicateChallengeResponse,
  emptyChallengeResponse,
  eventsAfterTerminal,
  illegalCrossPhaseTransition,
  legalAskBatch,
  legalStartBatch,
  mixedRunIdBatch,
  preparedJournalRecovery,
  protocolExtraEvent,
  protocolMissingRequired,
  protocolOutOfOrder,
  unknownChallengeResponse,
  wrongFromPhaseChanged,
} from "./graph-fixtures.js";

/**
 * G1-04 seed — adversarial event-batch skeleton.
 *
 * This suite asserts only the structural invariants that hold TODAY, without a
 * batch validator. The actual rejection behavior is declared as `it.todo`
 * blocks pointing at the Phase 1 validators that will consume these fixtures:
 *
 *   - G1-01: reject an illegal event batch BEFORE it is journaled.
 *   - G1-02: make replay fail-closed on an illegal log.
 *
 * Do NOT implement a validator here.
 */

describe("G1-04 fixtures — registries", () => {
  it("exposes non-empty control, illegal, and reference registries", () => {
    expect(CONTROL_FIXTURES.length).toBeGreaterThan(0);
    expect(ILLEGAL_FIXTURES.length).toBeGreaterThan(0);
    expect(REFERENCE_FIXTURES.length).toBeGreaterThan(0);
  });

  it("every registry entry carries a name, a rule, a non-empty batch, and a schemaValid flag", () => {
    for (const fixture of [...CONTROL_FIXTURES, ...ILLEGAL_FIXTURES, ...REFERENCE_FIXTURES]) {
      expect(fixture.name.length).toBeGreaterThan(0);
      expect(fixture.rule.length).toBeGreaterThan(0);
      expect(Array.isArray(fixture.events)).toBe(true);
      expect(fixture.events.length).toBeGreaterThan(0);
      expect(typeof fixture.schemaValid).toBe("boolean");
    }
  });
});

describe("G1-04 fixtures — every batch is a non-empty array of typed events", () => {
  for (const fixture of [...CONTROL_FIXTURES, ...ILLEGAL_FIXTURES, ...REFERENCE_FIXTURES]) {
    it(`${fixture.name} is a non-empty array whose events each declare a non-empty type`, () => {
      expect(Array.isArray(fixture.events)).toBe(true);
      expect(fixture.events.length).toBeGreaterThan(0);
      for (const event of fixture.events) {
        expect(typeof event.type).toBe("string");
        expect(event.type.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("G1-04 fixtures — control + reference batches are schema-valid today", () => {
  for (const fixture of [...CONTROL_FIXTURES, ...REFERENCE_FIXTURES]) {
    it(`${fixture.name} parses under RunEventSchema`, () => {
      for (const event of fixture.events) {
        expect(() => RunEventSchema.parse(event)).not.toThrow();
      }
    });
  }
});

describe("G1-04 fixtures — illegal batches carry the intended shape", () => {
  for (const fixture of ILLEGAL_FIXTURES) {
    if (fixture.schemaValid) {
      it(`${fixture.name} is schema-valid (illegality is graph-level, not schema-level)`, () => {
        for (const event of fixture.events) {
          expect(() => RunEventSchema.parse(event)).not.toThrow();
        }
      });
    } else {
      it(`${fixture.name} is schema-INVALID by design`, () => {
        expect(fixture.events).toHaveLength(1);
        expect(() => RunEventSchema.parse(fixture.events[0])).toThrow();
      });
    }
  }
});

describe("G1-04 fixtures — targeted structural invariants", () => {
  it("legalStartBatch is [run.started, phase.changed(SCENARIO→SCENARIO)]", () => {
    expect(legalStartBatch.map((e) => e.type)).toEqual(["run.started", "phase.changed"]);
    expect(legalStartBatch[1]).toMatchObject({ from: "SCENARIO", to: "SCENARIO" });
  });

  it("legalAskBatch is [question.asked, customer.replied, evidence.patched, question.assessed]", () => {
    expect(legalAskBatch.map((e) => e.type)).toEqual([
      "question.asked",
      "customer.replied",
      "evidence.patched",
      "question.assessed",
    ]);
  });

  it("illegalCrossPhaseTransition declares from=DISCOVERY while the folded phase is SCENARIO", () => {
    expect(illegalCrossPhaseTransition.map((e) => e.type)).toEqual([
      "run.started",
      "phase.changed",
      "phase.changed",
    ]);
    expect(illegalCrossPhaseTransition[2]).toMatchObject({ from: "DISCOVERY", to: "PROBLEM_FRAMING" });
  });

  it("wrongFromPhaseChanged declares from=PITCH to=DISCOVERY (no PHASE_EDGES edge)", () => {
    expect(wrongFromPhaseChanged).toHaveLength(1);
    expect(wrongFromPhaseChanged[0]).toMatchObject({ type: "phase.changed", from: "PITCH", to: "DISCOVERY" });
  });

  it("protocolMissingRequired omits customer.replied", () => {
    expect(protocolMissingRequired.map((e) => e.type)).toEqual(["question.asked", "evidence.patched"]);
  });

  it("protocolOutOfOrder places customer.replied before question.asked", () => {
    expect(protocolOutOfOrder.map((e) => e.type)).toEqual([
      "customer.replied",
      "question.asked",
      "evidence.patched",
    ]);
  });

  it("protocolExtraEvent injects hint.granted outside ASK_PROTOCOL", () => {
    expect(protocolExtraEvent.map((e) => e.type)).toEqual([
      "question.asked",
      "customer.replied",
      "hint.granted",
      "evidence.patched",
    ]);
  });

  it("mixedRunIdBatch spans two distinct runIds", () => {
    const runIds = new Set(mixedRunIdBatch.map((e) => e.runId));
    expect(runIds.size).toBe(2);
  });

  it("eventsAfterTerminal places question.asked after run.completed", () => {
    const types = eventsAfterTerminal.map((e) => e.type);
    const completedIdx = types.indexOf("run.completed");
    const afterIdx = types.indexOf("question.asked");
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(afterIdx).toBeGreaterThan(completedIdx);
  });

  it("unknownChallengeResponse references a challengeId that is never injected", () => {
    expect(unknownChallengeResponse).toHaveLength(1);
    expect(unknownChallengeResponse[0]).toMatchObject({ type: "challenge.responded" });
    if (unknownChallengeResponse[0].type === "challenge.responded") {
      expect(unknownChallengeResponse[0].response.challengeId).toBe("ch-not-injected");
    }
  });

  it("duplicateChallengeResponse answers the same challengeId twice", () => {
    expect(duplicateChallengeResponse).toHaveLength(2);
    expect(duplicateChallengeResponse.map((e) => e.type)).toEqual([
      "challenge.responded",
      "challenge.responded",
    ]);
    if (
      duplicateChallengeResponse[0].type === "challenge.responded" &&
      duplicateChallengeResponse[1].type === "challenge.responded"
    ) {
      expect(duplicateChallengeResponse[0].response.challengeId).toBe("ch-1");
      expect(duplicateChallengeResponse[1].response.challengeId).toBe("ch-1");
    }
  });

  it("emptyChallengeResponse carries an empty response object", () => {
    expect(emptyChallengeResponse).toHaveLength(1);
    if (emptyChallengeResponse[0].type === "challenge.responded") {
      expect(emptyChallengeResponse[0].response).toEqual({});
    }
  });

  it("preparedJournalRecovery commits customer/assessment/validation model outputs", () => {
    const types = preparedJournalRecovery.map((e) => e.type);
    for (const modelOutput of ["customer.replied", "question.assessed", "brief.validated"] as const) {
      expect(types).toContain(modelOutput);
    }
  });
});

describe("G1-01 batch validator — rejection contract (TODO: implement in G1-01)", () => {
  it.todo("rejects illegalCrossPhaseTransition (from != folded current phase)");
  it.todo("rejects wrongFromPhaseChanged (no PHASE_EDGES edge from→to)");
  it.todo("rejects protocolMissingRequired (ASK_PROTOCOL missing customer.replied)");
  it.todo("rejects protocolOutOfOrder (ASK_PROTOCOL ordered: true violated)");
  it.todo("rejects protocolExtraEvent (hint.granted outside ASK_PROTOCOL)");
  it.todo("rejects mixedRunIdBatch (a batch must belong to exactly one run)");
  it.todo("rejects eventsAfterTerminal (nothing after run.completed / run.aborted)");
  it.todo("rejects unknownChallengeResponse (challengeId never injected)");
  it.todo("rejects duplicateChallengeResponse (challengeId answered twice)");
  it.todo("rejects emptyChallengeResponse (empty response payload)");
});

describe("G1-02 replay fail-closed — rejection contract (TODO: implement in G1-02)", () => {
  it.todo("refuses to fold every ILLEGAL_FIXTURES batch (fail-closed, not silent)");
  it.todo("folds preparedJournalRecovery without re-invoking any model");
});
