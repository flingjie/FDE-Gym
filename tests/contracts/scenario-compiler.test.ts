import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { compileScenario } from "../../src/scenarios/compiler";
import { loadScenarioForRole, loadPublicScenario } from "../../src/scenarios/loader";
import { loadScenarioBundle, SCENARIO_MANIFEST_VERSION } from "../../src/scenarios/bundle";
import { ScenarioAuthoringSchema } from "../../src/scenarios/schema";
import {
  SCENARIO_BUNDLE_MISMATCH,
  UNSUPPORTED_SCHEMA_VERSION,
} from "../../src/core/errors";
import { loadEvents } from "../../src/core/event-store";
import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import { askCommand, startCommand, type CommandContext } from "../../src/cli/commands";
import type { AgentRole } from "../../src/core/domain";

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

const BUNDLE_PATHS = ["public.json", "customer.json", "evaluator.json", "events.json"] as const;

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

// Throwaway compiled roots for the default-root call sites below. The compiler
// defaults to `<cwd>/scenarios/compiled`, which is the COMMITTED bundle — so
// these tests compile into the OS temp dir instead and clean up afterwards,
// leaving the committed bundle byte-identical (matching scenario-calibration /
// all-scenarios, which already isolate compilation this way).
const tempRoots: string[] = [];
function makeCompiledRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fde-compiled-"));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// Bundle fixture helpers (Task 7) — build/mutate hash-consistent bundles so the
// loader's id/schema cross-checks (not just the hash check) can be exercised.
// ---------------------------------------------------------------------------

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function compileToTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fde-bundle-"));
  compileScenario(SOURCE_YAML, canarySeed, root);
  return root;
}

function bundleDir(root: string): string {
  return join(root, scenarioId);
}

/** Recompute artifact descriptors from the files on disk and rewrite the manifest. */
function rewriteManifest(dir: string): void {
  const artifacts = BUNDLE_PATHS.map((path) => {
    const content = readFileSync(join(dir, path), "utf8");
    return {
      path,
      sha256: sha256hex(content),
      bytes: Buffer.byteLength(content, "utf8"),
      schemaVersion: 1,
    };
  });
  const manifest = {
    manifestVersion: SCENARIO_MANIFEST_VERSION,
    id: scenarioId,
    schemaVersion: 1,
    locale: "zh-CN",
    digest: sha256hex(canonicalJson(artifacts)),
    artifacts,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

/** Flip one lowercase ASCII letter to a different letter (stays valid JSON, changes the hash). */
function tamper(content: string): string {
  const match = content.match(/[a-z]/);
  if (!match || match.index === undefined) throw new Error("no tamperable byte");
  const idx = match.index;
  const replacement = content[idx] === "a" ? "b" : "a";
  return content.slice(0, idx) + replacement + content.slice(idx + 1);
}

describe("Scenario Compiler and Loader", () => {
  describe("compileScenario", () => {
    it("validates the source YAML against ScenarioAuthoringSchema", () => {
      const sourceYaml = readFileSync(SOURCE_YAML, "utf-8");
      const parsed = parse(sourceYaml);
      expect(() => ScenarioAuthoringSchema.parse(parsed)).not.toThrow();
    });

    it("produces five JSON files under <compiledRoot>/<id>/", () => {
      const root = makeCompiledRoot();
      const result = compileScenario(SOURCE_YAML, canarySeed, root);
      expect(result.manifest).toBeDefined();
      expect(result.publicScenario).toBeDefined();
      expect(result.customerCapsule).toBeDefined();
      expect(result.evaluatorCapsule).toBeDefined();

      for (const file of ["public.json", "customer.json", "evaluator.json", "events.json", "manifest.json"]) {
        expect(() => readFileSync(join(root, scenarioId, file), "utf-8")).not.toThrow();
      }
    });

    it("injects unique canaries into customer and evaluator partitions", () => {
      const result = compileScenario(SOURCE_YAML, canarySeed, makeCompiledRoot());
      expect(result.customerCapsule.canary.length).toBeGreaterThan(0);
      expect(result.evaluatorCapsule.canary.length).toBeGreaterThan(0);
      expect(result.customerCapsule.canary).not.toBe(result.evaluatorCapsule.canary);
    });

    it("deterministically derives canaries from the seed", () => {
      const r1 = compileScenario(SOURCE_YAML, canarySeed, makeCompiledRoot());
      const r2 = compileScenario(SOURCE_YAML, canarySeed, makeCompiledRoot());
      expect(r1.customerCapsule.canary).toBe(r2.customerCapsule.canary);
      expect(r1.evaluatorCapsule.canary).toBe(r2.evaluatorCapsule.canary);
    });

    it("derives different canaries from different seeds", () => {
      const r1 = compileScenario(SOURCE_YAML, "seed-a", makeCompiledRoot());
      const r2 = compileScenario(SOURCE_YAML, "seed-b", makeCompiledRoot());
      expect(r1.customerCapsule.canary).not.toBe(r2.customerCapsule.canary);
      expect(r1.evaluatorCapsule.canary).not.toBe(r2.evaluatorCapsule.canary);
    });
  });

  describe("Public scenario must leak no hidden content", () => {
    let publicJson: string;
    let publicContent: Record<string, any>;

    beforeAll(() => {
      const root = makeCompiledRoot();
      compileScenario(SOURCE_YAML, canarySeed, root);
      publicJson = readFileSync(join(root, scenarioId, "public.json"), "utf-8");
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
      const root = makeCompiledRoot();
      compileScenario(SOURCE_YAML, canarySeed, root);
      customerContent = readJsonFile(join(root, scenarioId, "customer.json")) as any;
      evaluatorContent = readJsonFile(join(root, scenarioId, "evaluator.json")) as any;
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
    let root: string;

    afterEach(() => {
      if (root) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("rejects a compiled partition whose schemaVersion is not 1", () => {
      root = compileToTempRoot();
      const dir = bundleDir(root);
      const publicPath = join(dir, "public.json");
      const pub = readJsonFile(publicPath) as Record<string, unknown>;
      pub.schemaVersion = 2;
      writeFileSync(publicPath, JSON.stringify(pub, null, 2), "utf8");
      rewriteManifest(dir);

      let code: unknown;
      try {
        loadScenarioBundle(scenarioId, { compiledRoot: root });
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      expect(code).toBe(UNSUPPORTED_SCHEMA_VERSION);
    });
  });

  describe("manifest.json structure", () => {
    let manifest: Record<string, any>;

    beforeAll(() => {
      const root = makeCompiledRoot();
      compileScenario(SOURCE_YAML, canarySeed, root);
      manifest = readJsonFile(join(root, scenarioId, "manifest.json")) as any;
    });

    it("contains scenario id, manifestVersion, and schemaVersion", () => {
      expect(manifest.id).toBe(scenarioId);
      expect(manifest.manifestVersion).toBe(SCENARIO_MANIFEST_VERSION);
      expect(manifest.schemaVersion).toBe(1);
    });

    it("contains a digest and descriptors for all four artifacts", () => {
      expect(manifest.locale).toBe("zh-CN");
      expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);
      const paths = (manifest.artifacts as Array<{ path: string }>).map((a) => a.path).sort();
      expect(paths).toEqual([...BUNDLE_PATHS].sort());
      for (const artifact of manifest.artifacts as Array<Record<string, unknown>>) {
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof artifact.bytes).toBe("number");
        expect(artifact.schemaVersion).toBe(1);
      }
    });

    it("does NOT contain canary values", () => {
      expect(JSON.stringify(manifest)).not.toContain("canary");
    });

    it("does NOT contain a canary seed", () => {
      expect(JSON.stringify(manifest)).not.toContain("canarySeed");
      expect(JSON.stringify(manifest)).not.toContain(canarySeed);
    });
  });

  describe("bundle integrity (Task 7)", () => {
    const roots: string[] = [];
    function tmpRoot(): string {
      const root = mkdtempSync(join(tmpdir(), "fde-bundle-"));
      roots.push(root);
      return root;
    }
    afterEach(() => {
      for (const root of roots.splice(0)) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("compiling the same source and seed twice yields byte-identical artifacts and digests", () => {
      const rootA = tmpRoot();
      const rootB = tmpRoot();
      const a = compileScenario(SOURCE_YAML, canarySeed, rootA);
      const b = compileScenario(SOURCE_YAML, canarySeed, rootB);

      expect(a.digest).toBe(b.digest);
      expect(a.artifacts).toEqual(b.artifacts);

      for (const file of [...BUNDLE_PATHS, "manifest.json"]) {
        const contentA = readFileSync(join(rootA, scenarioId, file), "utf8");
        const contentB = readFileSync(join(rootB, scenarioId, file), "utf8");
        expect(contentA).toBe(contentB);
      }
    });

    it("rejects one-byte tampering in any partition or events.json before returning a role view", () => {
      for (const file of BUNDLE_PATHS) {
        const root = tmpRoot();
        compileScenario(SOURCE_YAML, canarySeed, root);
        const path = join(root, scenarioId, file);
        const original = readFileSync(path, "utf8");
        writeFileSync(path, tamper(original), "utf8");
        expect(() => loadScenarioBundle(scenarioId, { compiledRoot: root })).toThrow();
      }
    });

    it("rejects a bundle whose partition id differs from the manifest id", () => {
      const root = tmpRoot();
      compileScenario(SOURCE_YAML, canarySeed, root);
      const dir = bundleDir(root);
      const publicPath = join(dir, "public.json");
      const pub = readJsonFile(publicPath) as Record<string, unknown>;
      pub.id = "wrong-id";
      writeFileSync(publicPath, JSON.stringify(pub, null, 2), "utf8");
      rewriteManifest(dir);
      expect(() => loadScenarioBundle(scenarioId, { compiledRoot: root })).toThrow(/id mismatch/i);
    });

    it("rejects a bundle with a missing artifact file", () => {
      const root = tmpRoot();
      compileScenario(SOURCE_YAML, canarySeed, root);
      rmSync(join(root, scenarioId, "events.json"));
      expect(() => loadScenarioBundle(scenarioId, { compiledRoot: root })).toThrow();
    });

    it("rejects a bundle whose manifest digest is stale", () => {
      const root = tmpRoot();
      compileScenario(SOURCE_YAML, canarySeed, root);
      const dir = bundleDir(root);
      const manifestPath = join(dir, "manifest.json");
      const manifest = readJsonFile(manifestPath) as Record<string, unknown>;
      manifest.digest = "0".repeat(64);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      expect(() => loadScenarioBundle(scenarioId, { compiledRoot: root })).toThrow(/digest/i);
    });

    it("rejects a stale descriptor whose hash no longer matches its artifact", () => {
      const root = tmpRoot();
      compileScenario(SOURCE_YAML, canarySeed, root);
      const dir = bundleDir(root);
      const manifestPath = join(dir, "manifest.json");
      const manifest = readJsonFile(manifestPath) as { artifacts: Array<{ sha256: string }> };
      manifest.artifacts[0].sha256 = "0".repeat(64);
      const digest = sha256hex(canonicalJson(manifest.artifacts));
      writeFileSync(
        manifestPath,
        JSON.stringify({ ...(manifest as Record<string, unknown>), digest }, null, 2),
        "utf8",
      );
      expect(() => loadScenarioBundle(scenarioId, { compiledRoot: root })).toThrow(/hash mismatch/i);
    });

    it("manifest contains no canary values and no canary seed", () => {
      const root = tmpRoot();
      const pack = compileScenario(SOURCE_YAML, canarySeed, root);
      const manifestJson = readFileSync(join(root, scenarioId, "manifest.json"), "utf8");
      expect(manifestJson).not.toContain("canary");
      expect(manifestJson).not.toContain("canarySeed");
      expect(manifestJson).not.toContain(canarySeed);
      expect(manifestJson).not.toContain(pack.customerCapsule.canary);
      expect(manifestJson).not.toContain(pack.evaluatorCapsule.canary);
    });

    it("loads from an explicit compiledRoot without opening scenarios/source", () => {
      const root = tmpRoot(); // under the OS temp dir, outside the repository
      compileScenario(SOURCE_YAML, canarySeed, root);
      const bundle = loadScenarioBundle(scenarioId, { compiledRoot: root });
      expect(bundle.publicScenario.id).toBe(scenarioId);
      expect(bundle.customerCapsule.id).toBe(scenarioId);
      expect(bundle.evaluatorCapsule.id).toBe(scenarioId);
      expect(bundle.eventCandidates.length).toBeGreaterThanOrEqual(3);
      expect(bundle.bundleDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("rejects an unsafe scenario id", () => {
      const root = tmpRoot();
      expect(() => loadScenarioBundle("../etc", { compiledRoot: root })).toThrow();
      expect(() => loadScenarioBundle("", { compiledRoot: root })).toThrow();
    });
  });

  describe("bundle digest provenance (Task 7)", () => {
    const roots: string[] = [];
    const stores: string[] = [];
    function tmpRoot(): string {
      const root = mkdtempSync(join(tmpdir(), "fde-provenance-"));
      roots.push(root);
      return root;
    }
    function tmpStore(): string {
      const store = mkdtempSync(join(tmpdir(), "fde-provenance-store-"));
      stores.push(store);
      return store;
    }
    afterEach(() => {
      for (const root of roots.splice(0)) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      for (const store of stores.splice(0)) {
        try {
          rmSync(store, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("stamps run.started with the bundle digest and rejects a mismatched bundle on resume", async () => {
      const compiledRoot = tmpRoot();
      const baseDir = tmpStore();
      compileScenario(SOURCE_YAML, canarySeed, compiledRoot);
      const ctx: CommandContext = {
        runtime: new FixtureAgentRuntime(),
        baseDir,
        compiledRoot,
      };

      const start = await startCommand(ctx, {
        runId: "run-provenance",
        scenarioId,
        locale: "zh-CN",
        commandId: "start",
      });
      expect(start.ok).toBe(true);

      const recorded = await loadEvents("run-provenance", { baseDir });
      const started = recorded.find((event) => event.type === "run.started");
      expect(started && started.type === "run.started" ? started.scenarioBundleDigest : undefined).toMatch(
        /^[0-9a-f]{64}$/,
      );

      // Recompile the bundle with a different seed -> a different digest.
      compileScenario(SOURCE_YAML, "different-seed", compiledRoot);

      const ask = await askCommand(ctx, {
        runId: "run-provenance",
        question: "what changed?",
        stakeholderId: "vp-operations",
        commandId: "ask-1",
      });
      expect(ask.ok).toBe(false);
      if (!ask.ok) expect(ask.code).toBe(SCENARIO_BUNDLE_MISMATCH);
    });
  });
});
