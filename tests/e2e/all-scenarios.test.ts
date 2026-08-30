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
 * Drives each of the five agent scenarios through the COMPLETE fixture loop
 * (Scenario -> Discovery -> framing -> solution -> challenge -> pitch ->
 * review -> retry) in BOTH locales and asserts the learner replay is
 * byte-stable across repeated runs and never leaks hidden content.
 */

const text = (zh: string, en: string): LocalizedText => ({ "zh-CN": zh, "en-US": en });

const SCENARIOS = [
  "enterprise-knowledge-agent",
  "customer-support-agent",
  "data-analysis-agent",
  "document-review-agent",
  "software-engineering-agent",
] as const;
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
  "enterprise-knowledge-agent": [
    {
      question: "员工提问后，代理按什么顺序检索？答案常从哪来？",
      stakeholderId: "knowledge-lead",
      duId: "du-001",
      reply: text(
        "提问之后，代理会先走文档索引，再核对 ACL 目录。大约六成回答落在过期 wiki 上。",
        "Once someone asks, the agent queries the document index first, then checks the ACL directory. Roughly 60 percent of answers come from the stale wiki.",
      ),
      nodeId: "ev-n1",
      nodeClaim: text("检索先索引再核 ACL，多数答案来自过期 wiki", "Retrieval hits index then ACL; most answers come from the stale wiki"),
    },
    {
      question: "员工要问几个人才能拿到业务答案？越权命中怎样？",
      stakeholderId: "frontline-user",
      duId: "du-003",
      reply: text(
        "一线经常要连续问好几位同事才拿得到业务答案，越权命中大概在百分之八。",
        "Frontline staff often ask several colleagues in a row before they get a business answer, and unauthorized hits sit around eight percent.",
      ),
      nodeId: "ev-n2",
      nodeClaim: text("问多人才能拿到答案，存在越权命中", "Several people must be asked; unauthorized hits occur"),
    },
    {
      question: "不确定时，代理会怎样处理引用？",
      stakeholderId: "iam-security",
      duId: "du-015",
      reply: text("一旦没把握，代理就会捏造出处。", "If it is unsure, the agent invents citations."),
      nodeId: "ev-n3",
      nodeClaim: text("没把握时会捏造出处", "Uncertainty leads to invented citations"),
    },
  ],
  "customer-support-agent": [
    {
      question: "代理怎么调工具？每月多少工单能闭环？",
      stakeholderId: "support-director",
      duId: "du-001",
      reply: text(
        "工具调用顺序是先 CRM、再订单接口。每月大概十八万张工单，大约五成五能在工具闭环里结掉。",
        "Tool order is CRM first, then the order API. Volume is roughly 180 thousand tickets a month, and about fifty-five percent can close inside a tool loop.",
      ),
      nodeId: "ev-n1",
      nodeClaim: text("先 CRM 再订单接口，大量工单可工具闭环", "CRM then order API; a large share can close in a tool loop"),
    },
    {
      question: "人工成本占支持预算多少？一线流失怎样？",
      stakeholderId: "cfo",
      duId: "du-003",
      reply: text(
        "劳动力大约占支持预算的七成二，一线年流失大概百分之三十八。",
        "Labor is roughly seventy-two percent of the support budget, and frontline annual attrition is around thirty-eight percent.",
      ),
      nodeId: "ev-n2",
      nodeClaim: text("人工成本主导预算，一线流失高", "Labor dominates the budget; frontline attrition is high"),
    },
    {
      question: "不确定时会不会乱调退款接口？",
      stakeholderId: "compliance-officer",
      duId: "du-015",
      reply: text(
        "没把握时会编造退款口径，并且真去打退款接口。",
        "When it lacks certainty it invents a refund policy and actually invokes the refund API.",
      ),
      nodeId: "ev-n3",
      nodeClaim: text("不确定时会编造退款口径并真去调用", "Uncertainty invents refund policy and fires the refund API"),
    },
  ],
  "data-analysis-agent": [
    {
      question: "生成的 SQL 是谁执行的？行级安全按谁的账号算？",
      stakeholderId: "analytics-lead",
      duId: "du-001",
      reply: text(
        "代理自己从不跑语句，只把 SQL 交给分析师代跑，所以行级安全是按分析师账号展开的，提问者本人的权限从头到尾都没进来。",
        "The agent never runs the statement itself. It hands the SQL to an analyst, so row-level security unfolds against that analyst's account and the person who asked never contributes their own permissions.",
      ),
      nodeId: "ev-n1",
      nodeClaim: text("SQL 由分析师代跑，行级安全绑在分析师账号上", "An analyst runs the SQL, so RLS binds to the analyst's account"),
    },
    {
      question: "错误查询出过什么泄漏？",
      stakeholderId: "privacy-officer",
      duId: "du-003",
      reply: text(
        "曾经有一次坏查询打出大约两万四千行，里面带着手机号。",
        "A single bad query once dumped around twenty-four thousand rows that included mobile numbers.",
      ),
      nodeId: "ev-n2",
      nodeClaim: text("坏查询曾打出带手机号的明细", "A bad query once dumped detail rows with mobile numbers"),
    },
    {
      question: "JOIN 写错会怎样？",
      stakeholderId: "platform-dba",
      duId: "du-015",
      reply: text(
        "JOIN 写错时，会把本不该关联的用户表拼进来。",
        "A mistaken JOIN can stitch in a user table that was never supposed to be joined.",
      ),
      nodeId: "ev-n3",
      nodeClaim: text("错误 JOIN 会拼进不该关联的用户表", "A wrong JOIN stitches in a user table that should not join"),
    },
  ],
  "document-review-agent": [
    {
      question: "非标合同上，主数据比对和规则检查谁先跑？对不上的件去哪？",
      stakeholderId: "doc-ops",
      duId: "du-001",
      reply: text(
        "碰到不合模板的合同，主数据比对会先跑，规则检查要等比对结果回来才补。对不上的件就退回人工那边重新排队。",
        "On contracts that do not fit the templates, the master-data match runs first and the rule check only gets backfilled after that result lands. Files the match cannot line up are sent back into a manual re-queue.",
      ),
      nodeId: "ev-n1",
      nodeClaim: text("非标件先比对主数据，对不上的退回人工重排队", "Off-template files match master data first; mismatches go to a manual re-queue"),
    },
    {
      question: "审核积压对法务和业务有什么影响？抽查漏条款怎样？",
      stakeholderId: "business-owner",
      duId: "du-003",
      reply: text(
        "律师和业务都卡在审核队列上，抽查大概漏掉百分之九的条款。",
        "Both counsel and the business sit waiting on review, and spot checks miss roughly nine percent of clauses.",
      ),
      nodeId: "ev-n2",
      nodeClaim: text("法务与业务都在等审核，抽查会漏条款", "Counsel and business wait on review; spot checks miss clauses"),
    },
    {
      question: "代理会漏掉关键条款吗？",
      stakeholderId: "counsel",
      duId: "du-015",
      reply: text("关键条款经常被漏抽。", "Material clauses get skipped."),
      nodeId: "ev-n3",
      nodeClaim: text("关键条款会被漏抽", "Material clauses get skipped in extraction"),
    },
  ],
  "software-engineering-agent": [
    {
      question: "沙箱里跑的检查和 PR 之后重跑的是同一套吗？",
      stakeholderId: "eng-manager",
      duId: "du-001",
      reply: text(
        "沙箱只跑裁剪过的本地测试，完整流水线要等 PR 开出来才在另一套环境里重跑，所以沙箱绿了流水线不一定绿。",
        "The sandbox only runs a trimmed local suite. The full pipeline waits until the PR is open and then re-runs in a different environment, so a green sandbox often is not a green pipeline.",
      ),
      nodeId: "ev-n1",
      nodeClaim: text("沙箱绿不等于流水线绿，完整套件要等 PR 后重跑", "Sandbox-green is not pipeline-green; the full suite re-runs after the PR"),
    },
    {
      question: "绿测 PR 被 revert 的比例怎样？",
      stakeholderId: "qa-lead",
      duId: "du-003",
      reply: text(
        "绿测 PR 里大约有一成五后来被 revert。",
        "Roughly fifteen percent of PRs that passed tests later get reverted.",
      ),
      nodeId: "ev-n2",
      nodeClaim: text("一部分绿测 PR 随后被撤回", "A share of green-test PRs later get reverted"),
    },
    {
      question: "曾经有没有把秘密写进 PR？",
      stakeholderId: "platform-security",
      duId: "du-016",
      reply: text("发生过一次把 token 写进 PR 描述的事故。", "There was an incident where a token was written into a PR description."),
      nodeId: "ev-n3",
      nodeClaim: text("token 曾被写进 PR 描述", "A token was once written into a PR description"),
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
        expect(numericTokens(body)).not.toContain(token);
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

