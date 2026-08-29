import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  codexInvocationCompleted,
  runCodex,
} from "./codex-process.js";

export const STRICT_HOME_ENV = "FDE_GYM_CODEX_HOME" as const;

export type StrictPolicyFailure =
  | "STRICT_HOME_REQUIRED"
  | "STRICT_HOME_INVALID"
  | "MCP_INVENTORY_FAILED"
  | "MCP_SERVERS_ENABLED";

export class StrictCodexPolicyError extends Error {
  readonly code = "CODEX_STRICT_MODE_UNSAFE" as const;
  readonly failure: StrictPolicyFailure;

  constructor(failure: StrictPolicyFailure) {
    super("Codex strict-mode policy is unsafe");
    this.name = "StrictCodexPolicyError";
    this.failure = failure;
  }
}

export interface StrictExecOptions {
  model?: string;
  extra?: readonly string[];
  disableTools?: boolean;
}

export type StrictMcpInspection =
  | { safe: true }
  | { safe: false; failure: "MCP_INVENTORY_FAILED" | "MCP_SERVERS_ENABLED" };

export interface StrictMcpInspectionOptions {
  executable: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/** Minimal child-environment allowlist: the child never inherits arbitrary parent state. */
const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "CODEX_HOME",
];

/**
 * Build the environment handed to a child Codex invocation. Only an explicit
 * allowlist is inherited, so secrets held by the parent process (such as the
 * parent canary) are structurally incapable of leaking to the child.
 */
export function sanitizeChildEnv(
  source: NodeJS.ProcessEnv,
  extraAllow: string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set([...BASE_ENV_KEYS, ...extraAllow]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Resolve the dedicated strict home. It must be an absolute, existing, readable
 * directory; every failure is converted to a learner-safe policy error that
 * never embeds the path.
 */
export function resolveStrictCodexHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[STRICT_HOME_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new StrictCodexPolicyError("STRICT_HOME_REQUIRED");
  }
  if (!isAbsolute(raw)) {
    throw new StrictCodexPolicyError("STRICT_HOME_INVALID");
  }
  try {
    if (!statSync(raw).isDirectory()) {
      throw new Error("not a directory");
    }
    accessSync(raw, constants.R_OK);
  } catch {
    throw new StrictCodexPolicyError("STRICT_HOME_INVALID");
  }
  return raw;
}

/**
 * Child environment for strict role execution: a sanitized allowlist plus a
 * dedicated `CODEX_HOME` that is isolated from the user's normal configuration.
 */
export function buildStrictChildEnv(
  source: NodeJS.ProcessEnv,
  strictHome: string,
  extraAllow: string[] = [],
): NodeJS.ProcessEnv {
  const env = sanitizeChildEnv(source, extraAllow);
  env.CODEX_HOME = strictHome;
  return env;
}

/**
 * Build the single server-name-agnostic strict execution policy shared by the
 * runtime and the capability probe. It never names or disables a specific MCP
 * server; the dedicated home itself must contain no enabled server.
 */
export function buildStrictExecArgs(
  workdir: string,
  options: StrictExecOptions = {},
): string[] {
  const disableTools = options.disableTools !== false
    ? ["--disable", "shell_tool", "--disable", "unified_exec"]
    : [];
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--ignore-rules",
    "-C",
    workdir,
    ...disableTools,
    ...(options.extra ?? []),
    ...(options.model ? ["-m", options.model] : []),
    "-",
  ];
}

/**
 * Inspect the complete effective MCP inventory of the strict home. Only the
 * top-level array and each entry's `enabled` boolean are retained; server names
 * and configuration values never survive.
 */
export async function inspectStrictMcpInventory(
  options: StrictMcpInspectionOptions,
): Promise<StrictMcpInspection> {
  const run = await runCodex(options.executable, {
    args: ["mcp", "list", "--json"],
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (!codexInvocationCompleted(run)) {
    return { safe: false, failure: "MCP_INVENTORY_FAILED" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { safe: false, failure: "MCP_INVENTORY_FAILED" };
  }
  if (!Array.isArray(parsed)) {
    return { safe: false, failure: "MCP_INVENTORY_FAILED" };
  }
  const anyEnabled = parsed.some(
    (entry) =>
      entry === null ||
      typeof entry !== "object" ||
      (entry as { enabled?: unknown }).enabled !== false,
  );
  return anyEnabled
    ? { safe: false, failure: "MCP_SERVERS_ENABLED" }
    : { safe: true };
}
