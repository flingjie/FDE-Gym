import type { LocalizedText } from "../core/domain.js";
import type { ScenarioAuthoring } from "./schema.js";

export interface HintDisciplineIssue {
  path: Array<string | number>;
  message: string;
}

const ANSWER_BANNER = /关键发现|key discovery/i;

/** Maximal digit runs, commas stripped (`180,000` → `180000`, `18万` → `18`). */
export function numericTokens(text: string): string[] {
  const tokens = new Set<string>();
  const stripped = text.replace(/,/g, "");
  for (const match of stripped.matchAll(/\d+(?:\.\d+)?/g)) {
    tokens.add(match[0]);
  }
  return [...tokens];
}

function localizedValues(text: LocalizedText): string[] {
  return [text["zh-CN"], text["en-US"]];
}

export function hiddenNumericTokenSet(doc: ScenarioAuthoring): Set<string> {
  const tokens = new Set<string>();
  for (const unit of doc.customer.disclosureUnits) {
    for (const value of localizedValues(unit.text)) {
      for (const token of numericTokens(value)) tokens.add(token);
    }
  }
  for (const evidence of doc.evaluator.expectedEvidence) {
    for (const value of localizedValues(evidence.description)) {
      for (const token of numericTokens(value)) tokens.add(token);
    }
  }
  return tokens;
}

export function collectHintDisciplineIssues(doc: ScenarioAuthoring): HintDisciplineIssue[] {
  const issues: HintDisciplineIssue[] = [];
  const hidden = hiddenNumericTokenSet(doc);
  const seenTopics = new Set<string>();

  doc.evaluator.hintLadders.forEach((ladder, i) => {
    if (seenTopics.has(ladder.topic)) {
      issues.push({
        path: ["evaluator", "hintLadders", i, "topic"],
        message: `duplicate hint ladder topic: ${ladder.topic}`,
      });
    }
    seenTopics.add(ladder.topic);

    for (const level of ["1", "2", "3"] as const) {
      const text = ladder.hints[level];
      for (const locale of ["zh-CN", "en-US"] as const) {
        const value = text[locale];
        const path = ["evaluator", "hintLadders", i, "hints", level, locale];
        if (ANSWER_BANNER.test(value)) {
          issues.push({ path, message: "must not contain an answer banner (关键发现 / Key discovery)" });
        }
        if (level === "3") {
          if (!value.includes("?") && !value.includes("？")) {
            issues.push({ path, message: "L3 must be a question (contain ? or ？)" });
          }
        }
        for (const token of numericTokens(value)) {
          if (hidden.has(token)) {
            issues.push({
              path,
              message: `hint level ${level} repeats hidden numeric token: ${token}`,
            });
          }
        }
      }
    }
  });

  return issues;
}
