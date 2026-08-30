import { describe, expect, it } from "vitest";

import { AgentRuntimeError } from "../../src/agents/agent-runtime";
import { CustomerOutputSchema } from "../../src/agents/contracts";
import { UnconfiguredModelRuntime } from "../../src/agents/unconfigured-runtime";

describe("UnconfiguredModelRuntime", () => {
  it("fails closed with MODEL_ENDPOINT_REQUIRED on the first invoke", async () => {
    const runtime = new UnconfiguredModelRuntime();
    const error = await runtime
      .invoke(
        "customer",
        { locale: "zh-CN", question: "q", stakeholderId: "s1" },
        {
          runId: "r1",
          invocationId: "inv-1",
          freshContext: true,
          tools: "disabled",
          prompt: "ignored",
          canaries: [],
          outputSchema: CustomerOutputSchema,
          timeoutMs: 1000,
        },
      )
      .catch((e) => e);

    expect(error).toBeInstanceOf(AgentRuntimeError);
    expect(error.code).toBe("MODEL_ENDPOINT_REQUIRED");
    expect(String(error.message)).not.toContain("ignored");
  });
});
