import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { DirectModelRuntime } from "../../src/integrations/direct/direct-runtime";
import { buildRoleInput, type RunAggregate } from "../../src/security/context-firewall";
import {
  CustomerOutputSchema,
  EvidenceTrackerOutputSchema,
} from "../../src/agents/contracts";
import {
  AGENT_INPUT_INVALID,
  AGENT_OUTPUT_MALFORMED,
  AGENT_SPAWN_ERROR,
  AGENT_TIMEOUT,
  LEAK_GUARD_TRIGGERED,
} from "../../src/security/sanitizer";

const text = { "zh-CN": "好的", "en-US": "ok" };
const CUSTOMER_CANARY = "CUSTOMER_CANARY_7f3a9c1e2b4d";

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
function customerCapsule() {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: [validStakeholder()],
    disclosureUnits: [validDisclosureUnit()],
    responsePolicies: [],
    privateConflicts: [],
    canary: CUSTOMER_CANARY,
  };
}
function evaluatorCapsule() {
  return {
    id: "scn-1",
    schemaVersion: 1,
    expectedEvidence: [],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [],
    passGates: [],
    canary: "EVALUATOR_CANARY",
  };
}
function customerInput() {
  const out = buildRoleInput("customer", aggregate(), customerCapsule());
  if (out.kind !== "customer") throw new Error("expected customer input");
  return out.input;
}

const invokeOptions = (invocationId = "inv-1") => ({
  runId: "r1",
  invocationId,
  freshContext: true as const,
  tools: "disabled" as const,
  prompt: "CUSTOMER ROLE\n<UNTRUSTED_LEARNER_INPUT>question</UNTRUSTED_LEARNER_INPUT>",
  canaries: ["PER_CALL_CANARY"],
  outputSchema: CustomerOutputSchema,
  timeoutMs: 10_000,
});

const VALID_CUSTOMER = JSON.stringify({
  reply: text,
  stakeholderId: "s1",
  disclosedDisclosureUnitIds: [],
});

interface FakeResponse {
  status?: number;
  content: string;
  delayMs?: number;
}

interface FakeServer {
  baseUrl: string;
  lastBody: () => Record<string, unknown> | null;
  close: () => Promise<void>;
}

/** A minimal chat-completions fake: serves the proxy's `choices[0].delta.content` shape. */
async function startServer(
  handler: (body: Record<string, unknown>) => FakeResponse,
): Promise<FakeServer> {
  let lastBody: Record<string, unknown> | null = null;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      lastBody = body;
      const out = handler(body);
      const send = () => {
        res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ delta: { content: out.content, role: "assistant" }, finish_reason: "stop", index: 0 }] }));
      };
      if (out.delayMs && out.delayMs > 0) setTimeout(send, out.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    lastBody: () => lastBody,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close().catch(() => {})));
  servers = [];
});

function makeRuntime(server: FakeServer, timeoutMs = 10_000) {
  return new DirectModelRuntime({
    baseUrl: server.baseUrl,
    model: "deepseek-v4-pro",
    timeoutMs,
    canaries: [CUSTOMER_CANARY],
  });
}

describe("DirectModelRuntime — contract (fake chat-completions endpoint)", () => {
  it("returns a schema-validated result on the happy path", async () => {
    const server = await startServer(() => ({ content: VALID_CUSTOMER }));
    servers.push(server);
    const rt = makeRuntime(server);
    const res = await rt.invoke("customer", customerInput(), invokeOptions());
    expect(res.invocationId).toBe("inv-1");
    expect(res.output.reply["zh-CN"]).toBe("好的");
    expect(res.modelId).toBe("deepseek-v4-pro");
  });

  it("sends json_object response_format and the role prompt as a user message", async () => {
    const server = await startServer(() => ({ content: VALID_CUSTOMER }));
    servers.push(server);
    const rt = makeRuntime(server);
    await rt.invoke("customer", customerInput(), invokeOptions());
    const body = server.lastBody();
    expect(body?.response_format).toEqual({ type: "json_object" });
    const messages = body?.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("CUSTOMER ROLE");
    expect(messages[0].content).toContain("<UNTRUSTED_LEARNER_INPUT>");
  });

  it("triggers the leak guard on a canary in the raw content (no canary in error)", async () => {
    const server = await startServer(() => ({ content: `{"reply":{"zh-CN":"PER_CALL_CANARY","en-US":"x"},"stakeholderId":"s1","disclosedDisclosureUnitIds":[]}` }));
    servers.push(server);
    const rt = makeRuntime(server);
    const error = await rt.invoke("customer", customerInput(), invokeOptions()).catch((e) => e);
    expect(error.code).toBe(LEAK_GUARD_TRIGGERED);
    expect(String(error.message)).not.toContain("PER_CALL_CANARY");
    expect(JSON.stringify(error)).not.toContain("PER_CALL_CANARY");
  });

  it("returns AGENT_OUTPUT_MALFORMED on non-JSON output", async () => {
    const server = await startServer(() => ({ content: "not valid json {{{" }));
    servers.push(server);
    const rt = makeRuntime(server);
    await expect(rt.invoke("customer", customerInput(), invokeOptions())).rejects.toMatchObject({
      code: AGENT_OUTPUT_MALFORMED,
    });
  });

  it("returns AGENT_TIMEOUT when the endpoint hangs beyond the ceiling", async () => {
    const server = await startServer(() => ({ content: VALID_CUSTOMER, delayMs: 60_000 }));
    servers.push(server);
    const rt = makeRuntime(server, 300);
    const started = Date.now();
    await expect(rt.invoke("customer", customerInput(), invokeOptions())).rejects.toMatchObject({
      code: AGENT_TIMEOUT,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it("returns AGENT_SPAWN_ERROR on a non-2xx endpoint response", async () => {
    const server = await startServer(() => ({ status: 500, content: "boom" }));
    servers.push(server);
    const rt = makeRuntime(server);
    await expect(rt.invoke("customer", customerInput(), invokeOptions())).rejects.toMatchObject({
      code: AGENT_SPAWN_ERROR,
    });
  });

  it("rejects an evaluator capsule passed to the evidence tracker (fail closed, no request)", async () => {
    const server = await startServer(() => ({ content: VALID_CUSTOMER }));
    servers.push(server);
    const rt = makeRuntime(server);
    await expect(
      rt.invoke("evidence_tracker", evaluatorCapsule(), {
        ...invokeOptions(),
        outputSchema: EvidenceTrackerOutputSchema,
      }),
    ).rejects.toMatchObject({ code: AGENT_INPUT_INVALID });
    expect(server.lastBody()).toBeNull();
  });
});
