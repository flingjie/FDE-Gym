#!/usr/bin/env node
/**
 * FDE Gym — difficulty calibration + model-version drift measurement harness.
 *
 * A standalone manual tool (NOT wired into any npm script or CI). It drives a
 * compiled scenario N times through the full learner pipeline
 * (`start → ask → frame → submitBrief → submitDesign → respondChallenge →
 * submitPitch → review`) against a real `DirectModelRuntime`, collects each
 * run's `final` score, and reports `computeDifficulty` stats (and, with
 * `--baseline`, `computeDrift` against that baseline).
 *
 * Requires `npm run build` first: like `scripts/compile-scenarios.mjs`, this
 * script imports the COMPILED output from `dist/`, not `src/`.
 *
 * Usage:
 *   FDE_GYM_MODEL_BASE_URL=http://127.0.0.1:15721/v1 \
 *   FDE_GYM_MODEL=deepseek-v4-pro \
 *   node scripts/calibrate.mjs [--scenario <id>] [--samples <N>] [--baseline '<json-array>']
 *
 *   - `--scenario <id>`  compiled scenario id (default `customer-support-agent`).
 *   - `--samples <N>`    number of full pipeline runs; may also be given as the
 *                        single positional argument (default 3).
 *   - `--baseline <...>` JSON array of numbers; when supplied, `computeDrift`
 *                        is printed for (baseline, currentScores).
 *
 * Gating: runs ONLY when BOTH `FDE_GYM_MODEL_BASE_URL` and `FDE_GYM_MODEL` are
 * set explicitly — it does NOT fall back to `~/.codex/config.toml` (mirrors the
 * real-model contract suite's opt-in gate). Without them it prints a message and
 * exits 0, so a bare `node scripts/calibrate.mjs` never errors.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeDifficulty, computeDrift } from "../dist/scoring/calibration.js";

// The pipeline-driving modules (`dist/cli/commands.js` and its transitive deps,
// incl. `node:sqlite`) are imported LAZILY in `main()` — only AFTER the endpoint
// gate has passed — so a bare `node scripts/calibrate.mjs` with no endpoint
// prints the "no endpoint configured" message and exits 0 without loading them
// (and without the `node:sqlite` experimental warning they would surface).
let pipeline = null;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/calibrate.mjs [--scenario <id>] [--samples <N>] [--baseline '<json-array>']`;

/** Localized-text helper (both locale keys are required by the schema). */
const text = (zh, en) => ({ "zh-CN": zh, "en-US": en });

function parseArgs(argv) {
  const args = { scenario: "customer-support-agent", samples: 3, baseline: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenario") {
      args.scenario = argv[++i];
    } else if (arg === "--samples") {
      args.samples = Number(argv[++i]);
    } else if (arg === "--baseline") {
      args.baseline = JSON.parse(argv[++i]);
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) args.samples = Number(positional[0]);
  if (positional.length > 1) throw new Error(`too many positional arguments\n${USAGE}`);
  if (!Number.isInteger(args.samples) || args.samples < 1) {
    throw new Error(`--samples must be a positive integer, got ${args.samples}\n${USAGE}`);
  }
  if (args.baseline !== null) {
    const valid = Array.isArray(args.baseline) && args.baseline.every((x) => typeof x === "number");
    if (!valid) throw new Error("--baseline must be a JSON array of numbers");
  }
  return args;
}

// ---------------------------------------------------------------------------
// Endpoint gating (explicit env vars only — no ~/.codex/config.toml fallback)
// ---------------------------------------------------------------------------

const envBaseUrl = process.env.FDE_GYM_MODEL_BASE_URL;
const envModel = process.env.FDE_GYM_MODEL;
const config =
  envBaseUrl && envModel
    ? { baseUrl: envBaseUrl, model: envModel, apiKey: process.env.FDE_GYM_MODEL_API_KEY }
    : null;

if (!config) {
  console.log(
    "no endpoint configured — set FDE_GYM_MODEL_BASE_URL and FDE_GYM_MODEL to run calibration.",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Pipeline-driving helpers (mirror the real-model contract suite's shapes)
// ---------------------------------------------------------------------------

/** Unwrap a `CliResult`, surfacing the stable failure code on `ok:false`. */
function mustOk(result) {
  if (!result.ok) {
    throw new Error(`command failed with code=${result.code}: ${result.message}`);
  }
  return result.data;
}

/** Discovery questions derived from the first stakeholders' own concerns. */
function buildAskPlan(bundle, locale) {
  const pick = (localized) => localized[locale] ?? localized["zh-CN"] ?? localized["en-US"];
  return bundle.customerCapsule.stakeholders.slice(0, 3).map((stakeholder, i) => ({
    question:
      stakeholder.concerns?.[0] !== undefined
        ? pick(stakeholder.concerns[0])
        : `请介绍你在这个项目中的主要关切（第 ${i + 1} 位干系人）。`,
    stakeholderId: stakeholder.id,
  }));
}

function proposal(factIds) {
  return {
    id: "proposal-1",
    objective: text("设计一个平衡质量、延迟与成本的方案", "Design an approach balancing quality, latency, and cost"),
    approach: text("分层交付、关键写操作保留人工确认", "Layered delivery with human confirmation on sensitive writes"),
    approachEvidenceIds: [...factIds],
    assumptions: [text("现有系统可改造", "Existing systems can be adapted")],
    alternatives: [
      { id: "alt-1", description: text("最小改动方案", "Minimal-change approach"), tradeoff: text("收益有限", "Limited benefit") },
    ],
    tradeoffs: [text("集成复杂度", "Integration complexity")],
    risks: [
      { id: "risk-1", description: text("误操作风险", "Mis-action risk"), mitigation: text("人工确认与审计", "Human confirmation and audit") },
    ],
    validationPlan: [text("试点验证", "Pilot validation")],
    rolloutPlan: [text("分阶段上线", "Staged rollout")],
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

function response(challengeId) {
  return {
    id: `resp-${challengeId}`,
    challengeId,
    impact: text("限制方案范围", "Limits the solution scope"),
    decision: "change",
    rationale: text("缩小范围", "Narrow the scope"),
    newRiskOrValidation: text("增加验证", "Add validation"),
  };
}

function pitch(factIds) {
  return {
    id: "pitch-1",
    audience: text("管理层", "Leadership"),
    problem: text("当前流程存在效率与合规风险", "The current process has efficiency and compliance risks"),
    recommendation: text("分层交付方案", "Layered delivery approach"),
    expectedValue: text("削减成本", "Cut cost"),
    evidenceIds: [...factIds],
    risks: [text("工具超时", "Tool timeouts")],
    ask: text("批准试点", "Approve the pilot"),
    nextSteps: [text("组建团队", "Form the team")],
  };
}

// ---------------------------------------------------------------------------
// One full pipeline run
// ---------------------------------------------------------------------------

async function runOnce({ config, bundle, scenarioId, locale, index }) {
  const baseDir = mkdtempSync(join(tmpdir(), "fde-calibrate-"));
  try {
    const ctx = {
      runtime: new pipeline.DirectModelRuntime(config),
      baseDir,
      scenario: {
        public: bundle.publicScenario,
        customer: bundle.customerCapsule,
        evaluator: bundle.evaluatorCapsule,
        events: [...bundle.eventCandidates],
      },
    };

    const runId = `calibrate-run-${index}`;

    // 1. start -> DISCOVERY.
    mustOk(
      await pipeline.commands.startCommand(ctx, { runId, scenarioId, locale, commandId: "cmd-start" }),
    );

    // 2. Discovery: ask the first few stakeholders, then frame.
    const askPlan = buildAskPlan(bundle, locale);
    for (let i = 0; i < askPlan.length; i++) {
      mustOk(
        await pipeline.commands.askCommand(ctx, {
          runId,
          question: askPlan[i].question,
          stakeholderId: askPlan[i].stakeholderId,
          commandId: `cmd-ask-${i + 1}`,
        }),
      );
    }
    mustOk(await pipeline.commands.frameCommand(ctx, { runId, commandId: "cmd-frame" }));

    // 3. Ground the brief in the facts the Evidence Tracker actually committed,
    //    so its claim evidence ids resolve (the structural gate requires it).
    const committed = await pipeline.loadEvents(runId, { baseDir });
    const patched = committed.filter((event) => event.type === "evidence.patched");
    const factNodes = patched
      .flatMap((event) => event.patch.addNodes)
      .filter((node) => node.kind === "fact");
    const contradictionNodes = patched
      .flatMap((event) => event.patch.addNodes)
      .filter((node) => node.kind === "contradiction" && node.status === "active");

    if (factNodes.length === 0) {
      throw new Error("no facts committed during discovery");
    }
    const factIds = factNodes.map((node) => node.id);
    const firstFact = factNodes[0];

    const brief = {
      id: "brief-1",
      problemStatement: text("当前流程存在效率与合规风险", "The current process has efficiency and compliance risks"),
      goal: text("设计一个平衡质量、延迟与成本的方案", "Design an approach balancing quality, latency, and cost"),
      constraints: [text("敏感写操作须人工确认", "Sensitive writes require human confirmation")],
      claims: [
        { id: "claim-1", statement: firstFact.claim, weight: "major", evidenceIds: [firstFact.id] },
      ],
      successMeasures: [text("成本与首响时间显著下降", "Cost and first-response time drop significantly")],
      unknowns: [text("工具超时的人工插队规则", "The human jump-the-queue rule on tool timeout")],
      contradictions: contradictionNodes.map((node, i) => ({
        id: `contra-${i + 1}`,
        statement: node.claim,
        evidenceIds: [node.id],
        disposition: "resolved",
      })),
    };
    mustOk(await pipeline.commands.submitBriefCommand(ctx, { runId, brief, commandId: "cmd-brief" }));

    // 4. Solution design -> challenge -> pitch.
    const design = mustOk(
      await pipeline.commands.submitDesignCommand(ctx, {
        runId,
        proposal: proposal(factIds),
        commandId: "cmd-design",
        seed: 20260823,
      }),
    );
    for (let i = 0; i < design.injectedChallengeIds.length; i++) {
      mustOk(
        await pipeline.commands.respondChallengeCommand(ctx, {
          runId,
          response: response(design.injectedChallengeIds[i]),
          commandId: `cmd-resp-${i + 1}`,
        }),
      );
    }
    if (design.injectedChallengeIds.length === 0) {
      mustOk(
        await pipeline.commands.respondChallengeCommand(ctx, {
          runId,
          response: response("noop"),
          commandId: "cmd-resp-noop",
        }),
      );
    }
    mustOk(
      await pipeline.commands.submitPitchCommand(ctx, {
        runId,
        pitch: pitch(factIds),
        commandId: "cmd-pitch",
      }),
    );

    // 5. Review -> the run's `final` score.
    const reviewed = mustOk(
      await pipeline.commands.reviewCommand(ctx, { runId, commandId: "cmd-review" }),
    );
    return reviewed.score.final;
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  // Lazy-load the pipeline modules only now that the endpoint is configured.
  const [directRuntime, commands, eventStore, bundleModule] = await Promise.all([
    import("../dist/integrations/direct/direct-runtime.js"),
    import("../dist/cli/commands.js"),
    import("../dist/core/event-store.js"),
    import("../dist/scenarios/bundle.js"),
  ]);
  pipeline = {
    DirectModelRuntime: directRuntime.DirectModelRuntime,
    commands,
    loadEvents: eventStore.loadEvents,
    defaultCompiledRoot: bundleModule.defaultCompiledRoot,
    loadScenarioBundle: bundleModule.loadScenarioBundle,
  };

  const bundle = pipeline.loadScenarioBundle(args.scenario, {
    compiledRoot: pipeline.defaultCompiledRoot(),
  });
  const locale = bundle.publicScenario.locale;

  console.log(`calibrating scenario=${args.scenario} model=${config.model} samples=${args.samples}`);
  const scores = [];
  const failures = [];
  for (let i = 0; i < args.samples; i++) {
    try {
      const final = await runOnce({ config, bundle, scenarioId: args.scenario, locale, index: i });
      scores.push(final);
      console.log(`  run ${i + 1}/${args.samples}: final = ${final}`);
    } catch (error) {
      failures.push({ index: i + 1, message: error.message });
      console.log(`  run ${i + 1}/${args.samples}: FAILED — ${error.message}`);
    }
  }

  if (scores.length === 0) {
    console.log("no successful runs — nothing to summarize.");
    process.exit(1);
  }

  const difficulty = computeDifficulty(scores);
  console.log("difficulty:", difficulty);

  if (args.baseline !== null) {
    const drift = computeDrift(args.baseline, scores);
    console.log("drift:", drift);
  }

  if (failures.length > 0) {
    console.log(`warnings: ${failures.length} run(s) failed; stats cover ${scores.length} successful run(s).`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
