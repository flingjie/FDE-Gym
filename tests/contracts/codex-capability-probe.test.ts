import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// NOTE: this import is intentionally unresolved until Step 3 implements the probe.
// The first run of this test file must FAIL (RED) with a module-not-found error.
import {
  parseJsonlEvents,
  extractThreadId,
  extractAgentMessage,
  sanitizeChildEnv,
  probeCodexCapabilities,
} from "../../src/integrations/codex/capability-probe";

const fakeCodex = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));

let tempRoots: string[] = [];

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-probe-test-"));
  tempRoots.push(dir);
  return dir;
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FAKE_")) delete process.env[key];
  }
  delete process.env.FDE_PARENT_CANARY;
});

afterEach(() => {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tempRoots = [];
});

describe("codex capability probe — contract (fake executable)", () => {
  it("returns a full report with the exact required shape on the happy path", async () => {
    const workRoot = makeTemp();
    const home = makeTemp();
    mkdirSync(join(home, "skills", "custom"), { recursive: true });
    writeFileSync(join(home, "skills", "custom", "SKILL.md"), "# skill\n", "utf8");

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(home, "sessions"),
      timeoutMs: 10_000,
    });

    expect(report).toEqual({
      executable: fakeCodex,
      skillDiscovery: "user",
      localCommandExecution: true,
      freshContext: true,
      distinctRoleSessions: true,
      structuredOutput: true,
      toolsDisabled: true,
      parentCanaryIsolated: true,
      childCanaryContained: true,
      safeForStrictMode: true,
      failures: [],
    });
  });

  it("flags sessions that are not distinct", async () => {
    const workRoot = makeTemp();
    const home = makeTemp();
    process.env.FAKE_CODEX_THREAD_ID = "fixed-thread-id";

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(home, "sessions"),
      timeoutMs: 10_000,
      envExtraAllow: ["FAKE_CODEX_THREAD_ID"],
    });

    expect(report.distinctRoleSessions).toBe(false);
    expect(report.failures).toContain("SESSIONS_NOT_DISTINCT");
    expect(report.safeForStrictMode).toBe(false);
  });

  it("detects parent-context inheritance when a child leaks the parent canary", async () => {
    const workRoot = makeTemp();
    const home = makeTemp();

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(home, "sessions"),
      timeoutMs: 10_000,
      parentCanary: "PARENT_SECRET_XYZ",
      // Simulates a broken env-sanitization that lets the canary key through.
      envExtraAllow: ["FDE_PARENT_CANARY"],
    });

    expect(report.parentCanaryIsolated).toBe(false);
    expect(report.failures).toContain("PARENT_CONTEXT_INHERITED");
    expect(report.safeForStrictMode).toBe(false);
    // The canary VALUE must never be written into failures.
    expect(JSON.stringify(report.failures)).not.toContain("PARENT_SECRET_XYZ");
  });

  it("detects a role canary leaking into parent-visible stdout", async () => {
    const workRoot = makeTemp();
    const home = makeTemp();
    process.env.FAKE_LEAK_ROLE_CANARY = "1";

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(home, "sessions"),
      timeoutMs: 10_000,
      roleCanary: "ROLE_SECRET_ABC",
      envExtraAllow: ["FAKE_LEAK_ROLE_CANARY"],
    });

    expect(report.childCanaryContained).toBe(false);
    expect(report.failures).toContain("ROLE_CANARY_LEAKED");
    expect(report.safeForStrictMode).toBe(false);
    expect(JSON.stringify(report.failures)).not.toContain("ROLE_SECRET_ABC");
  });

  it("detects that tools are NOT disabled when the scenario file is readable", async () => {
    const workRoot = makeTemp();
    const home = makeTemp();

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(home, "sessions"),
      timeoutMs: 10_000,
      scenarioCanary: "SCENARIO_SECRET_QRS",
      disableTools: false,
    });

    expect(report.toolsDisabled).toBe(false);
    expect(report.failures).toContain("TOOLS_NOT_DISABLED");
    expect(report.safeForStrictMode).toBe(false);
    expect(JSON.stringify(report.failures)).not.toContain("SCENARIO_SECRET_QRS");
  });

  it("detects invalid structured output", async () => {
    const workRoot = makeTemp();
    const home = makeTemp();
    process.env.FAKE_SCHEMA_MODE = "invalid";

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(home, "sessions"),
      timeoutMs: 10_000,
      envExtraAllow: ["FAKE_SCHEMA_MODE"],
    });

    expect(report.structuredOutput).toBe(false);
    expect(report.failures).toContain("STRUCTURED_OUTPUT_INVALID");
    expect(report.safeForStrictMode).toBe(false);
  });

  it("records TIMEOUT and fails the gate when an invocation hangs", async () => {
    const workRoot = makeTemp();
    const home = makeTemp();
    process.env.FAKE_SLEEP_MS = "60000";

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(home, "sessions"),
      timeoutMs: 300,
      envExtraAllow: ["FAKE_SLEEP_MS"],
    });

    expect(report.failures).toContain("TIMEOUT");
    expect(report.safeForStrictMode).toBe(false);
  }, 20_000);

  it("records VERSION_CHECK_FAILED on a non-zero version exit", async () => {
    const workRoot = makeTemp();
    const home = makeTemp();
    process.env.FAKE_EXIT_CODE = "7";

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(home, "sessions"),
      timeoutMs: 10_000,
      envExtraAllow: ["FAKE_EXIT_CODE"],
    });

    expect(report.localCommandExecution).toBe(false);
    expect(report.failures).toContain("VERSION_CHECK_FAILED");
    expect(report.safeForStrictMode).toBe(false);
  });

  it("flags SESSION_PERSISTED when an ephemeral run writes a session file", async () => {
    const workRoot = makeTemp();
    const home = makeTemp();
    process.env.FAKE_PERSIST_SESSION = "1";
    process.env.CODEX_HOME = home;

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(home, "sessions"),
      timeoutMs: 10_000,
      envExtraAllow: ["FAKE_PERSIST_SESSION", "CODEX_HOME"],
    });

    expect(report.freshContext).toBe(false);
    expect(report.failures).toContain("SESSION_PERSISTED");
    expect(report.safeForStrictMode).toBe(false);
  });
});

describe("codex capability probe — parsing units", () => {
  it("drops reasoning (chain-of-thought) events and non-JSON lines", () => {
    const jsonl = [
      "not json at all",
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"reasoning","text":"SECRET_COT"}',
      '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"SECRET_NESTED_COT"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}',
    ].join("\n");

    const events = parseJsonlEvents(jsonl);
    const types = events.map((e) => e.type);
    expect(types).toContain("thread.started");
    expect(types).toContain("item.completed");
    expect(types).not.toContain("reasoning");
    expect(JSON.stringify(events)).not.toContain("SECRET_COT");
    expect(JSON.stringify(events)).not.toContain("SECRET_NESTED_COT");
    expect(extractThreadId(events)).toBe("t1");
    expect(extractAgentMessage(events)).toBe("OK");
  });

  it("sanitizes the child environment, dropping the parent canary", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      FDE_PARENT_CANARY: "SECRET",
      SOME_PARENT_SECRET: "ALSO_SECRET",
    };
    const env = sanitizeChildEnv(source, ["SOME_PARENT_SECRET"]);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.FDE_PARENT_CANARY).toBeUndefined();
    // Explicitly allow-listed keys still pass through (used for test control).
    expect(env.SOME_PARENT_SECRET).toBe("ALSO_SECRET");
  });
});
