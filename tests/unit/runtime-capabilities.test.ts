import { describe, expect, it } from "vitest";
import { DirectModelRuntime } from "../../src/integrations/direct/direct-runtime";
import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime";
import { UnconfiguredModelRuntime } from "../../src/agents/unconfigured-runtime";

describe("RuntimeCapabilities", () => {
  it("DirectModelRuntime reports prompted structured output + cancellation", () => {
    const c = new DirectModelRuntime({ baseUrl: "http://x/v1", model: "m" }).capabilities;
    expect(c).toMatchObject({ structuredOutput: "prompted", supportsSeed: false, supportsCancellation: true, maxInputTokens: null, provider: "openai-compatible" });
  });
  it("FixtureAgentRuntime reports native + seed", () => {
    const c = new FixtureAgentRuntime().capabilities;
    expect(c).toMatchObject({ structuredOutput: "native", supportsSeed: true, supportsCancellation: false, provider: "fixture" });
  });
  it("UnconfiguredModelRuntime reports unconfigured", () => {
    const c = new UnconfiguredModelRuntime().capabilities;
    expect(c.provider).toBe("unconfigured");
  });
});
