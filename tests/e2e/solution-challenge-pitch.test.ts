import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRng } from "../../src/simulation/rng";
import {
  prepareChallengeInjection,
  preparePitch,
  prepareRespondToChallenge,
  prepareSolutionDesign,
} from "../../src/core/orchestrator";
import { loadRun } from "../../src/core/event-store";
import { commitPrepared } from "../helpers/commit-prepared";
import type { RunAggregate } from "../../src/core/aggregate";
import type { CustomerCapsule, ScenarioEventCandidate } from "../../src/scenarios/schema";
import type { ChallengeResponse, PitchArtifact, SolutionProposal } from "../../src/core/domain";

const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });

const CANARY = "CUSTOMER_CANARY_SECRET_8c2e1f4a";

function customerCapsule(): CustomerCapsule {
  return {
    id: "scn-1",
    schemaVersion: 1,
    stakeholders: [
      {
        id: "vp-operations",
        role: text("运营副总裁", "VP of Operations"),
        persona: text("对新技术持怀疑态度的运营负责人", "Skeptical operations lead"),
        concerns: [text("投资回报", "ROI")],
        blindSpots: [],
      },
    ],
    disclosureUnits: [
      {
        id: "du-pain",
        topic: "pain",
        text: text("停机损失", "Downtime losses"),
        prerequisites: [],
        evidenceId: "ev-pain",
      },
      {
        id: "du-trust",
        topic: "trust",
        text: text("工程师不信任AI", "Engineers distrust AI"),
        prerequisites: [],
        evidenceId: "ev-trust",
      },
    ],
    responsePolicies: [],
    privateConflicts: [],
    canary: CANARY,
  };
}

function challengeCandidates(): ScenarioEventCandidate[] {
  return [
    {
      id: "event-staging",
      trigger: { kind: "on_stage_enter", phase: "CHALLENGE" },
      prompt: text("【重要通知】内网部署要求生效。", "【Notice】On-premises requirement is now in effect."),
    },
    {
      id: "event-budget",
      trigger: { kind: "after_evidence_revealed", evidenceId: "ev-pain" },
      prompt: text("【预算更新】预算被削减70%。", "【Budget】Budget reduced by 70%."),
    },
    {
      id: "event-accuracy",
      trigger: { kind: "after_evidence_revealed", evidenceId: "ev-trust" },
      prompt: text("【质量要求】准确率必须达到99%。", "【Quality】Accuracy must reach 99%."),
    },
  ];
}

function aggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    locale: "zh-CN",
    phase: "SOLUTION_DESIGN",
    transcript: [
      {
        turnId: "t1",
        seq: 0,
        question: "你们有多少停机损失？",
        customerReply: text("约200万美元。", "About $2M."),
        stakeholderId: "vp-operations",
      },
      {
        turnId: "t2",
        seq: 1,
        question: "工程师对AI怎么看？",
        customerReply: text("比较怀疑。", "Quite skeptical."),
        stakeholderId: "vp-operations",
      },
    ],
    graph: {
      version: 0,
      nodes: [
        {
          id: "ev-legacy",
          kind: "fact",
          claim: text("工厂运行遗留系统", "Factory runs legacy systems"),
          status: "active",
          sourceTranscriptIds: ["t1"],
          weight: 1,
          version: 0,
        },
      ],
      edges: [],
    },
    disclosedDisclosureUnitIds: ["du-pain"],
    grantedHints: [],
    pendingQuestion: null,
    coachTask: "brief-validation",
    brief: null,
    proposal: null,
    pitch: null,
    challengeResponses: [],
    ...overrides,
  };
}

function proposal(overrides: Partial<SolutionProposal> = {}): SolutionProposal {
  return {
    id: "proposal-1",
    objective: text("降低告警处理负担", "Reduce alert-handling burden"),
    approach: text("分层告警分类", "Tiered alert classification"),
    approachEvidenceIds: ["ev-legacy"],
    assumptions: [text("规则系统可替换", "Rule system is replaceable")],
    alternatives: [
      { id: "alt-1", description: text("外包", "Outsource"), tradeoff: text("成本高", "Costly") },
    ],
    tradeoffs: [text("集成复杂度", "Integration complexity")],
    risks: [{ id: "risk-1", description: text("误报", "False positives"), mitigation: text("阈值调优", "Threshold tuning") }],
    validationPlan: [text("六周试点", "Six-week pilot")],
    rolloutPlan: [text("分阶段上线", "Phased rollout")],
    decisions: [
      {
        id: "dec-1",
        decision: text("本地部署", "On-premises"),
        rationale: text("符合内网要求", "Meets VPC requirement"),
        evidenceIds: ["ev-legacy"],
      },
    ],
    ...overrides,
  };
}

function pitch(overrides: Partial<PitchArtifact> = {}): PitchArtifact {
  return {
    id: "pitch-1",
    audience: text("管理层", "Senior leadership"),
    problem: text("告警处理低效", "Inefficient alert handling"),
    recommendation: text("分层AI告警分类", "Tiered AI alert classification"),
    expectedValue: text("削减50%工作量", "Cut 50% workload"),
    evidenceIds: ["ev-legacy"],
    risks: [text("误报率", "False positive rate")],
    ask: text("批准六周试点", "Approve a six-week pilot"),
    nextSteps: [text("组建试点团队", "Form a pilot team")],
    ...overrides,
  };
}

function response(challengeId: string): ChallengeResponse {
  return {
    id: `resp-${challengeId}`,
    challengeId,
    impact: text("限制部署选项", "Limits deployment options"),
    decision: "keep",
    rationale: text("本地部署本来就在计划内", "On-premises was already planned"),
    newRiskOrValidation: text("增加内网性能验证", "Add on-premises performance validation"),
  };
}

let tempDirs: string[] = [];
function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "fde-scp-"));
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

describe("solution → challenge → pitch (middle and late stages)", () => {
  it("runs the full successful path through REVIEW", async () => {
    const baseDir = makeStore();
    const store = { baseDir };

    // 1. Submit the solution design: SOLUTION_DESIGN -> CHALLENGE.
    const designInput = {
      state: aggregate(),
      proposal: proposal(),
      commandId: "cmd-design",
    };
    const design = await prepareSolutionDesign(designInput);
    await commitPrepared({
      runId: designInput.state.runId,
      commandId: designInput.commandId,
      request: { type: "submit-design", proposal: designInput.proposal },
      events: design.acceptedEvents,
      result: { phase: design.updatedState.phase },
      store,
    });
    expect(design.acceptedEvents.map((e) => e.type)).toEqual([
      "design.submitted",
      "phase.changed",
    ]);
    expect(design.updatedState.phase).toBe("CHALLENGE");
    expect(design.updatedState.proposal).not.toBeNull();

    // 2. Inject the deterministic challenge wave.
    const injectionInput = {
      state: design.updatedState,
      capsule: customerCapsule(),
      candidates: challengeCandidates(),
      rng: createRng(20260823),
      commandId: "cmd-inject",
    };
    const injection = await prepareChallengeInjection(injectionInput);
    await commitPrepared({
      runId: injectionInput.state.runId,
      commandId: injectionInput.commandId,
      request: { type: "challenge-inject" },
      events: injection.acceptedEvents,
      result: {
        injectedChallengeIds: injection.injectedChallengeIds,
        phase: "CHALLENGE",
      },
      store,
    });
    // event-staging (on_stage_enter CHALLENGE) + event-budget (ev-pain revealed) fire;
    // event-accuracy (ev-trust NOT revealed) does not.
    expect(injection.injectedChallengeIds.slice().sort()).toEqual([
      "event-budget",
      "event-staging",
    ]);
    // Persisted BEFORE the render: challenge.injected precedes its customer.replied.
    const types = injection.acceptedEvents.map((e) => e.type);
    expect(types).toContain("challenge.injected");
    expect(types).toContain("customer.replied");
    expect(types.indexOf("challenge.injected")).toBeLessThan(types.indexOf("customer.replied"));
    // The interruption text is the scenario's prompt, never invented scoring.
    const interruption = injection.interruptions.find((i) => i.challengeId === "event-budget");
    expect(interruption).toBeDefined();
    expect(interruption!.reply).toEqual({
      "zh-CN": "【预算更新】预算被削减70%。",
      "en-US": "【Budget】Budget reduced by 70%.",
    });
    expect(interruption!.stakeholderId).toBe("vp-operations");

    // 3. Respond to every mandatory challenge. Not addressed until the last one.
    const mandatory = injection.injectedChallengeIds;
    let state = injection.updatedState;
    for (let i = 0; i < mandatory.length; i++) {
      const last = i === mandatory.length - 1;
      const respondInput = {
        state,
        response: response(mandatory[i]),
        commandId: `cmd-resp-${i}`,
        mandatoryChallengeIds: mandatory,
      };
      const result = await prepareRespondToChallenge(respondInput);
      await commitPrepared({
        runId: respondInput.state.runId,
        commandId: respondInput.commandId,
        request: { type: "respond-challenge", response: respondInput.response },
        events: result.acceptedEvents,
        result: {
          challengesAddressed: result.challengesAddressed,
          phase: result.updatedState.phase,
        },
        store,
      });
      expect(result.challengesAddressed).toBe(last);
      expect(result.updatedState.phase).toBe(last ? "PITCH" : "CHALLENGE");
      if (last) {
        expect(result.acceptedEvents.map((e) => e.type)).toEqual([
          "challenge.responded",
          "phase.changed",
        ]);
      } else {
        expect(result.acceptedEvents.map((e) => e.type)).toEqual(["challenge.responded"]);
      }
      state = result.updatedState;
    }

    // 4. Submit the pitch: PITCH -> REVIEW.
    const pitchInput = { state, pitch: pitch(), commandId: "cmd-pitch" };
    const pitched = await preparePitch(pitchInput);
    await commitPrepared({
      runId: pitchInput.state.runId,
      commandId: pitchInput.commandId,
      request: { type: "submit-pitch", pitch: pitchInput.pitch },
      events: pitched.acceptedEvents,
      result: { phase: pitched.updatedState.phase },
      store,
    });
    expect(pitched.acceptedEvents.map((e) => e.type)).toEqual([
      "pitch.submitted",
      "phase.changed",
    ]);
    expect(pitched.acceptedEvents[1]).toMatchObject({
      type: "phase.changed",
      from: "PITCH",
      to: "REVIEW",
    });
    expect(pitched.updatedState.phase).toBe("REVIEW");

    const loaded = await loadRun("run-1", store);
    expect(loaded.phase).toBe("REVIEW");
  });

  it("rejects a solution whose approach links no evidence", async () => {
    const baseDir = makeStore();
    const error = await prepareSolutionDesign({
      state: aggregate(),
      proposal: proposal({ approachEvidenceIds: [] }),
      commandId: "cmd-bad-design",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    // ZodError surfaces the empty-array min(1) violation.
    expect(JSON.stringify(error)).toContain("approachEvidenceIds");

    // Nothing was persisted: the run has no event file at all.
    const loaded = await loadRun("run-1", { baseDir }).catch((e) => e);
    expect((loaded as { code?: string }).code).toBe("RUN_NOT_FOUND");
  });

  it("does not advance to PITCH while a mandatory challenge is unanswered", async () => {
    const baseDir = makeStore();
    const store = { baseDir };

    const designInput = {
      state: aggregate(),
      proposal: proposal(),
      commandId: "cmd-design",
    };
    const design = await prepareSolutionDesign(designInput);
    await commitPrepared({
      runId: designInput.state.runId,
      commandId: designInput.commandId,
      request: { type: "submit-design", proposal: designInput.proposal },
      events: design.acceptedEvents,
      result: { phase: design.updatedState.phase },
      store,
    });
    const injectionInput = {
      state: design.updatedState,
      capsule: customerCapsule(),
      candidates: challengeCandidates(),
      rng: createRng(7),
      commandId: "cmd-inject",
    };
    const injection = await prepareChallengeInjection(injectionInput);
    await commitPrepared({
      runId: injectionInput.state.runId,
      commandId: injectionInput.commandId,
      request: { type: "challenge-inject" },
      events: injection.acceptedEvents,
      result: {
        injectedChallengeIds: injection.injectedChallengeIds,
        phase: "CHALLENGE",
      },
      store,
    });
    const mandatory = injection.injectedChallengeIds;
    expect(mandatory).toHaveLength(2);

    // Answer only the first mandatory challenge.
    const respondInput = {
      state: injection.updatedState,
      response: response(mandatory[0]),
      commandId: "cmd-resp-0",
      mandatoryChallengeIds: mandatory,
    };
    const partial = await prepareRespondToChallenge(respondInput);
    await commitPrepared({
      runId: respondInput.state.runId,
      commandId: respondInput.commandId,
      request: { type: "respond-challenge", response: respondInput.response },
      events: partial.acceptedEvents,
      result: {
        challengesAddressed: partial.challengesAddressed,
        phase: partial.updatedState.phase,
      },
      store,
    });

    expect(partial.challengesAddressed).toBe(false);
    expect(partial.updatedState.phase).toBe("CHALLENGE");
    expect(partial.acceptedEvents.map((e) => e.type)).toEqual(["challenge.responded"]);

    // A learner may retain the design ("keep") when they give a rationale —
    // decision keep is structurally accepted.
    expect(partial.updatedState.challengeResponses).toHaveLength(1);
    expect(partial.updatedState.challengeResponses[0].decision).toBe("keep");

    const loaded = await loadRun("run-1", store);
    expect(loaded.phase).toBe("CHALLENGE");
  });

  it("rejects a pitch missing an explicit ask", async () => {
    const baseDir = makeStore();
    // Reach PITCH first via a single challenge so the phase guard passes.
    const store = { baseDir };
    const designInput = {
      state: aggregate(),
      proposal: proposal(),
      commandId: "cmd-design",
    };
    const design = await prepareSolutionDesign(designInput);
    await commitPrepared({
      runId: designInput.state.runId,
      commandId: designInput.commandId,
      request: { type: "submit-design", proposal: designInput.proposal },
      events: design.acceptedEvents,
      result: { phase: design.updatedState.phase },
      store,
    });
    const injectionInput = {
      state: design.updatedState,
      capsule: customerCapsule(),
      candidates: [challengeCandidates()[0]],
      rng: createRng(3),
      commandId: "cmd-inject",
    };
    const injection = await prepareChallengeInjection(injectionInput);
    await commitPrepared({
      runId: injectionInput.state.runId,
      commandId: injectionInput.commandId,
      request: { type: "challenge-inject" },
      events: injection.acceptedEvents,
      result: {
        injectedChallengeIds: injection.injectedChallengeIds,
        phase: "CHALLENGE",
      },
      store,
    });
    const respondInput = {
      state: injection.updatedState,
      response: response(injection.injectedChallengeIds[0]),
      commandId: "cmd-resp-0",
      mandatoryChallengeIds: injection.injectedChallengeIds,
    };
    const answered = await prepareRespondToChallenge(respondInput);
    await commitPrepared({
      runId: respondInput.state.runId,
      commandId: respondInput.commandId,
      request: { type: "respond-challenge", response: respondInput.response },
      events: answered.acceptedEvents,
      result: {
        challengesAddressed: answered.challengesAddressed,
        phase: answered.updatedState.phase,
      },
      store,
    });
    expect(answered.updatedState.phase).toBe("PITCH");

    const error = await preparePitch({
      state: answered.updatedState,
      pitch: pitch({ ask: text("", "") }),
      commandId: "cmd-bad-pitch",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).toContain("ask");

    const loaded = await loadRun("run-1", store);
    expect(loaded.phase).toBe("PITCH");
  });
});
