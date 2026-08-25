import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime.js";
import {
  askCommand,
  clarifyCommand,
  frameCommand,
  hintCommand,
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
} from "../../src/cli/commands.js";
import { loadEvents } from "../../src/core/event-store.js";
import type { CliResult } from "../../src/cli/render.js";
import type { LearnerReplay } from "../../src/replay/projector.js";
import type {
  ChallengeResponse,
  Locale,
  PitchArtifact,
  ProblemBrief,
  SolutionProposal,
} from "../../src/core/domain.js";
import type {
  CustomerCapsule,
  EvaluatorCapsule,
  PublicScenario,
} from "../../src/scenarios/schema.js";

/**
 * Complete CLI-only learner journey (Task 11), driven through the `commands.ts`
 * surface with a deterministic `FixtureAgentRuntime`, in BOTH locales:
 *
 *   start → discovery (ask) → hint → failed brief → clarification →
 *   passed brief → design → challenge → pitch → review → replay → retry →
 *   comparison.
 *
 * Asserts every command returns the `ok:true` envelope, and that the replay is
 * byte-identical across repeated fixture runs and never leaks hidden content.
 */

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CUSTOMER_CANARY = "CUSTOMER_CANARY_7f3a9c1e2b4d";
const EVALUATOR_CANARY = "EVALUATOR_CANARY_9d4f2a7b1c3e";

function scenario(): NonNullable<CommandContext["scenario"]> {
  const publicScenario: PublicScenario = {
    id: "scn-1",
    schemaVersion: 1,
    locale: "zh-CN",
    openingRequest: text("请帮助设计告警优化方案", "Please help design an alert optimization"),
    visibleContext: text("制造企业", "A manufacturer"),
    visibleConstraints: [text("内网部署", "On-premises")],
    deliverables: [text("方案文档", "Design document")],
    learnerRules: [text("12个问题预算", "12-question budget")],
    questionBudget: 12,
  };
  const customer: CustomerCapsule = {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: [
      {
        id: "vp-operations",
        role: text("运营副总裁", "VP of Operations"),
        persona: text("怀疑新技术", "Skeptical of new tech"),
        concerns: [text("停机损失", "Downtime losses")],
        blindSpots: [],
      },
      {
        id: "technical-lead",
        role: text("技术负责人", "Technical Lead"),
        persona: text("熟悉现有系统", "Knows existing systems"),
        concerns: [text("集成", "Integration")],
        blindSpots: [],
      },
    ],
    disclosureUnits: [
      { id: "du-1", topic: "workflow", text: text("每天12000条告警", "12000 alerts daily"), prerequisites: [], evidenceId: "ev-workflow" },
      { id: "du-2", topic: "workflow", text: text("缺乏优先级", "No prioritization"), prerequisites: ["du-1"], evidenceId: "ev-workflow" },
      { id: "du-3", topic: "pain", text: text("40%时间浪费", "40% time wasted"), prerequisites: [], evidenceId: "ev-pain" },
    ],
    responsePolicies: [],
    privateConflicts: [],
    canary: CUSTOMER_CANARY,
  };
  const evaluator: EvaluatorCapsule = {
    id: "scn-1",
    schemaVersion: 1,
    expectedEvidence: [
      { id: "ev-workflow", category: "workflow", description: text("工作流信息", "Workflow info"), weight: 2, disclosureUnitIds: ["du-1", "du-2"] },
      { id: "ev-pain", category: "pain", description: text("痛点信息", "Pain info"), weight: 1, disclosureUnitIds: ["du-3"] },
    ],
    rubric: { stages: [] },
    criticalContradictions: [],
    hintLadders: [
      {
        id: "hl-workflow",
        topic: "workflow",
        hints: {
          "1": text("思考告警处理的起点。", "Think about the start of alert handling."),
          "2": text("关注每日告警量。", "Focus on daily alert volume."),
          "3": text("80%的告警是低价值的。", "80% of alerts are low-value."),
        },
      },
    ],
    passGates: [],
    canary: EVALUATOR_CANARY,
  };
  return {
    public: publicScenario,
    customer,
    evaluator,
    events: [
      {
        id: "event-budget-cut",
        trigger: { kind: "on_stage_enter", phase: "CHALLENGE" },
        prompt: text("【预算更新】本项目预算被削减70%。", "【Budget】The budget is reduced by 70%."),
      },
    ],
  };
}

function fixtures(): Record<string, unknown> {
  const node = (id: string, source: string, zh: string, en: string) => ({
    id,
    kind: "fact",
    claim: text(zh, en),
    status: "active",
    sourceTranscriptIds: [source],
    weight: 1,
    version: 0,
  });
  const patch = (patchId: string, expectedVersion: number, nodes: unknown[]) => ({
    patchId,
    expectedVersion,
    addNodes: nodes,
    addEdges: [],
    invalidateNodeIds: [],
  });
  return {
    "customer:cmd-ask-1:customer": {
      reply: text("每天大约产生12,000条设备告警。", "About 12,000 alerts are generated daily."),
      stakeholderId: "vp-operations",
      disclosedDisclosureUnitIds: ["du-1"],
    },
    "evidence_tracker:cmd-ask-1:evidence": {
      patch: patch("p-1", 0, [node("ev-a", "cmd-ask-1:turn", "每天约12000条告警", "~12000 alerts daily")]),
      questionAssessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
    },
    "customer:cmd-ask-2:customer": {
      reply: text("所有告警都没有优先级排序。", "All alerts lack prioritization."),
      stakeholderId: "technical-lead",
      disclosedDisclosureUnitIds: ["du-2"],
    },
    "evidence_tracker:cmd-ask-2:evidence": {
      patch: patch("p-2", 1, [node("ev-b", "cmd-ask-2:turn", "告警缺乏优先级", "Alerts lack prioritization")]),
      questionAssessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
    },
    "customer:cmd-ask-3:customer": {
      reply: text("工程师40%的时间花在低价值告警上。", "Engineers spend 40% of time on low-value alerts."),
      stakeholderId: "technical-lead",
      disclosedDisclosureUnitIds: ["du-3"],
    },
    "evidence_tracker:cmd-ask-3:evidence": {
      patch: patch("p-3", 2, [node("ev-c", "cmd-ask-3:turn", "40%时间浪费", "40% time wasted")]),
      questionAssessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
    },
    "coach_evaluator:cmd-brief-1:coach": {
      passed: false,
      entailments: [
        { claimId: "claim-automation", entailment: "unsupported" },
        { claimId: "claim-legacy", entailment: "supported" },
      ],
      missingCategories: [],
      unsupportedClaimIds: ["claim-automation"],
      feedback: text("自动化论断缺乏事实证据。", "The automation claim lacks factual evidence."),
    },
    "coach_evaluator:cmd-brief-2:coach": {
      passed: true,
      entailments: [{ claimId: "claim-pain", entailment: "supported" }],
      missingCategories: [],
      unsupportedClaimIds: [],
      feedback: text("通过。", "Pass."),
    },
    "coach_evaluator:cmd-review-1:coach": {
      verdict: "pass",
      strengths: [text("清晰的问题定义", "Clear problem framing")],
      weaknesses: [text("假设未验证", "Assumptions unverified")],
      missedOpportunities: [text("未追问根因", "Did not probe root cause")],
      decisionDivergencePoints: [{ id: "ddp-1", description: text("变更而非保留", "Changed rather than kept") }],
      nextFocus: [text("强化证据支撑", "Strengthen evidence support"), text("处理信任问题", "Address trust")],
    },
  };
}

function brief1(): ProblemBrief {
  return {
    id: "brief-1",
    problemStatement: text("告警处理低效", "Inefficient alerts"),
    goal: text("降低告警处理负担", "Reduce alert burden"),
    constraints: [text("内网部署", "On-premises")],
    claims: [
      {
        id: "claim-automation",
        statement: text("自动化可削减一半工作量", "Automation can halve workload"),
        weight: "critical",
        evidenceIds: ["ev-a"],
      },
      {
        id: "claim-legacy",
        statement: text("现有流程缺乏优先级", "Current process lacks prioritization"),
        weight: "major",
        evidenceIds: ["ev-b"],
      },
    ],
    successMeasures: [text("削减50%工作量", "Cut 50% workload")],
    unknowns: [text("集成复杂度", "Integration complexity")],
    contradictions: [],
  };
}

function brief2(): ProblemBrief {
  return {
    id: "brief-2",
    problemStatement: text("告警处理低效", "Inefficient alerts"),
    goal: text("降低告警处理负担", "Reduce alert burden"),
    constraints: [text("内网部署", "On-premises")],
    claims: [
      {
        id: "claim-pain",
        statement: text("40%时间浪费在低价值告警", "40% of time wasted on low-value alerts"),
        weight: "major",
        evidenceIds: ["ev-c"],
      },
    ],
    successMeasures: [text("削减50%工作量", "Cut 50% workload")],
    unknowns: [text("集成复杂度", "Integration complexity")],
    contradictions: [],
  };
}

function proposal(): SolutionProposal {
  return {
    id: "proposal-1",
    objective: text("降低告警处理负担", "Reduce alert burden"),
    approach: text("分层AI告警分类", "Tiered AI classification"),
    approachEvidenceIds: ["ev-b"],
    assumptions: [text("规则可替换", "Rules replaceable")],
    alternatives: [{ id: "alt-1", description: text("外包", "Outsource"), tradeoff: text("成本高", "Costly") }],
    tradeoffs: [text("集成复杂度", "Integration complexity")],
    risks: [{ id: "risk-1", description: text("误报", "False positives"), mitigation: text("阈值调优", "Threshold tuning") }],
    validationPlan: [text("六周试点", "Six-week pilot")],
    rolloutPlan: [text("分阶段上线", "Phased rollout")],
    decisions: [{ id: "dec-1", decision: text("本地部署", "On-premises"), rationale: text("符合内网要求", "Meets VPC"), evidenceIds: ["ev-b"] }],
  };
}

function response(): ChallengeResponse {
  return {
    id: "resp-1",
    challengeId: "event-budget-cut",
    impact: text("预算削减70%", "70% budget cut"),
    decision: "change",
    rationale: text("缩小方案范围", "Narrow scope"),
    newRiskOrValidation: text("增加成本验证", "Add cost validation"),
  };
}

function pitch(): PitchArtifact {
  return {
    id: "pitch-1",
    audience: text("管理层", "Leadership"),
    problem: text("告警处理低效", "Inefficient alerts"),
    recommendation: text("分层AI分类", "Tiered AI classification"),
    expectedValue: text("削减50%工作量", "Cut 50% workload"),
    evidenceIds: ["ev-b"],
    risks: [text("误报率", "False positive rate")],
    ask: text("批准六周试点", "Approve six-week pilot"),
    nextSteps: [text("组建试点团队", "Form pilot team")],
  };
}

let tempDirs: string[] = [];
function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-cli-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tempDirs = [];
});

function mustOk<T>(result: CliResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.data;
}

interface JourneyResult {
  replay: LearnerReplay;
  childRunId: string;
}

async function driveJourney(baseDir: string, locale: Locale, runId: string): Promise<JourneyResult> {
  const runtime = new FixtureAgentRuntime({ fixtures: fixtures() });
  const ctx: CommandContext = { runtime, baseDir, scenario: scenario() };

  mustOk(await startCommand(ctx, { runId, scenarioId: "scn-1", locale, commandId: "cmd-start" }));

  mustOk(await askCommand(ctx, { runId, question: "每天产生多少条告警？", stakeholderId: "vp-operations", commandId: "cmd-ask-1" }));
  mustOk(await askCommand(ctx, { runId, question: "告警有优先级吗？", stakeholderId: "technical-lead", commandId: "cmd-ask-2" }));
  mustOk(await hintCommand(ctx, { runId, topic: "workflow", level: 1, commandId: "cmd-hint-1" }));

  mustOk(await frameCommand(ctx, { runId, commandId: "cmd-frame-1" }));
  const failedBrief = mustOk(await submitBriefCommand(ctx, { runId, brief: brief1(), commandId: "cmd-brief-1" }));
  expect(failedBrief.passed).toBe(false);

  mustOk(await clarifyCommand(ctx, { runId, commandId: "cmd-clarify-1" }));
  mustOk(await askCommand(ctx, { runId, question: "工程师的时间花在哪里？", stakeholderId: "technical-lead", commandId: "cmd-ask-3" }));
  mustOk(await frameCommand(ctx, { runId, commandId: "cmd-frame-2" }));
  const passedBrief = mustOk(await submitBriefCommand(ctx, { runId, brief: brief2(), commandId: "cmd-brief-2" }));
  expect(passedBrief.passed).toBe(true);

  mustOk(await submitDesignCommand(ctx, { runId, proposal: proposal(), commandId: "cmd-design-1", seed: 20260823 }));
  mustOk(await respondChallengeCommand(ctx, { runId, response: response(), commandId: "cmd-resp-1" }));
  mustOk(await submitPitchCommand(ctx, { runId, pitch: pitch(), commandId: "cmd-pitch-1" }));

  const reviewed = mustOk(await reviewCommand(ctx, { runId, commandId: "cmd-review-1" }));
  expect(reviewed.score).toBeDefined();
  expect(reviewed.review.verdict).toBe("pass");

  const replay = mustOk(await replayCommand(ctx, { runId, locale }));

  const retry = mustOk(await retryCommand(ctx, { runId, newRunId: `${runId}-child`, commandId: "cmd-retry-1" }));
  expect(retry.runId).toBe(`${runId}-child`);

  // Comparison: the child is a fresh DISCOVERY run with no prior transcript.
  const childStatus = mustOk(await statusCommand(ctx, { runId: `${runId}-child` }));
  expect(childStatus.phase).toBe("DISCOVERY");
  expect(childStatus.transcriptCount).toBe(0);

  return { replay: replay.replay, childRunId: `${runId}-child` };
}

describe("CLI learner journey (both locales)", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    it(`drives the complete journey and produces a byte-stable replay in ${locale}`, async () => {
      const first = await driveJourney(makeStore(), locale, `run-${locale}`);
      const second = await driveJourney(makeStore(), locale, `run-${locale}`);

      // Byte-identical replay across repeated fixture runs.
      expect(JSON.stringify(first.replay)).toBe(JSON.stringify(second.replay));

      // The replay is locale-resolved and never leaks hidden content.
      const serialized = JSON.stringify(first.replay);
      expect(serialized).not.toContain("du-1");
      expect(serialized).not.toContain("du-2");
      expect(serialized).not.toContain("du-3");
      expect(serialized).not.toContain(CUSTOMER_CANARY);
      expect(serialized).not.toContain(EVALUATOR_CANARY);
      expect(serialized).not.toContain("chainOfThought");
    });
  }
});

describe("CLI evidence repair and clarification budget", () => {
  it("blocks frame on pending evidence and clears it through repair", async () => {
    const baseDir = makeStore();
    const fx: Record<string, unknown> = {
      "customer:cmd-repair-ask:customer": {
        reply: text("工程师40%的时间花在低价值告警上。", "Engineers spend 40% of time on low-value alerts."),
        stakeholderId: "technical-lead",
        disclosedDisclosureUnitIds: ["du-3"],
      },
      // Intentionally NO evidence_tracker fixture for cmd-repair-ask:evidence yet.
    };
    const runtime = new FixtureAgentRuntime({ fixtures: fx });
    const ctx: CommandContext = { runtime, baseDir, scenario: scenario() };

    mustOk(await startCommand(ctx, {
      runId: "run-repair",
      scenarioId: "scn-1",
      locale: "zh-CN",
      commandId: "cmd-start",
    }));

    const asked = mustOk(await askCommand(ctx, {
      runId: "run-repair",
      question: "工程师的时间花在哪里？",
      stakeholderId: "technical-lead",
      commandId: "cmd-repair-ask",
    }));
    expect(asked.pendingEvidence).toEqual({ code: "EVIDENCE_EXTRACTION_FAILED" });

    // frame is blocked while evidence is pending.
    const blocked = await frameCommand(ctx, { runId: "run-repair", commandId: "cmd-frame-blocked" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("FRAME_BLOCKED");

    // The persisted failure event carries ONLY turnId + stable code, never the message.
    const recorded = await loadEvents("run-repair", { baseDir });
    const pendingRecord = recorded.find((event) => event.type === "evidence.pending");
    expect(pendingRecord).toBeDefined();
    expect(pendingRecord).toHaveProperty("turnId", "cmd-repair-ask:turn");
    expect(pendingRecord).toHaveProperty("failureCode", "EVIDENCE_EXTRACTION_FAILED");
    expect(pendingRecord).not.toHaveProperty("message");
    expect(pendingRecord).not.toHaveProperty("error");

    // Provide the missing tracker fixture and repair.
    fx["evidence_tracker:cmd-repair-ask:evidence"] = {
      patch: {
        patchId: "p-repair",
        expectedVersion: 0,
        addNodes: [
          {
            id: "ev-repair",
            kind: "fact",
            claim: text("40%时间浪费", "40% time wasted"),
            status: "active",
            sourceTranscriptIds: ["cmd-repair-ask:turn"],
            weight: 1,
            version: 0,
          },
        ],
        addEdges: [],
        invalidateNodeIds: [],
      },
      questionAssessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
    };

    const repaired = mustOk(await repairEvidenceCommand(ctx, {
      runId: "run-repair",
      commandId: "cmd-repair-fix",
    }));
    expect(repaired.pendingEvidence).toBeNull();
    expect(repaired.composite).not.toBeNull();

    // frame now succeeds.
    const framed = mustOk(await frameCommand(ctx, { runId: "run-repair", commandId: "cmd-frame-ok" }));
    expect(framed.phase).toBe("PROBLEM_FRAMING");
  });

  it("never leaks the distinct internal failure code through the ask result", async () => {
    const baseDir = makeStore();
    // A schema-valid tracker output that still trips the leak guard by embedding
    // the hidden customer canary inside a claim value. The tracker fails with
    // LEAK_GUARD_TRIGGERED — a distinct internal code that must NOT reach the
    // learner-visible `ask` result.
    const fx: Record<string, unknown> = {
      "customer:cmd-leak-ask:customer": {
        reply: text("工程师40%的时间花在低价值告警上。", "Engineers spend 40% of time on low-value alerts."),
        stakeholderId: "technical-lead",
        disclosedDisclosureUnitIds: ["du-3"],
      },
      "evidence_tracker:cmd-leak-ask:evidence": {
        patch: {
          patchId: "p-leak",
          expectedVersion: 0,
          addNodes: [
            {
              id: "ev-leak",
              kind: "fact",
              claim: text(`泄漏 ${CUSTOMER_CANARY}`, `leak ${CUSTOMER_CANARY}`),
              status: "active",
              sourceTranscriptIds: ["cmd-leak-ask:turn"],
              weight: 1,
              version: 0,
            },
          ],
          addEdges: [],
          invalidateNodeIds: [],
        },
        questionAssessment: { intentCount: 1, atomicity: 1, neutrality: 1, relevance: 1, redundancy: 0 },
      },
    };
    const runtime = new FixtureAgentRuntime({ fixtures: fx });
    const ctx: CommandContext = { runtime, baseDir, scenario: scenario() };

    mustOk(await startCommand(ctx, {
      runId: "run-leak",
      scenarioId: "scn-1",
      locale: "zh-CN",
      commandId: "cmd-start",
    }));

    const asked = mustOk(await askCommand(ctx, {
      runId: "run-leak",
      question: "工程师的时间花在哪里？",
      stakeholderId: "technical-lead",
      commandId: "cmd-leak-ask",
    }));

    expect(asked.pendingEvidence).toEqual({ code: "EVIDENCE_EXTRACTION_FAILED" });
    expect(asked.pendingEvidence).not.toEqual({ code: "LEAK_GUARD_TRIGGERED" });
  });

  it("persists the clarification budget across separate CLI calls", async () => {
    const baseDir = makeStore();
    const runtime = new FixtureAgentRuntime({ fixtures: fixtures() });
    const ctx: CommandContext = { runtime, baseDir, scenario: scenario() };

    mustOk(await startCommand(ctx, {
      runId: "run-budget",
      scenarioId: "scn-1",
      locale: "zh-CN",
      commandId: "cmd-start",
    }));

    // Three clarification round-trips consume the budget of 3.
    for (let i = 1; i <= 3; i++) {
      mustOk(await frameCommand(ctx, { runId: "run-budget", commandId: `cmd-frame-${i}` }));
      mustOk(await clarifyCommand(ctx, { runId: "run-budget", commandId: `cmd-clarify-${i}` }));
    }

    // The fourth clarify (after reload) exceeds the persisted budget.
    mustOk(await frameCommand(ctx, { runId: "run-budget", commandId: "cmd-frame-4" }));
    const exceeded = await clarifyCommand(ctx, { runId: "run-budget", commandId: "cmd-clarify-4" });
    expect(exceeded.ok).toBe(false);
    if (!exceeded.ok) expect(exceeded.code).toBe("CLARIFICATION_BUDGET_EXCEEDED");
  });
});
