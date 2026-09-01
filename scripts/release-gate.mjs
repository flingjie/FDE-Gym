#!/usr/bin/env node
/**
 * FDE Gym release gate.
 *
 * Runs the full verification chain sequentially and stops at the FIRST failure,
 * printing the exact failed command and its exit code. The graph-validation +
 * generated-doc-drift steps ensure a graph change without a doc regeneration
 * fails CI.
 */
import { spawnSync } from "node:child_process";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NODE = process.execPath;

// label → { cmd, args }. Order is significant.
const STEPS = [
  { label: "npm ci", cmd: NPM, args: ["ci"] },
  { label: "npm run typecheck", cmd: NPM, args: ["run", "typecheck"] },
  { label: "npm run build", cmd: NPM, args: ["run", "build"] },
  { label: "npm test", cmd: NPM, args: ["test"] },
  { label: "graph validation + doc generation", cmd: NODE, args: ["scripts/generate-docs.mjs"] },
  { label: "generated-doc drift", cmd: "git", args: ["diff", "--exit-code", "--", "docs/graph/generated.md"] },
];

for (const step of STEPS) {
  process.stdout.write(`\n=== release gate: ${step.label} ===\n`);
  const result = spawnSync(step.cmd, step.args, { stdio: "inherit" });

  if (result.error) {
    process.stderr.write(
      `\nrelease gate: '${step.label}' could not start: ${result.error.message}\n`,
    );
    process.exit(1);
  }

  if (result.status !== 0) {
    const exitCode = result.status ?? `signal ${result.signal}`;
    process.stderr.write(
      `\nrelease gate: '${step.label}' FAILED with exit code ${exitCode}\n`,
    );
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("\nrelease gate: all steps passed.\n");
