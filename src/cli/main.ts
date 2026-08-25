#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { CodexAgentRuntime } from "../integrations/codex/codex-runtime.js";
import { installSkillCommand } from "../integrations/codex/install-skill.js";
import { LocaleSchema, type Locale } from "../core/domain.js";
import {
  askCommand,
  clarifyCommand,
  doctorCommand,
  frameCommand,
  hintCommand,
  listCommand,
  profileCommand,
  repairEvidenceCommand,
  replayCommand,
  respondChallengeCommand,
  retryCommand,
  reviewCommand,
  startCommand,
  statusCommand,
  submitBriefCommand,
  submitDesignCommand,
  submitPitchCommand,
  type CommandContext,
} from "./commands.js";
import {
  localize,
  renderHuman,
  renderHumanFailure,
  renderJson,
  type CliResult,
} from "./render.js";

/**
 * FDE Gym — the single learner-facing CLI entry point (Task 11).
 *
 * Routes the full command surface to the thin `commands.ts` handlers. Mutating
 * commands accept learner prose/artifacts as JSON on stdin (avoids shell
 * quoting/injection); run id, command id, scenario, and locale come from flags.
 * Every command prints the strict learner-safe envelope as JSON.
 */

const COMMAND_NAMES = [
  "doctor",
  "list",
  "start",
  "status",
  "frame",
  "ask",
  "hint",
  "clarify",
  "repair-evidence",
  "submit-brief",
  "submit-design",
  "respond-challenge",
  "submit-pitch",
  "review",
  "replay",
  "retry",
  "profile",
  "install-skill",
] as const;

type CommandName = (typeof COMMAND_NAMES)[number];

function resolveDefaultCodex(): string {
  const candidates = [process.env.CODEX_BIN, join(homedir(), ".local", "bin", "codex"), "codex"];
  for (const candidate of candidates) {
    if (candidate && candidate.length > 0) return candidate;
  }
  return "codex";
}

function readStdinJson(): unknown {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  if (raw.trim() === "") return {};
  return JSON.parse(raw) as unknown;
}

function requireString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseLocale(raw: unknown): Locale {
  const parsed = LocaleSchema.safeParse(raw);
  return parsed.success ? parsed.data : "zh-CN";
}

function usage(): string {
  return [
    "Usage: fde-gym <command> [options]",
    "",
    "Commands:",
    "  doctor            probe the Codex CLI capability surface",
    "  list              list all runs",
    "  start             start a new run (--run-id --scenario --locale)",
    "  status            show a run's phase summary (--run-id)",
    "  frame             move DISCOVERY -> PROBLEM_FRAMING (--run-id --command-id)",
    "  ask               ask the customer a question (--run-id --command-id; JSON stdin)",
    "  hint              request a hint (--run-id --command-id --topic [--level])",
    "  clarify           PROBLEM_FRAMING -> DISCOVERY (--run-id --command-id)",
    "  repair-evidence   re-run a pending evidence extraction (--run-id --command-id)",
    "  submit-brief      submit a problem brief (--run-id --command-id; JSON stdin)",
    "  submit-design     submit a solution design + inject challenges (--run-id --command-id; JSON stdin)",
    "  respond-challenge answer a challenge (--run-id --command-id; JSON stdin)",
    "  submit-pitch      submit the pitch (--run-id --command-id; JSON stdin)",
    "  review            run final review + score (--run-id --command-id)",
    "  replay            project the learner-safe replay (--run-id [--locale])",
    "  retry             start a clean retry (--run-id --new-run-id --command-id; JSON stdin)",
    "  profile           show the learner profile",
    "  install-skill     install the Codex Skill to the repo-local .codex/skills/ (--dry-run)",
    "",
    "Global flags: --base-dir <dir> --json",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (!(COMMAND_NAMES as readonly string[]).includes(command)) {
    const failure = { ok: false as const, ...localize("UNKNOWN_COMMAND", "zh-CN"), code: "UNKNOWN_COMMAND" };
    process.stderr.write(renderHumanFailure(failure) + "\n");
    process.exitCode = 2;
    return;
  }
  const commandName = command as CommandName;

  const parsed = parseArgs({
    args: argv.slice(1),
    allowPositionals: false,
    options: {
      "run-id": { type: "string" },
      "command-id": { type: "string" },
      "scenario": { type: "string" },
      "locale": { type: "string" },
      "topic": { type: "string" },
      "level": { type: "string" },
      "seed": { type: "string" },
      "new-run-id": { type: "string" },
      "base-dir": { type: "string" },
      "codex-bin": { type: "string" },
      "dry-run": { type: "boolean" },
      "json": { type: "boolean" },
      "human": { type: "boolean" },
      "require-safe": { type: "boolean" },
    },
  });
  const flags = parsed.values as Record<string, string | boolean | undefined>;

  const locale = parseLocale(flags.locale);
  const runtime = new CodexAgentRuntime({ executable: resolveDefaultCodex() });
  const ctx: CommandContext = {
    runtime,
    baseDir: typeof flags["base-dir"] === "string" ? flags["base-dir"] : undefined,
  };

  const runId = typeof flags["run-id"] === "string" ? flags["run-id"] : undefined;
  const commandId = typeof flags["command-id"] === "string" ? flags["command-id"] : undefined;
  const asJson = flags.json === true || flags.human !== true;

  let result: CliResult<unknown>;
  switch (commandName) {
    case "doctor": {
      result = await doctorCommand(ctx, {
        locale,
        executable: typeof flags["codex-bin"] === "string" ? flags["codex-bin"] : undefined,
        requireSafe: flags["require-safe"] === true,
      });
      break;
    }
    case "list": {
      result = await listCommand(ctx, { locale });
      break;
    }
    case "profile": {
      result = await profileCommand(ctx, { locale });
      break;
    }
    case "start": {
      const scenario = flags.scenario;
      if (!runId || !commandId || typeof scenario !== "string") {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await startCommand(ctx, { runId, scenarioId: scenario, locale, commandId });
      break;
    }
    case "status": {
      if (!runId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await statusCommand(ctx, { runId });
      break;
    }
    case "frame": {
      if (!runId || !commandId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await frameCommand(ctx, { runId, commandId });
      break;
    }
    case "ask": {
      if (!runId || !commandId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      const payload = readStdinJson() as Record<string, unknown>;
      const question = requireString(payload, "question");
      const stakeholderId = requireString(payload, "stakeholderId");
      if (!question || !stakeholderId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await askCommand(ctx, { runId, question, stakeholderId, commandId });
      break;
    }
    case "hint": {
      const topic = flags.topic;
      if (!runId || !commandId || typeof topic !== "string") {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      const level = flags.level === "1" || flags.level === "2" || flags.level === "3"
        ? (Number(flags.level) as 1 | 2 | 3)
        : undefined;
      result = await hintCommand(ctx, { runId, topic, level, commandId });
      break;
    }
    case "clarify": {
      if (!runId || !commandId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await clarifyCommand(ctx, { runId, commandId });
      break;
    }
    case "repair-evidence": {
      if (!runId || !commandId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await repairEvidenceCommand(ctx, { runId, commandId });
      break;
    }
    case "submit-brief": {
      if (!runId || !commandId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      const payload = readStdinJson() as Record<string, unknown>;
      if (!payload.brief) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await submitBriefCommand(ctx, {
        runId,
        commandId,
        brief: payload.brief as never,
      });
      break;
    }
    case "submit-design": {
      if (!runId || !commandId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      const payload = readStdinJson() as Record<string, unknown>;
      if (!payload.proposal) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await submitDesignCommand(ctx, {
        runId,
        commandId,
        proposal: payload.proposal as never,
        seed: typeof flags.seed === "string" ? Number(flags.seed) : undefined,
      });
      break;
    }
    case "respond-challenge": {
      if (!runId || !commandId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      const payload = readStdinJson() as Record<string, unknown>;
      if (!payload.response) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await respondChallengeCommand(ctx, {
        runId,
        commandId,
        response: payload.response as never,
      });
      break;
    }
    case "submit-pitch": {
      if (!runId || !commandId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      const payload = readStdinJson() as Record<string, unknown>;
      if (!payload.pitch) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await submitPitchCommand(ctx, {
        runId,
        commandId,
        pitch: payload.pitch as never,
      });
      break;
    }
    case "review": {
      if (!runId || !commandId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await reviewCommand(ctx, { runId, commandId });
      break;
    }
    case "replay": {
      if (!runId) {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      result = await replayCommand(ctx, { runId, locale });
      break;
    }
    case "retry": {
      const newRunId = flags["new-run-id"];
      if (!runId || !commandId || typeof newRunId !== "string") {
        result = { ok: false, code: "MISSING_ARGUMENT", ...localize("MISSING_ARGUMENT", locale) };
        break;
      }
      const payload = readStdinJson() as Record<string, unknown>;
      result = await retryCommand(ctx, {
        runId,
        commandId,
        newRunId,
        focusSummaries: Array.isArray(payload.focusSummaries) ? (payload.focusSummaries as never) : undefined,
        seed: typeof flags.seed === "string" ? Number(flags.seed) : undefined,
      });
      break;
    }
    case "install-skill": {
      result = installSkillCommand(ctx, {
        locale,
        dryRun: flags["dry-run"] === true,
      });
      break;
    }
    default: {
      result = { ok: false, code: "UNKNOWN_COMMAND", ...localize("UNKNOWN_COMMAND", locale) };
    }
  }

  if (asJson) {
    process.stdout.write(renderJson(result) + "\n");
  } else if (result.ok) {
    process.stdout.write(renderHuman(result) + "\n");
  } else {
    process.stdout.write(renderHumanFailure(result) + "\n");
  }
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fde-gym: fatal: ${message}\n`);
  process.exitCode = 1;
});
