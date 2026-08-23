#!/usr/bin/env node
// Deterministic fake for the Codex CLI `exec` surface, used by contract tests.
// It exercises the probe's parsing/isolation logic without touching a model.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const argv = process.argv.slice(2);

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
function hasFlag(name) {
  return argv.includes(name);
}
function hasDisable(feature) {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--disable" && argv[i + 1] === feature) return true;
  }
  return false;
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  stdin += d;
});
process.stdin.on("end", () => {
  main();
});

function main() {
  if (hasFlag("--version")) {
    process.stdout.write("codex-cli 0.149.0\n");
    process.exit(Number(process.env.FAKE_EXIT_CODE ?? 0));
  }

  if (process.env.FAKE_PERSIST_SESSION === "1") {
    const home = process.env.CODEX_HOME;
    if (home) {
      const dir = join(home, "sessions", "2026", "08");
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `fake-${process.pid}.jsonl`), '{"type":"thread.started"}\n', "utf8");
      } catch {
        /* ignore */
      }
    }
  }

  const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? 0);
  if (sleepMs > 0) {
    setTimeout(respond, sleepMs);
  } else {
    respond();
  }
}

function respond() {
  const exitCode = Number(process.env.FAKE_EXIT_CODE ?? 0);
  if (exitCode !== 0) {
    process.stderr.write(`fake-codex: simulated exit ${exitCode}\n`);
    process.exit(exitCode);
  }

  const json = hasFlag("--json");
  const threadId = process.env.FAKE_CODEX_THREAD_ID ?? `fake-${Date.now()}-${process.pid}`;

  const prompt = stdin.toLowerCase();
  let text = "OK";
  if (prompt.includes("environment")) {
    // Simulate an agent that echoes its entire environment (the leak surface we
    // must prove is sanitized).
    text = JSON.stringify(process.env);
  } else if (prompt.includes("scenario") || prompt.includes("read the file")) {
    if (hasDisable("shell_tool")) {
      text = "PERMISSION_DENIED";
    } else {
      const cwd = flagValue("-C") ?? process.cwd();
      const scenarioFile =
        process.env.FAKE_SCENARIO_FILE ?? join(dirname(cwd), "scenario-secret.txt");
      text =
        scenarioFile && existsSync(scenarioFile)
          ? readFileSync(scenarioFile, "utf8")
          : "MISSING";
    }
  } else if (process.env.FAKE_LEAK_ROLE_CANARY === "1") {
    const cwd = flagValue("-C") ?? process.cwd();
    const canaryFile = join(cwd, "role-canary.txt");
    text = existsSync(canaryFile) ? readFileSync(canaryFile, "utf8") : "NO_CANARY_FILE";
  }

  const schemaFile = flagValue("--output-schema");
  const lastMsgFile = flagValue("--output-last-message") ?? flagValue("-o");
  const schemaMode = process.env.FAKE_SCHEMA_MODE ?? "valid";

  let finalText = text;
  if (schemaFile) {
    finalText = schemaMode === "invalid" ? "not json at all" : JSON.stringify({ result: text });
  }

  if (lastMsgFile) {
    try {
      mkdirSync(dirname(lastMsgFile), { recursive: true });
      writeFileSync(lastMsgFile, finalText, "utf8");
    } catch {
      /* ignore */
    }
  }

  if (json) {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({ type: "turn.started" }),
      // Chain-of-thought must never be stored by the probe.
      JSON.stringify({ type: "reasoning", text: "FAKE_CHAIN_OF_THOUGHT_MUST_NOT_BE_STORED" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: finalText },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ];
    process.stdout.write(lines.join("\n") + "\n");
  } else {
    process.stdout.write(finalText + "\n");
  }

  process.exit(0);
}
