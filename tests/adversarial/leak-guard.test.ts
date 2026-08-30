import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_OUTPUT_INVALID,
  LEAK_GUARD_TRIGGERED,
  containsCanary,
  sanitizeAgentResult,
} from "../../src/security/sanitizer";
import { projectPublic } from "../../src/security/public-projection";
import { CustomerOutputSchema, FinalReviewOutputSchema } from "../../src/agents/contracts";
import { appendEvents } from "../../src/core/event-store";
import type { RunEvent } from "../../src/core/domain";

const CUSTOMER_CANARY = "CUSTOMER_CANARY_7f3a9c1e2b4d";
const EVALUATOR_CANARY = "EVALUATOR_CANARY_9d4f2a7b1c3e";
const CANARIES = [CUSTOMER_CANARY, EVALUATOR_CANARY];

const text = { "zh-CN": "好的", "en-US": "ok" };

const cleanEvents: RunEvent[] = [
  { type: "run.started", runId: "r1", commandId: "c1", scenarioId: "scn-1", locale: "zh-CN" },
  { type: "phase.changed", runId: "r1", commandId: "c2", from: "SCENARIO", to: "DISCOVERY" },
  { type: "question.asked", runId: "r1", commandId: "c3", questionId: "q1", question: "每天有多少告警？" },
  { type: "customer.replied", runId: "r1", commandId: "c4", questionId: "q1", reply: text, stakeholderId: "s1", disclosedDisclosureUnitIds: [] },
  { type: "evidence.patched", runId: "r1", commandId: "c5", patch: { patchId: "p1", expectedVersion: 0, addNodes: [], addEdges: [], invalidateNodeIds: [] } },
  { type: "hint.granted", runId: "r1", commandId: "c6", topic: "workflow", level: 1, hint: text },
];

describe("leak guard — sanitizer (raw + parsed output)", () => {
  it("strips a canary embedded in a prohibited key (chain-of-thought)", () => {
    const raw = {
      reply: text,
      stakeholderId: "s1",
      disclosedDisclosureUnitIds: [],
      reasoning: CUSTOMER_CANARY,
      chainOfThought: EVALUATOR_CANARY,
    };
    const res = sanitizeAgentResult(
      "customer",
      { invocationId: "i1", output: raw },
      CustomerOutputSchema,
      { canaries: CANARIES },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const serialized = JSON.stringify(res.output);
      expect(serialized).not.toContain(CUSTOMER_CANARY);
      expect(serialized).not.toContain(EVALUATOR_CANARY);
      expect(serialized).not.toContain("reasoning");
    }
  });

  it("triggers LEAK_GUARD_TRIGGERED without the matched text when a canary is a required-field value", () => {
    const raw = {
      reply: { "zh-CN": CUSTOMER_CANARY, "en-US": "ok" },
      stakeholderId: "s1",
      disclosedDisclosureUnitIds: [],
    };
    const res = sanitizeAgentResult(
      "customer",
      { invocationId: "i1", output: raw },
      CustomerOutputSchema,
      { canaries: CANARIES },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.code).toBe(LEAK_GUARD_TRIGGERED);
      expect(res.failure.message).not.toContain(CUSTOMER_CANARY);
      expect(JSON.stringify(res)).not.toContain(CUSTOMER_CANARY);
    }
  });

  it("distinguishes a schema-invalid output from a leak", () => {
    const res = sanitizeAgentResult(
      "customer",
      { invocationId: "i1", output: { wrong: "shape" } },
      CustomerOutputSchema,
      { canaries: CANARIES },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe(AGENT_OUTPUT_INVALID);
  });

  it("detects a canary in raw text (stdout/stderr surface)", () => {
    expect(containsCanary(`some stdout\n${CUSTOMER_CANARY}\n`, CANARIES)).toBe(true);
    expect(containsCanary("clean output", CANARIES)).toBe(false);
  });
});

describe("leak guard — public projection (public JSONL / snapshot)", () => {
  it("projects every run event without canaries, CoT, or internal ids", () => {
    const projected = cleanEvents.map(projectPublic);
    for (const pub of projected) {
      expect(pub).not.toBeNull();
      const serialized = JSON.stringify(pub);
      expect(serialized).not.toContain(CUSTOMER_CANARY);
      expect(serialized).not.toContain(EVALUATOR_CANARY);
      expect(serialized).not.toContain("canary");
      expect(serialized).not.toContain("commandId");
    }
    const snapshot = JSON.stringify(projected);
    expect(snapshot).not.toContain(CUSTOMER_CANARY);
    expect(snapshot).not.toContain("chainOfThought");
  });

  it("returns null (fail-safe) for an unrecognized event carrying a canary", () => {
    const unknown = {
      type: "internal.secret",
      runId: "r1",
      commandId: "c-x",
      canary: CUSTOMER_CANARY,
    } as unknown as RunEvent;
    expect(projectPublic(unknown)).toBeNull();
  });

  it("projects review events with learner-safe Coach feedback and no internal fields", () => {
    const review: RunEvent = {
      type: "review.completed",
      runId: "r1",
      commandId: "c9",
      review: {
        verdict: "pass",
        strengths: [text],
        weaknesses: [text],
        missedOpportunities: [{ ...text }],
        decisionDivergencePoints: [{ id: "ddp-1", description: text }],
        nextFocus: [text],
      },
    };
    const pub = projectPublic(review);
    expect(pub).not.toBeNull();
    const serialized = JSON.stringify(pub);
    // Task 11: missed opportunities and decision-divergence points are sanitized
    // Coach feedback over public input only, so they are learner-safe and now
    // projected (the replay surfaces them).
    expect(serialized).toContain("missedOpportunities");
    expect(serialized).toContain("decisionDivergencePoints");
    expect(serialized).toContain("strengths");
    expect(serialized).toContain("nextFocus");
    // Hidden/internal fields never surface.
    expect(serialized).not.toContain("canary");
    expect(serialized).not.toContain("commandId");
  });
});

describe("leak guard — replay (event store)", () => {
  it("commits only canary-free events to the append-only store", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "fde-leak-replay-"));
    try {
      await appendEvents("r1", cleanEvents, { baseDir });
      const raw = readFileSync(join(baseDir, "runs", "r1", "events.jsonl"), "utf8");
      expect(raw).not.toContain(CUSTOMER_CANARY);
      expect(raw).not.toContain(EVALUATOR_CANARY);
      expect(raw).not.toContain("canary");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("never advances state with a leaked coach output (rejected before append)", () => {
    const leaked = {
      verdict: "pass",
      strengths: [text],
      weaknesses: [{ "zh-CN": EVALUATOR_CANARY, "en-US": "x" }],
      missedOpportunities: [text],
      decisionDivergencePoints: [],
      nextFocus: [text],
    };
    const res = sanitizeAgentResult("coach_evaluator", { invocationId: "i1", output: leaked }, FinalReviewOutputSchema, {
      canaries: CANARIES,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe(LEAK_GUARD_TRIGGERED);
  });
});
