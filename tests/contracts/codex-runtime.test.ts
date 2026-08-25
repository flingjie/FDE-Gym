import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAgentRuntime } from "../../src/integrations/codex/codex-runtime";
import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import { buildRoleInput, type RunAggregate } from "../../src/security/context-firewall";
import {
  CustomerOutputSchema,
  EvidenceTrackerOutputSchema,
} from "../../src/agents/contracts";
import {
  AGENT_INPUT_INVALID,
  AGENT_OUTPUT_MALFORMED,
  AGENT_TIMEOUT,
  LEAK_GUARD_TRIGGERED,
} from "../../src/security/sanitizer";

const fakeCodexRuntime = fileURLToPath(new URL("./fake-codex-runtime.mjs", import.meta.url));

const text = { "zh-CN": "好的", "en-US": "ok" };

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
      {
        id: "ev-a",
        kind: "fact",
        claim: text,
        status: "active",
        sourceTranscriptIds: ["t1"],
        weight: 1,
        version: 0,
      },
    ],
    edges: [],
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
    canary: "CUSTOMER_CANARY",
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

function aggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "r1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "DISCOVERY",
    transcript: [
      { turnId: "t1", seq: 0, question: "每天有多少告警？", customerReply: text, stakeholderId: "s1" },
    ],
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
  const out = buildRoleInput("customer", aggregate(), customerCapsule());
  if (out.kind !== "customer") throw new Error("expected customer input");
  return out.input;
}

const FAKE_KEYS = [
  "FAKE_RUNTIME_MODE",
  "FAKE_RUNTIME_CANARY",
  "FAKE_RUNTIME_COUNT_FILE",
  "FAKE_RUNTIME_SLEEP_MS",
  "FAKE_RUNTIME_PROMPT_FILE",
  "FAKE_RUNTIME_SCHEMA_FILE",
];

let tempRoots: string[] = [];

function makeRuntime(
  mode = "valid",
  extra: {
    sleepMs?: number;
    timeoutMs?: number;
    canaries?: readonly string[];
    fakeCanary?: string;
  } = {},
) {
  const workRoot = mkdtempSync(join(tmpdir(), "fde-codex-rt-"));
  const countFile = join(workRoot, "count.txt");
  const promptFile = join(workRoot, "captured-prompt.txt");
  const schemaFile = join(workRoot, "captured-schema.json");
  const fakeCanary = extra.fakeCanary ?? "CUSTOMER_CANARY_7f3a9c1e2b4d";
  tempRoots.push(workRoot);

  process.env.FAKE_RUNTIME_MODE = mode;
  process.env.FAKE_RUNTIME_CANARY = fakeCanary;
  process.env.FAKE_RUNTIME_COUNT_FILE = countFile;
  process.env.FAKE_RUNTIME_SLEEP_MS = String(extra.sleepMs ?? 0);
  process.env.FAKE_RUNTIME_PROMPT_FILE = promptFile;
  process.env.FAKE_RUNTIME_SCHEMA_FILE = schemaFile;

  const rt = new CodexAgentRuntime({
    executable: fakeCodexRuntime,
    workRoot,
    timeoutMs: extra.timeoutMs ?? 10_000,
    canaries: extra.canaries ?? [fakeCanary],
    envExtraAllow: FAKE_KEYS,
  });
  return { rt, workRoot, countFile, canary: fakeCanary, promptFile, schemaFile };
}

function readCount(countFile: string): number {
  try {
    return Number(readFileSync(countFile, "utf8"));
  } catch {
    return 0;
  }
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

describe("CodexAgentRuntime — contract (fake executable)", () => {
  it("returns a schema-validated result on the happy path", async () => {
    const { rt } = makeRuntime("valid");
    const res = await rt.invoke("customer", customerInput(), invokeOptions());
    expect(res.invocationId).toBe("inv-1");
    expect(res.output.reply["zh-CN"]).toBe("好的");
  });

  it("passes the rendered role prompt to the child process", async () => {
    const { rt, promptFile } = makeRuntime("valid");
    await rt.invoke("customer", customerInput(), invokeOptions());

    const captured = readFileSync(promptFile, "utf8");
    expect(captured).toContain("CUSTOMER ROLE");
    expect(captured).toContain("<UNTRUSTED_LEARNER_INPUT>question</UNTRUSTED_LEARNER_INPUT>");
  });

  it("writes a complete JSON schema (not a generic one-property object)", async () => {
    const { rt, schemaFile } = makeRuntime("valid");
    await rt.invoke("customer", customerInput(), invokeOptions());

    const schema = JSON.parse(readFileSync(schemaFile, "utf8")) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties?.reply).toBeTruthy();
    expect(schema.required).toContain("reply");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(1);
  });

  it("triggers the leak guard on a per-call canary in raw stdout with no global canaries", async () => {
    const { rt, countFile } = makeRuntime("raw-stdout-leak", {
      fakeCanary: "PER_CALL_CANARY",
      canaries: [],
    });
    const error = await rt.invoke("customer", customerInput(), invokeOptions()).catch((e) => e);
    expect(error.code).toBe(LEAK_GUARD_TRIGGERED);
    expect(String(error.message)).not.toContain("PER_CALL_CANARY");
    expect(readCount(countFile)).toBe(2);
  });

  it("repairs malformed output once, then returns a stable error on the second failure", async () => {
    const { rt, countFile } = makeRuntime("malformed");
    await expect(rt.invoke("customer", customerInput(), invokeOptions())).rejects.toMatchObject({
      code: AGENT_OUTPUT_MALFORMED,
    });
    expect(readCount(countFile)).toBe(2);
  });

  it("succeeds when the repair attempt produces valid output", async () => {
    const { rt, countFile } = makeRuntime("repair-once");
    const res = await rt.invoke("customer", customerInput(), invokeOptions());
    expect(res.output.reply["zh-CN"]).toBe("好的");
    expect(readCount(countFile)).toBe(2);
  });

  it("retries once on a leak-guard match and fails with LEAK_GUARD_TRIGGERED (no canary in error)", async () => {
    const { rt, countFile, canary } = makeRuntime("leak");
    const error = await rt.invoke("customer", customerInput(), invokeOptions()).catch((e) => e);
    expect(error.code).toBe(LEAK_GUARD_TRIGGERED);
    expect(String(error.message)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(readCount(countFile)).toBe(2);
  });

  it("succeeds when the leak retry produces clean output", async () => {
    const { rt, countFile } = makeRuntime("leak-once");
    const res = await rt.invoke("customer", customerInput(), invokeOptions());
    expect(res.output.reply["zh-CN"]).toBe("好的");
    expect(readCount(countFile)).toBe(2);
  });

  it("kills on timeout and returns a stable AGENT_TIMEOUT error (no retry)", async () => {
    const { rt, countFile } = makeRuntime("valid", { sleepMs: 60_000, timeoutMs: 300 });
    await expect(rt.invoke("customer", customerInput(), invokeOptions())).rejects.toMatchObject({
      code: AGENT_TIMEOUT,
    });
    expect(readCount(countFile)).toBe(1);
  }, 20_000);

  it("rejects an evaluator capsule passed to the evidence tracker (fail closed, no spawn)", async () => {
    const { rt, countFile } = makeRuntime("valid");
    await expect(
      rt.invoke("evidence_tracker", evaluatorCapsule(), {
        ...invokeOptions(),
        outputSchema: EvidenceTrackerOutputSchema,
      }),
    ).rejects.toMatchObject({ code: AGENT_INPUT_INVALID });
    expect(readCount(countFile)).toBe(0);
  });
});

describe("FixtureAgentRuntime", () => {
  it("maps (role, invocationId) to a validated fixture output", async () => {
    const rt = new FixtureAgentRuntime({
      fixtures: {
        "customer:inv-9": {
          reply: text,
          stakeholderId: "s1",
          disclosedDisclosureUnitIds: ["d1"],
        },
      },
    });
    const res = await rt.invoke("customer", customerInput(), invokeOptions("inv-9"));
    expect(res.invocationId).toBe("inv-9");
    expect(res.output.reply).toEqual(text);
    expect(res.output.disclosedDisclosureUnitIds).toEqual(["d1"]);
  });

  it("rejects a fixture that does not match the role output schema", async () => {
    const rt = new FixtureAgentRuntime({
      fixtures: { "customer:inv-10": { wrong: "shape" } },
    });
    await expect(rt.invoke("customer", customerInput(), invokeOptions("inv-10"))).rejects.toThrow();
  });

  it("throws a stable error for an unknown (role, invocationId) pair", async () => {
    const rt = new FixtureAgentRuntime({ fixtures: {} });
    await expect(rt.invoke("customer", customerInput(), invokeOptions("missing"))).rejects.toThrow(
      /no fixture/,
    );
  });
});
