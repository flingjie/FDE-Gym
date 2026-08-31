import { describe, expect, it } from "vitest";
import { buildRoleInput } from "../../src/security/context-firewall";
import type { PublicRunView } from "../../src/core/aggregate";
import type { CustomerCapsule } from "../../src/scenarios/schema";

const text = { "zh-CN": "提高工厂运营效率", "en-US": "Improve factory operational efficiency" };

// A complete, schema-valid public view: `buildRoleInput` fail-closes over the
// full aggregate, so the runtime call below must carry every required field.
const validPublic: PublicRunView = {
  runId: "run-1",
  scenarioId: "scn-1",
  locale: "zh-CN",
  phase: null,
  transcript: [],
  graph: { version: 0, nodes: [], edges: [] },
  disclosedDisclosureUnitIds: [],
  grantedHints: [],
  pendingQuestion: { question: "q", stakeholderId: "s1" },
  coachTask: "brief-validation",
  brief: null,
  proposal: null,
  pitch: null,
  challengeResponses: [],
  pendingEvidence: null,
  clarificationBudgetUsed: 0,
};

// A complete `CustomerCapsule`, so the only compile-time error on the guarded
// line is the forbidden `score` field (never the capsule shape).
const validCapsule: CustomerCapsule = {
  id: "scn-1",
  schemaVersion: 1,
  stakeholders: [{ id: "s1", role: text, persona: text, concerns: [text], blindSpots: [text] }],
  disclosureUnits: [],
  responsePolicies: [],
  privateConflicts: [],
  canary: "CUSTOMER_CANARY_abc123",
};

describe("firewall type boundary", () => {
  it("buildRoleInput is callable", () => {
    expect(typeof buildRoleInput).toBe("function");
  });

  it("rejects an aggregate carrying a sensitive field at compile time", () => {
    // @ts-expect-error — score is not on PublicRunView; this line is a type error
    buildRoleInput("customer", { ...validPublic, score: "LEAK" }, validCapsule);
    expect(validPublic.locale).toBe("zh-CN");
  });
});
