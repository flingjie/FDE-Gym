#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  probeCodexCapabilities,
  type CodexCapabilityReport,
} from "../integrations/codex/capability-probe.js";

function resolveDefaultCodex(): string {
  const candidates = [
    process.env.CODEX_BIN,
    join(homedir(), ".local", "bin", "codex"),
    "codex",
  ];
  for (const candidate of candidates) {
    if (candidate && (candidate === "codex" || existsSync(candidate))) return candidate;
  }
  return "codex";
}

function formatReport(report: CodexCapabilityReport): string {
  const lines: string[] = [];
  lines.push(`executable:        ${report.executable}`);
  lines.push(`skill discovery:   ${report.skillDiscovery}`);
  lines.push(`local command:     ${report.localCommandExecution}`);
  lines.push(`fresh context:     ${report.freshContext}`);
  lines.push(`distinct sessions: ${report.distinctRoleSessions}`);
  lines.push(`structured output: ${report.structuredOutput}`);
  lines.push(`tools disabled:    ${report.toolsDisabled}`);
  lines.push(`parent isolated:   ${report.parentCanaryIsolated}`);
  lines.push(`child contained:   ${report.childCanaryContained}`);
  lines.push(`safe (strict):     ${report.safeForStrictMode}`);
  if (report.failures.length > 0) {
    lines.push(`failures:          ${report.failures.join(", ")}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command !== "doctor") {
    process.stderr.write(
      `fde-gym: unknown command ${JSON.stringify(command ?? "(none)")}. Usage: fde-gym doctor [--json]\n`,
    );
    process.exitCode = 2;
    return;
  }

  const asJson = argv.includes("--json");
  const executable = resolveDefaultCodex();
  const report = await probeCodexCapabilities({ executable });

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(report) + "\n");
  }
  process.exitCode = report.safeForStrictMode ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`fde-gym: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
