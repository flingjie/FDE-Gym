import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_OUTPUT_INVALID,
  LEAK_GUARD_TRIGGERED,
  containsCanary,
  sanitizeAgentResult,
} from "../../src/security/sanitizer";
import { projectPublic } from "../../src/security/public-projection";
import { buildRoleInput, type RunAggregate } from "../../src/security/context-firewall";
import { CodexAgentRuntime } from "../../src/integrations/codex/codex-runtime";
import { CustomerOutputSchema, FinalReviewOutputSchema } from "../../src/agents/contracts";
import { appendEvents } from "../../src/core/event-store";
import type { RunEvent } from "../../src/core/domain";

const fakeCodexRuntime = fileURLToPath(new URL("../contracts/fake-codex-runtime.mjs", import.meta.url));

const CUSTOMER_CANARY = "CUSTOMER_CANARY_7f3a9c1e2b4d";
const EVALUATOR_CANARY = "EVALUATOR_CANARY_9d4f2a7b1c3e";
const CANARIES = [CUSTOMER_CANARY, EVALUATOR_CANARY];

const text = { "zh-CN": "好的", "en-US": "ok" };

const cleanEvents: RunEvent[] = [
  { type: "run.started", runId: "r1", commandId: "c1", scenarioId: "scn-1", locale: "zh-CN" },
  { type: "phase.changed", runId: "r1", commandId: "c2", from: "SCENARIO", to: "DISCOVERY" },
  { type: "question.asked", runId: "r1", commandId: "c3", questionId: "q1", question: "每天有多少告警？" },
  { type: "customer.replied", runId: "r1", commandId: "c4", questionId: "q1", reply: text, stakeholderId: "s1" },
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

  it("excludes raw evaluator output fields from projected review events", () => {
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
    expect(serialized).not.toContain("missedOpportunities");
    expect(serialized).not.toContain("decisionDivergencePoints");
    expect(serialized).toContain("strengths");
    expect(serialized).toContain("nextFocus");
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

describe("leak guard — CodexAgentRuntime stdout/stderr scan", () => {
  const FAKE_KEYS = ["FAKE_RUNTIME_MODE", "FAKE_RUNTIME_CANARY", "FAKE_RUNTIME_COUNT_FILE", "FAKE_RUNTIME_SLEEP_MS"];
  let tempRoots: string[] = [];

  function validStakeholder() {
    return { id: "s1", role: text, persona: text, concerns: [text], blindSpots: [text] };
  }
  function validDisclosureUnit() {
    return { id: "d1", topic: "workflow", text, prerequisites: [], evidenceId: "e1" };
  }
  function validGraph() {
    return {
      version: 0,
      nodes: [
        { id: "ev-a", kind: "fact", claim: text, status: "active", sourceTranscriptIds: ["t1"], weight: 1, version: 0 },
      ],
      edges: [],
    };
  }
  function aggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
    return {
      runId: "r1",
      scenarioId: "scn-1",
      locale: "zh-CN",
      phase: "DISCOVERY",
      transcript: [{ turnId: "t1", seq: 0, question: "每天有多少告警？", customerReply: text, stakeholderId: "s1" }],
      graph: validGraph(),
      disclosedDisclosureUnitIds: [],
      grantedHints: [],
      pendingQuestion: { question: "每天有多少告警？", stakeholderId: "s1" },
      hintRequest: null,
      coachTask: "hint",
      brief: null,
      proposal: null,
      pitch: null,
      challengeResponses: [],
      ...overrides,
    };
  }
  function customerInput() {
    const out = buildRoleInput("customer", aggregate(), {
      id: "scn-1",
      schemaVersion: 1,
      stakeholders: [validStakeholder()],
      disclosureUnits: [validDisclosureUnit()],
      responsePolicies: [],
      privateConflicts: [],
      canary: "CUSTOMER_CANARY",
    });
    if (out.kind !== "customer") throw new Error("expected customer input");
    return out.input;
  }

  function makeRuntime(mode: string) {
    const workRoot = mkdtempSync(join(tmpdir(), "fde-leak-rt-"));
    const countFile = join(workRoot, "count.txt");
    tempRoots.push(workRoot);
    process.env.FAKE_RUNTIME_MODE = mode;
    process.env.FAKE_RUNTIME_CANARY = CUSTOMER_CANARY;
    process.env.FAKE_RUNTIME_COUNT_FILE = countFile;
    process.env.FAKE_RUNTIME_SLEEP_MS = "0";
    const rt = new CodexAgentRuntime({
      executable: fakeCodexRuntime,
      workRoot,
      timeoutMs: 10_000,
      canaries: [CUSTOMER_CANARY, EVALUATOR_CANARY],
      envExtraAllow: FAKE_KEYS,
    });
    return { rt };
  }

  afterEach(() => {
    for (const key of FAKE_KEYS) delete process.env[key];
    for (const dir of tempRoots) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tempRoots = [];
  });

  it("catches a canary emitted only in raw stdout (reasoning), not in parsed output", async () => {
    const { rt } = makeRuntime("stdout-leak");
    const error = await rt
      .invoke("customer", customerInput(), {
        runId: "r1",
        invocationId: "inv-1",
        freshContext: true,
        tools: "disabled",
        outputSchema: CustomerOutputSchema,
        timeoutMs: 10_000,
      })
      .catch((e) => e);
    expect(error.code).toBe(LEAK_GUARD_TRIGGERED);
    expect(String(error.message)).not.toContain(CUSTOMER_CANARY);
    expect(JSON.stringify(error)).not.toContain(CUSTOMER_CANARY);
  });

  it("recovers when the stdout leak disappears on the fresh-context retry", async () => {
    const { rt } = makeRuntime("stdout-leak-once");
    const res = await rt.invoke("customer", customerInput(), {
      runId: "r1",
      invocationId: "inv-1",
      freshContext: true,
      tools: "disabled",
      outputSchema: CustomerOutputSchema,
      timeoutMs: 10_000,
    });
    expect(res.output.reply["zh-CN"]).toBe("好的");
  });
});
