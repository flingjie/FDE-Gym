#!/usr/bin/env node
/**
 * FDE Gym release gate (Task 9).
 *
 * Runs the full verification chain sequentially and stops at the FIRST failure,
 * printing the exact failed command and its exit code. The live strict-doctor
 * probe (`npm run doctor:strict`) is a hard gate: a failing live doctor is a
 * failed release, never downgraded to a warning.
 */
import { spawnSync } from "node:child_process";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

// label → argv (after the npm executable). Order is significant.
const STEPS = [
  { label: "npm ci", args: ["ci"] },
  { label: "npm run typecheck", args: ["run", "typecheck"] },
  { label: "npm run build", args: ["run", "build"] },
  { label: "npm test", args: ["test"] },
];

for (const step of STEPS) {
  process.stdout.write(`\n=== release gate: ${step.label} ===\n`);
  const result = spawnSync(NPM, step.args, { stdio: "inherit" });

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
