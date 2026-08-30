#!/usr/bin/env node
import { compileScenario } from "../dist/scenarios/compiler.js";

// Shared canaries across the five bundles are an accepted consequence of this seed.
const seed = "test-seed-2026-08-23";
const ids = [
  "enterprise-knowledge-agent",
  "customer-support-agent",
  "data-analysis-agent",
  "document-review-agent",
  "software-engineering-agent",
];

for (const id of ids) {
  compileScenario(`scenarios/source/${id}.yaml`, seed);
  console.log("compiled", id);
}
