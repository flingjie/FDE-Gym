import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readCodexModelConfig,
  resolveDirectModelConfig,
} from "../../src/integrations/direct/config";

let roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-direct-config-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  roots = [];
});

const REALISTIC_TOML = `
model_provider = "custom"
model = "deepseek-v4-pro"
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers]

[model_providers.custom]
name = "deepseek"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "SUPER_SECRET_TOKEN"
`;

describe("direct runtime config", () => {
  it("extracts model + the custom provider's base_url and ignores the token", () => {
    const path = join(tmp(), "config.toml");
    writeFileSync(path, REALISTIC_TOML, "utf8");
    const cfg = readCodexModelConfig(path);
    expect(cfg.model).toBe("deepseek-v4-pro");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:15721/v1");
    // The token must never be copied out of the file.
    expect(JSON.stringify(cfg)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("returns empty config for a missing file", () => {
    expect(readCodexModelConfig(join(tmp(), "nope.toml"))).toEqual({});
  });

  it("prefers env vars over the TOML", () => {
    const path = join(tmp(), "config.toml");
    writeFileSync(path, REALISTIC_TOML, "utf8");
    const cfg = resolveDirectModelConfig(
      { FDE_GYM_MODEL_BASE_URL: "http://env/v1", FDE_GYM_MODEL: "env-model" },
      path,
    );
    expect(cfg?.baseUrl).toBe("http://env/v1");
    expect(cfg?.model).toBe("env-model");
  });

  it("falls back to the TOML when env vars are absent", () => {
    const path = join(tmp(), "config.toml");
    writeFileSync(path, REALISTIC_TOML, "utf8");
    const cfg = resolveDirectModelConfig({}, path);
    expect(cfg?.baseUrl).toBe("http://127.0.0.1:15721/v1");
    expect(cfg?.model).toBe("deepseek-v4-pro");
  });

  it("returns null when neither env nor TOML yield an endpoint", () => {
    expect(resolveDirectModelConfig({}, join(tmp(), "nope.toml"))).toBeNull();
  });
});
