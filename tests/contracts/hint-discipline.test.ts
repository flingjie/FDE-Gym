import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import type { ScenarioAuthoring } from "../../src/scenarios/schema";
import { ScenarioAuthoringSchema } from "../../src/scenarios/schema";
import {
  collectHintDisciplineIssues,
  numericTokens,
} from "../../src/scenarios/hint-discipline";

const neutralText = {
  "zh-CN": "提高工厂运营效率",
  "en-US": "Improve factory operational efficiency",
};

function minimalAuthoring(
  overrides: Partial<{
    disclosureText: { "zh-CN": string; "en-US": string };
    evidenceDescription: { "zh-CN": string; "en-US": string };
    hintLadders: ScenarioAuthoring["evaluator"]["hintLadders"];
  }> = {},
): ScenarioAuthoring {
  const disclosureText = overrides.disclosureText ?? {
    "zh-CN": "每月约18万张工单，55%重复",
    "en-US": "About 180,000 tickets per month, 55% duplicate",
  };
  const evidenceDescription = overrides.evidenceDescription ?? neutralText;

  return {
    id: "manufacturing-alert-triage",
    schemaVersion: 1,
    locale: "zh-CN",
    public: {
      openingRequest: neutralText,
      visibleContext: neutralText,
      visibleConstraints: [neutralText],
      deliverables: [neutralText],
      learnerRules: [neutralText],
      questionBudget: 12,
    },
    customer: {
      stakeholders: [
        {
          id: "s1",
          role: neutralText,
          persona: neutralText,
          concerns: [neutralText],
          blindSpots: [neutralText],
        },
      ],
      disclosureUnits: [
        {
          id: "d1",
          topic: "workflow",
          text: disclosureText,
          prerequisites: [],
          evidenceId: "e1",
        },
      ],
      responsePolicies: [],
      privateConflicts: [],
    },
    evaluator: {
      expectedEvidence: [
        {
          id: "e1",
          category: "workflow",
          description: evidenceDescription,
          weight: 2,
          disclosureUnitIds: ["d1"],
        },
      ],
      rubric: { stages: [] },
      criticalContradictions: [
        { id: "c1", statement: neutralText, expectedEvidenceIds: ["e1"] },
      ],
      hintLadders: overrides.hintLadders ?? [
        {
          id: "h1",
          topic: "workflow",
          hints: {
            "1": neutralText,
            "2": neutralText,
            "3": {
              "zh-CN": "现在每月工单量是多少？",
              "en-US": "What is monthly ticket volume?",
            },
          },
        },
      ],
      passGates: [],
    },
    events: [
      {
        id: "ev1",
        trigger: { kind: "after_evidence_revealed", evidenceId: "e1" },
        prompt: neutralText,
      },
    ],
  };
}

describe("numericTokens", () => {
  it("extracts comma-separated and 万-suffixed numbers", () => {
    expect(numericTokens("180,000")).toEqual(["180000"]);
    expect(numericTokens("18万")).toEqual(["18"]);
    expect(numericTokens("3,400")).toEqual(["3400"]);
  });
});

describe("collectHintDisciplineIssues", () => {
  it("flags L3 answer banners and hidden numeric tokens", () => {
    const doc = minimalAuthoring({
      hintLadders: [
        {
          id: "h1",
          topic: "workflow",
          hints: {
            "1": neutralText,
            "2": neutralText,
            "3": {
              "zh-CN": "关键发现：每月约18万张",
              "en-US": "Key discovery: 180,000 tickets",
            },
          },
        },
      ],
    });

    const issues = collectHintDisciplineIssues(doc);
    const messages = issues.map((i) => i.message);

    expect(messages).toContain(
      "L3 must not contain an answer banner (关键发现 / Key discovery)",
    );
    expect(messages.some((m) => m.includes("repeats hidden numeric token: 18"))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes("repeats hidden numeric token: 180000"))).toBe(
      true,
    );
  });

  it("accepts Socratic L3 questions with clean L1/L2", () => {
    const doc = minimalAuthoring();
    expect(collectHintDisciplineIssues(doc)).toEqual([]);
  });

  it("requires L3 to contain ? or ？", () => {
    const doc = minimalAuthoring({
      hintLadders: [
        {
          id: "h1",
          topic: "workflow",
          hints: {
            "1": neutralText,
            "2": neutralText,
            "3": {
              "zh-CN": "现在每月工单量是多少",
              "en-US": "What is monthly ticket volume",
            },
          },
        },
      ],
    });

    const issues = collectHintDisciplineIssues(doc);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["evaluator", "hintLadders", 0, "hints", "3", "zh-CN"],
          message: "L3 must be a question (contain ? or ？)",
        }),
        expect.objectContaining({
          path: ["evaluator", "hintLadders", 0, "hints", "3", "en-US"],
          message: "L3 must be a question (contain ? or ？)",
        }),
      ]),
    );
  });

  it("flags duplicate hint ladder topics", () => {
    const doc = minimalAuthoring({
      hintLadders: [
        {
          id: "h1",
          topic: "workflow",
          hints: {
            "1": neutralText,
            "2": neutralText,
            "3": {
              "zh-CN": "现在每月工单量是多少？",
              "en-US": "What is monthly ticket volume?",
            },
          },
        },
        {
          id: "h2",
          topic: "workflow",
          hints: {
            "1": neutralText,
            "2": neutralText,
            "3": {
              "zh-CN": "重复率大约是多少？",
              "en-US": "What is the approximate repeat rate?",
            },
          },
        },
      ],
    });

    const issues = collectHintDisciplineIssues(doc);
    expect(issues).toContainEqual({
      path: ["evaluator", "hintLadders", 1, "topic"],
      message: "duplicate hint ladder topic: workflow",
    });
  });

  it("flags hint levels that repeat hidden numeric tokens", () => {
    const doc18 = minimalAuthoring({
      hintLadders: [
        {
          id: "h1",
          topic: "workflow",
          hints: {
            "1": { "zh-CN": "工单量约18", "en-US": "Volume around 18" },
            "2": neutralText,
            "3": {
              "zh-CN": "现在每月工单量是多少？",
              "en-US": "What is monthly ticket volume?",
            },
          },
        },
      ],
    });
    expect(
      collectHintDisciplineIssues(doc18).some(
        (i) =>
          i.message === "hint level 1 repeats hidden numeric token: 18" &&
          i.path[4] === "1",
      ),
    ).toBe(true);

    const doc3400 = minimalAuthoring({
      disclosureText: {
        "zh-CN": "峰值约3,400张",
        "en-US": "Peak around 3,400 tickets",
      },
      hintLadders: [
        {
          id: "h1",
          topic: "workflow",
          hints: {
            "1": { "zh-CN": "峰值约3张", "en-US": "Peak around 3" },
            "2": neutralText,
            "3": {
              "zh-CN": "峰值工单量大约是多少？",
              "en-US": "What is the approximate peak volume?",
            },
          },
        },
      ],
    });
    expect(
      collectHintDisciplineIssues(doc3400).some((i) =>
        i.message.includes("repeats hidden numeric token: 3"),
      ),
    ).toBe(false);
  });
});

const SOURCES = [
  "support-automation",
  "manufacturing-alert-triage",
  "data-migration",
  "export-freight-forwarding",
] as const;

describe("production source ladders", () => {
  for (const id of SOURCES) {
    it(`${id} has no hint-discipline issues`, () => {
      const raw = readFileSync(join(process.cwd(), "scenarios", "source", `${id}.yaml`), "utf8");
      const doc = ScenarioAuthoringSchema.parse(parse(raw));
      expect(collectHintDisciplineIssues(doc)).toEqual([]);
    });
  }
});
