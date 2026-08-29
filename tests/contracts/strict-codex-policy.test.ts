import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStrictChildEnv,
  buildStrictExecArgs,
  inspectStrictMcpInventory,
  resolveStrictCodexHome,
  StrictCodexPolicyError,
} from "../../src/integrations/codex/strict-policy";

const fakeCodex = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const roots: string[] = [];

function makeTemp(): string {
  const path = mkdtempSync(join(tmpdir(), "fde-strict-policy-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  delete process.env.FAKE_MCP_MODE;
  for (const path of roots) {
    chmodSync(path, 0o700);
    rmSync(path, { recursive: true, force: true });
  }
  roots.length = 0;
});

describe("strict Codex policy", () => {
  it("requires an explicit absolute readable strict home", () => {
    expect(() => resolveStrictCodexHome({})).toThrow(StrictCodexPolicyError);
    expect(() => resolveStrictCodexHome({ FDE_GYM_CODEX_HOME: "relative/home" })).toThrow(
      StrictCodexPolicyError,
    );
    const file = join(makeTemp(), "not-a-directory");
    writeFileSync(file, "x", "utf8");
    expect(() => resolveStrictCodexHome({ FDE_GYM_CODEX_HOME: file })).toThrow(
      StrictCodexPolicyError,
    );
    const unreadable = makeTemp();
    chmodSync(unreadable, 0o000);
    expect(() => resolveStrictCodexHome({ FDE_GYM_CODEX_HOME: unreadable })).toThrow(
      StrictCodexPolicyError,
    );
  });

  it("uses the dedicated home and drops unrelated parent secrets", () => {
    const home = makeTemp();
    const env = buildStrictChildEnv(
      { PATH: "/usr/bin", HOME: "/home/user", CODEX_HOME: "/normal", SECRET: "no" },
      home,
    );
    expect(env.CODEX_HOME).toBe(home);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SECRET).toBeUndefined();
  });

  it("builds one server-name-agnostic strict exec policy", () => {
    const args = buildStrictExecArgs("/tmp/role", { model: "model-x" });
    expect(args).toContain("--ignore-rules");
    expect(args).toEqual(expect.arrayContaining(["--disable", "shell_tool"]));
    expect(args).toEqual(expect.arrayContaining(["--disable", "unified_exec"]));
    expect(args).not.toContain("mcp_servers.node_repl.enabled=false");
    expect(args.at(-1)).toBe("-");
  });

  it("accepts an empty MCP inventory", async () => {
    const home = makeTemp();
    process.env.FAKE_MCP_MODE = "empty";
    const result = await inspectStrictMcpInventory({
      executable: fakeCodex,
      env: buildStrictChildEnv(process.env, home, ["FAKE_MCP_MODE"]),
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ safe: true });
  });

  it("rejects an enabled MCP without retaining its name", async () => {
    const home = makeTemp();
    process.env.FAKE_MCP_MODE = "enabled";
    const result = await inspectStrictMcpInventory({
      executable: fakeCodex,
      env: buildStrictChildEnv(process.env, home, ["FAKE_MCP_MODE"]),
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ safe: false, failure: "MCP_SERVERS_ENABLED" });
    expect(JSON.stringify(result)).not.toContain("fake-filesystem");
  });

  it.each(["invalid", "exit", "timeout"])("rejects an indeterminate MCP inventory: %s", async (mode) => {
    const home = makeTemp();
    process.env.FAKE_MCP_MODE = mode;
    const result = await inspectStrictMcpInventory({
      executable: fakeCodex,
      env: buildStrictChildEnv(process.env, home, ["FAKE_MCP_MODE"]),
      timeoutMs: mode === "timeout" ? 100 : 10_000,
    });
    expect(result).toEqual({ safe: false, failure: "MCP_INVENTORY_FAILED" });
  });
});
