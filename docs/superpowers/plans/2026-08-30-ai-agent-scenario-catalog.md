# Five AI-agent training scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four production scenarios with five tool-using, HITL, fail-closed AI-agent scenarios and retarget compiler, e2e, calibration, and golden replay onto the new catalog.

**Architecture:** No schema or runtime change. Clone the existing `support-automation.yaml` structural skeleton (4 stakeholders, 16 disclosure units, 8 expected-evidence rows, 5-stage rubric, 2 contradictions, 8 Socratic ladders, 2 pass gates, ≥3 events). Swap prose per the frozen catalog. Compile with seed `test-seed-2026-08-23`. Delete old source+compiled trees. Keep the v1 `tests/fixtures/runs/v1/manufacturing/` log as a **format** fixture; do not use it as a catalog member.

**Tech Stack:** TypeScript (Node ≥ 22), Vitest, Zod, existing `compileScenario` / `ScenarioAuthoringSchema` / `collectHintDisciplineIssues`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-ai-agent-scenario-catalog-design.md`

## Global Constraints

- Node.js ≥ 22 (`engines.node` is `>=22` in `package.json`).
- Source imports use the `.js` extension (NodeNext ESM); test imports are extensionless.
- Do **not** add schema fields for tools, MCP, sandboxes, or VLM.
- Do **not** change `requestHint`, hint-discipline rules, the phase loop, or scoring formulas.
- Do **not** edit `docs/mvp-acceptance.md`.
- Do **not** make Gym execute CRM/SQL/Git/OCR.
- Do **not** keep old scenario ids as aliases.
- Do **not** rewrite `tests/fixtures/runs/v1/manufacturing/` (v1 event-format compatibility). Move current golden **snapshots** if the v1 projector test still needs them.
- Hints: Socratic L1/L2/L3; no `关键发现` / `Key discovery`; no numeric tokens from disclosure units or expected-evidence descriptions.
- Public copy must not contain hidden quantities (e.g. do **not** put `70` in `customer-support-agent` public opening).
- Verify with `npx vitest run <files>` after each task; `npm run typecheck` before each commit.

**New catalog ids (exact):** `enterprise-knowledge-agent`, `customer-support-agent`, `data-analysis-agent`, `document-review-agent`, `software-engineering-agent`

**Deleted ids (exact):** `support-automation`, `manufacturing-alert-triage`, `data-migration`, `export-freight-forwarding`

---

### Task 1: Catalog contract test (RED until YAML exists)

**Files:**
- Create: `tests/contracts/scenario-catalog.test.ts`

**Interfaces:**
- Consumes: `ScenarioAuthoringSchema.parse`, `collectHintDisciplineIssues`, `readdirSync` of `scenarios/source`.
- Produces: the frozen id list later tasks must satisfy.

- [ ] **Step 1: Write the failing test**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { collectHintDisciplineIssues } from "../../src/scenarios/hint-discipline";
import { ScenarioAuthoringSchema } from "../../src/scenarios/schema";

export const PRODUCTION_SCENARIO_IDS = [
  "enterprise-knowledge-agent",
  "customer-support-agent",
  "data-analysis-agent",
  "document-review-agent",
  "software-engineering-agent",
] as const;

const RETIRED = [
  "support-automation",
  "manufacturing-alert-triage",
  "data-migration",
  "export-freight-forwarding",
] as const;

describe("production scenario catalog", () => {
  const sourceDir = join(process.cwd(), "scenarios", "source");
  const yamlIds = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => name.replace(/\.yaml$/, ""))
    .sort();

  it("contains exactly the five agent scenario ids", () => {
    expect(yamlIds).toEqual([...PRODUCTION_SCENARIO_IDS].sort());
  });

  it("does not keep retired ids", () => {
    for (const id of RETIRED) {
      expect(yamlIds).not.toContain(id);
    }
  });

  it("parses and passes hint discipline", () => {
    for (const id of PRODUCTION_SCENARIO_IDS) {
      const doc = ScenarioAuthoringSchema.parse(
        parse(readFileSync(join(sourceDir, `${id}.yaml`), "utf8")),
      );
      expect(doc.id).toBe(id);
      expect(collectHintDisciplineIssues(doc)).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run tests/contracts/scenario-catalog.test.ts`

Expected: FAIL (old four yaml ids; new files missing).

- [ ] **Step 3: Do not author YAML in this task.** Commit the test only.

```bash
npm run typecheck
git add tests/contracts/scenario-catalog.test.ts
git commit -m "$(cat <<'EOF'
test: pin the five-agent production catalog ids

EOF
)"
```

---

### Task 2: Author `customer-support-agent.yaml` (golden target)

**Files:**
- Create: `scenarios/source/customer-support-agent.yaml`

**Interfaces:**
- Consumes: structural skeleton of `scenarios/source/support-automation.yaml` (copy the file, then replace `id` and all prose). Keep `schemaVersion: 1`, `locale: zh-CN`, `questionBudget: 12`, `responsePolicies: []`, `privateConflicts: []`, evidence ids `ev-workflow`…`ev-failure-modes`, DU ids `du-001`…`du-016` (two per topic in the same order as support-automation), ladder ids `hl-workflow` etc.
- Produces: a source file that `ScenarioAuthoringSchema.parse` + `collectHintDisciplineIssues` accept.

**Skeleton rule:** `cp scenarios/source/support-automation.yaml scenarios/source/customer-support-agent.yaml` then replace content. Do not drop rubric stages, pass gates, or events.

**Public (no `70`, no ticket-volume numbers):**

- opening zh: `请帮助我们设计一个会调用业务系统工具的客服代理，自动处理大部分请求，并在敏感操作上保留人工。`
- opening en: `Please help us design a customer-support agent that calls business-system tools, handles most requests automatically, and keeps humans on sensitive actions.`
- visibleContext: SaaS support center; leadership wants a **tool-calling agent** (CRM, order, refund/shipping APIs), not a rules engine with a chat skin.
- visibleConstraints (must name ≥2 tool classes + HITL + one failing path, without hidden numbers):
  1. Payment, refund, and account-change **actions** require a human (HITL).
  2. Ticket data must not go to offshore third-party LLMs.
  3. Agent must not fabricate policy.
  4. CRM / order / refund APIs are the allowed tools; the agent must not silently retry a timed-out refund call as success.
- deliverables: agent design doc; tool-calling vs FAQ-bot trade-off; escalation + HITL; quality/latency/cost measures.
- learnerRules: same 12-question / stakeholder / DISCOVERY / PITCH pattern as support-automation, worded for this customer.

**Stakeholders (keep 4; change personas to the agent story):**

| id | role |
|---|---|
| `support-director` | 客服总监 / Support Director |
| `compliance-officer` | 合规官 / Compliance Officer |
| `automation-engineer` | 代理平台工程师 / Agent-platform engineer (wants to maximize auto-handle; underestimates HITL) |
| `cfo` | CFO |

**Disclosure units (hidden numbers OK here; keep them out of hints):**

| id | topic | zh (en equivalent required) |
|---|---|---|
| du-001 | workflow | 代理先查 CRM 再查订单 API；每月约18万张工单，约55%可走工具闭环。 |
| du-002 | workflow | 平均首响约4小时，高峰约9小时；无工具超时时的人工插队规则。 |
| du-003 | pain | 人工成本占总支持预算约72%；一线年流失约38%。 |
| du-004 | pain | 复杂工单一次解决率约51%；客服从 CRM 来回切屏。 |
| du-005 | root-cause | 现网仍是规则引擎加 FAQ，不能调订单/退款 API。 |
| du-006 | root-cause | 用户换个说法就匹配失败；代理没有工具结果就改口编政策。 |
| du-007 | business-impact | 因等待流失的终身价值约320美元/人，每月约900人。 |
| du-008 | business-impact | 管理层估计工具闭环覆盖约40%工单可年省约210万美元；工程师私下想把自动处理推到70%。 |
| du-009 | constraints | 付款、退款、账户变更必须人工确认后才许调用写 API。 |
| du-010 | constraints | 工单与 CRM 数据不得出境到第三方大模型。 |
| du-011 | success-measures | 目标：自动闭环大部分重复单，首响从约4小时降到约1小时，人工成本降约35%。 |
| du-012 | success-measures | 质量红线：政策准确率不低于约92%，且退款 API 不得在超时后被当成成功。 |
| du-013 | trust | 一线怕丢工作，绕过代理直接人工回复。 |
| du-014 | trust | 高管以为可以一步全自动，低估 HITL 与工具失败。 |
| du-015 | failure-modes | 不确定时会幻觉退款政策并调用退款 API。 |
| du-016 | failure-modes | 高峰工具超时会把上万张单打进人工队列。 |

Map `evidenceId` exactly as support-automation (`du-001/002` → `ev-workflow`, … `du-015/016` → `ev-failure-modes`). Rewrite `expectedEvidence[].description` to agent/tool language **without those numeric tokens**.

**Hints:** L1 dimension, L2 evidence *kind*, L3 question with `？`/`?`. Forbidden tokens include: `70`, `18`, `55`, `4`, `9`, `72`, `38`, `51`, `320`, `900`, `40`, `210`, `1`, `35`, `92`. Do not say 关键发现.

Example workflow L3 zh: `现在客服代理会按什么顺序调用 CRM 和订单接口？重复单大概能闭环多少？首响在平时和高峰分别怎样？`

**Contradictions:** (1) engineer wants 70% auto-handle vs compliance HITL on refunds; (2) CFO savings vs frontline bypass.

**Events (≥3):** compliance mandate on write APIs; CFO ROI demand (may contain `15` — keep `15` out of hints if used); unsafe automation incident (policy hallucination); escalation-required after N questions. Copy trigger shapes from support-automation (`on_stage_enter`, `after_evidence_revealed`, `after_question_count`).

- [ ] **Step 1:** Copy YAML, apply the table, then run:

`npx vitest run tests/contracts/scenario-catalog.test.ts tests/contracts/hint-discipline.test.ts`

Expected: catalog test still fails on “exactly five ids”, but `ScenarioAuthoringSchema.parse` of this one file must succeed. Add a temporary focused assertion if useful:

```ts
it("customer-support-agent parses", () => { /* parse this file only */ });
```

Prefer: run a one-off in the catalog test file is unnecessary — instead:

```bash
npx vitest run tests/contracts/hint-discipline.test.ts
```

and a node snippet is not required if you add to `scenario-catalog.test.ts` a `it.each` that skips missing files… **Do not skip.** Until Task 3, catalog test stays RED. Verify this file alone:

```bash
npx vitest run tests/contracts/domain-schema.test.ts
```

Then parse-check:

Use the existing production-source loop pattern: temporarily run in the shell:

```ts
// npx vitest not required — compile via:
```

Simplest check: extend Task 1 test is already the gate. For this task, run:

```
npx tsx` is unavailable. Use:

```
node --experimental-strip-types -e '
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ScenarioAuthoringSchema } from "./src/scenarios/schema.ts";
import { collectHintDisciplineIssues } from "./src/scenarios/hint-discipline.ts";
const doc = ScenarioAuthoringSchema.parse(parse(readFileSync("scenarios/source/customer-support-agent.yaml","utf8")));
console.log(doc.id, collectHintDisciplineIssues(doc));
'
```

If strip-types fails on NodeNext, run `npx vitest run tests/contracts/hint-discipline.test.ts` after adding `customer-support-agent` to `SOURCES` **in addition to** the old four (Task 4 removes the old four). **Do not** add it to `SOURCES` yet if that test currently expects only four empty lists — adding a fifth id that exists will pass the new one and still pass the old four.

Add `customer-support-agent` to `SOURCES` in `tests/contracts/hint-discipline.test.ts` now so this task has a GREEN file-level gate. Task 4 replaces `SOURCES` with the five-id list and drops retired ids.

- [ ] **Step 2:** `npm run typecheck` and commit

```bash
git add scenarios/source/customer-support-agent.yaml tests/contracts/hint-discipline.test.ts
git commit -m "$(cat <<'EOF'
feat: add customer-support-agent training scenario

EOF
)"
```

---

### Task 3: Author the other four source YAML files

**Files:**
- Create: `scenarios/source/enterprise-knowledge-agent.yaml`
- Create: `scenarios/source/data-analysis-agent.yaml`
- Create: `scenarios/source/document-review-agent.yaml`
- Create: `scenarios/source/software-engineering-agent.yaml`

**Interfaces:** Same skeleton as Task 2 (`cp` support-automation.yaml). Same DU/evidence/ladder id scheme. Add each id to `SOURCES` in `hint-discipline.test.ts` as you finish it (or all four at end of this task).

For each file: 4 stakeholders, 16 DUs, Socratic ladders, ≥2 contradictions, ≥3 events, 5-stage rubric retargeted to the domain, 2 pass gates. Public constraints must name ≥2 tool classes, HITL, and one unauthorized/failing tool path, **without** hidden numeric tokens.

#### `enterprise-knowledge-agent`

- opening: 让员工用代理问到内部业务答案（检索必须带引用、必须过权限）。
- tools: document index, ACL directory, wiki/ticket lookup.
- HITL: 无权限内容不得引用；对外口径需人工。
- failure: 编造引用；检索忽略 ACL。
- stakeholders: `knowledge-lead` (知识/IT), `iam-security` (安全/IAM), `frontline-user` (一线业务, Slack 口口相传), `ops-owner` (知识库运营).
- hidden numbers (DU only; keep out of hints): 约 60% 答案来自过期 wiki；越权命中约 8%；引用幻觉抽查约 12%.
- public: no 60/8/12.

#### `data-analysis-agent`

- opening: 让业务人员用自然语言问数仓（只读）。
- tools: read-only SQL, BI semantic layer, row-level security.
- HITL/hard stop: 禁止写库；跨部门宽表需批准。
- failure: 错 JOIN / 漏过滤打出 PII。
- stakeholders: `analytics-lead`, `platform-dba`, `business-requester`, `privacy-officer`.
- hidden numbers: 一次错误查询曾打出约 2.4 万行含手机号；语义层覆盖约 40% 指标。
- public: no 2.4万 / 40.

#### `document-review-agent`

- opening: 自动审核合同/报告/PDF（解析→抽取→规则→主数据比对）。
- tools: parse/OCR-or-VLM, clause extraction, rule engine, master-data match.
- HITL: 盖章/承诺性结论必须律师或业务确认。
- failure: 漏关键条款；幻觉不存在的约定。
- stakeholders: `counsel`, `business-owner`, `doc-ops`, `procurement-lead`.
- hidden numbers: 积压约 1.2 万份；抽查漏条款约 9%。
- public: no 1.2万 / 9.

#### `software-engineering-agent`

- opening: 代理修 Bug、跑测试、开 PR（沙箱内）。
- tools: Git, isolated sandbox, test runner, PR API.
- HITL: 受保护分支合并、生产密钥、禁止 push 默认分支。
- failure: 测试绿但改错行为；秘密写进 PR。
- stakeholders: `eng-manager`, `platform-security`, `ic-developer`, `qa-lead`.
- hidden numbers: 约 15% 绿测 PR 被 revert；曾有一次把 token 写进 PR 描述。
- public: no 15.

Hint ladders: follow D0.1. L3 both locales contain `?` or `？`.

- [ ] **Step 1:** Author the four files.
- [ ] **Step 2:** `SOURCES` in `hint-discipline.test.ts` must include all five new ids (old four may still be present until Task 4).

Run: `npx vitest run tests/contracts/hint-discipline.test.ts`

Expected: PASS for every listed source that exists.

- [ ] **Step 3:** Commit

```bash
npm run typecheck
git add scenarios/source/enterprise-knowledge-agent.yaml scenarios/source/data-analysis-agent.yaml scenarios/source/document-review-agent.yaml scenarios/source/software-engineering-agent.yaml tests/contracts/hint-discipline.test.ts
git commit -m "$(cat <<'EOF'
feat: add four remaining AI-agent training scenarios

EOF
)"
```

---

### Task 4: Compile new bundles; delete the old catalog; retarget compiler tests

**Files:**
- Modify: `scripts/compile-scenarios.mjs` (`ids` array → the five new ids; keep seed `test-seed-2026-08-23`)
- Create: `scenarios/compiled/<five ids>/` via the script
- Delete: four old `scenarios/source/*.yaml` (except if already unused) and four old `scenarios/compiled/<retired>/` trees
- Modify: `tests/contracts/hint-discipline.test.ts` — `SOURCES` = only the five new ids (including committed-bundle equality vs source)
- Modify: `tests/contracts/scenario-compiler.test.ts` — `SOURCE_YAML` / `scenarioId` / public snapshot path → `customer-support-agent`
- Create: `tests/fixtures/customer-support-public.snapshot.json` (generate from compile public.json; do not hand-edit)
- Delete: `tests/fixtures/manufacturing-public.snapshot.json` after compiler test no longer references it
- Modify: `src/scenarios/loader.ts` example id in the doc comment

**Interfaces:**
- Consumes: five source YAML from Tasks 2–3; `compileScenario` from `src/scenarios/compiler.ts`.
- Produces: committed bundles whose `hintLadders` equal source (existing discipline test).

- [ ] **Step 1:** Update `scripts/compile-scenarios.mjs` ids to:

```js
const ids = [
  "enterprise-knowledge-agent",
  "customer-support-agent",
  "data-analysis-agent",
  "document-review-agent",
  "software-engineering-agent",
];
```

- [ ] **Step 2:** `npm run build && node scripts/compile-scenarios.mjs`

- [ ] **Step 3:** Delete retired source YAML and `scenarios/compiled/{support-automation,manufacturing-alert-triage,data-migration,export-freight-forwarding}/` (entire directories).

- [ ] **Step 4:** Point compiler test at `customer-support-agent.yaml`. Copy compiled `public.json` (from a **temp** compile or from committed bundle) to `tests/fixtures/customer-support-public.snapshot.json`. Update `PUBLIC_SNAPSHOT` path. Delete `manufacturing-public.snapshot.json`.

- [ ] **Step 5:** `SOURCES` and catalog test must now be GREEN.

Run: `npx vitest run tests/contracts/scenario-catalog.test.ts tests/contracts/hint-discipline.test.ts tests/contracts/scenario-compiler.test.ts`

Expected: PASS.

- [ ] **Step 6:** Commit

```bash
npm run typecheck
git add scripts/compile-scenarios.mjs scenarios/source scenarios/compiled tests/contracts/hint-discipline.test.ts tests/contracts/scenario-compiler.test.ts tests/fixtures/customer-support-public.snapshot.json tests/fixtures/manufacturing-public.snapshot.json src/scenarios/loader.ts
git commit -m "$(cat <<'EOF'
feat: compile the agent catalog and drop retired scenarios

EOF
)"
```

Use `git add -A` on `scenarios/compiled` so deletions are included. Do not add `docs/mvp-acceptance.md`.

---

### Task 5: Retarget all-scenarios and calibration journeys

**Files:**
- Modify: `tests/e2e/all-scenarios.test.ts` — `SCENARIOS` = the five ids; rewrite `ASK_PLANS` (and any per-id brief/proposal if specialized)
- Modify: `tests/contracts/scenario-calibration.test.ts` — same `SCENARIOS`; rewrite `ASK_PLANS`; replace `EXPECTED_FINAL` after the first failing run

**Interfaces:**
- Consumes: stakeholder ids and `du-001` / a pain DU / a failure-modes DU from each YAML (use the same ids as authored: `du-001`, a mid pain/root DU, `du-015` or `du-016`).
- Produces: fixture journeys that compile each source to a temp root (already the pattern).

`ASK_PLANS` needs **three** asks per id. Replies must match the corresponding DU text (paraphrase OK if the Customer fixture returns that `reply` object). `stakeholderId` must exist on that scenario.

Generic `brief()` / `proposal()` / `pitch()` in calibration may stay if they only reference `ev-n1`.

- [ ] **Step 1:** Switch `SCENARIOS` to the five ids. Write `ASK_PLANS` for each. Set `EXPECTED_FINAL` to `{ [id]: 0 }` for all five so the score assertion fails with a real number.

- [ ] **Step 2:** Run

`npx vitest run tests/contracts/scenario-calibration.test.ts tests/e2e/all-scenarios.test.ts`

Expected: FAIL on `EXPECTED_FINAL` (and possibly leak snapshots / leaked-public strings). Read the actual `final` from the assertion diff. Also refresh any per-scenario leaked-public expected strings in calibration (search `EXPECTED` / snapshot objects in that file).

- [ ] **Step 3:** Pin `EXPECTED_FINAL` to the actual integers. Fix leak assertions so they still forbid disclosure-unit ids and canaries in public JSON.

- [ ] **Step 4:** Re-run until PASS.

- [ ] **Step 5:** Commit

```bash
npm run typecheck
git add tests/e2e/all-scenarios.test.ts tests/contracts/scenario-calibration.test.ts
git commit -m "$(cat <<'EOF'
test: drive all five agent scenarios through e2e and calibration

EOF
)"
```

---

### Task 6: Retarget golden replay to `customer-support-agent`

**Files:**
- Create: `tests/golden/fixtures/customer-support-events.jsonl`
- Create: `tests/golden/fixtures/customer-support-replay.zh-CN.json`
- Create: `tests/golden/fixtures/customer-support-replay.en-US.json`
- Modify: `tests/golden/manufacturing-replay.test.ts` — rename describes; load the new files; update the locale-specific reply assertions
- Move (not delete yet): current `tests/golden/fixtures/manufacturing-replay.{zh-CN,en-US}.json` → `tests/fixtures/runs/v1/manufacturing/replay.{zh-CN,en-US}.json` so the **v1 frozen run** describe still compares against manufacturing snapshots
- Modify: the v1 describe in the same test file to `loadSnapshot` from the v1 directory, not the golden fixtures dir
- Delete: `tests/golden/fixtures/manufacturing-events.jsonl` after the first describe no longer reads it

**Interfaces:**
- Consumes: `projectReplay` (unchanged). Event `scenarioId` must be `customer-support-agent`. Stakeholder / `du-*` / hint L1 text / challenge prompt must match the new YAML (hint L1 = that file’s workflow L1). `HIDDEN_MARKERS` still includes `du-001` (replay must strip it).
- Produces: byte-stable snapshots.

**Event log shape:** Keep the same *event types and count* as `manufacturing-events.jsonl` (start, two asks, one hint, frame, brief pass, design, challenge, respond, pitch, review, score). Replace payloads:

- `scenarioId`: `customer-support-agent`
- ask-1: workflow question; `support-director`; disclose `du-001`; reply from du-001
- ask-2: a second DU (e.g. du-003 or du-005) with its stakeholder
- hint: topic `workflow` level 1 text **copied from the YAML L1**
- challenge: use one of the new scenario’s `events[].prompt` texts
- brief/design/pitch: agent wording, evidence node ids consistent with the patches

- [ ] **Step 1:** Write `customer-support-events.jsonl` by copying the manufacturing jsonl and replacing fields. Do not include canary sentinels.

- [ ] **Step 2:** Generate snapshots (do not hand-type JSON):

```ts
// tests/golden/write-customer-support-snapshots.test.ts  (delete after generating)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectReplay } from "../../src/replay/projector.js";
// load events, then:
writeFileSync(join(out, "customer-support-replay.zh-CN.json"), JSON.stringify(projectReplay(events, "zh-CN"), null, 2) + "\n");
writeFileSync(join(out, "customer-support-replay.en-US.json"), JSON.stringify(projectReplay(events, "en-US"), null, 2) + "\n");
```

Run once, then **delete** the writer test. Commit only the fixtures + the updated golden test.

- [ ] **Step 3:** Point v1 frozen-run test at `tests/fixtures/runs/v1/manufacturing/replay.*.json` (moved manufacturing snapshots). Keep `tests/fixtures/runs/v1/manufacturing/events.jsonl` unchanged. Tamper test may still replace the string `manufacturing-alert-triage` inside that **v1** log.

- [ ] **Step 4:** Update locale assertions to the new ask-1 replies.

Run: `npx vitest run tests/golden/manufacturing-replay.test.ts tests/contracts/version-compatibility.test.ts`

Expected: PASS. Rename the test file only if you also update imports; renaming is optional. If you rename to `customer-support-replay.test.ts`, `git mv` and fix the v1 describe paths.

- [ ] **Step 5:** Commit

```bash
npm run typecheck
git add tests/golden tests/fixtures/runs/v1/manufacturing
git commit -m "$(cat <<'EOF'
test: freeze golden replay on customer-support-agent

EOF
)"
```

---

### Task 7: ADR-0004 and example-id docs

**Files:**
- Modify: `docs/architecture-decisions.md` (append ADR-0004)
- Modify: `docs/scenario-authoring.md` (example id `customer-support-agent`)
- Modify: `tests/fixtures/adversarial-prompts.yaml` (compiled path → `customer-support-agent/evaluator.json`)
- Modify: spec status in `docs/superpowers/specs/2026-08-30-ai-agent-scenario-catalog-design.md` to Accepted

**Interfaces:** None.

- [ ] **Step 1:** Append:

```markdown
## ADR-0004: Production catalog is five AI-agent scenarios

- **Status:** Accepted
- **Date:** 2026-08-30

### Context

The previous catalog mixed ETL, alert classification, and document-fill AI
with one support-automation scenario. The product trains FDEs to sell
tool-using agents with HITL and explicit failure modes.

### Decision

- Production ids: `enterprise-knowledge-agent`, `customer-support-agent`,
  `data-analysis-agent`, `document-review-agent`, `software-engineering-agent`.
- Retired: `support-automation`, `manufacturing-alert-triage`,
  `data-migration`, `export-freight-forwarding` (no aliases).
- Tools exist only as authored facts. Gym does not execute CRM, SQL, Git, or OCR.

### Consequences

- Old runs against retired bundle digests fail `SCENARIO_BUNDLE_MISMATCH`.
- Golden projector fixtures follow `customer-support-agent`; v1 manufacturing
  event logs remain a format-compatibility fixture.
```

- [ ] **Step 2:** Replace the authoring example id. Replace the adversarial compiled path.

- [ ] **Step 3:** Run `npm test` and `npm run typecheck`.

Expected: all tests PASS (including `scenario-catalog`).

- [ ] **Step 4:** Commit

```bash
git add docs/architecture-decisions.md docs/scenario-authoring.md tests/fixtures/adversarial-prompts.yaml docs/superpowers/specs/2026-08-30-ai-agent-scenario-catalog-design.md
git commit -m "$(cat <<'EOF'
docs: record ADR-0004 and retarget scenario examples

EOF
)"
```

Do not edit `docs/mvp-acceptance.md`. Historical plans/specs that mention old ids stay as records.

---

## Spec coverage

| Spec item | Task |
|---|---|
| Five new ids + agent bar in prose | 2–3 |
| Delete four old source+compiled | 4 |
| No schema/runtime/tools execution | all |
| compile-scenarios.mjs + committed bundles | 4 |
| hint-discipline SOURCES | 2–4 |
| all-scenarios + calibration | 5 |
| compiler test + public snapshot | 4 |
| Golden regen; no manufacturing golden filenames | 6 |
| v1 manufacturing log preserved | 6 |
| adversarial path + authoring example + loader comment | 4, 7 |
| ADR-0004 | 7 |
| No mvp-acceptance.md | 7 |

## Placeholder scan

No TBD. `EXPECTED_FINAL` is pinned from the first calibration failure output in Task 5, not invented. Golden snapshots are generated by `projectReplay`, not typed by hand.
