import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { collectHintDisciplineIssues } from "../../src/scenarios/hint-discipline";
import { ScenarioAuthoringSchema } from "../../src/scenarios/schema";

export const PRODUCTION_SCENARIO_IDS = [
  "enterprise-knowledge-agent",
  "customer-support-agent",
  "data-analysis-agent",
  "document-review-agent",
  "software-engineering-agent",
] as const;

const RETIRED = [
  "support-automation",
  "manufacturing-alert-triage",
  "data-migration",
  "export-freight-forwarding",
] as const;

describe("production scenario catalog", () => {
  const sourceDir = join(process.cwd(), "scenarios", "source");
  const yamlIds = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => name.replace(/\.yaml$/, ""))
    .sort();

  it("contains exactly the five agent scenario ids", () => {
    expect(yamlIds).toEqual([...PRODUCTION_SCENARIO_IDS].sort());
  });

  it("does not keep retired ids", () => {
    for (const id of RETIRED) {
      expect(yamlIds).not.toContain(id);
    }
  });

  it("parses and passes hint discipline", () => {
    for (const id of PRODUCTION_SCENARIO_IDS) {
      const doc = ScenarioAuthoringSchema.parse(
        parse(readFileSync(join(sourceDir, `${id}.yaml`), "utf8")),
      );
      expect(doc.id).toBe(id);
      expect(collectHintDisciplineIssues(doc)).toEqual([]);
    }
  });
});
