#!/usr/bin/env node
// Deterministic fake for CodexAgentRuntime, emulating the `codex exec` surface.
// Behavior is controlled by FAKE_RUNTIME_* env vars (see tests/contracts/codex-runtime.test.ts).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** Write a capture to a file named by an env var (the test's observation surface). */
function capture(envKey, content) {
  const file = process.env[envKey];
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  } catch {
    /* ignore */
  }
}

let stdin = "";
let count = 1;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => main());

function isMcpList() {
  return argv[0] === "mcp" && argv[1] === "list" && argv.includes("--json");
}

function respondMcpList() {
  const mode = process.env.FAKE_MCP_MODE ?? "empty";
  if (mode === "timeout") {
    setTimeout(() => {
      process.stdout.write("[]\n");
      process.exit(0);
    }, 60_000);
    return;
  }
  if (mode === "exit") {
    process.stderr.write("fake-codex: MCP inventory failed\n");
    process.exit(7);
  }
  if (mode === "invalid") {
    process.stdout.write("not-json\n");
    process.exit(0);
  }
  const inventory =
    mode === "enabled"
      ? [{ name: "fake-filesystem", enabled: true }]
      : mode === "disabled"
        ? [{ name: "fake-disabled", enabled: false }]
        : [];
  process.stdout.write(JSON.stringify(inventory) + "\n");
  process.exit(0);
}

function main() {
  if (isMcpList()) {
    respondMcpList();
    return;
  }

  // Record the attempt immediately (before any sleep) so a timeout-killed child
  // still counts as one spawn for the runtime's retry accounting.
  const countFile = process.env.FAKE_RUNTIME_COUNT_FILE;
  if (countFile) {
    try {
      count = Number(readFileSync(countFile, "utf8")) + 1;
    } catch {
      count = 1;
    }
    try {
      mkdirSync(dirname(countFile), { recursive: true });
      writeFileSync(countFile, String(count), "utf8");
    } catch {
      /* ignore */
    }
  }

  // Capture the rendered prompt and the complete output schema the runtime
  // handed to this child, so contract tests can assert on both.
  capture("FAKE_RUNTIME_PROMPT_FILE", stdin);
  capture("FAKE_RUNTIME_ARGS_FILE", JSON.stringify(argv));
  capture("FAKE_RUNTIME_HOME_FILE", process.env.CODEX_HOME ?? "");
  const schemaFile = flagValue("--output-schema");
  if (schemaFile) {
    try {
      capture("FAKE_RUNTIME_SCHEMA_FILE", readFileSync(schemaFile, "utf8"));
    } catch {
      /* ignore */
    }
  }

  const sleepMs = Number(process.env.FAKE_RUNTIME_SLEEP_MS ?? 0);
  if (sleepMs > 0) setTimeout(respond, sleepMs);
  else respond();
}

function respond() {
  const mode = process.env.FAKE_RUNTIME_MODE ?? "valid";
  const canary = process.env.FAKE_RUNTIME_CANARY ?? "FAKE_CANARY";

  if (mode === "exit") {
    process.stderr.write("fake-codex: role process failed\n");
    process.exit(Number(process.env.FAKE_RUNTIME_EXIT_CODE ?? 7));
  }

  const valid = JSON.stringify({
    reply: { "zh-CN": "好的", "en-US": "ok" },
    stakeholderId: "s1",
    disclosedDisclosureUnitIds: [],
  });
  const leaked = JSON.stringify({
    reply: { "zh-CN": canary, "en-US": canary },
    stakeholderId: "s1",
    disclosedDisclosureUnitIds: [],
  });

  let text = valid;
  let stdoutCanary = null;
  let rawStdout = null;
  switch (mode) {
    case "malformed":
      text = "not valid json {{{";
      break;
    case "leak":
      text = leaked;
      break;
    case "leak-once":
      text = count === 1 ? leaked : valid;
      break;
    case "repair-once":
      text = count === 1 ? "not valid json {{{" : valid;
      break;
    case "stdout-leak":
      text = valid;
      stdoutCanary = canary;
      break;
    case "stdout-leak-once":
      text = valid;
      stdoutCanary = count === 1 ? canary : null;
      break;
    case "raw-stdout-leak":
      text = valid;
      rawStdout = canary;
      break;
    case "valid":
    default:
      text = valid;
      break;
  }

  const outFile = flagValue("-o");
  if (outFile) {
    try {
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, text, "utf8");
    } catch {
      /* ignore */
    }
  }

  if (argv.includes("--json")) {
    const threadId = `fake-${Date.now()}-${process.pid}-${count}`;
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({ type: "turn.started" }),
      ...(stdoutCanary ? [JSON.stringify({ type: "reasoning", text: stdoutCanary })] : []),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ];
    process.stdout.write(lines.join("\n") + "\n");
  } else {
    process.stdout.write(text + "\n");
  }

  if (rawStdout) process.stdout.write(rawStdout + "\n");
  process.exit(0);
}
