import { afterEach, describe, expect, it, beforeAll } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { compileScenario } from "../../src/scenarios/compiler";
import { loadScenarioForRole, loadPublicScenario } from "../../src/scenarios/loader";
import { ScenarioAuthoringSchema } from "../../src/scenarios/schema";
import { UNSUPPORTED_SCHEMA_VERSION } from "../../src/core/errors";
import type { AgentRole } from "../../src/core/domain";

const COMPILED_DIR = join(process.cwd(), "scenarios", "compiled");
const SOURCE_YAML = join(
  process.cwd(),
  "scenarios",
  "source",
  "manufacturing-alert-triage.yaml",
);
const PUBLIC_SNAPSHOT = join(
  process.cwd(),
  "tests",
  "fixtures",
  "manufacturing-public.snapshot.json",
);

const scenarioId = "manufacturing-alert-triage";
const canarySeed = "test-seed-2026-08-23";
const compiledPath = join(COMPILED_DIR, scenarioId);

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

describe("Scenario Compiler and Loader", () => {
  describe("compileScenario", () => {
    it("validates the source YAML against ScenarioAuthoringSchema", () => {
      const sourceYaml = readFileSync(SOURCE_YAML, "utf-8");
      const parsed = parse(sourceYaml);
      expect(() => ScenarioAuthoringSchema.parse(parsed)).not.toThrow();
    });

    it("produces four JSON files under scenarios/compiled/<id>/", () => {
      const result = compileScenario(SOURCE_YAML, canarySeed);
      expect(result.manifest).toBeDefined();
      expect(result.publicScenario).toBeDefined();
      expect(result.customerCapsule).toBeDefined();
      expect(result.evaluatorCapsule).toBeDefined();

      for (const file of ["public.json", "customer.json", "evaluator.json", "manifest.json"]) {
        expect(() => readFileSync(join(compiledPath, file), "utf-8")).not.toThrow();
      }
    });

    it("injects unique canaries into customer and evaluator partitions", () => {
      const result = compileScenario(SOURCE_YAML, canarySeed);
      expect(result.customerCapsule.canary.length).toBeGreaterThan(0);
      expect(result.evaluatorCapsule.canary.length).toBeGreaterThan(0);
      expect(result.customerCapsule.canary).not.toBe(result.evaluatorCapsule.canary);
    });

    it("deterministically derives canaries from the seed", () => {
      const r1 = compileScenario(SOURCE_YAML, canarySeed);
      const r2 = compileScenario(SOURCE_YAML, canarySeed);
      expect(r1.customerCapsule.canary).toBe(r2.customerCapsule.canary);
      expect(r1.evaluatorCapsule.canary).toBe(r2.evaluatorCapsule.canary);
    });

    it("derives different canaries from different seeds", () => {
      const r1 = compileScenario(SOURCE_YAML, "seed-a");
      const r2 = compileScenario(SOURCE_YAML, "seed-b");
      expect(r1.customerCapsule.canary).not.toBe(r2.customerCapsule.canary);
      expect(r1.evaluatorCapsule.canary).not.toBe(r2.evaluatorCapsule.canary);
    });
  });

  describe("Public scenario must leak no hidden content", () => {
    let publicJson: string;
    let publicContent: Record<string, any>;

    beforeAll(() => {
      compileScenario(SOURCE_YAML, canarySeed);
      publicJson = readFileSync(join(compiledPath, "public.json"), "utf-8");
      publicContent = JSON.parse(publicJson);
    });

    it("contains no hidden fact text (e.g., 12,000 alerts/day, 80%)", () => {
      expect(publicJson).not.toContain("12,000");
      expect(publicJson).not.toContain("80%");
    });

    it("contains no disclosure unit ids, evidence ids, or prerequisites", () => {
      expect(publicJson).not.toContain("disclosureUnit");
      expect(publicJson).not.toContain("evidenceId");
      expect(publicJson).not.toContain("prerequisites");
    });

    it("contains no rubric weights or criteria", () => {
      expect(publicJson).not.toContain("criteria");
      expect(publicJson).not.toContain("rubric");
    });

    it("contains no hint answers (level-3 text)", () => {
      expect(publicJson).not.toContain('"3":');
    });

    it("contains no event trigger text", () => {
      expect(publicJson).not.toContain("trigger");
      expect(publicJson).not.toContain("event");
    });

    it("contains no canary values", () => {
      expect(publicJson).not.toContain("canary");
    });

    it("does contain the opening request and visible context", () => {
      expect(publicContent.openingRequest["zh-CN"]).toMatch(/效率|efficiency/i);
      expect(publicContent.visibleContext["zh-CN"]).toBeDefined();
      expect(publicContent.visibleContext["en-US"]).toBeDefined();
    });

    it("matches the golden byte-stable snapshot", () => {
      const snapshot = readFileSync(PUBLIC_SNAPSHOT, "utf-8");
      expect(publicJson).toBe(snapshot);
    });
  });

  describe("Customer and evaluator partitions", () => {
    let customerContent: Record<string, any>;
    let evaluatorContent: Record<string, any>;

    beforeAll(() => {
      compileScenario(SOURCE_YAML, canarySeed);
      customerContent = readJsonFile(join(compiledPath, "customer.json")) as any;
      evaluatorContent = readJsonFile(join(compiledPath, "evaluator.json")) as any;
    });

    it("customer partition contains its canary", () => {
      expect(customerContent.canary).toBeDefined();
      expect(customerContent.canary.length).toBeGreaterThan(0);
    });

    it("evaluator partition contains its canary", () => {
      expect(evaluatorContent.canary).toBeDefined();
      expect(evaluatorContent.canary.length).toBeGreaterThan(0);
    });

    it("customer partition contains disclosureUnits with hidden facts", () => {
      expect(customerContent.disclosureUnits.length).toBeGreaterThan(0);
      const hasHiddenFact = customerContent.disclosureUnits.some(
        (u: any) => u.text["zh-CN"].includes("12,000") || u.text["en-US"].includes("12,000"),
      );
      expect(hasHiddenFact).toBe(true);
    });

    it("evaluator partition contains hintLadders with level-3 hints", () => {
      expect(evaluatorContent.hintLadders.length).toBeGreaterThan(0);
      const hasLevel3 = evaluatorContent.hintLadders.some(
        (l: any) => "3" in l.hints && l.hints["3"]["zh-CN"].length > 0,
      );
      expect(hasLevel3).toBe(true);
    });

    it("evaluator partition contains rubric with weighted criteria", () => {
      expect(evaluatorContent.rubric.stages.length).toBeGreaterThan(0);
      const allStagesHaveWeights = evaluatorContent.rubric.stages.every(
        (s: any) => s.criteria && s.criteria.length > 0,
      );
      expect(allStagesHaveWeights).toBe(true);
    });

    it("customer and evaluator partitions are structurally independent", () => {
      expect(customerContent.rubric).toBeUndefined();
      expect(customerContent.expectedEvidence).toBeUndefined();
      expect(evaluatorContent.stakeholders).toBeUndefined();
      expect(evaluatorContent.disclosureUnits).toBeUndefined();
    });
  });

  describe("loadScenarioForRole", () => {
    it("loads the customer partition by role name", () => {
      const customer = loadScenarioForRole(scenarioId, "customer" as AgentRole) as any;
      expect(customer.id).toBe(scenarioId);
      expect(customer.canary).toBeDefined();
      expect(customer.disclosureUnits).toBeDefined();
    });

    it("loads the evaluator partition for the evidence_tracker role", () => {
      const evaluator = loadScenarioForRole(scenarioId, "evidence_tracker" as AgentRole) as any;
      expect(evaluator.id).toBe(scenarioId);
      expect(evaluator.canary).toBeDefined();
      expect(evaluator.hintLadders).toBeDefined();
      expect(evaluator.rubric).toBeDefined();
    });

    it("loads the evaluator partition for the coach_evaluator role", () => {
      const evaluator = loadScenarioForRole(scenarioId, "coach_evaluator" as AgentRole) as any;
      expect(evaluator.canary).toBeDefined();
      expect(evaluator.rubric).toBeDefined();
    });

    it("rejects an unknown scenario id", () => {
      expect(() =>
        loadScenarioForRole("non-existent-id", "customer" as AgentRole),
      ).toThrow(/not found/i);
    });

    it("rejects an unknown role", () => {
      expect(() =>
        loadScenarioForRole(scenarioId, "bogus-role" as unknown as AgentRole),
      ).toThrow(/unknown role/i);
    });

    it("never returns the authoring source or cross-role data", () => {
      const customer = loadScenarioForRole(scenarioId, "customer" as AgentRole) as any;
      const evaluator = loadScenarioForRole(scenarioId, "evidence_tracker" as AgentRole) as any;

      expect(customer.rubric).toBeUndefined();
      expect(customer.expectedEvidence).toBeUndefined();
      expect(customer.criticalContradictions).toBeUndefined();
      expect(customer.hintLadders).toBeUndefined();

      expect(evaluator.stakeholders).toBeUndefined();
      expect(evaluator.disclosureUnits).toBeUndefined();
      expect(evaluator.privateConflicts).toBeUndefined();
    });
  });

  describe("loadPublicScenario", () => {
    it("loads the learner-visible public partition without hidden content or canaries", () => {
      const pub = loadPublicScenario(scenarioId);
      expect(pub.id).toBe(scenarioId);
      expect(JSON.stringify(pub)).not.toContain("canary");
      expect(JSON.stringify(pub)).not.toContain("12,000");
    });
  });

  describe("loader schema-version gate (Task 14)", () => {
    const probeId = "__unsupported-version-probe__";
    const probeDir = join(COMPILED_DIR, probeId);

    afterEach(() => {
      try {
        rmSync(probeDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it("rejects a compiled partition whose schemaVersion is not 1", () => {
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(
        join(probeDir, "public.json"),
        JSON.stringify({
          id: probeId,
          schemaVersion: 2,
          locale: "zh-CN",
          openingRequest: { "zh-CN": "x", "en-US": "x" },
          visibleContext: { "zh-CN": "x", "en-US": "x" },
          visibleConstraints: [],
          deliverables: [],
          learnerRules: [],
          questionBudget: 1,
        }),
        "utf8",
      );

      let code: unknown;
      try {
        loadPublicScenario(probeId);
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      expect(code).toBe(UNSUPPORTED_SCHEMA_VERSION);
    });
  });

  describe("manifest.json structure", () => {
    let manifest: Record<string, any>;

    beforeAll(() => {
      compileScenario(SOURCE_YAML, canarySeed);
      manifest = readJsonFile(join(compiledPath, "manifest.json")) as any;
    });

    it("contains scenario id and schemaVersion", () => {
      expect(manifest.id).toBe(scenarioId);
      expect(manifest.schemaVersion).toBe(1);
    });

    it("contains locale and file names", () => {
      expect(manifest.locale).toBe("zh-CN");
      expect(manifest.files.public).toBe("public.json");
      expect(manifest.files.customer).toBe("customer.json");
      expect(manifest.files.evaluator).toBe("evaluator.json");
    });

    it("does NOT contain canary values", () => {
      expect(JSON.stringify(manifest)).not.toContain("canary");
    });
  });
});
