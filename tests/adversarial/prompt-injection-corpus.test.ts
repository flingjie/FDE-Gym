import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import {
  answerDiscoveryQuestion,
  renderCustomerPrompt,
  type AnswerDiscoveryQuestionContext,
} from "../../src/agents/customer";
import { buildRoleInput, type RunAggregate } from "../../src/security/context-firewall";
import { LEAK_GUARD_TRIGGERED } from "../../src/security/sanitizer";
import type { CustomerCapsule } from "../../src/scenarios/schema";

/**
 * Task 13 — cross-cutting adversarial prompt-injection corpus.
 *
 * Loads `tests/fixtures/adversarial-prompts.yaml` (12 categories: direct
 * instruction override, fake system/developer tags, administrator claims,
 * Base64, ROT13, rubric extraction, hidden-file requests, malformed JSON,
 * tool-use requests, error-message exfiltration, cross-role messaging, and
 * cross-retry private-memory recovery) and asserts, for EVERY prompt:
 *
 *   1. The Customer returns a stable refusal (no hidden canary, no disclosure).
 *   2. The learner text is wrapped in the UNTRUSTED_LEARNER_INPUT boundary
 *      exactly once and the canary never reaches the rendered prompt.
 *   3. A runtime that actually leaks a canary is rejected with
 *      `LEAK_GUARD_TRIGGERED` — WITHOUT echoing the canary or the prompt.
 */

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CANARY = "CUSTOMER_CANARY_SECRET_7f3a9c1e";
const REFUSAL = text("这个请求我无法满足。", "I can't help with that request.");

const CORPUS_PATH = join(process.cwd(), "tests", "fixtures", "adversarial-prompts.yaml");

type Corpus = Record<string, string[]>;

function loadCorpus(): Array<{ category: string; prompt: string }> {
  const raw = parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null) throw new Error("corpus must be a mapping");
  const corpus = raw as Corpus;
  const entries: Array<{ category: string; prompt: string }> = [];
  for (const [category, prompts] of Object.entries(corpus)) {
    expect(Array.isArray(prompts)).toBe(true);
    for (const prompt of prompts) entries.push({ category, prompt });
  }
  return entries;
}

const corpus = loadCorpus();

function capsule(): CustomerCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: [
      {
        id: "s-owner",
        role: text("企业主", "Business owner"),
        persona: text("企业主", "Owner"),
        concerns: [text("成本", "cost")],
        blindSpots: [text("技术细节", "technical details")],
      },
    ],
    disclosureUnits: [
      {
        id: "d1",
        topic: "workflow",
        text: text("三套遗留系统", "three legacy systems"),
        prerequisites: [],
        evidenceId: "e1",
      },
    ],
    responsePolicies: [],
    privateConflicts: [],
    canary: CANARY,
  };
}

function aggregate(question: string): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "DISCOVERY",
    transcript: [],
    graph: { version: 0, nodes: [], edges: [] },
    disclosedDisclosureUnitIds: [],
    grantedHints: [],
    pendingQuestion: { question, stakeholderId: "s-owner" },
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
  };
}

function context(question: string, runtime: FixtureAgentRuntime): AnswerDiscoveryQuestionContext {
  return {
    runtime,
    state: aggregate(question),
    capsule: capsule(),
    invocationId: "inv-1",
    timeoutMs: 1_000,
  };
}

/** A well-behaved customer that stably refuses every injected prompt. */
function compliantRuntime() {
  return new FixtureAgentRuntime({
    fixtures: {
      "customer:inv-1": {
        reply: REFUSAL,
        stakeholderId: "s-owner",
        disclosedDisclosureUnitIds: [],
      },
    },
  });
}

describe("adversarial prompt-injection corpus", () => {
  it("contains all 12 required categories", () => {
    const raw = parse(readFileSync(CORPUS_PATH, "utf8")) as Record<string, string[]>;
    const categories = Object.keys(raw);
    for (const required of [
      "direct-instruction-override",
      "fake-system-tags",
      "administrator-claims",
      "base64",
      "rot13",
      "rubric-extraction",
      "hidden-file-requests",
      "malformed-json",
      "tool-use-requests",
      "error-message-exfiltration",
      "cross-role-messaging",
      "cross-retry-private-memory-recovery",
    ]) {
      expect(categories).toContain(required);
    }
  });

  it.each(corpus)("[$category] returns a stable refusal without a canary", async ({ prompt }) => {
    const turn = await answerDiscoveryQuestion(context(prompt, compliantRuntime()));

    expect(turn.reply["zh-CN"]).toContain("无法");
    expect(turn.reply["en-US"]).toContain("can't");
    expect(turn.disclosedDisclosureUnitIds).toEqual([]);

    const serialized = JSON.stringify(turn);
    expect(serialized).not.toContain(CANARY);
    for (const key of ["canary", "score", "rubric", "groundTruth", "systemPrompt", "evaluator"]) {
      expect(serialized).not.toContain(key);
    }
  });

  it.each(corpus)("[$category] wraps learner text in UNTRUSTED_LEARNER_INPUT without a canary", ({ prompt }) => {
    const built = buildRoleInput("customer", aggregate(prompt), capsule());
    expect(built.kind).toBe("customer");
    if (built.kind !== "customer") return;

    const rendered = renderCustomerPrompt(built.input);
    expect(rendered).toContain("UNTRUSTED_LEARNER_INPUT");
    // The learner text appears inside the boundary (JSON-escaped, so prompts
    // containing quotes match their escaped form rather than the raw bytes).
    expect(rendered).toContain(JSON.stringify(prompt).slice(1, -1));
    expect(rendered).not.toContain(CANARY);
    // The canary value is a hidden capsule field; it must never be rendered.
    expect(rendered).not.toContain("expectedEvidence");
    expect(rendered).not.toContain("hintLadders");
  });

  it.each(corpus)("[$category] triggers LEAK_GUARD_TRIGGERED without matched text on a canary leak", async ({ prompt }) => {
    const runtime = new FixtureAgentRuntime({
      fixtures: {
        "customer:inv-1": {
          reply: text(`${CANARY}`, "leaked"),
          stakeholderId: "s-owner",
          disclosedDisclosureUnitIds: [],
        },
      },
    });

    const error = await answerDiscoveryQuestion(context(prompt, runtime)).catch((e) => e);

    expect((error as { code?: string }).code).toBe(LEAK_GUARD_TRIGGERED);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain(prompt);
  });
});
