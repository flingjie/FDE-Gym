import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDirectModelConfig } from "../../src/integrations/direct/config.js";
import { DirectModelRuntime } from "../../src/integrations/direct/direct-runtime.js";
import {
  askCommand,
  frameCommand,
  replayCommand,
  respondChallengeCommand,
  reviewCommand,
  startCommand,
  submitBriefCommand,
  submitDesignCommand,
  submitPitchCommand,
  type CommandContext,
} from "../../src/cli/commands.js";
import { loadEvents } from "../../src/core/event-store.js";
import { defaultCompiledRoot, loadScenarioBundle } from "../../src/scenarios/bundle.js";
import type { CliResult } from "../../src/cli/render.js";
import type {
  ChallengeResponse,
  Locale,
  LocalizedText,
  PitchArtifact,
  ProblemBrief,
  SolutionProposal,
} from "../../src/core/domain.js";

/**
 * Task 1 (Phase 3c) — gated real-model contract suite.
 *
 * Drives the FULL learner pipeline (`start → ask → frame → submitBrief →
 * submitDesign → respondChallenge → submitPitch → review → replay`) against a
 * real `DirectModelRuntime` (the `FDE_GYM_MODEL_BASE_URL`/`FDE_GYM_MODEL`
 * endpoint, or the Codex `~/.codex/config.toml` it falls back to) and asserts
 * the learner-facing contract STRUCTURALLY — never specific scores:
 *
 *   1. Pipeline succeeds  — every `mustOk` unwrap asserts `ok === true`.
 *   2. Role outputs schema-valid — any `AGENT_OUTPUT_MALFORMED` would surface
 *      as `ok:false` above (asserted); the `*Data` fields are also parsed.
 *   3. No hidden leakage — serialized envelopes never contain the canary, any
 *      disclosure-unit id, `expectedEvidence`, `chainOfThought`, or `rubric`.
 *   4. Byte-stable replay — `replayCommand` twice yields identical JSON.
 *   5. Fully-provenanced score — the `review` result carries
 *      `score`/`stageStates`/`measuredCapability`/`confidence`, and the
 *      committed `score.computed` provenance carries a 64-hex `comparabilityKey`,
 *      a `promptSetDigest`, a `runtimePolicyVersion`, and a `modelId`.
 *
 * Gated by `describe.skipIf(!configured)`: when no model endpoint is
 * configured the suite SKIPS (never fails), so it is not a release-gate or CI
 * blocker. When an endpoint IS configured the suite runs; the assertions are
 * structural, so any failure is a model-behavior note rather than a contract
 * violation of this repo's own code.
 */

const config = resolveDirectModelConfig();
const configured = config !== null;

const SCENARIO_ID = "customer-support-agent";
const LOCALE: Locale = "zh-CN";

const text = (zh: string, en: string): LocalizedText => ({ "zh-CN": zh, "en-US": en });

/** Discovery questions targeting disclosure units the Coach can ground the brief on. */
const ASK_PLAN: ReadonlyArray<{ question: string; stakeholderId: string }> = [
  { question: "代理怎么调工具？每月多少工单能闭环？", stakeholderId: "support-director" },
  { question: "人工成本占支持预算多少？一线流失怎样？", stakeholderId: "cfo" },
  { question: "不确定时会不会乱调退款接口？", stakeholderId: "compliance-officer" },
];

function proposal(factIds: readonly string[]): SolutionProposal {
  return {
    id: "proposal-1",
    objective: text("降低客服处理负担", "Reduce support handling burden"),
    approach: text("分层工具闭环代理", "Tiered tool-loop agent"),
    approachEvidenceIds: [...factIds],
    assumptions: [text("现有系统可改造", "Existing systems can be adapted")],
    alternatives: [
      { id: "alt-1", description: text("FAQ 机器人", "FAQ bot"), tradeoff: text("无法调业务接口", "Cannot call business APIs") },
    ],
    tradeoffs: [text("集成复杂度", "Integration complexity")],
    risks: [
      { id: "risk-1", description: text("误报", "False positives"), mitigation: text("阈值调优", "Threshold tuning") },
    ],
    validationPlan: [text("试点验证", "Pilot validation")],
    rolloutPlan: [text("分阶段上线", "Phased rollout")],
    decisions: [
      {
        id: "dec-1",
        decision: text("渐进引入", "Incremental adoption"),
        rationale: text("降低风险", "Lower risk"),
        evidenceIds: [...factIds],
      },
    ],
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

function pitch(factIds: readonly string[]): PitchArtifact {
  return {
    id: "pitch-1",
    audience: text("管理层", "Leadership"),
    problem: text("客服流程低效", "Inefficient support process"),
    recommendation: text("分层工具闭环", "Tiered tool loop"),
    expectedValue: text("削减人力成本", "Cut labor cost"),
    evidenceIds: [...factIds],
    risks: [text("工具超时", "Tool timeouts")],
    ask: text("批准试点", "Approve the pilot"),
    nextSteps: [text("组建团队", "Form the team")],
  };
}

let tempDirs: string[] = [];
function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-real-model-"));
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
  if (!result.ok) {
    // Surface the stable failure code so a model-dependent failure is diagnosable
    // (AGENT_OUTPUT_MALFORMED, AGENT_TIMEOUT, INVALID_PHASE_COMMAND, …) rather
    // than a bare `false`.
    expect(result.ok, `command failed with code=${result.code}: ${result.message}`).toBe(true);
    throw new Error("unreachable");
  }
  return result.data;
}

describe.skipIf(!configured)("real-model contract", () => {
  it(
    "drives the full pipeline against DirectModelRuntime and satisfies the learner contract",
    { timeout: 600_000 },
    async () => {
      if (!config) throw new Error("unreachable: suite is gated on a configured model");

      const baseDir = makeStore();
      const bundle = loadScenarioBundle(SCENARIO_ID, { compiledRoot: defaultCompiledRoot() });
      const ctx: CommandContext = {
        runtime: new DirectModelRuntime(config),
        baseDir,
        scenario: {
          public: bundle.publicScenario,
          customer: bundle.customerCapsule,
          evaluator: bundle.evaluatorCapsule,
          events: [...bundle.eventCandidates],
        },
      };

      const runId = "run-real-model";

      // Every learner-facing serialized envelope, for the leak assertions.
      const envelopes: string[] = [];
      async function run<T>(pending: Promise<CliResult<T>>): Promise<T> {
        const result = await pending;
        const data = mustOk(result);
        envelopes.push(JSON.stringify(result));
        return data;
      }

      // 1. Pipeline: start -> discovery -> framing -> design -> challenge -> pitch -> review.
      await run(startCommand(ctx, { runId, scenarioId: SCENARIO_ID, locale: LOCALE, commandId: "cmd-start" }));

      const firstAsk = await run(
        askCommand(ctx, {
          runId,
          question: ASK_PLAN[0].question,
          stakeholderId: ASK_PLAN[0].stakeholderId,
          commandId: "cmd-ask-1",
        }),
      );
      // 2. Schema-valid role output: the customer reply is a real localized string.
      expect(firstAsk.customerReply["zh-CN"].length).toBeGreaterThan(0);

      for (let i = 1; i < ASK_PLAN.length; i++) {
        await run(
          askCommand(ctx, {
            runId,
            question: ASK_PLAN[i].question,
            stakeholderId: ASK_PLAN[i].stakeholderId,
            commandId: `cmd-ask-${i + 1}`,
          }),
        );
      }
      await run(frameCommand(ctx, { runId, commandId: "cmd-frame" }));

      // Build the brief from the evidence the model's tracker actually committed,
      // so its claim evidence ids resolve (the structural gate requires it). The
      // claim statement mirrors the extracted fact so the Coach can judge it
      // "supported". This is harness bookkeeping, not a contract assertion.
      const committed = await loadEvents(runId, { baseDir });
      const patched = committed.filter((event) => event.type === "evidence.patched");
      const factNodes = patched.flatMap((event) => event.patch.addNodes).filter((node) => node.kind === "fact");
      const contradictionNodes = patched
        .flatMap((event) => event.patch.addNodes)
        .filter((node) => node.kind === "contradiction" && node.status === "active");

      expect(factNodes.length).toBeGreaterThan(0);
      const factIds = factNodes.map((node) => node.id);
      const firstFact = factNodes[0];

      const brief: ProblemBrief = {
        id: "brief-1",
        problemStatement: text("当前客服代理流程存在效率与合规风险", "The current support-agent process has efficiency and compliance risks"),
        goal: text("设计一个兼顾质量、延迟与成本的客服代理", "Design a support agent balancing quality, latency, and cost"),
        constraints: [text("敏感写操作须人工确认", "Sensitive writes require human confirmation")],
        claims: [{ id: "claim-1", statement: firstFact.claim, weight: "major", evidenceIds: [firstFact.id] }],
        successMeasures: [text("首响与人工成本显著下降", "First-response and labor cost drop significantly")],
        unknowns: [text("工具超时的人工插队规则", "The human jump-the-queue rule on tool timeout")],
        contradictions: contradictionNodes.map((node, i) => ({
          id: `contra-${i + 1}`,
          statement: node.claim,
          evidenceIds: [node.id],
          disposition: "resolved" as const,
        })),
      };
      await run(submitBriefCommand(ctx, { runId, brief, commandId: "cmd-brief" }));

      const design = await run(
        submitDesignCommand(ctx, { runId, proposal: proposal(factIds), commandId: "cmd-design", seed: 20260823 }),
      );
      for (const challengeId of design.injectedChallengeIds) {
        await run(
          respondChallengeCommand(ctx, { runId, response: response(challengeId), commandId: `cmd-resp-${challengeId}` }),
        );
      }
      // With zero injected challenges the run still needs one respond-challenge to
      // advance CHALLENGE -> PITCH (the mandatory-challenge gate is vacuous there).
      if (design.injectedChallengeIds.length === 0) {
        await run(respondChallengeCommand(ctx, { runId, response: response("noop"), commandId: "cmd-resp-noop" }));
      }

      await run(submitPitchCommand(ctx, { runId, pitch: pitch(factIds), commandId: "cmd-pitch" }));

      // 5a. Fully-provenanced score: the review result carries all four figures.
      const reviewed = await run(reviewCommand(ctx, { runId, commandId: "cmd-review" }));
      expect(reviewed).toHaveProperty("score");
      expect(reviewed).toHaveProperty("stageStates");
      expect(reviewed).toHaveProperty("measuredCapability");
      expect(reviewed).toHaveProperty("confidence");

      // 4. Byte-stable replay: replay is a projection of committed events, so a
      // second replay of the same run is byte-identical (never re-invokes the model).
      const replay1 = await run(replayCommand(ctx, { runId, locale: LOCALE }));
      const replay2 = await run(replayCommand(ctx, { runId, locale: LOCALE }));
      expect(JSON.stringify(replay1)).toBe(JSON.stringify(replay2));

      // 3. No hidden leakage in any learner-facing envelope.
      const forbidden = [
        bundle.customerCapsule.canary,
        bundle.evaluatorCapsule.canary,
        ...bundle.customerCapsule.disclosureUnits.map((unit) => unit.id),
        "expectedEvidence",
        "chainOfThought",
        "rubric",
      ];
      for (const envelope of envelopes) {
        for (const token of forbidden) {
          expect(envelope).not.toContain(token);
        }
      }

      // 5b. The committed score.computed provenance carries a full comparability identity.
      const afterReview = await loadEvents(runId, { baseDir });
      const scoreEvent = afterReview.find((event) => event.type === "score.computed");
      expect(scoreEvent).toBeDefined();
      if (scoreEvent && scoreEvent.type === "score.computed") {
        expect(scoreEvent.provenance.comparabilityKey).toMatch(/^[0-9a-f]{64}$/);
        expect(scoreEvent.provenance.promptSetDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(scoreEvent.provenance.runtimePolicyVersion).toBeGreaterThan(0);
        expect(scoreEvent.provenance.modelId).toBe(config.model);
      }
    },
  );
});
