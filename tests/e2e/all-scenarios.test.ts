import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { compileScenario } from "../../src/scenarios/compiler.js";
import { ScenarioAuthoringSchema } from "../../src/scenarios/schema.js";
import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime.js";
import {
  askCommand,
  frameCommand,
  hintCommand,
  respondChallengeCommand,
  retryCommand,
  reviewCommand,
  startCommand,
  statusCommand,
  submitBriefCommand,
  submitDesignCommand,
  submitPitchCommand,
  replayCommand,
  type CommandContext,
} from "../../src/cli/commands.js";
import { numericTokens } from "../../src/scenarios/hint-discipline";
import type {
  ChallengeResponse,
  LocalizedText,
  PitchArtifact,
  ProblemBrief,
  SolutionProposal,
} from "../../src/core/domain.js";
import type { LearnerReplay } from "../../src/replay/projector.js";

/**
 * Task 13 — end-to-end loop across every scenario and both locales.
 *
 * Drives each of the three MVP scenarios through the COMPLETE fixture loop
 * (Scenario -> Discovery -> framing -> solution -> challenge -> pitch ->
 * review -> retry) in BOTH locales and asserts the learner replay is
 * byte-stable across repeated runs and never leaks hidden content.
 */

const text = (zh: string, en: string): LocalizedText => ({ "zh-CN": zh, "en-US": en });

const SCENARIOS = ["manufacturing-alert-triage", "data-migration", "support-automation"] as const;
type ScenarioId = (typeof SCENARIOS)[number];

function sourcePath(id: ScenarioId): string {
  return join(process.cwd(), "scenarios", "source", `${id}.yaml`);
}

function authoring(id: ScenarioId) {
  return ScenarioAuthoringSchema.parse(parse(readFileSync(sourcePath(id), "utf8")));
}

function compilePack(id: ScenarioId) {
  const compiledRoot = mkdtempSync(join(tmpdir(), "fde-all-scenarios-compiled-"));
  tempDirs.push(compiledRoot);
  return compileScenario(sourcePath(id), "e2e-seed", compiledRoot);
}

interface AskPlan {
  question: string;
  stakeholderId: string;
  duId: string;
  reply: LocalizedText;
  nodeId: string;
  nodeClaim: LocalizedText;
}

const ASK_PLANS: Record<ScenarioId, AskPlan[]> = {
  "manufacturing-alert-triage": [
    {
      question: "每天产生多少条设备告警？",
      stakeholderId: "vp-operations",
      duId: "du-001",
      reply: text("工厂每天产生约12,000条告警。", "The factory produces about 12,000 alerts a day."),
      nodeId: "ev-n1",
      nodeClaim: text("每天产生大量设备告警", "A large volume of daily equipment alerts"),
    },
    {
      question: "工程师在低价值告警上花了多少时间？",
      stakeholderId: "technical-lead",
      duId: "du-005",
      reply: text("工程师花约40%的时间处理低价值告警。", "Engineers spend about 40% of time on low-value alerts."),
      nodeId: "ev-n2",
      nodeClaim: text("工程师时间被低价值告警占用", "Engineer time is consumed by low-value alerts"),
    },
    {
      question: "如果AI误报率过高会怎样？",
      stakeholderId: "project-manager",
      duId: "du-017",
      reply: text("高误报会让工程师忽略所有告警。", "A high false-positive rate makes engineers ignore all alerts."),
      nodeId: "ev-n3",
      nodeClaim: text("高误报率带来安全风险", "A high false-positive rate creates safety risk"),
    },
  ],
  "data-migration": [
    {
      question: "迁移涉及多少数据和哪些表？",
      stakeholderId: "project-manager",
      duId: "du-001",
      reply: text("迁移涉及约3,200万条订单记录和15张表。", "The migration covers about 32 million order records across 15 tables."),
      nodeId: "ev-n1",
      nodeClaim: text("迁移涉及大量订单数据", "The migration involves a large volume of order data"),
    },
    {
      question: "数据质量有哪些问题？",
      stakeholderId: "technical-lead",
      duId: "du-003",
      reply: text("抽样发现约12%的记录有字段问题。", "Sampling found about 12% of records have field issues."),
      nodeId: "ev-n2",
      nodeClaim: text("数据存在字段缺失与不一致", "Data has missing and inconsistent fields"),
    },
    {
      question: "如果回滚失败会发生什么？",
      stakeholderId: "data-owner",
      duId: "du-015",
      reply: text("回滚失败会导致新旧系统同时写入。", "A failed rollback makes old and new systems write simultaneously."),
      nodeId: "ev-n3",
      nodeClaim: text("回滚失败会造成数据分叉", "A failed rollback causes data divergence"),
    },
  ],
  "support-automation": [
    {
      question: "每月处理多少工单，多少是重复的？",
      stakeholderId: "support-director",
      duId: "du-001",
      reply: text("每月约18万张工单，55%是重复问题。", "About 180,000 tickets a month, 55% repetitive."),
      nodeId: "ev-n1",
      nodeClaim: text("支持中心工单量大且重复度高", "The support center has high ticket volume and repeat rate"),
    },
    {
      question: "人工成本占多大比例？",
      stakeholderId: "compliance-officer",
      duId: "du-003",
      reply: text("人工成本占总支持预算的72%。", "Labor is 72% of the support budget."),
      nodeId: "ev-n2",
      nodeClaim: text("人工成本主导支持预算", "Labor dominates the support budget"),
    },
    {
      question: "自动化能节省多少成本？",
      stakeholderId: "cfo",
      duId: "du-008",
      reply: text("覆盖40%工单每年可节省约210万美元。", "Covering 40% of tickets saves about $2.1M a year."),
      nodeId: "ev-n3",
      nodeClaim: text("自动化可带来可量化节省", "Automation brings quantifiable savings"),
    },
  ],
};

function fixturesFor(id: ScenarioId): Record<string, unknown> {
  const plan = ASK_PLANS[id];
  const fixtures: Record<string, unknown> = {};
  plan.forEach((ask, i) => {
    const idx = i + 1;
    fixtures[`customer:ask-${idx}:customer`] = {
      reply: ask.reply,
      stakeholderId: ask.stakeholderId,
      disclosedDisclosureUnitIds: [ask.duId],
    };
    fixtures[`evidence_tracker:ask-${idx}:evidence`] = {
      patch: {
        patchId: `p-${idx}`,
        expectedVersion: i,
        addNodes: [
          {
            id: ask.nodeId,
            kind: "fact",
            claim: ask.nodeClaim,
            status: "active",
            sourceTranscriptIds: [`ask-${idx}:turn`],
            weight: 1,
            version: 0,
          },
        ],
        addEdges: [],
        invalidateNodeIds: [],
      },
      questionAssessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
    };
  });
  fixtures["coach_evaluator:brief-1:coach"] = {
    passed: true,
    entailments: [{ claimId: "claim-1", entailment: "supported" }],
    missingCategories: [],
    unsupportedClaimIds: [],
    feedback: text("通过。", "Pass."),
  };
  fixtures["coach_evaluator:review-1:coach"] = {
    verdict: "pass",
    strengths: [text("清晰的问题定义", "Clear problem framing")],
    weaknesses: [text("假设未验证", "Assumptions unverified")],
    missedOpportunities: [text("未追问根因", "Did not probe root cause")],
    decisionDivergencePoints: [{ id: "ddp-1", description: text("变更而非保留", "Changed rather than kept") }],
    nextFocus: [text("强化证据支撑", "Strengthen evidence support"), text("处理信任问题", "Address trust")],
  };
  return fixtures;
}

function brief(): ProblemBrief {
  return {
    id: "brief-1",
    problemStatement: text("当前流程存在效率问题", "The current process has efficiency problems"),
    goal: text("降低工作负担", "Reduce workload"),
    constraints: [text("预算与时间有限", "Limited budget and time")],
    claims: [
      {
        id: "claim-1",
        statement: text("当前流程低效", "The current process is inefficient"),
        weight: "major",
        evidenceIds: ["ev-n1"],
      },
    ],
    successMeasures: [text("工作量削减", "Workload reduction")],
    unknowns: [text("集成复杂度", "Integration complexity")],
    contradictions: [],
  };
}

function proposal(): SolutionProposal {
  return {
    id: "proposal-1",
    objective: text("提升效率", "Improve efficiency"),
    approach: text("分层自动化", "Tiered automation"),
    approachEvidenceIds: ["ev-n1"],
    assumptions: [text("现有系统可改造", "Existing system is changeable")],
    alternatives: [{ id: "alt-1", description: text("外包", "Outsource"), tradeoff: text("成本高", "Costly") }],
    tradeoffs: [text("集成复杂度", "Integration complexity")],
    risks: [{ id: "risk-1", description: text("误报", "False positives"), mitigation: text("阈值调优", "Threshold tuning") }],
    validationPlan: [text("试点验证", "Pilot validation")],
    rolloutPlan: [text("分阶段上线", "Phased rollout")],
    decisions: [{ id: "dec-1", decision: text("渐进引入", "Incremental adoption"), rationale: text("降低风险", "Lower risk"), evidenceIds: ["ev-n1"] }],
  };
}

function pitch(): PitchArtifact {
  return {
    id: "pitch-1",
    audience: text("管理层", "Leadership"),
    problem: text("流程低效", "Inefficient process"),
    recommendation: text("分层自动化", "Tiered automation"),
    expectedValue: text("削减工作量", "Cut workload"),
    evidenceIds: ["ev-n1"],
    risks: [text("误报率", "False positive rate")],
    ask: text("批准试点", "Approve the pilot"),
    nextSteps: [text("组建团队", "Form the team")],
  };
}

function response(challengeId: string): ChallengeResponse {
  return {
    id: `resp-${challengeId}`,
    challengeId,
    impact: text("限制方案范围", "Limits the solution scope"),
    decision: "change",
    rationale: text("缩小范围", "Narrow the scope"),
    newRiskOrValidation: text("增加验证", "Add validation"),
  };
}

let tempDirs: string[] = [];
function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-all-scenarios-"));
  tempDirs.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tempDirs = [];
}
afterEach(cleanup);

async function driveJourney(
  id: ScenarioId,
  baseDir: string,
  locale: "zh-CN" | "en-US",
  runId: string,
): Promise<LearnerReplay> {
  const pack = compilePack(id);
  const scenario: NonNullable<CommandContext["scenario"]> = {
    public: pack.publicScenario,
    customer: pack.customerCapsule,
    evaluator: pack.evaluatorCapsule,
    events: [...pack.eventCandidates],
  };
  const runtime = new FixtureAgentRuntime({ fixtures: fixturesFor(id) });
  const ctx: CommandContext = { runtime, baseDir, scenario };

  const ok = (r: { ok: boolean }) => expect(r.ok).toBe(true);

  ok(await startCommand(ctx, { runId, scenarioId: id, locale, commandId: "start" }));
  const hint = await hintCommand(ctx, {
    runId,
    topic: "workflow",
    level: 3,
    commandId: `cmd-hint-l3-${id}-${locale}`,
  });
  expect(hint.ok).toBe(true);
  if (hint.ok) {
    const body = hint.data.hint[locale];
    expect(body.includes("?") || body.includes("？")).toBe(true);
    expect(body).not.toMatch(/关键发现|Key discovery/i);
    const unit = pack.customerCapsule.disclosureUnits.find((u) => u.topic === "workflow");
    if (unit) {
      for (const token of numericTokens(unit.text[locale])) {
        expect(body.split(/[^\d.]+/)).not.toContain(token);
      }
    }
  }
  const plan = ASK_PLANS[id];
  for (let i = 0; i < plan.length; i++) {
    ok(
      await askCommand(ctx, {
        runId,
        question: plan[i].question,
        stakeholderId: plan[i].stakeholderId,
        commandId: `ask-${i + 1}`,
      }),
    );
  }
  ok(await frameCommand(ctx, { runId, commandId: "frame-1" }));
  ok(await submitBriefCommand(ctx, { runId, brief: brief(), commandId: "brief-1" }));

  const design = await submitDesignCommand(ctx, { runId, proposal: proposal(), commandId: "design-1", seed: 20260823 });
  expect(design.ok).toBe(true);
  if (design.ok) {
    for (const challengeId of design.data.injectedChallengeIds) {
      ok(await respondChallengeCommand(ctx, { runId, response: response(challengeId), commandId: `resp-${challengeId}` }));
    }
  }

  ok(await submitPitchCommand(ctx, { runId, pitch: pitch(), commandId: "pitch-1" }));
  ok(await reviewCommand(ctx, { runId, commandId: "review-1" }));

  const replay = await replayCommand(ctx, { runId, locale });
  expect(replay.ok).toBe(true);
  if (!replay.ok) throw new Error("replay failed");

  const retry = await retryCommand(ctx, { runId, newRunId: `${runId}-child`, commandId: "retry-1" });
  expect(retry.ok).toBe(true);

  const child = await statusCommand(ctx, { runId: `${runId}-child` });
  expect(child.ok).toBe(true);
  if (child.ok) {
    expect(child.data.phase).toBe("DISCOVERY");
    expect(child.data.transcriptCount).toBe(0);
  }

  return replay.data.replay;
}

describe("all-scenarios end-to-end loop (both locales, byte-stable)", () => {
  for (const id of SCENARIOS) {
    for (const locale of ["zh-CN", "en-US"] as const) {
      it(`drives ${id} in ${locale} to a byte-stable, leak-free replay`, async () => {
        const first = await driveJourney(id, makeStore(), locale, `run-${id}-${locale}`);
        const second = await driveJourney(id, makeStore(), locale, `run-${id}-${locale}`);

        // Byte-stable across repeated fixture runs (same locale).
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));

        // The replay is locale-resolved.
        expect(first.locale).toBe(locale);

        // No hidden content reaches the learner replay.
        const pack = compilePack(id);
        const serialized = JSON.stringify(first);
        for (const unit of pack.customerCapsule.disclosureUnits) {
          expect(serialized).not.toContain(unit.text["zh-CN"]);
          expect(serialized).not.toContain(unit.text["en-US"]);
        }
        for (const evidence of pack.evaluatorCapsule.expectedEvidence) {
          expect(serialized).not.toContain(evidence.description["zh-CN"]);
        }
        expect(serialized).not.toContain("关键发现");
        expect(serialized).not.toContain(pack.customerCapsule.canary);
        expect(serialized).not.toContain(pack.evaluatorCapsule.canary);
        for (const key of ["canary", "disclosureUnit", "chainOfThought", "systemPrompt", "rubric"]) {
          expect(serialized).not.toContain(key);
        }

        // A challenge stage was actually exercised (>= 1 injected challenge).
        expect(first.eventInjections.length).toBeGreaterThanOrEqual(1);
        // A review and score completed.
        expect(first.score).not.toBeNull();
      });
    }
  }
});

