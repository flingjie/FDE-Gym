import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { installSkill, parseSkillFrontmatter } from "../../src/integrations/codex/install-skill.js";
import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime.js";
import {
  askCommand,
  startCommand,
  type CommandContext,
} from "../../src/cli/commands.js";
import { localize, type CliResult } from "../../src/cli/render.js";
import type { Locale } from "../../src/core/domain.js";
import type { CustomerCapsule, EvaluatorCapsule, PublicScenario } from "../../src/scenarios/schema.js";

/**
 * Task 12 — Codex Skill smoke (no real network).
 *
 * Installs the real Skill into a temp package root's project-local
 * `.codex/skills/fde-gym/` and asserts it loads (SKILL.md frontmatter +
 * resolvable references). Then proves the CLI produces locale-correct envelopes
 * — zh-CN default, `--locale en-US` switch — both at the command layer (via
 * `FixtureAgentRuntime` for the model-backed `ask` turn) and, when `dist/` is
 * built, through the actual `fde-gym` binary.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const distCliMain = join(REPO_ROOT, "dist", "cli", "main.js");
const fakeCodex = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

let tempDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-skill-smoke-"));
  tempDirs.push(dir);
  return dir;
}
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

function scenario(): NonNullable<CommandContext["scenario"]> {
  const publicScenario: PublicScenario = {
    id: "scn-smoke",
    schemaVersion: 1,
    locale: "zh-CN",
    openingRequest: text("请帮助设计告警优化方案", "Please help design an alert optimization"),
    visibleContext: text("制造企业", "A manufacturer"),
    visibleConstraints: [text("内网部署", "On-premises")],
    deliverables: [text("方案文档", "Design document")],
    learnerRules: [text("12个问题预算", "12-question budget")],
    questionBudget: 12,
  };
  const customer: CustomerCapsule = {
    id: "scn-smoke",
    schemaVersion: 1,
    stakeholders: [
      {
        id: "vp-operations",
        role: text("运营副总裁", "VP of Operations"),
        persona: text("怀疑新技术", "Skeptical of new tech"),
        concerns: [],
        blindSpots: [],
      },
    ],
    disclosureUnits: [
      {
        id: "du-1",
        topic: "workflow",
        text: text("每天12000条告警", "12000 alerts daily"),
        prerequisites: [],
        evidenceId: "ev-workflow",
      },
    ],
    responsePolicies: [],
    privateConflicts: [],
    canary: "CUSTOMER_CANARY_SMOKE",
  };
  const evaluator: EvaluatorCapsule = {
    id: "scn-smoke",
    schemaVersion: 1,
    expectedEvidence: [
      {
        id: "ev-workflow",
        category: "workflow",
        description: text("工作流信息", "Workflow info"),
        weight: 1,
        disclosureUnitIds: ["du-1"],
      },
    ],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [],
    passGates: [],
    canary: "EVALUATOR_CANARY_SMOKE",
  };
  return { public: publicScenario, customer, evaluator, events: [] };
}

function fixtures(): Record<string, unknown> {
  return {
    "customer:smoke-ask:customer": {
      reply: text("每天大约产生12,000条设备告警。", "About 12,000 alerts are generated daily."),
      stakeholderId: "vp-operations",
      disclosedDisclosureUnitIds: ["du-1"],
    },
    "evidence_tracker:smoke-ask:evidence": {
      patch: {
        patchId: "smoke-patch",
        expectedVersion: 0,
        addNodes: [
          {
            id: "ev-a",
            kind: "fact",
            claim: text("每天约12000条告警", "~12000 alerts daily"),
            status: "active",
            sourceTranscriptIds: ["smoke-ask:turn"],
            weight: 1,
            version: 0,
          },
        ],
        addEdges: [],
        invalidateNodeIds: [],
      },
      questionAssessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
    },
  };
}

async function driveAsk(locale: Locale, baseDir: string) {
  const runtime = new FixtureAgentRuntime({ fixtures: fixtures() });
  const ctx: CommandContext = { runtime, baseDir, scenario: scenario() };
  const runId = `run-${locale}`;
  const started = await startCommand(ctx, {
    runId,
    scenarioId: "scn-smoke",
    locale,
    commandId: `smoke-start-${locale}`,
  });
  expect(started.ok).toBe(true);
  return askCommand(ctx, {
    runId,
    question: "每天产生多少条告警？",
    stakeholderId: "vp-operations",
    commandId: "smoke-ask",
  });
}

describe("Codex Skill smoke", () => {
  it("installs the real Skill to a project-local .codex/skills/fde-gym and the Skill loads", () => {
    // The destination is derived from the package root, so point at a temp root
    // holding a copy of the real Skill to keep the test hermetic.
    const root = tmp();
    const skillSrc = join(REPO_ROOT, "skills", "fde-gym");
    const skillDst = join(root, "skills", "fde-gym");
    mkdirSync(join(skillDst, "references"), { recursive: true });
    copyFileSync(join(skillSrc, "SKILL.md"), join(skillDst, "SKILL.md"));
    for (const doc of ["commands.md", "learner-flow.md", "security-boundaries.md"]) {
      copyFileSync(join(skillSrc, "references", doc), join(skillDst, "references", doc));
    }

    const result = installSkill({ packageRoot: root });

    for (const file of [
      "SKILL.md",
      "references/commands.md",
      "references/learner-flow.md",
      "references/security-boundaries.md",
    ]) {
      expect(result.files).toContain(file);
    }

    const installedSkill = readFileSync(join(root, ".codex", "skills", "fde-gym", "SKILL.md"), "utf8");
    const fm = parseSkillFrontmatter(installedSkill);
    expect(fm?.name).toBe("fde-gym");
    expect(typeof fm?.description).toBe("string");
    expect((fm!.description as string).length).toBeGreaterThan(0);

    for (const doc of [
      "references/commands.md",
      "references/learner-flow.md",
      "references/security-boundaries.md",
    ]) {
      expect(existsSync(join(root, ".codex", "skills", "fde-gym", doc))).toBe(true);
    }
  });

  it("localizes failure messages: zh-CN default vs en-US switch", () => {
    expect(localize("UNKNOWN_COMMAND", "zh-CN").message).toBe("未知命令。");
    expect(localize("UNKNOWN_COMMAND", "en-US").message).toBe("Unknown command.");
    expect(localize("MISSING_ARGUMENT", "zh-CN").message).not.toBe(
      localize("MISSING_ARGUMENT", "en-US").message,
    );
    expect(localize("AGENT_PROCESS_ERROR", "zh-CN").message).not.toBe(
      localize("AGENT_PROCESS_ERROR", "en-US").message,
    );
    expect(localize("CODEX_STRICT_MODE_UNSAFE", "en-US").nextActions.join(" ")).toContain(
      "FDE_GYM_CODEX_HOME",
    );
  });

  it("produces locale-correct envelopes through the command layer (FixtureAgentRuntime)", async () => {
    const zh = (await driveAsk("zh-CN", tmp())) as CliResult<unknown>;
    const en = (await driveAsk("en-US", tmp())) as CliResult<unknown>;

    expect(zh.ok).toBe(true);
    expect(en.ok).toBe(true);
    if (zh.ok && en.ok) {
      expect(zh.locale).toBe("zh-CN");
      expect(en.locale).toBe("en-US");
      const zhReply = zh.data as { customerReply: { "zh-CN": string } };
      const enReply = en.data as { customerReply: { "en-US": string } };
      expect(zhReply.customerReply["zh-CN"].length).toBeGreaterThan(0);
      expect(enReply.customerReply["en-US"].length).toBeGreaterThan(0);
    }
  });

  const hasDist = existsSync(distCliMain);
  it.skipIf(!hasDist)("real CLI: zh-CN default and --locale en-US switch (built binary)", () => {
    const home = tmp();
    const env = { ...process.env, FDE_GYM_HOME: join(home, "store") };

    const zh = spawnSync(process.execPath, [distCliMain, "list", "--json"], {
      encoding: "utf8",
      env,
    });
    const en = spawnSync(process.execPath, [distCliMain, "list", "--json", "--locale", "en-US"], {
      encoding: "utf8",
      env,
    });

    expect(zh.status).toBe(0);
    const zhJson = JSON.parse(zh.stdout.trim());
    expect(zhJson.ok).toBe(true);
    expect(zhJson.locale).toBe("zh-CN");

    const enJson = JSON.parse(en.stdout.trim());
    expect(enJson.ok).toBe(true);
    expect(enJson.locale).toBe("en-US");
  });

  it.skipIf(!hasDist)("real CLI: doctor --require-safe gates the release exit code (built binary)", () => {
    const home = tmp();
    const env = { ...process.env, FDE_GYM_HOME: join(home, "store") };
    const missingCodex = join(home, "no-such-codex");

    // A safe probe: both diagnostic and strict modes exit 0.
    const diag = spawnSync(process.execPath, [distCliMain, "doctor", "--json", "--codex-bin", fakeCodex], {
      encoding: "utf8",
      env,
    });
    expect(diag.status).toBe(0);
    const diagJson = JSON.parse(diag.stdout.trim());
    expect(diagJson.ok).toBe(true);
    expect(diagJson.data.report.safeForStrictMode).toBe(true);

    const strictOk = spawnSync(
      process.execPath,
      [distCliMain, "doctor", "--json", "--require-safe", "--codex-bin", fakeCodex],
      { encoding: "utf8", env },
    );
    expect(strictOk.status).toBe(0);

    // An unsafe probe: diagnostic stays diagnostic, strict exits non-zero.
    const diagUnsafe = spawnSync(process.execPath, [distCliMain, "doctor", "--json", "--codex-bin", missingCodex], {
      encoding: "utf8",
      env,
    });
    expect(diagUnsafe.status).toBe(0);
    expect(JSON.parse(diagUnsafe.stdout.trim()).data.report.safeForStrictMode).toBe(false);

    const strictUnsafe = spawnSync(
      process.execPath,
      [distCliMain, "doctor", "--json", "--require-safe", "--codex-bin", missingCodex],
      { encoding: "utf8", env },
    );
    expect(strictUnsafe.status).toBe(1);
    const strictJson = JSON.parse(strictUnsafe.stdout.trim());
    expect(strictJson.ok).toBe(false);
    expect(strictJson.code).toBe("CODEX_STRICT_MODE_UNSAFE");
  });
});
