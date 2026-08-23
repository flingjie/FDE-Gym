import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { localize, type CliResult } from "../../cli/render.js";
import type { Locale } from "../../core/domain.js";

/**
 * FDE Gym — Codex Skill installer (Task 12).
 *
 * Installs the learner-facing Skill (`skills/fde-gym/`) and the built CLI
 * package (`dist/`) into the probed user-skill path (`$CODEX_HOME/skills/
 * fde-gym/`, default `~/.codex/skills/fde-gym/`) established by the Task 1
 * spike. Source paths are resolved from this package's own location
 * (`import.meta.url`), never from `process.cwd()`, so the installer works no
 * matter where `fde-gym install-skill` is invoked.
 *
 * It copies ONLY the Skill files and the built CLI package — never scenario
 * source or compiled capsules. It refuses to overwrite an existing Skill whose
 * frontmatter `name` is not `fde-gym`, and supports `--dry-run` to list the
 * exact files before writing anything.
 */

const SKILL_DIR_NAME = "fde-gym";
const SKILL_SOURCE_REL = join("skills", SKILL_DIR_NAME);
const CLI_PACKAGE_REL = "dist";

export interface InstallSkillOptions {
  /** CODEX_HOME override. Default: `$CODEX_HOME` ?? `~/.codex`. */
  codexHome?: string;
  /** Package root override (test control). Default: derived from `import.meta.url`. */
  packageRoot?: string;
  /** Return the exact file list without writing anything. */
  dryRun?: boolean;
}

export interface InstallSkillEntry {
  /** Absolute source path. */
  source: string;
  /** Absolute destination path. */
  destination: string;
  /** Destination-relative path (POSIX separators). */
  rel: string;
}

export interface InstallSkillPlan {
  destinationRoot: string;
  entries: InstallSkillEntry[];
  /** Source directories that were absent (e.g. `dist/` not yet built). */
  missingSources: string[];
}

export interface InstallSkillData {
  destination: string;
  dryRun: boolean;
  files: string[];
  missingSources: string[];
}

export class InstallSkillError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallSkillError";
    this.code = code;
  }
}

/** Parse a `---`-fenced YAML frontmatter block into a record (null if absent/invalid). */
export function parseSkillFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const value = parseYaml(match[1]);
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The Codex user-skill directory for this Skill: `$CODEX_HOME/skills/fde-gym/`. */
export function probeSkillDestination(codexHome?: string): string {
  const home = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(home, "skills", SKILL_DIR_NAME);
}

/**
 * The package root, derived from this module's own URL. Resolves identically
 * from `src/` under vitest and from `dist/` under the built CLI, and never from
 * `process.cwd()`.
 */
export function resolvePackageRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

function isFdeGymSkill(content: string): boolean {
  return parseSkillFrontmatter(content)?.name === "fde-gym";
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function enumerateFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const path = join(dir, name);
    try {
      if (lstatSync(path).isDirectory()) out.push(...enumerateFiles(path));
      else out.push(path);
    } catch {
      /* ignore unreadable entries */
    }
  }
  return out;
}

/** Build the install plan (exact file list) without writing anything. */
export function planInstall(options: InstallSkillOptions = {}): InstallSkillPlan {
  const packageRoot = options.packageRoot ?? resolvePackageRoot();
  const destinationRoot = probeSkillDestination(options.codexHome);
  const skillSrc = join(packageRoot, SKILL_SOURCE_REL);
  const cliSrc = join(packageRoot, CLI_PACKAGE_REL);

  const missingSources: string[] = [];
  if (!existsSync(skillSrc)) missingSources.push(SKILL_SOURCE_REL);
  if (!existsSync(cliSrc)) missingSources.push(CLI_PACKAGE_REL);

  const entries: InstallSkillEntry[] = [];
  for (const source of enumerateFiles(skillSrc)) {
    const rel = toPosix(relative(skillSrc, source));
    entries.push({ source, destination: join(destinationRoot, rel), rel });
  }
  for (const source of enumerateFiles(cliSrc)) {
    const rel = toPosix(join(CLI_PACKAGE_REL, relative(cliSrc, source)));
    entries.push({ source, destination: join(destinationRoot, rel), rel });
  }
  // Deterministic, locale-independent ordering (exact-file-list contract).
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  return { destinationRoot, entries, missingSources };
}

/** Throw if the destination already holds a SKILL.md that is not FDE Gym's. */
function assertNotOverwritingUnrelated(destinationRoot: string): void {
  const existing = join(destinationRoot, "SKILL.md");
  if (!existsSync(existing)) return;
  const content = readFileSync(existing, "utf8");
  if (!isFdeGymSkill(content)) {
    throw new InstallSkillError(
      "SKILL_EXISTS_UNRELATED",
      `refusing to overwrite an unrelated existing Skill at ${existing}`,
    );
  }
}

/** Install the Skill (and built CLI) to the probed path. Returns the exact file list. */
export function installSkill(options: InstallSkillOptions = {}): InstallSkillData {
  const plan = planInstall(options);
  if (plan.missingSources.includes(SKILL_SOURCE_REL)) {
    throw new InstallSkillError(
      "SKILL_SOURCE_MISSING",
      `Skill source not found at ${SKILL_SOURCE_REL}`,
    );
  }
  assertNotOverwritingUnrelated(plan.destinationRoot);

  if (!options.dryRun) {
    mkdirSync(plan.destinationRoot, { recursive: true });
    for (const entry of plan.entries) {
      mkdirSync(dirname(entry.destination), { recursive: true });
      copyFileSync(entry.source, entry.destination);
    }
  }

  return {
    destination: plan.destinationRoot,
    dryRun: options.dryRun === true,
    files: plan.entries.map((entry) => entry.rel),
    missingSources: plan.missingSources,
  };
}

export interface InstallSkillArgs {
  locale: Locale;
  codexHome?: string;
  dryRun?: boolean;
}

/** CLI command handler: wraps `installSkill` in the learner-safe envelope. */
export function installSkillCommand(
  _ctx: unknown,
  args: InstallSkillArgs,
): CliResult<InstallSkillData> {
  try {
    const data = installSkill({ codexHome: args.codexHome, dryRun: args.dryRun });
    return { ok: true, runId: "", phase: "SCENARIO", locale: args.locale, data };
  } catch (error) {
    const code = error instanceof InstallSkillError ? error.code : "INSTALL_SKILL_FAILED";
    const { message, nextActions } = localize(code, args.locale);
    return { ok: false, code, message, nextActions };
  }
}
