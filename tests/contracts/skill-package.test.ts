import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  InstallSkillError,
  installSkill,
  parseSkillFrontmatter,
  planInstall,
  probeSkillDestination,
  resolvePackageRoot,
} from "../../src/integrations/codex/install-skill.js";

/**
 * Task 12 — package validation.
 *
 * Validates the learner-facing Codex Skill metadata against the contract proven
 * by the Task 1 spike: user-level discovery from `$CODEX_HOME/skills/fde-gym/`,
 * a `SKILL.md` whose frontmatter carries `name` + `description`, references to
 * ONLY the three learner docs, and no hidden-content references. Also validates
 * the installer: exact `--dry-run` file list, probed destination, cwd-independence
 * of source resolution, refusal to overwrite an unrelated Skill, and that it never
 * ships scenario source or compiled capsules.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SKILL_DIR = join(REPO_ROOT, "skills", "fde-gym");

const REFERENCE_DOCS = [
  "references/commands.md",
  "references/learner-flow.md",
  "references/security-boundaries.md",
] as const;

function readSkill(name: string): string {
  return readFileSync(join(SKILL_DIR, name), "utf8");
}

describe("SKILL.md metadata", () => {
  const skill = readSkill("SKILL.md");

  it("carries Codex frontmatter with a non-empty name + description", () => {
    const fm = parseSkillFrontmatter(skill);
    expect(fm).not.toBeNull();
    expect(typeof fm!.name).toBe("string");
    expect((fm!.name as string).trim().length).toBeGreaterThan(0);
    expect(typeof fm!.description).toBe("string");
    expect((fm!.description as string).trim().length).toBeGreaterThan(0);
  });

  it("is named fde-gym (the installer's identity marker)", () => {
    expect(parseSkillFrontmatter(skill)!.name).toBe("fde-gym");
  });

  it("references ONLY the three reference docs", () => {
    const refs = [...skill.matchAll(/references\/[A-Za-z0-9._-]+\.md/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThan(0);
    const unique = [...new Set(refs)].sort();
    expect(unique).toEqual([...REFERENCE_DOCS].sort());
  });

  it("never references scenario source, capsules, hidden prompts, or local profile contents", () => {
    for (const forbidden of [
      "scenarios/source",
      "capsule",
      "hidden",
      "canary",
      "evaluator",
      "profile",
    ]) {
      expect(skill).not.toContain(forbidden);
    }
  });

  it("instructs doctor before the first strict run and to stop when isolation is unavailable", () => {
    expect(skill).toContain("doctor");
    expect(skill).toContain("safeForStrictMode");
  });

  it("instructs stdin payloads and rendering only the returned envelope", () => {
    expect(skill).toMatch(/stdin/);
    expect(skill).toMatch(/ok/);
  });

  it("all three referenced docs exist on disk (the Skill resolves)", () => {
    for (const doc of REFERENCE_DOCS) {
      expect(existsSync(join(SKILL_DIR, doc))).toBe(true);
    }
  });
});

describe("install-skill", () => {
  let tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tempDirs = [];
  });

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "fde-skill-ct-"));
    tempDirs.push(dir);
    return dir;
  }

  /** A fixture package root with a controlled skills/fde-gym/ + dist/ tree. */
  function fixturePackage(): string {
    const root = tmp();
    const skill = join(root, "skills", "fde-gym");
    mkdirSync(join(skill, "references"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: fde-gym\ndescription: test\n---\n# FDE Gym\n");
    writeFileSync(join(skill, "references", "commands.md"), "commands");
    writeFileSync(join(skill, "references", "learner-flow.md"), "flow");
    writeFileSync(join(skill, "references", "security-boundaries.md"), "security");
    mkdirSync(join(root, "dist", "cli"), { recursive: true });
    mkdirSync(join(root, "dist", "core"), { recursive: true });
    writeFileSync(join(root, "dist", "cli", "main.js"), "// main");
    writeFileSync(join(root, "dist", "core", "domain.js"), "// domain");
    return root;
  }

  it("--dry-run lists the exact Skill + built CLI files without writing anything", () => {
    const root = fixturePackage();
    const home = tmp();
    const result = installSkill({ packageRoot: root, codexHome: home, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.files).toEqual([
      "SKILL.md",
      "dist/cli/main.js",
      "dist/core/domain.js",
      "references/commands.md",
      "references/learner-flow.md",
      "references/security-boundaries.md",
    ]);
    // Nothing written to disk.
    expect(existsSync(join(home, "skills", "fde-gym"))).toBe(false);
  });

  it("installs the Skill + built CLI to the probed $CODEX_HOME/skills/fde-gym path", () => {
    const root = fixturePackage();
    const home = tmp();
    const result = installSkill({ packageRoot: root, codexHome: home });

    expect(result.dryRun).toBe(false);
    expect(result.destination).toBe(join(home, "skills", "fde-gym"));
    expect(readFileSync(join(home, "skills", "fde-gym", "SKILL.md"), "utf8")).toContain("name: fde-gym");
    expect(existsSync(join(home, "skills", "fde-gym", "references", "commands.md"))).toBe(true);
    expect(existsSync(join(home, "skills", "fde-gym", "dist", "cli", "main.js"))).toBe(true);
  });

  it("probes the destination from $CODEX_HOME (falling back to ~/.codex)", () => {
    const home = tmp();
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(probeSkillDestination()).toBe(join(home, "skills", "fde-gym"));
      expect(probeSkillDestination(join(home, "override"))).toBe(
        join(home, "override", "skills", "fde-gym"),
      );
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it("refuses to overwrite an unrelated SKILL.md (install and dry-run)", () => {
    const root = fixturePackage();
    const home = tmp();
    const dest = join(home, "skills", "fde-gym");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "---\nname: someone-else\ndescription: x\n---\n");

    expect(() => installSkill({ packageRoot: root, codexHome: home })).toThrow(InstallSkillError);
    expect(() => installSkill({ packageRoot: root, codexHome: home, dryRun: true })).toThrow(
      InstallSkillError,
    );
    // The unrelated Skill is untouched.
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toContain("someone-else");
  });

  it("allows an idempotent reinstall over FDE Gym's own SKILL.md", () => {
    const root = fixturePackage();
    const home = tmp();
    installSkill({ packageRoot: root, codexHome: home });
    const again = installSkill({ packageRoot: root, codexHome: home });
    expect(again.files).toContain("SKILL.md");
    expect(again.files).toContain("references/commands.md");
  });

  it("resolves the source path from the package, not the current working directory", () => {
    const root = fixturePackage();
    const home = tmp();
    const elsewhere = tmp();
    const cwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const plan = planInstall({ packageRoot: root, codexHome: home });
      expect(plan.entries.length).toBeGreaterThan(0);
      for (const entry of plan.entries) {
        expect(entry.source.startsWith(root)).toBe(true);
      }
    } finally {
      process.chdir(cwd);
    }
  });

  it("default package root resolves to this repo and is stable under cwd changes", () => {
    const before = resolvePackageRoot();
    expect(existsSync(join(before, "skills", "fde-gym", "SKILL.md"))).toBe(true);
    expect(existsSync(join(before, "package.json"))).toBe(true);

    const elsewhere = tmp();
    const cwd = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(resolvePackageRoot()).toBe(before);
    } finally {
      process.chdir(cwd);
    }
  });

  it("never copies scenario source or compiled capsules", () => {
    const root = fixturePackage();
    const home = tmp();
    const plan = planInstall({ packageRoot: root, codexHome: home });
    for (const entry of plan.entries) {
      expect(entry.rel).not.toMatch(/scenarios\/(source|compiled)/);
      expect(entry.rel).not.toMatch(/\.yaml$/);
      expect(entry.rel).not.toMatch(/capsule/);
    }
  });
});
