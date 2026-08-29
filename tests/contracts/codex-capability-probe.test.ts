import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseJsonlEvents,
  extractThreadId,
  extractAgentMessage,
} from "../../src/integrations/codex/codex-process";
import {
  sanitizeChildEnv,
  probeCodexCapabilities,
} from "../../src/integrations/codex/capability-probe";
import { doctorCommand, type CommandContext } from "../../src/cli/commands.js";
import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime.js";

const fakeCodex = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const missingCodex = fileURLToPath(new URL("../fixtures/no-such-codex", import.meta.url));

let tempRoots: string[] = [];
let strictHome: string;

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-probe-test-"));
  tempRoots.push(dir);
  return dir;
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FAKE_")) delete process.env[key];
  }
  strictHome = makeTemp();
  process.env.FDE_GYM_CODEX_HOME = strictHome;
});

afterEach(() => {
  delete process.env.FDE_GYM_CODEX_HOME;
  delete process.env.FDE_PARENT_CANARY;
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

    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      skillDiscoveryHome: home,
      sessionsDir: join(strictHome, "sessions"),
      timeoutMs: 10_000,
      envExtraAllow: ["FAKE_PERSIST_SESSION"],
    });

    expect(report.freshContext).toBe(false);
    expect(report.failures).toContain("SESSION_PERSISTED");
    expect(report.safeForStrictMode).toBe(false);
  });

  it("fails parent isolation when only the environment probe exits nonzero", async () => {
    process.env.FAKE_FAIL_ON = "environment";
    process.env.FAKE_FAIL_MODE = "exit";
    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot: makeTemp(),
      sessionsDir: join(makeTemp(), "sessions"),
      timeoutMs: 10_000,
      envExtraAllow: ["FAKE_FAIL_ON", "FAKE_FAIL_MODE", "FAKE_MCP_MODE"],
    });
    expect(report.parentCanaryIsolated).toBe(false);
    expect(report.failures).toContain("ENVIRONMENT_PROBE_FAILED");
    expect(report.safeForStrictMode).toBe(false);
  });

  it("fails tool isolation when only the tool probe exits nonzero", async () => {
    process.env.FAKE_FAIL_ON = "tools";
    process.env.FAKE_FAIL_MODE = "exit";
    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot: makeTemp(),
      sessionsDir: join(makeTemp(), "sessions"),
      timeoutMs: 10_000,
      envExtraAllow: ["FAKE_FAIL_ON", "FAKE_FAIL_MODE", "FAKE_MCP_MODE"],
    });
    expect(report.toolsDisabled).toBe(false);
    expect(report.failures).toContain("TOOL_ISOLATION_PROBE_FAILED");
    expect(report.safeForStrictMode).toBe(false);
  });

  it("does not validate stale structured output after this invocation fails", async () => {
    const workRoot = makeTemp();
    writeFileSync(join(workRoot, "structured-out.txt"), JSON.stringify({ result: "stale" }), "utf8");
    process.env.FAKE_FAIL_ON = "structured";
    process.env.FAKE_FAIL_MODE = "exit";
    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot,
      sessionsDir: join(makeTemp(), "sessions"),
      timeoutMs: 10_000,
      cleanup: false,
      envExtraAllow: ["FAKE_FAIL_ON", "FAKE_FAIL_MODE", "FAKE_MCP_MODE"],
    });
    expect(report.structuredOutput).toBe(false);
    expect(report.failures).toContain("STRUCTURED_OUTPUT_INVOCATION_FAILED");
    expect(report.safeForStrictMode).toBe(false);
  });

  it("does not mutate the process-wide parent canary across concurrent probes", async () => {
    process.env.FDE_PARENT_CANARY = "ORIGINAL_PARENT_VALUE";
    await Promise.all([
      probeCodexCapabilities({ executable: fakeCodex, workRoot: makeTemp(), sessionsDir: join(makeTemp(), "a"), timeoutMs: 10_000 }),
      probeCodexCapabilities({ executable: fakeCodex, workRoot: makeTemp(), sessionsDir: join(makeTemp(), "b"), timeoutMs: 10_000 }),
    ]);
    expect(process.env.FDE_PARENT_CANARY).toBe("ORIGINAL_PARENT_VALUE");
  });

  it("rejects an enabled MCP before model capability probes", async () => {
    process.env.FAKE_MCP_MODE = "enabled";
    const report = await probeCodexCapabilities({
      executable: fakeCodex,
      workRoot: makeTemp(),
      sessionsDir: join(makeTemp(), "sessions"),
      timeoutMs: 10_000,
      envExtraAllow: ["FAKE_MCP_MODE"],
    });
    expect(report.failures).toContain("MCP_SERVERS_ENABLED");
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

describe("doctor command — strict release gate", () => {
  const ctx: CommandContext = { runtime: new FixtureAgentRuntime({ fixtures: {} }) };

  it("returns a diagnostic report (ok) for an unsafe probe without --require-safe", async () => {
    const result = await doctorCommand(ctx, { locale: "en-US", executable: missingCodex });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.report.safeForStrictMode).toBe(false);
      // The diagnostic path preserves the full safe boolean matrix.
      expect(result.data.report).toEqual(
        expect.objectContaining({
          localCommandExecution: expect.any(Boolean),
          freshContext: expect.any(Boolean),
          distinctRoleSessions: expect.any(Boolean),
          structuredOutput: expect.any(Boolean),
          toolsDisabled: expect.any(Boolean),
          parentCanaryIsolated: expect.any(Boolean),
          childCanaryContained: expect.any(Boolean),
          safeForStrictMode: expect.any(Boolean),
          failures: expect.any(Array),
        }),
      );
    }
  });

  it("fails with CODEX_STRICT_MODE_UNSAFE under --require-safe for an unsafe probe", async () => {
    const result = await doctorCommand(ctx, {
      locale: "en-US",
      executable: missingCodex,
      requireSafe: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CODEX_STRICT_MODE_UNSAFE");
      // The strict failure is learner-safe: no report payload, no raw output,
      // no model prose, no canary values.
      expect("data" in result).toBe(false);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("safeForStrictMode");
      expect(serialized).not.toContain("canary");
    }
  });

  it("passes --require-safe for a safe probe", async () => {
    const result = await doctorCommand(ctx, {
      locale: "en-US",
      executable: fakeCodex,
      requireSafe: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.report.safeForStrictMode).toBe(true);
    }
  });
});
