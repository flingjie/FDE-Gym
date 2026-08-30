import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { compileScenario } from "../../src/scenarios/compiler.js";
import {
  ScenarioAuthoringSchema,
  type ScenarioAuthoring,
  type CustomerCapsule,
  type EvaluatorCapsule,
  type PublicScenario,
  type ScenarioEventCandidate,
} from "../../src/scenarios/schema.js";
import { FixtureAgentRuntime } from "../../src/agents/fixture-runtime.js";
import {
  askCommand,
  frameCommand,
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
import type {
  ChallengeResponse,
  LocalizedText,
  PitchArtifact,
  ProblemBrief,
  SolutionProposal,
} from "../../src/core/domain.js";

/**
 * Task 13 — cross-scenario calibration suite.
 *
 * For EACH of the five agent scenarios this asserts the complete content
 * contract and a deterministic fixture path:
 *   - >= 3 stakeholders;
 *   - every discovery rubric dimension (the 8 canonical categories) represented
 *     in `expectedEvidence`;
 *   - >= 2 critical contradictions;
 *   - >= 3 deterministic events;
 *   - a complete L1/2/3 hint ladder for every evidence category;
 *   - a 5-stage rubric and at least one pass gate;
 *   - a public-partition leak snapshot (compile, then assert the public JSON
 *     contains none of the hidden facts/canaries);
 *   - a full fixture path Scenario -> Retry whose score is EXACT (deterministic).
 *
 * Score note (documented tolerance): the fixture submissions below are FIXED
 * exemplars, so the fixture score is an exact, reproducible number. For a
 * REAL-model smoke run the same scenario may score within a documented band
 * (say +/-10 points on `final`) because the model's prose varies; that
 * tolerance lives here in this comment, NOT as a loosened assertion — the
 * fixture path stays exact.
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

/** The 8 canonical discovery dimensions the reference scenario defines. */
const DISCOVERY_DIMENSIONS = [
  "workflow",
  "pain",
  "root-cause",
  "business-impact",
  "constraints",
  "success-measures",
  "trust",
  "failure-modes",
] as const;

/** Expected exact `final` score for each scenario's fixed fixture journey. */
const EXPECTED_FINAL: Record<ScenarioId, number> = {
  "enterprise-knowledge-agent": 80,
  "customer-support-agent": 80,
  "data-analysis-agent": 80,
  "document-review-agent": 80,
  "software-engineering-agent": 80,
};

function sourcePath(id: ScenarioId): string {
  return join(process.cwd(), "scenarios", "source", `${id}.yaml`);
}

function compilePack(id: ScenarioId) {
  const compiledRoot = mkdtempSync(join(tmpdir(), "fde-calibration-compiled-"));
  tempDirs.push(compiledRoot);
  return compileScenario(sourcePath(id), "calibration-seed", compiledRoot);
}

function authoring(id: ScenarioId): ScenarioAuthoring {
  return ScenarioAuthoringSchema.parse(parse(readFileSync(sourcePath(id), "utf8")));
}

// ---------------------------------------------------------------------------
// Journey fixtures (fixed exemplars)
// ---------------------------------------------------------------------------

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
      question: "业务怎么问数？代理怎么生成 SQL？",
      stakeholderId: "analytics-lead",
      duId: "du-001",
      reply: text(
        "业务用自然语言对数仓提问，代理会先打 BI 语义层，再写出只读 SQL。",
        "People on the business side query the warehouse in natural language. The agent goes to the BI semantic layer first, then writes read-only SQL.",
      ),
      nodeId: "ev-n1",
      nodeClaim: text("自然语言问数，先语义层再只读 SQL", "Natural-language asks hit the semantic layer, then read-only SQL"),
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
      question: "文档进来后怎么处理到条款抽取？",
      stakeholderId: "doc-ops",
      duId: "du-001",
      reply: text(
        "文件进来后会先解析，或者送进 OCR/视觉模型，然后才抽条款。",
        "Once a file arrives it is parsed, or sent through OCR/VLM, and only then does clause extraction run.",
      ),
      nodeId: "ev-n1",
      nodeClaim: text("进线后先解析或 OCR，再抽条款", "Inbound files are parsed or OCR'd, then clauses are extracted"),
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
      question: "代理怎么改代码并开 PR？",
      stakeholderId: "eng-manager",
      duId: "du-001",
      reply: text(
        "代理在隔离沙箱里拉取 Git 分支、改代码、跑测试，然后通过 PR 接口开评审。",
        "Inside an isolated sandbox the agent checks out a Git branch, edits code, runs tests, and then opens a review through the PR API.",
      ),
      nodeId: "ev-n1",
      nodeClaim: text("沙箱内改代码跑测试再经接口开 PR", "Sandbox edit-test-then-open-PR through the API"),
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

// ---------------------------------------------------------------------------
// Journey driver
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];
function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-calibration-"));
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

interface JourneyResult {
  score: { final: number; [k: string]: unknown };
  childRunId: string;
}

async function driveJourney(id: ScenarioId, baseDir: string, runId: string): Promise<JourneyResult> {
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

  ok(await startCommand(ctx, { runId, scenarioId: id, locale: "zh-CN", commandId: "start" }));
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
  const briefResult = await submitBriefCommand(ctx, { runId, brief: brief(), commandId: "brief-1" });
  expect(briefResult.ok).toBe(true);
  if (briefResult.ok) expect(briefResult.data.passed).toBe(true);

  const design = await submitDesignCommand(ctx, { runId, proposal: proposal(), commandId: "design-1", seed: 20260823 });
  expect(design.ok).toBe(true);
  if (design.ok) {
    for (const challengeId of design.data.injectedChallengeIds) {
      ok(await respondChallengeCommand(ctx, { runId, response: response(challengeId), commandId: `resp-${challengeId}` }));
    }
  }

  ok(await submitPitchCommand(ctx, { runId, pitch: pitch(), commandId: "pitch-1" }));
  const reviewed = await reviewCommand(ctx, { runId, commandId: "review-1" });
  expect(reviewed.ok).toBe(true);
  const retry = await retryCommand(ctx, { runId, newRunId: `${runId}-child`, commandId: "retry-1" });
  expect(retry.ok).toBe(true);

  const child = await statusCommand(ctx, { runId: `${runId}-child` });
  expect(child.ok).toBe(true);
  if (child.ok) {
    expect(child.data.phase).toBe("DISCOVERY");
    expect(child.data.transcriptCount).toBe(0);
  }

  if (!reviewed.ok) throw new Error("review failed");
  return { score: reviewed.data.score as JourneyResult["score"], childRunId: `${runId}-child` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scenario calibration", () => {
  for (const id of SCENARIOS) {
    describe(id, () => {
      it("validates against ScenarioAuthoringSchema and compiles", () => {
        expect(() => authoring(id)).not.toThrow();
        const pack = compilePack(id);
        expect(pack.id).toBe(id);
        expect(pack.schemaVersion).toBe(1);
      });

      it("has at least 3 stakeholders", () => {
        expect(authoring(id).customer.stakeholders.length).toBeGreaterThanOrEqual(3);
      });

      it("represents every discovery rubric dimension in expectedEvidence", () => {
        const categories = authoring(id).evaluator.expectedEvidence.map((e) => e.category);
        for (const dim of DISCOVERY_DIMENSIONS) {
          expect(categories).toContain(dim);
        }
      });

      it("has at least 2 critical contradictions", () => {
        expect(authoring(id).evaluator.criticalContradictions.length).toBeGreaterThanOrEqual(2);
      });

      it("has at least 3 deterministic events", () => {
        expect(authoring(id).events.length).toBeGreaterThanOrEqual(3);
      });

      it("has a complete L1/2/3 hint ladder for every evidence category", () => {
        const doc = authoring(id);
        const ladders = doc.evaluator.hintLadders;
        for (const evidence of doc.evaluator.expectedEvidence) {
          const ladder = ladders.find((l) => l.topic === evidence.category);
          expect(ladder, `missing hint ladder for ${evidence.category}`).toBeDefined();
          if (ladder) {
            for (const level of ["1", "2", "3"] as const) {
              expect(ladder.hints[level]["zh-CN"].length).toBeGreaterThan(0);
              expect(ladder.hints[level]["en-US"].length).toBeGreaterThan(0);
            }
          }
        }
      });

      it("has a 5-stage rubric with weighted criteria and pass gates", () => {
        const doc = authoring(id);
        const stageIds = doc.evaluator.rubric.stages.map((s) => s.id);
        expect(stageIds.sort()).toEqual(["challenge", "framing", "pitch", "process", "solution"]);
        for (const stage of doc.evaluator.rubric.stages) {
          expect(stage.criteria.length).toBeGreaterThan(0);
          for (const criterion of stage.criteria) expect(criterion.weight).toBeGreaterThan(0);
        }
        expect(doc.evaluator.passGates.length).toBeGreaterThanOrEqual(1);
      });

      it("leaks no hidden facts or canaries in the public partition", () => {
        const pack = compilePack(id);
        const publicJson = JSON.stringify(pack.publicScenario);

        // No hidden disclosure-unit text or evidence descriptions.
        for (const unit of pack.customerCapsule.disclosureUnits) {
          expect(publicJson).not.toContain(unit.text["zh-CN"]);
          expect(publicJson).not.toContain(unit.text["en-US"]);
        }
        for (const evidence of pack.evaluatorCapsule.expectedEvidence) {
          expect(publicJson).not.toContain(evidence.description["zh-CN"]);
        }
        // No level-3 hint answers.
        for (const ladder of pack.evaluatorCapsule.hintLadders) {
          expect(publicJson).not.toContain(ladder.hints["3"]["zh-CN"]);
        }
        // No hidden structural keys or canaries.
        for (const key of [
          "canary",
          "disclosureUnit",
          "expectedEvidence",
          "hintLadder",
          "criticalContradiction",
          "rubric",
          "passGate",
          "evidenceId",
          "prerequisites",
        ]) {
          expect(publicJson).not.toContain(key);
        }
        expect(publicJson).not.toContain(pack.customerCapsule.canary);
        expect(publicJson).not.toContain(pack.evaluatorCapsule.canary);
      });

      it("drives a full fixture path Scenario -> Retry with an exact, deterministic score", async () => {
        const first = await driveJourney(id, makeStore(), `run-${id}`);
        const second = await driveJourney(id, makeStore(), `run-${id}`);

        // Exact: the full score breakdown is byte-identical across fixture runs.
        expect(second.score).toEqual(first.score);
        // Exact: the final score matches the documented fixed-exemplar value.
        expect(first.score.final).toBe(EXPECTED_FINAL[id]);
        expect(second.score.final).toBe(EXPECTED_FINAL[id]);
        // Sanity: a fresh child DISCOVERY run was spawned.
        expect(first.childRunId).toBe(`run-${id}-child`);
      });
    });
  }
});
