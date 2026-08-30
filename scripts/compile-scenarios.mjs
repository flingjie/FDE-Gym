#!/usr/bin/env node
import { compileScenario } from "../dist/scenarios/compiler.js";

// Shared canaries across the four bundles are an accepted consequence of this seed.
const seed = "test-seed-2026-08-23";
const ids = [
  "support-automation",
  "manufacturing-alert-triage",
  "data-migration",
  "export-freight-forwarding",
];

for (const id of ids) {
  compileScenario(`scenarios/source/${id}.yaml`, seed);
  console.log("compiled", id);
}
