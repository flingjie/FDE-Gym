# Scenario Authoring

A scenario is a single bilingual YAML source document validated by
`ScenarioAuthoringSchema` (`src/scenarios/schema.ts`) and compiled by
`src/scenarios/compiler.ts` into three role partitions plus a manifest (see
`docs/architecture.md`). The source lives at `scenarios/source/<id>.yaml`; the
compiled partitions land in `scenarios/compiled/<id>/`.

## Top-level shape

```yaml
id: <string>            # scenario id, e.g. "customer-support-agent"
schemaVersion: 1        # frozen; anything else is rejected at load time
locale: zh-CN           # default locale for the run (still fully bilingual)
public: { ... }         # learner-visible content
customer: { ... }       # hidden customer facts + stakeholders
evaluator: { ... }      # hidden evaluation criteria
events: [ ... ]         # deterministic challenge/constraint-change candidates
```

## Bilingual content requirements

Every prose field is a `LocalizedText` and **must** carry non-empty `zh-CN` and
`en-US` values (the schema is `.strict()` and enforces `min(1)` on both). There
is no fallback locale: a missing or empty locale fails compilation.

```yaml
openingRequest:
  "zh-CN": "请帮助我们设计……"
  "en-US": "Please help us design …"
```

## `public` (learner-visible)

`openingRequest`, `visibleContext`, `visibleConstraints[]`, `deliverables[]`,
`learnerRules[]`, and `questionBudget` (a positive integer — the learner's
discovery question budget). **Nothing here may contain hidden facts**: the
compiled `public.json` is what the learner sees and is asserted (in tests) to be
free of disclosure-unit/evidence ids, rubric criteria, hint answers, event
trigger text, and canaries.

## `customer` (hidden)

- `stakeholders[]` — `id`, `role`, `persona`, `concerns[]`, `blindSpots[]`
  (information the stakeholder is blind to, so the Customer may say
  "I don't know").
- `disclosureUnits[]` — the hidden facts the Customer may reveal. Each has an
  `id`, a `topic` (discovery category, e.g. `workflow`/`pain`/`root-cause`),
  bilingual `text`, `prerequisites` (disclosure-unit ids that must be revealed
  first), and an `evidenceId` linking it to evaluator-side expected evidence.
- `responsePolicies[]` and `privateConflicts[]` — optional behavioral/dynamic
  cues (may be empty).

## `evaluator` (hidden)

- `expectedEvidence[]` — what the tracker/evaluator looks for: `id`, `category`,
  bilingual `description`, a strictly-positive `weight`, and
  `disclosureUnitIds[]` (which disclosure units reveal it). **Weight** drives
  information gain and scoring (see `docs/scoring.md`).
- `rubric` — the **`scenarioDeliverableRubric`**: five stages (`framing`,
  `solution`, `challenge`, `pitch`, `process`), each with weighted `criteria`
  (`id`, bilingual `label`, `weight` 0–100, bilingual `description`). This is the
  scenario-specific **deliverable quality** rubric; the fixed
  capability-dimension weighting used by Raw is the **`capabilityScoringRubric`**
  in `src/scoring/rubric.ts` and never varies per scenario. The
  `scenarioDeliverableRubric` describes expected quality for the Coach/learner;
  only the `capabilityScoringRubric` drives numeric scoring.
- `criticalContradictions[]` — `id`, bilingual `statement`,
  `expectedEvidenceIds[]`. These encode the tensions a learner must surface.
- `hintLadders[]` — one ladder per discovery topic: `id`, `topic`, and `hints`
  with keys `"1"`, `"2"`, `"3"` (all three required).
- `passGates[]` — `id` + bilingual `description` of each scenario gate.
  **Guidance-only**: these are authored expectations, not executable predicates.
  They carry no predicate mapping (e.g. "passes when evidence X is supported"),
  so no run currently fails or passes on them. The executable pass/fail gates
  are the fixed `PassGateResults` computed by `src/scoring/formulas.ts` — see
  `docs/scoring.md`. Until each `passGates[]` entry has an executable predicate
  mapping, treat them as authoring/coaching guidance, not release gates.

### Hint ladder discipline (L1/2/3)

Escalation is enforced by `src/simulation/hints.ts`, not by model behavior.
Selection remains `requestHint`; skip-ahead stays allowed. A lower level never
leaks a higher level's text. Do not put answers (or near-answers) in L1/L2.

| Level | Allowed | Forbidden |
|---|---|---|
| **L1** | A thinking **dimension** or an open question with **no hidden fact** (no quantities, thresholds, dollar amounts, or unique operational counts from disclosure units). | Answers; 「关键发现」; copying disclosure-unit numbers. |
| **L2** | The **category** of missing evidence (volume, cost share, constraint class). May name *kinds* of metric. | The metric's value; the same numbers as L3 answers. |
| **L3** | **Exactly one** actionable **question** (or one tight compound question) that a learner could put to a stakeholder. Must be a question in both locales. | The answer; 「关键发现」 / `Key discovery`; any numeric or currency token that appears in that scenario's disclosure-unit or expected-evidence text. |

Compile-time checks (`ScenarioAuthoringSchema`): L3 must not contain `关键发现`
or `Key discovery`; L3 must contain `?` or `？` in both locales; hint text at
any level must not repeat numeric tokens from `disclosureUnits[].text` or
`expectedEvidence[].description`.

## Deterministic events (the 5 trigger kinds)

`events[]` are `ScenarioEventCandidate`s: `id`, `trigger`, and bilingual
`prompt` (the challenge/constraint-change text). Exactly five trigger kinds
exist (`EventTrigger`):

| Trigger kind | Fires when | Key field |
|---|---|---|
| `on_stage_enter` | the run is in the given phase | `phase` |
| `after_question_count` | `questionCount >= count` | `count` |
| `after_evidence_revealed` | the given evidence id has been revealed | `evidenceId` |
| `if_contradiction_unresolved` | the given contradiction id is still unresolved | `contradictionId` |
| `after_challenge_response_count` | `challengeResponseCount >= count` | `count` |

Selection is deterministic (`src/simulation/event-scheduler.ts`): filter fired
candidates → sort by `id` → seeded Fisher–Yates shuffle. **Same scenario bundle
digest + seed + trigger context → same scheduled event order**: the **selected
set** is fully determined by the scenario bundle + context, and the **order** is
seeded (see determinism claim #2 in `docs/architecture.md`).

> **NOTE — `if_contradiction_unresolved` namespace caveat (known limitation).**
> At authoring/lint time, `if_contradiction_unresolved.contradictionId` is
> validated against the evaluator's `criticalContradictions[].id`. At **runtime**,
> however, the scheduler matches that id against **evidence-graph
> `contradiction`-kind node ids** (which are produced by the Evidence Tracker,
> not authored — see `buildTriggerContext` in `src/core/orchestrator.ts`). The
> two namespaces are different, so an authored `contradictionId` will only
> actually fire if the tracker happens to create a contradiction node with that
> exact id. Treat `if_contradiction_unresolved` as best-effort today; prefer the
> count- and evidence-based triggers for guaranteed behavior.

## Lint rules (compile-time, from `ScenarioAuthoringSchema.superRefine`)

The source fails compilation if any of these is violated:

1. duplicate `stakeholder.id`
2. duplicate `disclosureUnits.id`
3. a disclosure unit's `prerequisites` references a missing disclosure-unit id
4. duplicate `expectedEvidence.id`
5. a disclosure unit's `evidenceId` references a missing expected-evidence id
6. duplicate `criticalContradictions.id`
7. duplicate `hintLadders.id`
8. duplicate `events.id`
9. `after_evidence_revealed.evidenceId` references a missing expected-evidence id
10. `if_contradiction_unresolved.contradictionId` references a missing
    critical-contradiction id (see the namespace caveat above)

## Complete example (placeholders — no production hidden answers)

Everything below is a valid, compilable source. Hidden facts are replaced with
clearly-marked placeholders (`【占位：…】` / `[PLACEHOLDER: …]`); replace them
with real content when authoring a production scenario.

```yaml
id: onboarding-automation
schemaVersion: 1
locale: zh-CN

public:
  openingRequest:
    "zh-CN": "请帮我们设计一个方案，改进新员工的入职流程。"
    "en-US": "Please help us design a solution to improve the new-hire onboarding process."
  visibleContext:
    "zh-CN": "我们是一家中型软件公司，入职流程目前依赖人工和若干零散工具。"
    "en-US": "We are a mid-size software company; onboarding currently relies on manual steps and a few disjointed tools."
  visibleConstraints:
    - "zh-CN": "预算有限"
      "en-US": "Limited budget"
    - "zh-CN": "必须与现有 HR 系统集成"
      "en-US": "Must integrate with the existing HR system"
  deliverables:
    - "zh-CN": "入职流程优化方案文档"
      "en-US": "Onboarding optimization design document"
  learnerRules:
    - "zh-CN": "你有 8 个问题预算"
      "en-US": "You have a budget of 8 questions"
  questionBudget: 8

customer:
  stakeholders:
    - id: hr-director
      role: { "zh-CN": "人力资源总监", "en-US": "HR Director" }
      persona: { "zh-CN": "关注入职体验和效率。", "en-US": "Focused on onboarding experience and efficiency." }
      concerns: []
      blindSpots: []
    - id: new-hire
      role: { "zh-CN": "新员工", "en-US": "New hire" }
      persona: { "zh-CN": "刚入职，亲身经历流程。", "en-US": "Recently joined; experiences the process first-hand." }
      concerns: []
      blindSpots: []
  disclosureUnits:
    - id: du-onb-001
      topic: workflow
      text:
        "zh-CN": "【占位：真实隐藏事实】入职流程目前有 N 个手工步骤。"
        "en-US": "[PLACEHOLDER: real hidden fact] Onboarding currently has N manual steps."
      prerequisites: []
      evidenceId: ev-workflow
    - id: du-onb-002
      topic: pain
      text:
        "zh-CN": "【占位：真实隐藏事实】平均入职周期为 X 天，首周流失率约 Y%。"
        "en-US": "[PLACEHOLDER: real hidden fact] Average time-to-productivity is X days; first-week dropout ~Y%."
      prerequisites: ["du-onb-001"]
      evidenceId: ev-pain
  responsePolicies: []
  privateConflicts: []

evaluator:
  expectedEvidence:
    - id: ev-workflow
      category: workflow
      description: { "zh-CN": "入职流程的结构信息", "en-US": "Structural information about the onboarding flow" }
      weight: 2
      disclosureUnitIds: ["du-onb-001"]
    - id: ev-pain
      category: pain
      description: { "zh-CN": "入职流程的业务痛点", "en-US": "Business pain of the onboarding flow" }
      weight: 2
      disclosureUnitIds: ["du-onb-002"]
  rubric:
    stages:
      - id: framing
        label: { "zh-CN": "问题定义", "en-US": "Problem Framing" }
        criteria:
          - id: f-c1
            label: { "zh-CN": "问题陈述清晰度", "en-US": "Clarity" }
            weight: 100
            description: { "zh-CN": "准确描述问题", "en-US": "Accurately describe the problem" }
      - id: solution
        label: { "zh-CN": "方案设计", "en-US": "Solution Design" }
        criteria:
          - id: s-c1
            label: { "zh-CN": "方案完整性", "en-US": "Completeness" }
            weight: 100
            description: { "zh-CN": "方案是否完整", "en-US": "Is the solution complete" }
      - id: challenge
        label: { "zh-CN": "挑战应对", "en-US": "Challenge Response" }
        criteria:
          - id: ch-c1
            label: { "zh-CN": "应对质量", "en-US": "Response quality" }
            weight: 100
            description: { "zh-CN": "能否有效应对挑战", "en-US": "Can address challenges" }
      - id: pitch
        label: { "zh-CN": "方案表达", "en-US": "Presentation" }
        criteria:
          - id: p-c1
            label: { "zh-CN": "表达清晰度", "en-US": "Clarity" }
            weight: 100
            description: { "zh-CN": "表达清晰", "en-US": "Clear presentation" }
      - id: process
        label: { "zh-CN": "实施流程", "en-US": "Process" }
        criteria:
          - id: pr-c1
            label: { "zh-CN": "流程合理性", "en-US": "Reasonableness" }
            weight: 100
            description: { "zh-CN": "流程合理", "en-US": "Reasonable process" }
  criticalContradictions:
    - id: cc-001
      statement:
        "zh-CN": "管理层希望流程更精简，而新员工需要更多支持。"
        "en-US": "Management wants a leaner process while new hires need more support."
      expectedEvidenceIds: ["ev-workflow", "ev-pain"]
  hintLadders:
    - id: hl-workflow
      topic: workflow
      hints:
        "1": { "zh-CN": "入职流程从哪里开始？", "en-US": "Where does onboarding start?" }
        "2": { "zh-CN": "关注流程中的手工步骤数量。", "en-US": "Focus on the number of manual steps." }
        "3": { "zh-CN": "入职流程目前包含哪些手工步骤，先后顺序是怎样的？", "en-US": "Which manual steps does onboarding currently include, and in what order?" }
    - id: hl-pain
      topic: pain
      hints:
        "1": { "zh-CN": "入职周期对业务有什么影响？", "en-US": "How does onboarding time affect the business?" }
        "2": { "zh-CN": "关注流失率。", "en-US": "Focus on the dropout rate." }
        "3": { "zh-CN": "平均入职周期有多长，首周流失情况如何？", "en-US": "How long is the average onboarding cycle, and what does first-week dropout look like?" }
  passGates:
    - id: pg-001
      description:
        "zh-CN": "方案必须与约束兼容"
        "en-US": "The solution must be constraint-compatible"

events:
  - id: event-constraint
    trigger: { kind: on_stage_enter, phase: DISCOVERY }
    prompt:
      "zh-CN": "【通知】现有 HR 系统必须保留。"
      "en-US": "[Notice] The existing HR system must be retained."
  - id: event-budget
    trigger: { kind: after_evidence_revealed, evidenceId: ev-pain }
    prompt:
      "zh-CN": "【预算更新】预算被削减。"
      "en-US": "[Budget update] The budget has been cut."
```

Compile it with `compileScenario("scenarios/source/onboarding-automation.yaml", canarySeed)`
(see `src/scenarios/compiler.ts`).
