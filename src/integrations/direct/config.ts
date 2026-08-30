import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DirectModelRuntimeConfig } from "./direct-runtime.js";

/**
 * Resolve the config for the direct chat-completions runtime.
 *
 * Priority: explicit env vars, then the Codex `~/.codex/config.toml` (the
 * `model` + the custom provider's `base_url` the user already configured for
 * Codex). Returns `null` when neither yields a usable endpoint — the caller
 * then fails closed with `MODEL_ENDPOINT_REQUIRED`.
 *
 * FDE Gym never reads, copies, or prints the provider auth token: the local
 * cc-switch proxy manages it, so the direct runtime needs only `baseUrl` +
 * `model`.
 */

const BASE_URL_ENV = "FDE_GYM_MODEL_BASE_URL";
const MODEL_ENV = "FDE_GYM_MODEL";
const API_KEY_ENV = "FDE_GYM_MODEL_API_KEY";

export interface CodexTomlModelConfig {
  model?: string;
  baseUrl?: string;
}

export function resolveDirectModelConfig(
  env: NodeJS.ProcessEnv = process.env,
  configTomlPath: string = join(homedir(), ".codex", "config.toml"),
): DirectModelRuntimeConfig | null {
  const envBaseUrl = env[BASE_URL_ENV];
  const envModel = env[MODEL_ENV];
  if (envBaseUrl && envModel) {
    return { baseUrl: envBaseUrl, model: envModel, apiKey: env[API_KEY_ENV] };
  }

  const fromToml = readCodexModelConfig(configTomlPath);
  if (fromToml.baseUrl && fromToml.model) {
    return { baseUrl: fromToml.baseUrl, model: fromToml.model };
  }
  return null;
}

/**
 * Minimal reader for the subset of `~/.codex/config.toml` the direct runtime
 * needs: the top-level `model`, the top-level `model_provider` (to locate the
 * section), and that section's `base_url`. Deliberately ignores every other
 * key — including auth tokens — so secrets are never copied out of the file.
 */
export function readCodexModelConfig(path: string): CodexTomlModelConfig {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  const result: CodexTomlModelConfig = {};
  let provider: string | null = null;
  let section = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2];

    if (section === "") {
      if (key === "model") result.model = value;
      else if (key === "model_provider") provider = value;
    } else if (provider !== null && section === `model_providers.${provider}` && key === "base_url") {
      result.baseUrl = value;
    }
  }

  return result;
}
