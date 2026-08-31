import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const COMMANDS_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "commands.ts");

describe("CLI boundary — commands.ts is a thin adapter", () => {
  it("does not import the transaction, prepare*, or concrete store/scenario modules", () => {
    const src = readFileSync(COMMANDS_SRC, "utf8");
    for (const forbidden of [
      "executeCommandTransaction",
      "command-transaction",
      "prepareDiscoveryTurn", "prepareFramingGate", "prepareClarification",
      "prepareSolutionDesign", "prepareChallengeInjection", "prepareRespondToChallenge",
      "preparePitch", "prepareRetry", "prepareReview", "prepareRepairPendingEvidence",
      "loadScenarioBundle", "loadLearnerProfile", "foldRunAggregate", "projectReplay",
    ]) {
      expect(src, `commands.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });
});
